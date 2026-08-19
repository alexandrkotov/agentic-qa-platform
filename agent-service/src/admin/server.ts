import express from 'express';
import { readFile, writeFile, readdir, mkdir, unlink, cp, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { SystemDescriptorSchema, parseSystemDescriptor } from '../descriptor/schema.ts';
import type { SystemDescriptor, SystemComponent, DockerComposeComponent } from '../descriptor/schema.ts';
import { runDiscoveryForDescriptor } from '../bootstrap/discovery.ts';
import { deployTarget, undeployTarget, cancelDeploy, DeployCancelledError, getTargetContainerNames, getRunningContainerNames, resolveTargetPaths } from '../bootstrap/deployTarget.ts';
import { clearTargetData } from '../bootstrap/clearTargetData.ts';
import type { DeployState, PortMapping } from '../bootstrap/deployTarget.ts';
import { hasSetup, runSetup, setupScriptPath } from '../bootstrap/setupTarget.ts';
import { probeTarget, ProbeTargetError } from '../bootstrap/probeTarget.ts';
import { syncKafkaUi } from '../bootstrap/kafkaUiSync.ts';
import { targetsDirFromEnv } from '../bootstrap/targetsDir.ts';
import { convertRecording } from '../bootstrap/convertRecording.ts';
import { runCommand } from '../util/runCommand.ts';
import { expandHostProjectRoot } from '../util/expandHostProjectRoot.ts';
import { parseDiscoveryReport } from '../agents/generate/reportSchema.ts';
import { proposeGrouping } from '../agents/generate/group.ts';
import { splitByBudget } from '../agents/generate/budget.ts';
import { generateGeneration } from '../agents/generate/spec.ts';
import { generateLoadTestScript } from '../agents/loadtest/spec.ts';
import type { AgentProvider } from '../providers/AgentProvider.ts';
import { renderGeneration, writeRenderedFiles } from '../agents/generate/render.ts';
import { compileAndVerify, collectExistingStepPatterns, collectApprovedSpecPatterns } from '../agents/generate/verify.ts';
import {
  ProposedGroupingSchema,
  ApprovedGroupingSchema,
  ProposedGenerationSchema,
  ApprovedGenerationSchema,
  CorrectionsSchema,
} from '../agents/generate/contract.ts';
import { loadCorrections, saveCorrections } from '../agents/generate/corrections.ts';
import { loadUatContext, saveUatContext } from '../agents/generate/uat.ts';
import { loadTestEnvOverrides, loadTestEnvText, saveTestEnvText } from '../agents/generate/testEnv.ts';
import { extractTextFromFile, extractTextFromGoogleUrl } from '../agents/generate/uatExtract.ts';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { proposeWorkflow } from '../agents/workflow/propose.ts';
import { proposeUiFlow } from '../agents/workflow/proposeUiFlow.ts';
import { proposeSequenceFlow } from '../agents/workflow/proposeSequenceFlow.ts';
import {
  renderErDiagram,
  renderStateDiagram,
  renderArchitectureDiagram,
  renderApiInventoryDiagram,
  renderUiFlowDiagram,
  renderSequenceDiagram,
} from '../agents/workflow/render.ts';
import {
  ProposedWorkflowSchema,
  ApprovedWorkflowSchema,
  ProposedUiFlowSchema,
  ApprovedUiFlowSchema,
  ProposedSequenceFlowSchema,
  ApprovedSequenceFlowSchema,
} from '../agents/workflow/contract.ts';
import { ClaudeProvider } from '../providers/ClaudeProvider.ts';
import { discoverScenarios, resolveScenarioSelectors } from '../agents/e2e/scenarios.ts';
import { runOneScenario } from '../agents/e2e/index.ts';
import { loadApplyPreview, performApply } from '../agents/e2e/applyCore.ts';
import { config } from '../config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESCRIPTORS_DIR = resolve(__dirname, '../../descriptors');
const PORT = Number(process.env.ADMIN_PORT ?? 4400);

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
/** Plain filename only (no slashes) — same defence-in-depth as descriptorPath()'s NAME_PATTERN below. */
const REPORT_NAME_PATTERN = /^discovery-[A-Za-z0-9:_.-]+\.json$/;

/** Resolves a descriptor name to a file path with a given suffix, rejecting
 * anything that isn't a plain filename component — this is the only thing
 * standing between an HTTP request body and a path on disk, so it must
 * reject traversal outright rather than merely warn. */
function resolveDescriptorFile(name: string, suffix: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw Object.assign(new Error('Descriptor name must be alphanumeric (with - or _ only)'), {
      status: 400,
    });
  }
  return join(DESCRIPTORS_DIR, `${name}${suffix}`);
}
function descriptorPath(name: string): string {
  return resolveDescriptorFile(name, '.json');
}

/** Same defence-in-depth as descriptorPath(): a report request must name an
 * exact, plain discovery-*.json filename already sitting in reportsDir. */
function reportFilePath(name: string): string {
  if (!REPORT_NAME_PATTERN.test(name)) {
    throw Object.assign(new Error('Report name must be an exact "discovery-*.json" filename'), { status: 400 });
  }
  return join(config.reportsDir, name);
}

const GROUPING_NAME_PATTERN = /^generate-grouping-approved-[A-Za-z0-9:_.-]+\.json$/;
function groupingFilePath(name: string): string {
  if (!GROUPING_NAME_PATTERN.test(name)) {
    throw Object.assign(new Error('Grouping name must be an exact "generate-grouping-approved-*.json" filename'), {
      status: 400,
    });
  }
  return join(config.reportsDir, name);
}

// Mirrors generate.html's own descriptorFromReportName — discovery.ts names
// every report "discovery-<isoTimestamp>-<descriptorLabel>.json", timestamp
// first (sortable), descriptor label last. Duplicated here rather than
// shared: this admin server and its static pages are two separate JS
// worlds in this codebase (server-side TS vs. self-contained browser
// script), with no existing mechanism to share code between them.
const REPORT_DESCRIPTOR_PATTERN = /^discovery-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)\.json$/;
function descriptorFromReportName(reportName: string): string | null {
  const m = reportName.match(REPORT_DESCRIPTOR_PATTERN);
  return m ? m[1] : null;
}

// Same idea, one layer down: newly-approved groupings now carry the
// descriptor in their own filename too (see /api/generate/group/approve),
// so most lookups never need to open the file. Groupings approved before
// that convention existed fall back to reading sourceReportPath — there
// are only ever a handful of files here, so the extra read is cheap.
const GROUPING_DESCRIPTOR_PATTERN = /^generate-grouping-approved-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)\.json$/;
async function descriptorForGroupingFile(name: string): Promise<string | null> {
  const fromName = name.match(GROUPING_DESCRIPTOR_PATTERN);
  if (fromName) return fromName[1];
  try {
    const raw = JSON.parse(await readFile(join(config.reportsDir, name), 'utf-8'));
    const reportPath = typeof raw.sourceReportPath === 'string' ? raw.sourceReportPath : undefined;
    const reportName = reportPath?.split('/').pop();
    return reportName ? descriptorFromReportName(reportName) : null;
  } catch {
    return null;
  }
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'static')));
// Serves bootstrap/setupPage.ts's own saved recordings (agent-service/
// reports/setup-videos/<name>/<file>.webm) so the "Record setup" UI can
// link straight to a playable URL instead of just a filesystem path the
// user has to go find by hand — same local-only, no-auth trust model as
// every other route here.
app.use('/videos', express.static(join(config.reportsDir, 'setup-videos')));

app.get('/api/descriptors', async (_req, res) => {
  const files = await readdir(DESCRIPTORS_DIR);
  // Exclude sibling *.corrections.json files (see corrections.ts) — they live
  // in the same directory as real descriptors but aren't one themselves.
  const names = files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.corrections.json'))
    .map((f) => f.replace(/\.json$/, ''));
  res.json(names);
});

app.get('/api/descriptors/:name', async (req, res) => {
  try {
    const raw = await readFile(descriptorPath(req.params.name), 'utf-8');
    res.json(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No descriptor named "${req.params.name}"` });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// Backs the descriptor list's own "AUTO-SETUP" corner badge (index.html) —
// a target with a registered bootstrap/setup/<name>.ts script gets its
// first-run wizard handled automatically on every fresh deploy, no human
// click-through needed. Doesn't require the descriptor to exist (hasSetup()
// is a plain filesystem check, same reasoning as the deploy-status route's
// own comment above it), so this never 404s even for a stale/mistyped name.
app.get('/api/descriptors/:name/has-setup', (req, res) => {
  res.json({ hasSetup: hasSetup(req.params.name) });
});

// Backs the "Record setup" panel's own codegen-command builder (index.html)
// — needs the target's real currently-published port(s), the same
// state.json a real deploy already wrote (see deployTarget.ts's own
// DeployState). Same read-only resolveTargetPaths()+state.json pattern
// already used by the hub-status code further down this file (search
// "kumaUrl") and by probeTarget.ts, just generalized to any descriptor
// instead of hardcoding "uptime-kuma".
app.get('/api/descriptors/:name/ports', async (req, res) => {
  try {
    const { statePath } = resolveTargetPaths(targetsDirFromEnv(), req.params.name);
    const state = JSON.parse(await readFile(statePath, 'utf-8')) as DeployState;
    res.json({ ports: state.ports });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(400).json({ error: 'No deployed configuration found for this target yet — deploy it first.' });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// Tier 1 of "Record setup" (see memory `project_setup_script_autogen_idea`)
// — a purely mechanical, no-Claude-call transform from a pasted
// `playwright codegen` recording into a draft SetupFn. See
// convertRecording.ts's own header comment for what this deliberately does
// NOT attempt (a real idempotency check, deciding which recorded steps are
// optional) — that stays a human/Claude-in-chat research step, same as it
// was for setup/trilium.ts and setup/nocodb.ts.
//
// Writes straight to bootstrap/setup/<name>.ts, not just returned for
// copy-paste — docker-compose.yml now bind-mounts that one directory
// specifically (unlike the rest of agent-service/src/, baked into the
// image), so this is a real, persisted write the very next `/setup` (run)
// or `/setup/source` (read/edit) call can see immediately, no rebuild.
// `code` itself isn't echoed back in the response — the UI's own Source
// view re-reads it fresh via GET .../setup/source right after this call,
// so there's no reason to duplicate it in two places that could drift.
app.post('/api/descriptors/:name/setup/generate-draft', async (req, res) => {
  try {
    const { recording } = req.body as { recording?: string };
    if (!recording) {
      res.status(400).json({ error: '"recording" is required' });
      return;
    }
    const { code, envVars, warnings } = convertRecording(recording, req.params.name);
    await writeFile(setupScriptPath(req.params.name), code, 'utf-8');
    res.json({ envVars, warnings });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// The setup script's own raw source — read/edit half of the same
// generate → run → edit → save loop above. `text: null` (not a 404) when
// none exists yet mirrors hasSetup()'s own "most targets don't need one"
// framing — the UI shows an empty/placeholder editor, not an error.
app.get('/api/descriptors/:name/setup/source', async (req, res) => {
  try {
    const text = await readFile(setupScriptPath(req.params.name), 'utf-8');
    res.json({ text });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.json({ text: null });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// No schema validation beyond "is a string" — this is TypeScript source,
// not JSON; a syntax/type error just surfaces the next time /setup (run)
// actually imports it, same as any hand-edited file would today.
app.put('/api/descriptors/:name/setup/source', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: '"text" is required' });
      return;
    }
    await writeFile(setupScriptPath(req.params.name), text, 'utf-8');
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// "Start/Stop recording" — the codegen-recorder service (docker-compose.yml)
// is always up (an idle Xvfb+x11vnc+noVNC shell, genuinely cheap — see that
// service's own comment for why), so these two routes only ever manage the
// one thing that's actually expensive: the `playwright codegen` process
// itself, via `docker exec`. No image build, no container start/stop here
// — that's docker-compose's job, done once at platform boot.
// ---------------------------------------------------------------------------

const RECORDER_CONTAINER = 'codegen-recorder';
// Where each recording session's own generated script lands inside the
// container — `codegen`'s own `--output` flag writes/updates this file as
// the human records, not just once at the very end. Read back by /stop
// below, so a human clicking Stop never has to have manually copied
// anything out of the Inspector's own UI first — losing an unsaved
// recording that way (the Inspector's own copy is gone the moment its
// browser process is killed) was a real gap caught live, not a
// theoretical one.
const RECORDING_OUTPUT_PATH = '/work/recording.spec.ts';

app.post('/api/recorder/start', async (req, res) => {
  try {
    const { url } = req.body as { url?: string };
    if (!url) {
      res.status(400).json({ error: '"url" is required' });
      return;
    }
    // Kill any previous recording session first — starting a new one
    // (a different target, or just retrying) should always reflect this
    // click, never leave a stale codegen process pointed at the old URL
    // running alongside it. A SEPARATE `docker exec`, not chained with `;`
    // into the same `sh -c` script as the launch below — confirmed live
    // this is not just style: `pkill -f 'playwright codegen'` matches
    // against every process's own command line, including the very `sh -c
    // "pkill ...; ... npx playwright codegen ..."` wrapper it's running
    // inside of (that string is right there in its own argv) — chained,
    // pkill killed its own enclosing shell before `npx` ever started,
    // silently, no error surfaced anywhere. pkill's built-in self-exclusion
    // only protects pkill's own PID, not its parent shell.
    await runCommand('docker', ['exec', RECORDER_CONTAINER, 'pkill', '-f', 'playwright codegen'], process.cwd(), process.env);
    // Also clear out any previous recording file — a stale one from an
    // earlier session (or one abandoned without ever clicking Stop)
    // shouldn't leak into this new one if this exact run never actually
    // produces its own (codegen crashes, or the human never lands on a
    // real page before stopping).
    await runCommand('docker', ['exec', RECORDER_CONTAINER, 'rm', '-f', RECORDING_OUTPUT_PATH], process.cwd(), process.env);
    const launch = await runCommand(
      'docker',
      ['exec', '-d', RECORDER_CONTAINER, 'sh', '-c', `DISPLAY=:99 npx playwright codegen --output '${RECORDING_OUTPUT_PATH}' '${url}'`],
      process.cwd(),
      process.env,
    );
    if (launch.code !== 0) {
      res.status(500).json({ error: `Failed to start recording: ${launch.output}` });
      return;
    }
    // The real password x11vnc is actually enforcing, parsed fresh from the
    // container's own log every call — never a value invented here. Same
    // password for as long as the container itself has been up (start.sh
    // only generates a new one on container start, not per recording).
    //
    // Last match, not first: `docker logs` (no --since) returns the WHOLE
    // log history since the container was created, not just since its most
    // recent start — if x11vnc has ever been restarted in place (it isn't
    // supervised, so a crash — confirmed live: a stale /tmp/.X99-lock after
    // an unclean shutdown left it a zombie unable to reattach to Xvfb —
    // just leaves it dead until something notices) the log accumulates one
    // "VNC password:" line per attempt. The first one is whatever password
    // was live when the container originally started, not the one x11vnc
    // is actually enforcing right now — taking it silently handed back a
    // stale password and made every real recording attempt fail with
    // "password check failed" until the container was force-recreated.
    const logs = await runCommand('docker', ['logs', RECORDER_CONTAINER], process.cwd(), process.env);
    const matches = [...logs.output.matchAll(/VNC password: (\S+)/g)];
    if (matches.length === 0) {
      res.status(500).json({ error: `codegen-recorder is up but its VNC password wasn't found in its logs — is the service actually running (docker compose up codegen-recorder)?` });
      return;
    }
    res.json({ password: matches[matches.length - 1][1] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/recorder/stop', async (_req, res) => {
  try {
    // Just the Chromium process — the lightweight VNC shell itself keeps
    // running, ready for the next Start click. Not an error if nothing was
    // actually recording (pkill's own non-zero "no process matched" exit
    // is a normal, expected outcome here, not a real failure).
    await runCommand('docker', ['exec', RECORDER_CONTAINER, 'pkill', '-f', 'playwright codegen'], process.cwd(), process.env);
    // A brief pause before reading — the file is written eagerly as
    // codegen records (confirmed live), but SIGTERM landing mid-write to
    // disk is a real enough race to guard against rather than assume away.
    await new Promise((r) => setTimeout(r, 300));
    // Best-effort: the human may have clicked Stop before ever navigating
    // anywhere real, or the file may already be gone from a /start call
    // that immediately followed without an intervening recording — `cat`
    // failing just means no recording to hand back, not a route failure.
    const read = await runCommand('docker', ['exec', RECORDER_CONTAINER, 'cat', RECORDING_OUTPUT_PATH], process.cwd(), process.env);
    res.json({ ok: true, recording: read.code === 0 ? read.output : null });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put('/api/descriptors/:name', async (req, res) => {
  try {
    const path = descriptorPath(req.params.name);
    const parsed = SystemDescriptorSchema.parse(req.body);
    await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    res.json(parsed);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/descriptors', async (req, res) => {
  try {
    const { name, ...body } = req.body as { name?: string };
    if (!name) {
      res.status(400).json({ error: '"name" is required' });
      return;
    }
    const path = descriptorPath(name);
    try {
      await readFile(path, 'utf-8');
      res.status(409).json({ error: `Descriptor "${name}" already exists` });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const parsed = SystemDescriptorSchema.parse({ name, components: [], ...body });
    await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    res.status(201).json(parsed);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.delete('/api/descriptors/:name', async (req, res) => {
  try {
    await unlink(descriptorPath(req.params.name));
    // Best-effort — a corrections sidecar (see corrections.ts) only exists
    // once Generate has run against this descriptor at least once, and
    // leaving it behind would silently reattach to a same-named descriptor
    // created later.
    await unlink(resolveDescriptorFile(req.params.name, '.corrections.json')).catch(() => {});
    res.status(204).end();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No descriptor named "${req.params.name}"` });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Deploy — spins up a target described only by a `docker-compose` component
// (see descriptor/components/dockerCompose.ts) from its own repo, via the
// Docker socket already mounted into this container (docker-compose.yml's
// own comment on that mount has the full DooD-mirroring story). Root-equivalent
// on the HOST, triggered from an unauthenticated local UI: this route clones
// an arbitrary git repo named in the descriptor and runs whatever compose
// file it contains against the host's real Docker daemon. Acceptable here
// because this whole admin server is already a local, single-user dev tool
// with no auth of its own (same trust boundary as /api/tests/run spawning
// arbitrary local processes) — but worth stating plainly, not left implicit,
// given what this specific route actually does.
//
// Deliberately NOT part of /api/discovery/run's own flow — deploy has to
// finish and be reachable *before* a human can even write real component
// URLs into the rest of the descriptor, so it's its own explicit action.
// ---------------------------------------------------------------------------

function findDockerComposeComponent(descriptor: SystemDescriptor): DockerComposeComponent {
  const found = descriptor.components.find((c): c is DockerComposeComponent => c.type === 'docker-compose');
  if (!found) {
    throw Object.assign(new Error('Descriptor has no "docker-compose" component to deploy'), { status: 400 });
  }
  return found;
}

// Backs two separate UI moments off the same signal (index.html): the
// pre-deploy "leftover containers detected, they'll be removed" warning
// (checked right before the Deploy confirm), and the Stop/Remove button's
// own label + disabled state for whichever target is currently selected.
// Queried by Compose's own project label, not by name-existence in
// descriptors/ — deliberately doesn't require the descriptor to still have
// a docker-compose component (or exist at all) so a target's containers
// don't become unqueryable just because its descriptor was edited/deleted.
app.get('/api/descriptors/:name/deploy/status', async (req, res) => {
  try {
    const containerNames = await getTargetContainerNames(req.params.name);
    res.json({ containerNames });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/descriptors/:name/deploy', async (req, res) => {
  try {
    const name = req.params.name;
    const descriptor = parseSystemDescriptor(JSON.parse(await readFile(descriptorPath(name), 'utf-8')));
    const component = findDockerComposeComponent(descriptor);

    // Long-running (clone + potentially several GB of image pulls) with
    // previously zero feedback beyond a static "deploying…" status —
    // stream NDJSON the same way Discovery/Generate's own long calls do.
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    try {
      // Kafka UI Multi-Cluster — detach kafka-ui from this target's own
      // network BEFORE deployTarget()'s own self-healing cleanup (a
      // redeploy of an already-live kafka-having target) tries to remove
      // it, avoiding a real "network has active endpoints" failure. Never
      // throws — see kafkaUiSync.ts's own doc comment.
      await syncKafkaUi((message) => send({ type: 'progress', message }), { excludeTarget: name });
      const result = await deployTarget(component, name, (message) => send({ type: 'progress', message }));
      // Picks up the freshly (re)deployed target's own cluster, if any.
      await syncKafkaUi((message) => send({ type: 'progress', message }));
      send({
        type: 'done',
        projectName: result.projectName,
        ports: result.ports,
      });
    } catch (err) {
      if (err instanceof DeployCancelledError) {
        // Distinct from a real failure — the UI shows this as "cancelled",
        // not "failed", and the rollback progress leading up to it already
        // streamed as ordinary `progress` events above.
        send({ type: 'cancelled', message: err.message });
      } else {
        send({ type: 'error', error: (err as Error).message });
      }
    }
    res.end();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No descriptor named "${req.params.name}"` });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// Fire-and-forget: just signals bootstrap/deployTarget.ts's AbortController
// for this name (if a deploy is actually in flight) and returns immediately
// — the real rollback progress and final "cancelled" event stream through
// the ORIGINAL /deploy request's still-open connection above, not this one.
// Deliberately a separate route rather than reusing /undeploy: undeploy
// tries to acquire the same in-process lock deployTarget() is already
// holding and would just bounce off it with "already in progress", and
// conflating "tear down a running stack" with "cancel one that's still
// starting up" would make either code path harder to reason about.
app.post('/api/descriptors/:name/deploy/cancel', (req, res) => {
  const cancelled = cancelDeploy(req.params.name);
  res.json({ cancelled });
});

app.post('/api/descriptors/:name/undeploy', async (req, res) => {
  try {
    const name = req.params.name;
    // Confirms this descriptor really does describe a docker-compose deploy
    // before touching anything — same shape check as the deploy route,
    // even though undeployTarget() itself only needs the plain name.
    const descriptor = parseSystemDescriptor(JSON.parse(await readFile(descriptorPath(name), 'utf-8')));
    findDockerComposeComponent(descriptor);

    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    try {
      // Detach kafka-ui from this target's network first — see the
      // matching comment on /deploy above.
      await syncKafkaUi((message) => send({ type: 'progress', message }), { excludeTarget: name });
      await undeployTarget(name, (message) => send({ type: 'progress', message }));
      send({ type: 'done' });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No descriptor named "${req.params.name}"` });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// Undeploy + genuinely wipe whatever persists the target's own state
// (bind-mounted directory or named Docker volume — see
// clearTargetData.ts's own header for why `docker compose down` alone
// never touches either) + redeploy fresh. Backs "Record setup"'s own
// "Reset & Run" button — the exact sequence this project's own sessions
// already did BY HAND, repeatedly, to get a genuinely fresh instance to
// test a setup script's first-run path against — but deliberately
// independent of setup/recording entirely, so it's just as reusable for
// a future generic "Reset" action elsewhere (next to Deploy/Remove).
app.post('/api/descriptors/:name/reset', async (req, res) => {
  try {
    const name = req.params.name;
    const descriptor = parseSystemDescriptor(JSON.parse(await readFile(descriptorPath(name), 'utf-8')));
    const component = findDockerComposeComponent(descriptor);

    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    try {
      // Detach kafka-ui before the undeploy leg — same reasoning as
      // /deploy and /undeploy above; the post-deploy sync below picks the
      // target's cluster back up once it's redeployed.
      await syncKafkaUi((message) => send({ type: 'progress', message }), { excludeTarget: name });
      await undeployTarget(name, (message) => send({ type: 'progress', message }));
      await clearTargetData(name, (message) => send({ type: 'progress', message }));
      const result = await deployTarget(component, name, (message) => send({ type: 'progress', message }));
      await syncKafkaUi((message) => send({ type: 'progress', message }));
      // A container reporting "Started"/"Healthy" and the app inside it
      // actually accepting connections are two different moments for any
      // target with no healthcheck of its own (confirmed live this exact
      // gap already, for uptime-kuma.ts's own retry loop) — "Reset & Run"
      // hits it every time since it immediately runs right after, unlike
      // an ordinary Deploy where a human's own next click naturally
      // absorbs the gap.
      await waitForTargetReady(result.ports, (message) => send({ type: 'progress', message }));
      send({ type: 'done', projectName: result.projectName, ports: result.ports });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No descriptor named "${req.params.name}"` });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

async function waitForTargetReady(ports: PortMapping[], onProgress?: (message: string) => void): Promise<void> {
  for (const mapping of ports) {
    const url = `http://host.docker.internal:${mapping.publishedPort}/`;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(2000) });
        break;
      } catch {
        if (attempt === 1) onProgress?.(`${url} not accepting connections yet — retrying...`);
        if (attempt === 10) onProgress?.(`${url} still not responding after 10 attempts — continuing anyway.`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// One-time "first run" setup for targets whose own admin account/config
// doesn't survive a fresh docker-compose deploy — see
// bootstrap/setupTarget.ts's own comment for which targets actually need
// this and why. Mechanical (no LLM call), same NDJSON-progress shape as
// /deploy above. hasSetup() is checked BEFORE the NDJSON headers go out
// (unlike a mid-stream error) so a descriptor with no registered setup
// script gets a real 400 status, not just an error line buried in an
// otherwise-200 stream — CI can call this unconditionally for whatever
// descriptor tests/.current-descriptor names and branch on the real HTTP
// status, without special-casing which targets happen to need one.
app.post('/api/descriptors/:name/setup', async (req, res) => {
  try {
    const name = req.params.name;
    if (!hasSetup(name)) {
      res.status(400).json({ error: `No first-run setup script registered for "${name}".` });
      return;
    }
    const env = expandOverrides(await loadTestEnvOverrides(descriptorPath(name)));

    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    // Only the "Record setup" UI's own Run button sends `record: true` —
    // CI's own real call to this exact route (.github/workflows/tests.yml)
    // sends a plain POST with no body, so `onFrame` stays undefined there
    // and bootstrap/setupPage.ts's own screencast/video-recording path
    // never runs at all: zero added cost for every CI run. See that
    // file's own header comment for why live view and the saved
    // recording share one flag instead of two.
    const { record } = (req.body ?? {}) as { record?: boolean };
    const onFrame = record ? (data: string) => send({ type: 'frame', data }) : undefined;

    try {
      await runSetup(name, env, (message) => send({ type: 'progress', message }), onFrame);
      send({ type: 'done' });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Post-deploy probe-and-propose (step 4 of the "External Target Onboarding"
// initiative) — entirely mechanical, no Claude call, resolves in seconds
// (a bit of JSON parsing plus a handful of real HTTP requests), so unlike
// Discovery/Deploy above this is a plain JSON response, not NDJSON-streamed.
// See bootstrap/probeTarget.ts's own module comment for the full design and
// the real, verified-live facts (published-port dependency, sqlite files
// never being named in the compose config, etc.) that shaped it.
// ---------------------------------------------------------------------------

app.post('/api/descriptors/:name/probe', async (req, res) => {
  try {
    res.json(await probeTarget(req.params.name));
  } catch (err) {
    if (err instanceof ProbeTargetError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Discovery — runs the same agent `pnpm discovery` does, from a descriptor
// already sitting in descriptors/. A real, costed, long-running Claude call
// (up to 60 tool-use iterations) — like /api/generate/spec below, not
// something to call on every page load.
//
// This server runs inside a container on the app stack's own Docker
// network (see docker-compose.yml's workbench service — plain bridge + `ports:`,
// not network_mode: host, which doesn't reliably forward to a real host
// browser under Docker Desktop/WSL2). Every descriptor's component URLs are
// written as plain "localhost:PORT", correct for `pnpm discovery` running on
// the host but wrong here — rewrite postgres/rest-api/web-ui host names to
// this compose network's service names before running. Kafka is
// deliberately left alone: its MCP server is a *sibling* container spawned
// via the mounted Docker socket, with its own --network=host
// (descriptor/components/kafka.ts) — a peer of the daemon, not a child of
// this container's network namespace, so it already reaches the real
// host-published broker port regardless.
// ---------------------------------------------------------------------------

const CONTAINER_NETWORK_HOSTS: Record<string, string> = {
  postgres: 'db',
  'rest-api': 'app',
  'web-ui': 'frontend',
};

function rewriteHost(url: string, host: string): string {
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.toString();
}

// A hand-written external-target URL (e.g. a docker-compose-deployed
// target's own "http://host.docker.internal:<port>", per
// bootstrap/deployTarget.ts) is not this fixed sample app's own
// localhost:PORT convention — rewriting it too would silently clobber it
// into pointing at this project's own db/app/frontend instead of the real
// target, and Discovery would produce a plausible-looking report about the
// wrong system entirely. Every URL in this project's own existing
// descriptors (orderflow.json, kafka-demo.json, kafka-consumer-demo.json)
// uses "localhost", so gating on it is behavior-preserving for them.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function rewriteHostIfLoopback(url: string, host: string): string {
  return isLoopbackUrl(url) ? rewriteHost(url, host) : url;
}

/** Returns a copy of the descriptor with postgres/rest-api/web-ui URLs pointed at this compose network's service names instead of "localhost" — but only the ones that were actually "localhost" to begin with, see rewriteHostIfLoopback. */
function rewriteForContainerNetwork(descriptor: SystemDescriptor): SystemDescriptor {
  const components: SystemComponent[] = descriptor.components.map((component) => {
    const host = CONTAINER_NETWORK_HOSTS[component.type];
    if (!host) return component;
    switch (component.type) {
      case 'postgres':
        return { ...component, connectionString: rewriteHostIfLoopback(component.connectionString, host) };
      case 'rest-api':
        return {
          ...component,
          swaggerUrl: component.swaggerUrl ? rewriteHostIfLoopback(component.swaggerUrl, host) : component.swaggerUrl,
          baseUrl: component.baseUrl ? rewriteHostIfLoopback(component.baseUrl, host) : component.baseUrl,
        };
      case 'web-ui':
        return { ...component, baseUrl: rewriteHostIfLoopback(component.baseUrl, host) };
      default:
        return component;
    }
  });
  return { ...descriptor, components };
}

/** Effective base origin a rest-api component's own tools/frontend would call — baseUrl if set, else the swagger URL's own origin (mirrors restApiBuilder's own doc comment). Null when neither is set — restApiBuilder itself throws on that combination before any call starts, but this function runs earlier (deciding whether a rewrite is even needed), so it has to tolerate a still-incomplete component rather than assume that guard already ran. */
function restApiOrigin(descriptor: SystemDescriptor): string | null {
  const restApi = descriptor.components.find((c): c is Extract<SystemComponent, { type: 'rest-api' }> => c.type === 'rest-api');
  if (!restApi) return null;
  const origin = restApi.baseUrl ?? restApi.swaggerUrl;
  return origin ? new URL(origin).origin : null;
}

/**
 * A docker-compose-deployed generic target's own `host.docker.internal:<port>`
 * baseUrl/swaggerUrl (probeTarget.ts's own proposal convention) is a snapshot
 * of whatever port Docker happened to publish it on AT PROPOSE TIME — it goes
 * silently stale the moment that port is reused by something else on a later
 * (re)deploy, since `assignPorts()` in deployTarget.ts re-picks host ports
 * fresh every deploy. Confirmed live 2026-08-18: Uptime Kuma's own cached
 * baseUrl pointed at :3001, which this project's own Grafana service (added
 * in this same Load-stage work) now permanently occupies — a load test
 * against "uptime-kuma" silently hammered Grafana's web server instead and
 * 100% 404'd, no error, just a wrong answer. Re-resolves every host.docker.
 * internal-hosted rest-api/web-ui baseUrl to the CURRENTLY live published
 * port by reading the target's own state.json (deployTarget.ts's own
 * DeployState — the same live source hub/index.html's own /api/demo/status
 * already reads for Uptime Kuma's dashboard link) — but only when there's
 * exactly one published port to disambiguate to; a multi-port target can't
 * be safely guessed at here without more bookkeeping than a descriptor
 * component currently records (which service/container-port a given baseUrl
 * actually corresponds to), so it's left as the descriptor's own cached
 * value unchanged for that case — a known, narrower limitation, not silently
 * wrong the way the single-port case was.
 */
async function refreshDockerComposeBaseUrls(descriptor: SystemDescriptor, name: string): Promise<SystemDescriptor> {
  if (!descriptor.components.some((c) => c.type === 'docker-compose')) return descriptor;
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) return descriptor;

  let state: DeployState;
  try {
    const { statePath } = resolveTargetPaths(join(hostRoot, 'targets'), name);
    state = JSON.parse(await readFile(statePath, 'utf-8')) as DeployState;
  } catch {
    return descriptor; // not deployed / no state file yet — best-effort, same as /api/demo/status's own kumaUrl handling
  }
  if (state.ports.length !== 1) return descriptor;
  const livePort = state.ports[0].publishedPort;

  function refreshUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'host.docker.internal') return url; // only this project's own docker-compose-component convention needs refreshing
      parsed.port = String(livePort);
      return parsed.toString();
    } catch {
      return url;
    }
  }

  const components = descriptor.components.map((component) => {
    switch (component.type) {
      case 'rest-api':
        return {
          ...component,
          swaggerUrl: component.swaggerUrl ? refreshUrl(component.swaggerUrl) : component.swaggerUrl,
          baseUrl: component.baseUrl ? refreshUrl(component.baseUrl) : component.baseUrl,
        };
      case 'web-ui':
        return { ...component, baseUrl: refreshUrl(component.baseUrl) };
      default:
        return component;
    }
  });
  return { ...descriptor, components };
}

/**
 * Chromium's *browser-context* networking (an in-page fetch/XHR — not
 * Node's own fetch, and not Playwright's out-of-page page.request client,
 * neither of which are affected) silently upgrades cross-origin sub-resource
 * requests to bare, dot-less hostnames like "app" to HTTPS and does not fall
 * back on failure (`net::ERR_SSL_PROTOCOL_ERROR` — this compose service only
 * speaks plain HTTP). Confirmed live via the response's own
 * `non-authoritative-reason: HSTS` header — a Chromium-internal label, this
 * compose network never sends that header itself. Confirmed the fix too:
 * the *resolved IP address* of the same service is exempt from this
 * heuristic (IPs don't look like a real, upgradeable domain to Chromium the
 * way a short hostname does), so the frontend-facing rewrite target below
 * uses the IP, not the "app" hostname `rewriteForContainerNetwork` itself
 * uses elsewhere (fine there — Postgres/rest-api/web-ui-navigation traffic
 * doesn't go through a browser's networking stack, only this one path does).
 */
async function resolveToIpOrigin(origin: string): Promise<string> {
  const url = new URL(origin);
  const { address } = await lookup(url.hostname);
  url.hostname = address;
  return url.origin;
}

/**
 * A browser page loaded via web-ui's rewritten URL (e.g. "frontend:5173")
 * still runs the *frontend app's own* client-side JS, which calls the
 * backend at whatever origin is baked into its own bundle — this project's
 * frontend hardcodes "http://localhost:3000" (frontend/src/api/client.ts),
 * correct for a real user's browser but wrong from inside this container.
 * Found live: the discovery agent burned real API iterations trying (and
 * mostly failing) to work around this itself via ad-hoc Playwright network
 * interception before a run had to be aborted. Fixed deterministically
 * instead — Chromium evaluates this script in every page before the app's
 * own scripts run (playwright-mcp's --init-script), monkey-patching
 * fetch/XHR to transparently redirect `fromOrigin` requests to `toOrigin`.
 */
function buildFrontendApiRewriteScript(fromOrigin: string, toOrigin: string): string {
  return `(() => {
  const FROM = ${JSON.stringify(fromOrigin)};
  const TO = ${JSON.stringify(toOrigin)};
  function rewrite(url) {
    return typeof url === 'string' && url.indexOf(FROM) === 0 ? TO + url.slice(FROM.length) : url;
  }
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      input = rewrite(input);
    } else if (input && typeof input === 'object' && 'url' in input) {
      const url = rewrite(input.url);
      if (url !== input.url) input = new Request(url, input);
    }
    return originalFetch.call(this, input, init);
  };
  const OriginalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return OriginalXHROpen.call(this, method, rewrite(String(url)), ...rest);
  };
})();
`;
}

app.post('/api/discovery/run', async (req, res) => {
  let initScriptPath: string | null = null;
  try {
    const { descriptor: name } = req.body as { descriptor?: string };
    if (!name) {
      res.status(400).json({ error: '"descriptor" is required' });
      return;
    }
    const path = descriptorPath(name);
    const descriptor = parseSystemDescriptor(JSON.parse(await readFile(path, 'utf-8')));

    // A descriptor that's only ever had its docker-compose component added
    // (see /api/descriptors/:name/deploy) has nothing to explore yet — the
    // human still needs to deploy, then hand-add the real components with
    // their now-live URLs. Catching this here (free) avoids a wasted paid
    // Claude call for a run that could never produce anything but an empty
    // report.
    if (descriptor.components.every((c) => c.type === 'docker-compose')) {
      res.status(400).json({
        error: 'This descriptor only describes a deployment (docker-compose component) — deploy it, then add the components you want to explore before running discovery.',
      });
      return;
    }

    // Order doesn't matter between these two — rewriteForContainerNetwork
    // only ever touches loopback (localhost) hostnames, this only ever
    // touches host.docker.internal ones, never the same URL.
    const rewritten = rewriteForContainerNetwork(await refreshDockerComposeBaseUrls(descriptor, name));

    const hasWebUi = descriptor.components.some((c) => c.type === 'web-ui');
    const fromOrigin = restApiOrigin(descriptor);
    const toOrigin = restApiOrigin(rewritten);
    if (hasWebUi && fromOrigin && toOrigin && fromOrigin !== toOrigin) {
      const toOriginForBrowser = await resolveToIpOrigin(toOrigin);
      initScriptPath = join(tmpdir(), `discovery-frontend-api-rewrite-${Date.now()}.js`);
      await writeFile(initScriptPath, buildFrontendApiRewriteScript(fromOrigin, toOriginForBrowser), 'utf-8');
    }
    const savedInitScriptPath = initScriptPath;

    // Discovery is one long tool-using agent call (browser actions, DB
    // queries, all via MCP) that can run for minutes with previously zero
    // feedback beyond a static "calling Claude" status — stream NDJSON
    // progress the same way Generate's own long-running calls do. Once the
    // first res.write() below fires, status/headers are already sent — any
    // failure past that point has to be a `{"type":"error"}` line, not a
    // status code.
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    const provider = new ClaudeProvider();
    try {
      const reportPath = await runDiscoveryForDescriptor(
        provider,
        rewritten,
        name,
        savedInitScriptPath
          ? (servers) =>
              servers.map((s) =>
                s.command.includes('playwright-mcp') ? { ...s, args: [...s.args, '--init-script', savedInitScriptPath] } : s,
              )
          : undefined,
        (message) => send({ type: 'progress', message }),
      );
      send({ type: 'done', path: reportPath });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  } finally {
    if (initScriptPath) await unlink(initScriptPath).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Visualize — turns a discovery report into diagrams a human can read before
// working with the raw report. Entity relationships are fully mechanical
// (no LLM, no approval needed — same reasoning as budget.ts's split in the
// generate pipeline: this is rendering, not a decision). The business
// workflow model is a real, costed LLM call (like Discovery/Stage 2 above),
// so it goes through the same propose -> human edits -> approve cycle.
// ---------------------------------------------------------------------------

const WORKFLOW_APPROVED_NAME_PATTERN = /^generate-workflow-approved-[A-Za-z0-9:_.-]+\.json$/;

/** Latest approved workflow model whose sourceReportPath matches this report, if any — lets the UI show a already-approved model instead of requiring a fresh (paid) generate call every time the same report is reselected. */
app.get('/api/workflow/for-report', async (req, res) => {
  try {
    const reportName = req.query.report;
    if (typeof reportName !== 'string' || !reportName) {
      res.status(400).json({ error: '"report" query param is required' });
      return;
    }
    const targetPath = reportFilePath(reportName);
    const files = await readdir(config.reportsDir).catch(() => [] as string[]);
    const candidates = files.filter((f) => WORKFLOW_APPROVED_NAME_PATTERN.test(f)).sort();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidatePath = join(config.reportsDir, candidates[i]);
      const raw = JSON.parse(await readFile(candidatePath, 'utf-8'));
      if (raw.sourceReportPath !== targetPath) continue;
      const approved = ApprovedWorkflowSchema.parse(raw);
      res.json({ path: candidatePath, approved, rendered: approved.entities.map(renderStateDiagram) });
      return;
    }
    res.json(null);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/render-er', async (req, res) => {
  try {
    const { report: reportName } = req.body as { report?: string };
    if (!reportName) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const report = parseDiscoveryReport(JSON.parse(await readFile(reportFilePath(reportName), 'utf-8')));
    res.json({ mermaid: renderErDiagram(report) });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/propose', async (req, res) => {
  try {
    const { report: reportName } = req.body as { report?: string };
    if (!reportName) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const path = reportFilePath(reportName);
    const report = parseDiscoveryReport(JSON.parse(await readFile(path, 'utf-8')));
    const provider = new ClaudeProvider();
    const proposed = await proposeWorkflow(provider, report, path, descriptorFromReportName(reportName) ?? undefined);
    res.json(proposed);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Model response failed validation', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/approve', async (req, res) => {
  try {
    const proposed = ProposedWorkflowSchema.parse(req.body);
    const approved = ApprovedWorkflowSchema.parse({ ...proposed, approvedAt: new Date().toISOString() });
    await mkdir(config.reportsDir, { recursive: true });
    const timestamp = approved.approvedAt.replace(/[:.]/g, '-');
    const outPath = join(config.reportsDir, `generate-workflow-approved-${timestamp}.json`);
    await writeFile(outPath, JSON.stringify(approved, null, 2), 'utf-8');
    const rendered = approved.entities.map(renderStateDiagram);
    res.status(201).json({ path: outPath, approved, rendered });
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/render-architecture', async (req, res) => {
  try {
    const { report: reportName } = req.body as { report?: string };
    if (!reportName) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const report = parseDiscoveryReport(JSON.parse(await readFile(reportFilePath(reportName), 'utf-8')));
    res.json({ mermaid: renderArchitectureDiagram(report) });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/render-api-inventory', async (req, res) => {
  try {
    const { report: reportName } = req.body as { report?: string };
    if (!reportName) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const report = parseDiscoveryReport(JSON.parse(await readFile(reportFilePath(reportName), 'utf-8')));
    res.json({ mermaid: renderApiInventoryDiagram(report) });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

const UI_FLOW_APPROVED_NAME_PATTERN = /^generate-ui-flow-approved-[A-Za-z0-9:_.-]+\.json$/;

/** Same reuse-existing-approved-model idea as /api/workflow/for-report, for UI flow models instead. */
app.get('/api/workflow/ui-flow-for-report', async (req, res) => {
  try {
    const reportName = req.query.report;
    if (typeof reportName !== 'string' || !reportName) {
      res.status(400).json({ error: '"report" query param is required' });
      return;
    }
    const targetPath = reportFilePath(reportName);
    const files = await readdir(config.reportsDir).catch(() => [] as string[]);
    const candidates = files.filter((f) => UI_FLOW_APPROVED_NAME_PATTERN.test(f)).sort();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidatePath = join(config.reportsDir, candidates[i]);
      const raw = JSON.parse(await readFile(candidatePath, 'utf-8'));
      if (raw.sourceReportPath !== targetPath) continue;
      const approved = ApprovedUiFlowSchema.parse(raw);
      res.json({ path: candidatePath, approved, rendered: renderUiFlowDiagram(approved) });
      return;
    }
    res.json(null);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/propose-ui-flow', async (req, res) => {
  try {
    const { report: reportName } = req.body as { report?: string };
    if (!reportName) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const path = reportFilePath(reportName);
    const report = parseDiscoveryReport(JSON.parse(await readFile(path, 'utf-8')));
    const provider = new ClaudeProvider();
    const proposed = await proposeUiFlow(provider, report, path, descriptorFromReportName(reportName) ?? undefined);
    res.json(proposed);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Model response failed validation', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/approve-ui-flow', async (req, res) => {
  try {
    const proposed = ProposedUiFlowSchema.parse(req.body);
    const approved = ApprovedUiFlowSchema.parse({ ...proposed, approvedAt: new Date().toISOString() });
    await mkdir(config.reportsDir, { recursive: true });
    const timestamp = approved.approvedAt.replace(/[:.]/g, '-');
    const outPath = join(config.reportsDir, `generate-ui-flow-approved-${timestamp}.json`);
    await writeFile(outPath, JSON.stringify(approved, null, 2), 'utf-8');
    res.status(201).json({ path: outPath, approved, rendered: renderUiFlowDiagram(approved) });
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

const SEQUENCE_APPROVED_NAME_PATTERN = /^generate-sequence-approved-[A-Za-z0-9:_.-]+\.json$/;

/** Same reuse-existing-approved-model idea as /api/workflow/for-report, for sequence flow models instead. */
app.get('/api/workflow/sequence-for-report', async (req, res) => {
  try {
    const reportName = req.query.report;
    if (typeof reportName !== 'string' || !reportName) {
      res.status(400).json({ error: '"report" query param is required' });
      return;
    }
    const targetPath = reportFilePath(reportName);
    const files = await readdir(config.reportsDir).catch(() => [] as string[]);
    const candidates = files.filter((f) => SEQUENCE_APPROVED_NAME_PATTERN.test(f)).sort();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidatePath = join(config.reportsDir, candidates[i]);
      const raw = JSON.parse(await readFile(candidatePath, 'utf-8'));
      if (raw.sourceReportPath !== targetPath) continue;
      const approved = ApprovedSequenceFlowSchema.parse(raw);
      res.json({ path: candidatePath, approved, rendered: approved.scenarios.map(renderSequenceDiagram) });
      return;
    }
    res.json(null);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/propose-sequence', async (req, res) => {
  try {
    const { report: reportName } = req.body as { report?: string };
    if (!reportName) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const path = reportFilePath(reportName);
    const report = parseDiscoveryReport(JSON.parse(await readFile(path, 'utf-8')));
    const provider = new ClaudeProvider();
    const proposed = await proposeSequenceFlow(provider, report, path, descriptorFromReportName(reportName) ?? undefined);
    res.json(proposed);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Model response failed validation', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/workflow/approve-sequence', async (req, res) => {
  try {
    const proposed = ProposedSequenceFlowSchema.parse(req.body);
    const approved = ApprovedSequenceFlowSchema.parse({ ...proposed, approvedAt: new Date().toISOString() });
    await mkdir(config.reportsDir, { recursive: true });
    const timestamp = approved.approvedAt.replace(/[:.]/g, '-');
    const outPath = join(config.reportsDir, `generate-sequence-approved-${timestamp}.json`);
    await writeFile(outPath, JSON.stringify(approved, null, 2), 'utf-8');
    res.status(201).json({ path: outPath, approved, rendered: approved.scenarios.map(renderSequenceDiagram) });
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Generate pipeline — Stage 1 (grouping) review, and per-descriptor
// corrections. Stage 2 (spec) and Stage 3 (render) routes land in later
// milestones.
// ---------------------------------------------------------------------------

app.get('/api/generate/reports', async (_req, res) => {
  const files = await readdir(config.reportsDir).catch(() => [] as string[]);
  const candidates = files.filter((f) => REPORT_NAME_PATTERN.test(f)).sort();

  // Only list reports that will actually work if picked — e.g. a discovery
  // run that hit max iterations without ever producing a final JSON answer
  // writes its raw (non-JSON) text as the "report". Surfacing a cryptic
  // parse error only after the user has already picked one and clicked
  // "Generate grouping" is worse than just not offering it in the first place.
  const valid: string[] = [];
  for (const name of candidates) {
    try {
      const raw = JSON.parse(await readFile(join(config.reportsDir, name), 'utf-8'));
      parseDiscoveryReport(raw);
      valid.push(name);
    } catch {
      // Not a usable report — omit it rather than let it fail later.
    }
  }
  res.json(valid);
});

/** Latest approved grouping whose sourceReportPath matches this report, if any — same reuse-existing-approval idea as /api/workflow/for-report, so re-selecting a report doesn't force a fresh (re-)grouping to see what was already approved for it. */
app.get('/api/generate/grouping-for-report', async (req, res) => {
  try {
    const reportName = req.query.report;
    if (typeof reportName !== 'string' || !reportName) {
      res.status(400).json({ error: '"report" query param is required' });
      return;
    }
    const targetPath = reportFilePath(reportName);
    const files = await readdir(config.reportsDir).catch(() => [] as string[]);
    const candidates = files.filter((f) => GROUPING_NAME_PATTERN.test(f)).sort();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidatePath = join(config.reportsDir, candidates[i]);
      const raw = JSON.parse(await readFile(candidatePath, 'utf-8'));
      if (raw.sourceReportPath !== targetPath) continue;
      const approved = ApprovedGroupingSchema.parse(raw);
      res.json({ path: candidatePath, approved });
      return;
    }
    res.json(null);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate/group', async (req, res) => {
  try {
    const { report, threshold } = req.body as { report?: string; threshold?: number };
    if (!report) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const path = reportFilePath(report);
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    const discoveryReport = parseDiscoveryReport(raw);
    const proposed = proposeGrouping(discoveryReport, path, {
      ungroupedFallbackRatio: typeof threshold === 'number' ? threshold : undefined,
    });
    res.json(proposed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No report named "${(req.body as { report?: string }).report}"` });
      return;
    }
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Report failed validation', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate/group/approve', async (req, res) => {
  try {
    const proposed = ProposedGroupingSchema.parse(req.body);
    const approved = ApprovedGroupingSchema.parse({ ...proposed, approvedAt: new Date().toISOString() });
    await mkdir(config.reportsDir, { recursive: true });
    const timestamp = approved.approvedAt.replace(/[:.]/g, '-');
    // Suffix with the descriptor when the source report carries one (see
    // descriptorFromReportName) so Stage 2's "Approved grouping" dropdown can
    // filter to the current descriptor by filename alone, without opening
    // every grouping file. Groupings from reports that predate the naming
    // convention just don't get a suffix — same graceful-degrade as
    // everywhere else this convention is used.
    const sourceReportName = approved.sourceReportPath.split('/').pop() ?? '';
    const descriptorSuffix = descriptorFromReportName(sourceReportName);
    const outName = `generate-grouping-approved-${timestamp}${descriptorSuffix ? `-${descriptorSuffix}` : ''}.json`;
    const outPath = join(config.reportsDir, outName);
    await writeFile(outPath, JSON.stringify(approved, null, 2), 'utf-8');
    res.status(201).json({ path: outPath, approved });
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.get('/api/generate/corrections/:descriptorName', async (req, res) => {
  try {
    res.json(await loadCorrections(descriptorPath(req.params.descriptorName)));
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.put('/api/generate/corrections/:descriptorName', async (req, res) => {
  try {
    const path = descriptorPath(req.params.descriptorName);
    const parsed = CorrectionsSchema.parse(req.body);
    await saveCorrections(path, parsed);
    res.json(parsed);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// UAT / acceptance-test notes — free text mixed into Stage 2's own prompt
// (see uat.ts, spec.ts's buildUatBlock). GET/PUT mirror the corrections pair
// above exactly. The two extract-* routes are deliberately "propose, don't
// persist" — same pattern as Stage 1 grouping/Stage 2 spec/E2E fixes: they
// only ever return extracted text for the browser to show in a textarea for
// review, never call saveUatContext themselves. A human still has to click
// "Save UAT notes" (the PUT route) to actually persist anything, so a bad
// extraction (garbled PDF text, wrong sheet) is never silently written.
// ---------------------------------------------------------------------------

app.get('/api/generate/uat/:descriptorName', async (req, res) => {
  try {
    res.json({ text: await loadUatContext(descriptorPath(req.params.descriptorName)) });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.put('/api/generate/uat/:descriptorName', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: '"text" is required' });
      return;
    }
    await saveUatContext(descriptorPath(req.params.descriptorName), text);
    res.json({ text });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Test-run environment overrides — plain dotenv text (see testEnv.ts's own
// comment for why). GET/PUT mirror the UAT pair above exactly.
// ---------------------------------------------------------------------------

app.get('/api/generate/env/:descriptorName', async (req, res) => {
  try {
    res.json({ text: await loadTestEnvText(descriptorPath(req.params.descriptorName)) });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.put('/api/generate/env/:descriptorName', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: '"text" is required' });
      return;
    }
    await saveTestEnvText(descriptorPath(req.params.descriptorName), text);
    res.json({ text });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// Memory storage (not disk) — the extracted text is all that ever needs to
// survive past this one request; nothing here writes the uploaded file
// itself anywhere. Capped at 10 files per request — plenty for a UAT
// upload, cheap to raise later if that's ever actually too tight.
const uatUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/generate/uat/extract-file', uatUpload.array('files', 10), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: '"files" is required' });
      return;
    }
    // All-or-nothing: one bad file (wrong extension, corrupt PDF) fails the
    // whole batch with a clear "which one" error, rather than silently
    // dropping it and returning a partial result the human might not
    // notice is incomplete.
    const extracted: string[] = [];
    for (const file of files) {
      try {
        extracted.push(await extractTextFromFile(file.buffer, file.originalname));
      } catch (err) {
        throw Object.assign(new Error(`"${file.originalname}": ${(err as Error).message}`), {
          status: (err as { status?: number }).status ?? 500,
        });
      }
    }
    // Every file gets its own "## File: <name>" heading, even a lone one —
    // not just when there's more than one (revised from this route's first
    // version): the client now APPENDS each extraction onto whatever's
    // already in the UAT textarea rather than replacing it (see
    // generate.html), specifically so multiple file batches and multiple
    // Google links can all accumulate into one combined document. Without
    // a heading on every piece, a human editing that combined text has no
    // way to tell where one source's content ends and the next begins.
    const text = files.map((f, i) => `## File: ${f.originalname}\n${extracted[i]}`).join('\n\n');
    res.json({ text });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate/uat/extract-url', async (req, res) => {
  try {
    const { url } = req.body as { url?: string };
    if (!url) {
      res.status(400).json({ error: '"url" is required' });
      return;
    }
    const text = await extractTextFromGoogleUrl(url);
    res.json({ text });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Generate pipeline — Stage 2 (spec) proposal/approval. Makes a real LLM call
// (ClaudeProvider), unlike every other route on this server.
// ---------------------------------------------------------------------------

app.get('/api/generate/groupings', async (req, res) => {
  const files = await readdir(config.reportsDir).catch(() => [] as string[]);
  const names = files.filter((f) => GROUPING_NAME_PATTERN.test(f)).sort();
  const descriptor = req.query.descriptor;
  // Optional filter — omit entirely for the unfiltered list (e.g. before
  // Stage 1 has picked a report and a "current descriptor" even exists).
  if (typeof descriptor !== 'string' || !descriptor) {
    res.json(names);
    return;
  }
  const matches: string[] = [];
  for (const name of names) {
    if ((await descriptorForGroupingFile(name)) === descriptor) matches.push(name);
  }
  res.json(matches);
});

/** A single approved grouping's own content, by exact filename — lets the UI read back e.g. sourceReportPath (to derive Stage 2's Descriptor field) without duplicating that derivation server-side per caller. */
app.get('/api/generate/groupings/:name', async (req, res) => {
  try {
    const approved = ApprovedGroupingSchema.parse(JSON.parse(await readFile(groupingFilePath(req.params.name), 'utf-8')));
    res.json(approved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No grouping named "${req.params.name}"` });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

const SPEC_APPROVED_NAME_PATTERN = /^generate-spec-approved-[A-Za-z0-9:_.-]+\.json$/;
function specFilePath(name: string): string {
  if (!SPEC_APPROVED_NAME_PATTERN.test(name)) {
    throw Object.assign(new Error('Spec name must be an exact "generate-spec-approved-*.json" filename'), { status: 400 });
  }
  return join(config.reportsDir, name);
}

/**
 * Merged view of every approved spec whose sourceGroupingPath matches this
 * grouping, newest-per-group-key wins — not just the single latest file. A
 * grouping this large is normally approved across several separate rounds
 * (see /api/generate/specs's own comment, same reasoning), each covering
 * only a subset of groups; returning just the latest FILE meant Generate's
 * "Show last approved generation" and Corrections' relevance-highlighting
 * (both consumers of this route) only ever saw whichever round happened
 * most recently, silently missing every group approved in an earlier round.
 * `path` becomes a comma-joined list of every file that actually
 * contributed at least one group to the merge, so the "Loaded approved
 * generation from …" status stays honest about it being a merge.
 */
app.get('/api/generate/spec-for-grouping', async (req, res) => {
  try {
    const groupingName = req.query.grouping;
    if (typeof groupingName !== 'string' || !groupingName) {
      res.status(400).json({ error: '"grouping" query param is required' });
      return;
    }
    const targetPath = groupingFilePath(groupingName);
    const files = await readdir(config.reportsDir).catch(() => [] as string[]);
    const candidates = files.filter((f) => SPEC_APPROVED_NAME_PATTERN.test(f)).sort().reverse(); // newest first

    const groupsByKey = new Map<string, ReturnType<typeof ApprovedGenerationSchema.parse>['groups'][number]>();
    const contributingPaths: string[] = [];
    let newest: ReturnType<typeof ApprovedGenerationSchema.parse> | null = null;

    for (const name of candidates) {
      const candidatePath = join(config.reportsDir, name);
      const raw = JSON.parse(await readFile(candidatePath, 'utf-8'));
      if (raw.sourceGroupingPath !== targetPath) continue;
      const approved = ApprovedGenerationSchema.parse(raw);
      if (!newest) newest = approved; // first match in newest-first order

      let contributedSomething = false;
      for (const group of approved.groups) {
        if (!groupsByKey.has(group.key)) {
          groupsByKey.set(group.key, group);
          contributedSomething = true;
        }
      }
      if (contributedSomething) contributingPaths.push(candidatePath);
    }

    if (!newest) {
      res.json(null);
      return;
    }

    const merged = ApprovedGenerationSchema.parse({
      generatedAt: newest.generatedAt,
      sourceGroupingPath: targetPath,
      approvedAt: newest.approvedAt,
      groups: [...groupsByKey.values()],
    });
    res.json({ path: contributingPaths.join(', '), approved: merged });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

/**
 * EVERY approved spec for this grouping, newest first — not just the latest
 * one /api/generate/spec-for-grouping returns. A grouping this large usually
 * gets approved across several separate Generate+Approve rounds (one
 * "Limit to groups" batch at a time, e.g. retrying just the groups that
 * failed last time), each producing its OWN generate-spec-approved-*.json
 * covering only that round's groups — Render & Run needs to render each of
 * those in turn to get the complete suite on disk, not just whichever round
 * happened most recently.
 */
app.get('/api/generate/specs', async (req, res) => {
  try {
    const groupingName = req.query.grouping;
    if (typeof groupingName !== 'string' || !groupingName) {
      res.status(400).json({ error: '"grouping" query param is required' });
      return;
    }
    const targetPath = groupingFilePath(groupingName);
    const files = await readdir(config.reportsDir).catch(() => [] as string[]);
    const candidates = files.filter((f) => SPEC_APPROVED_NAME_PATTERN.test(f)).sort().reverse();
    const results: { name: string; approvedAt: string; groups: string[] }[] = [];
    for (const name of candidates) {
      const raw = JSON.parse(await readFile(join(config.reportsDir, name), 'utf-8'));
      if (raw.sourceGroupingPath !== targetPath) continue;
      const approved = ApprovedGenerationSchema.parse(raw);
      results.push({ name, approvedAt: approved.approvedAt, groups: approved.groups.map((g) => g.key) });
    }
    res.json(results);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// APP_ROOT/TESTS_ROOT — needed by both /api/generate/spec below (to seed the
// step-pattern-collision registry from whatever's already in tests/steps/)
// and Stage 3's render/"Run tests" endpoints further down, as well as the
// E2E routes further down still. Deliberately NOT using
// bootstrap/generateRender.ts's own derivation (resolve(config.reportsDir,
// '..', '..')), correct for the *host* layout (<repo>/agent-service/reports
// -> two levels up is <repo>) — this container has no such nesting,
// reportsDir sits directly at /usr/src/app/reports, so going up two levels
// lands outside the container entirely (/usr/src). Same reasoning is why
// agent-service/src/agents/e2e/index.ts's own module-level TESTS_ROOT
// (correct for the CLI's host layout) can't be reused here either — the E2E
// routes below pass this TESTS_ROOT explicitly into runOneScenario/
// loadApplyPreview/performApply instead of relying on that module constant.
// ---------------------------------------------------------------------------

const APP_ROOT = resolve(config.reportsDir, '..');
const TESTS_ROOT = join(APP_ROOT, 'tests');
const TESTS_STEPS_DIR = join(APP_ROOT, 'tests', 'steps');
const TESTS_FEATURES_DIR = join(APP_ROOT, 'tests', 'features');
// Sibling of reports/ on disk (the user's own call, not nested under it —
// see docker-compose.yml's own comment on this same directory's bind mount
// for why that needs its own mount entry).
const APP_ARCHIVE_DIR = join(APP_ROOT, 'archive');

/**
 * tests/.env (and the currently-committed steps.ts files' own hardcoded
 * fallback) is written for a host run (localhost:3000/5173/5432/9094) — the
 * processes this server spawns run inside the workbench container instead,
 * so they need this compose network's own service names. Values match
 * app/db/kafka's own docker-compose.yml definitions exactly (db's
 * user/pass/db name, kafka's internal PLAINTEXT listener). Shared by
 * /api/tests/run and every /api/e2e/* route that spawns bddgen/playwright —
 * confirmed live (see /api/tests/run's original comment) that every
 * scenario fails with ECONNREFUSED ::1:3000 without this override.
 *
 * This base is specific to THIS project's own orderflow compose network —
 * wrong for any externally deployed target (a docker-compose component only
 * reachable via host.docker.internal:<port>, e.g. Uptime Kuma). Overlaying a
 * descriptor's own testEnv.ts overrides (see buildTestRunEnv below) is what
 * makes an external target's own FRONTEND_URL/credentials actually take
 * effect instead of silently falling back to these orderflow defaults —
 * live-verified: without it, every scenario against Uptime Kuma failed with
 * ERR_CONNECTION_REFUSED at http://frontend:5173.
 *
 * These 4 keys deliberately do NOT come from process.env.BACKEND_URL etc.
 * directly — agent-service/.env already defines those same names for a
 * completely different purpose (host-mode `pnpm test`/`pnpm e2e`, run
 * outside Docker, where localhost really is correct), and env_file already
 * loads that .env into this container's own process.env before this file
 * ever runs. Reusing the same keys here would silently break the
 * ECONNREFUSED fix above the moment .env's host-mode values changed. A
 * separate CONTAINER_* namespace lets .env be the one real place to edit
 * these (rather than a code literal) without colliding with the host-mode
 * values living right next to them in the same file.
 */
// Split out from BASE_TEST_RUN_ENV below so the snapshot route can build a
// small, secret-free "what was actually used" file (resolveTestEnvForSnapshot)
// without ever touching the full ...process.env spread — that spread carries
// ANTHROPIC_API_KEY/OPENAI_API_KEY, which must never land in archive/.
const CONTAINER_ENV_DEFAULTS: Record<string, string> = {
  BACKEND_URL: process.env.CONTAINER_BACKEND_URL ?? 'http://app:3000',
  FRONTEND_URL: process.env.CONTAINER_FRONTEND_URL ?? 'http://frontend:5173',
  DATABASE_URL: process.env.CONTAINER_DATABASE_URL ?? 'postgres://user:pass@db:5432/testdb',
  KAFKA_BROKERS: process.env.CONTAINER_KAFKA_BROKERS ?? 'kafka:9092',
};

const BASE_TEST_RUN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...CONTAINER_ENV_DEFAULTS,
};

/**
 * descriptor omitted (or no .env sidecar on disk yet) -> exactly
 * BASE_TEST_RUN_ENV, unchanged from before this function existed — every
 * existing orderflow/kafka-demo caller keeps working with zero behavior
 * change. A descriptor with its own descriptors/<name>.env overlays those
 * keys on top (loadTestEnvOverrides() itself already returns {} on a
 * missing file, so a target with no overrides yet is the same no-op path).
 */
// A descriptor's own .env sidecar (e.g. uptime-kuma.env's SQLITE_DB_PATH) is
// checked into git and shared across every machine/CI runner that clones
// this repo — see expandHostProjectRoot.ts for why a value that points
// under this deployment's own targets/ mount must carry the
// `${HOST_PROJECT_ROOT}` placeholder rather than one machine's hardcoded
// absolute prefix, and why it's expanded here rather than relying on
// dotenv's own (nonexistent) automatic expansion.
function expandOverrides(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, expandHostProjectRoot(v)]));
}

async function buildTestRunEnv(descriptor?: string): Promise<NodeJS.ProcessEnv> {
  if (!descriptor) return BASE_TEST_RUN_ENV;
  const overrides = await loadTestEnvOverrides(descriptorPath(descriptor));
  return { ...BASE_TEST_RUN_ENV, ...expandOverrides(overrides) };
}

/**
 * The snapshot's own "what env was really used" file — deliberately NOT a
 * copy of the raw descriptors/<name>.env sidecar (that file doesn't exist
 * at all for orderflow/kafka-demo, which rely purely on CONTAINER_ENV_DEFAULTS
 * with no sidecar of their own), and deliberately NOT the full resolved
 * process.env (that would leak ANTHROPIC_API_KEY/OPENAI_API_KEY straight
 * into archive/, which is only .gitignored — not actually safe to treat as
 * secret-free). Just the same two layers buildTestRunEnv() itself applies —
 * base container defaults, then a descriptor's own overrides on top —
 * flattened to plain KEY=VALUE text. A target with neither still gets a
 * real, honest file (the base defaults), not an absent one.
 */
async function resolveTestEnvForSnapshot(descriptor: string): Promise<string> {
  const overrides = await loadTestEnvOverrides(descriptorPath(descriptor));
  const resolved: Record<string, string> = { ...CONTAINER_ENV_DEFAULTS, ...expandOverrides(overrides) };
  return Object.entries(resolved).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

app.post('/api/generate/spec', async (req, res) => {
  try {
    const { grouping, descriptor, maxScenarios, groups } = req.body as {
      grouping?: string;
      descriptor?: string;
      maxScenarios?: number;
      groups?: string[];
    };
    if (!grouping) {
      res.status(400).json({ error: '"grouping" is required' });
      return;
    }
    const groupingPath = groupingFilePath(grouping);
    const approvedGrouping = ApprovedGroupingSchema.parse(JSON.parse(await readFile(groupingPath, 'utf-8')));

    const reportRaw = JSON.parse(await readFile(approvedGrouping.sourceReportPath, 'utf-8'));
    parseDiscoveryReport(reportRaw); // validate shape before spending money on a Claude call
    const reportJson = JSON.stringify(reportRaw, null, 2);
    const corrections = descriptor ? await loadCorrections(descriptorPath(descriptor)) : {};
    const uatContext = descriptor ? await loadUatContext(descriptorPath(descriptor)) : '';

    // Filter by Stage 1 group keys (e.g. "orders") *before* budget-splitting,
    // not after — filtering the post-split render groups would require the
    // human to already know internal "orders-1"/"orders-2" chunk keys, which
    // are purely an artifact of how big a group happens to be relative to
    // "Scenarios per Claude call", not something this field should expose.
    // Typing "orders" here means the whole group, batched however many
    // Claude calls it actually needs.
    let filteredGrouping = approvedGrouping;
    if (groups?.length) {
      filteredGrouping = {
        ...approvedGrouping,
        groups: approvedGrouping.groups.filter((g) => groups.includes(g.key)),
        ungrouped: groups.includes('ungrouped') ? approvedGrouping.ungrouped : [],
      };
    }
    const renderGroups = splitByBudget(filteredGrouping, typeof maxScenarios === 'number' ? maxScenarios : undefined);
    if (renderGroups.length === 0) {
      res.status(400).json({ error: '"groups" matched no groups for this grouping' });
      return;
    }

    // Real Claude calls here run sequentially and can easily take several
    // minutes for a large grouping (one call per render-group, ~15-40s
    // each) with nothing but a static "Calling Claude…" status otherwise —
    // stream NDJSON progress lines instead of a single buffered JSON
    // response, so the browser can show what's actually happening. Once the
    // first res.write() below fires, the HTTP status/headers are already
    // sent — any failure past that point has to be reported as a
    // `{"type":"error"}` line, not a status code, since it's too late to
    // change either.
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    const rawProvider = new ClaudeProvider();
    const provider: AgentProvider = {
      run: async (opts) => {
        // Injects the descriptor here, once, rather than threading it through
        // spec.ts's own generateGeneration/generateGenerationForGroup param
        // lists — this wrapper already sees every provider.run() call this
        // route makes, and every call already has this route's own
        // `descriptor` request-body field in scope.
        opts = { ...opts, descriptor: opts.descriptor ?? descriptor };
        const t0 = Date.now();
        send({ type: 'progress', message: `Calling Claude for "${opts.operation}"…` });
        try {
          const result = await rawProvider.run(opts);
          send({ type: 'progress', message: `"${opts.operation}" responded (${((Date.now() - t0) / 1000).toFixed(1)}s)` });
          return result;
        } catch (err) {
          send({ type: 'progress', message: `"${opts.operation}" errored after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${(err as Error).message}` });
          throw err;
        }
      },
    };

    try {
      const { generation, failures } = await generateGeneration(
        provider,
        renderGroups,
        reportJson,
        corrections,
        groupingPath,
        TESTS_STEPS_DIR,
        config.reportsDir,
        uatContext,
        (message) => send({ type: 'progress', message }),
      );
      send({ type: 'done', generation, failures });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate/spec/approve', async (req, res) => {
  try {
    const proposed = ProposedGenerationSchema.parse(req.body);

    // The admin UI lets a human hand-edit featureContent/stepsContent before
    // approving — an edit could reintroduce a step-text/pattern mismatch the
    // generation-time check wouldn't have seen. Re-verify every group here
    // too, before persisting, not just at generation time.
    const excludeSourceKeys = [...new Set(proposed.groups.map((g) => g.sourceKey))];
    const patternRegistry = await collectExistingStepPatterns(TESTS_STEPS_DIR, excludeSourceKeys);
    // Same gap as generateGeneration's own collectApprovedSpecPatterns call
    // (spec.ts) — a sibling group for this SAME grouping may already be
    // approved from an earlier, separate round and not written to disk yet,
    // so the on-disk scan above can't see it. Without this, approving group
    // B here can't catch that it collides with already-approved group A
    // until "Write files" -> bddgen, well after both look approved.
    for (const [pattern, owner] of await collectApprovedSpecPatterns(config.reportsDir, proposed.sourceGroupingPath, excludeSourceKeys)) {
      if (!patternRegistry.has(pattern)) patternRegistry.set(pattern, owner);
    }
    for (const group of proposed.groups) {
      const ownPatterns = compileAndVerify(group, patternRegistry);
      for (const [pattern, owner] of ownPatterns) patternRegistry.set(pattern, owner);
    }

    const approved = ApprovedGenerationSchema.parse({ ...proposed, approvedAt: new Date().toISOString() });
    await mkdir(config.reportsDir, { recursive: true });
    const timestamp = approved.approvedAt.replace(/[:.]/g, '-');
    const outPath = join(config.reportsDir, `generate-spec-approved-${timestamp}.json`);
    await writeFile(outPath, JSON.stringify(approved, null, 2), 'utf-8');
    res.status(201).json({ path: outPath, approved });
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Generate pipeline — Stage 3 (render) and "Run tests". Both mechanical, no
// LLM.
// ---------------------------------------------------------------------------

app.post('/api/generate/render', async (req, res) => {
  try {
    const { spec: specName } = req.body as { spec?: string };
    if (!specName) {
      res.status(400).json({ error: '"spec" is required' });
      return;
    }
    const generation = ApprovedGenerationSchema.parse(JSON.parse(await readFile(specFilePath(specName), 'utf-8')));
    const files = renderGeneration(generation);
    const written = await writeRenderedFiles(files, APP_ROOT);
    // Records which descriptor the suite now sitting in tests/ actually
    // belongs to — same descriptorForGroupingFile lookup
    // resolveSnapshotContext (below) already uses, not new resolution
    // logic. CI reads this file to know which target to deploy and test
    // against, so a future suite swap (rendering a different descriptor's
    // spec here) keeps CI correctly pointed without a separate manual edit
    // anywhere. Best-effort: a descriptor that can't be resolved shouldn't
    // block the render itself from succeeding.
    const groupingName = generation.sourceGroupingPath.split('/').pop()!;
    const descriptor = await descriptorForGroupingFile(groupingName);
    if (descriptor) {
      await writeFile(join(TESTS_ROOT, '.current-descriptor'), descriptor + '\n', 'utf-8').catch(() => {});
    }
    res.json({ written });
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Spec failed validation', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Test-suite snapshot — the user's own idea. "Write files" above silently
// overwrites tests/features/tests/steps with zero history; corrections/UAT
// have the exact same problem elsewhere in this app (see
// project_test_suite_snapshot_idea in memory). Two routes, not one:
// /preview computes the exact descriptor+timestamp+path WITHOUT touching
// disk at all, so a confirm dialog can show the human the real destination
// before they commit to anything; the plain route does the actual copy,
// reusing the SAME timestamp the client already saw (only the timestamp —
// descriptor is re-derived independently both times, deterministically,
// rather than trusted from the client) so the two calls can never disagree
// about where a snapshot actually lands.
// ---------------------------------------------------------------------------

/** Same "newest file whose sourceReportPath matches" scan as /api/workflow/for-report
 *  and its ui-flow/sequence-flow siblings above, factored out so the snapshot route
 *  below can reuse it for all three approved-artifact kinds without repeating the loop. */
async function findLatestApprovedArtifactPath(namePattern: RegExp, targetReportPath: string): Promise<string | null> {
  const files = await readdir(config.reportsDir).catch(() => [] as string[]);
  const candidates = files.filter((f) => namePattern.test(f)).sort();
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidatePath = join(config.reportsDir, candidates[i]);
    const raw = JSON.parse(await readFile(candidatePath, 'utf-8'));
    if (raw.sourceReportPath === targetReportPath) return candidatePath;
  }
  return null;
}

async function resolveSnapshotContext(specName: string): Promise<{ descriptor: string; groupingPath: string; reportPath: string }> {
  const generation = ApprovedGenerationSchema.parse(JSON.parse(await readFile(specFilePath(specName), 'utf-8')));
  const groupingName = generation.sourceGroupingPath.split('/').pop()!;
  const descriptor = (await descriptorForGroupingFile(groupingName)) ?? 'unknown';
  const groupingPath = groupingFilePath(groupingName);
  const grouping = ApprovedGroupingSchema.parse(JSON.parse(await readFile(groupingPath, 'utf-8')));
  return { descriptor, groupingPath, reportPath: grouping.sourceReportPath };
}

/**
 * Which approved spec(s) actually produced whatever's CURRENTLY in
 * tests/features and tests/steps — for the Snapshots tab's own
 * "Save snapshot now" control. Deliberately scoped by
 * tests/.current-descriptor (the one honest record of what's really on
 * disk right now — see /api/demo/status's own comment on the same file),
 * NOT by whatever grouping happens to be selected in Stage 1's UI at the
 * moment: those are two independent pieces of state, and a snapshot built
 * from the Stage-1 selection's spec while it disagreed with the real
 * on-disk descriptor would bundle the CURRENT suite together with a
 * different target's descriptor/report/grouping — wrong metadata, not
 * just a confusing picker. Same one-pass-over-every-spec-file approach as
 * /api/generate/specs above, just filtered by descriptor instead of by one
 * exact grouping (a descriptor can have several groupings over time, and
 * each grouping can have several approved-spec rounds — see this route's
 * own "specs" array, sorted newest-first, for the human to see all of it).
 */
app.get('/api/generate/specs-for-current-suite', async (req, res) => {
  try {
    let descriptor: string | null = null;
    try {
      descriptor = (await readFile(join(TESTS_ROOT, '.current-descriptor'), 'utf-8')).trim() || null;
    } catch {
      descriptor = null;
    }
    if (!descriptor) {
      res.json({ descriptor: null, specs: [] });
      return;
    }
    const files = await readdir(config.reportsDir).catch(() => [] as string[]);
    const candidates = files.filter((f) => SPEC_APPROVED_NAME_PATTERN.test(f));
    const results: { name: string; approvedAt: string; groups: string[] }[] = [];
    for (const name of candidates) {
      const raw = JSON.parse(await readFile(join(config.reportsDir, name), 'utf-8'));
      const groupingName = typeof raw.sourceGroupingPath === 'string' ? raw.sourceGroupingPath.split('/').pop() : undefined;
      if (!groupingName || (await descriptorForGroupingFile(groupingName)) !== descriptor) continue;
      // A handful of real, pre-existing files on disk predate the current
      // `groups` shape (an older `scenarios` shape from before Generate's
      // per-group batching existed) and fail this parse — genuinely not
      // usable here regardless (the snapshot-creation route itself parses
      // a chosen spec the same way, so picking one of these would already
      // fail at snapshot time too), so skipped rather than failing this
      // whole route over files that were never valid candidates to begin
      // with. /api/generate/specs above has the same latent parse risk,
      // just scoped to one grouping at a time so it rarely actually hits
      // one of these; this route scans every grouping for a descriptor at
      // once, so it hits them far more often — worth someone's own look at
      // some point, not fixed here since it's a pre-existing, unrelated
      // latent issue in the older route too.
      let approved;
      try {
        approved = ApprovedGenerationSchema.parse(raw);
      } catch {
        continue;
      }
      results.push({ name, approvedAt: approved.approvedAt, groups: approved.groups.map((g) => g.key) });
    }
    results.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt)); // newest first
    res.json({ descriptor, specs: results });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate/snapshot/preview', async (req, res) => {
  try {
    const { spec: specName } = req.body as { spec?: string };
    if (!specName) {
      res.status(400).json({ error: '"spec" is required' });
      return;
    }
    const { descriptor } = await resolveSnapshotContext(specName);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.json({ descriptor, timestamp, path: `archive/bdd-test-suite-${descriptor}-${timestamp}` });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate/snapshot', async (req, res) => {
  try {
    const { spec: specName, timestamp } = req.body as { spec?: string; timestamp?: string };
    if (!specName || !timestamp) {
      res.status(400).json({ error: '"spec" and "timestamp" are required' });
      return;
    }
    const { descriptor, groupingPath, reportPath } = await resolveSnapshotContext(specName);
    const snapshotDir = join(APP_ARCHIVE_DIR, `bdd-test-suite-${descriptor}-${timestamp}`);
    await mkdir(snapshotDir, { recursive: true });

    // Whatever's currently on disk, about to be overwritten by this same
    // round's "Write files" — a no-op (caught, not fatal) if either
    // doesn't exist yet, e.g. a fresh target's very first generation.
    await cp(TESTS_FEATURES_DIR, join(snapshotDir, 'tests', 'features'), { recursive: true }).catch(() => {});
    await cp(TESTS_STEPS_DIR, join(snapshotDir, 'tests', 'steps'), { recursive: true }).catch(() => {});

    await cp(descriptorPath(descriptor), join(snapshotDir, 'descriptor.json')).catch(() => {});
    await cp(descriptorPath(descriptor).replace(/\.json$/, '.corrections.json'), join(snapshotDir, 'corrections.json')).catch(() => {});
    // This descriptor's own first-run setup script (bootstrap/setupTarget.ts),
    // if it has one — most don't (see that file's own comment for why). A
    // snapshot without this would be silently incomplete for a target like
    // uptime-kuma: everything needed to regenerate/rerun the suite would be
    // there except the one piece of automation that makes a fresh deploy of
    // THIS target actually reach a logged-in, testable state.
    if (hasSetup(descriptor)) {
      await cp(setupScriptPath(descriptor), join(snapshotDir, 'setup-script.ts')).catch(() => {});
    }
    // loadtests/<descriptor>-load.js — not git-tracked itself (see the root
    // .gitignore's own comment, same "snapshot is the real source of truth"
    // treatment as tests/features/tests/steps above), so this is the one
    // place a k6 script this descriptor actually has ever gets persisted.
    // Most descriptors don't have one yet (no rest-api component, or
    // nobody's generated/approved a script for it) — same graceful skip as
    // setup-script.ts above.
    await cp(loadTestScriptPath(descriptor), join(snapshotDir, `${descriptor}-load.js`)).catch(() => {});
    await cp(descriptorPath(descriptor).replace(/\.json$/, '.uat.md'), join(snapshotDir, 'uat.md')).catch(() => {});
    // The env that was ACTUALLY in effect for this descriptor's test runs —
    // resolved (base container defaults + this descriptor's own overrides,
    // see resolveTestEnvForSnapshot's own comment), not a raw copy of the
    // sidecar file. A descriptor with no sidecar of its own (orderflow,
    // kafka-demo) still gets a real, honest file here — the shared base
    // defaults it actually ran against — rather than nothing at all.
    await writeFile(join(snapshotDir, 'test-env.env'), await resolveTestEnvForSnapshot(descriptor), 'utf-8').catch(() => {});
    // The RAW override sidecar itself (descriptors/<name>.env), separate
    // from test-env.env above — that one is a flattened/resolved view
    // deliberately unsuitable to restore as the sidecar file itself (see
    // resolveTestEnvForSnapshot's own comment: writing it back would bake
    // container defaults in as if they were real per-descriptor overrides).
    // This copy is what tests/support/restore-suite.mjs actually restores
    // descriptors/<name>.env from. Most descriptors have no sidecar at all
    // (same soft-fail as corrections.json/uat.md above).
    await cp(descriptorPath(descriptor).replace(/\.json$/, '.env'), join(snapshotDir, 'env-overrides.env')).catch(() => {});

    // The exact recipe that produced THIS generation — not every
    // historical discovery report/grouping ever run for this descriptor;
    // those already have their own permanent, never-overwritten
    // timestamped files elsewhere in reports/, so re-bundling all of
    // history into every single snapshot would be redundant bloat.
    await cp(reportPath, join(snapshotDir, 'discovery-report.json')).catch(() => {});
    await cp(groupingPath, join(snapshotDir, 'grouping.json')).catch(() => {});
    await cp(specFilePath(specName), join(snapshotDir, 'approved-spec.json')).catch(() => {});

    // Analysis-tab artifacts for this same discovery report, if any exist —
    // only the three paid/approved ones (business workflow, UI flow,
    // sequence flow). Architecture/ER/API Inventory are purely mechanical
    // renders off discovery-report.json (already snapshotted above), so
    // there's nothing separate to persist for those.
    const workflowPath = await findLatestApprovedArtifactPath(WORKFLOW_APPROVED_NAME_PATTERN, reportPath);
    if (workflowPath) await cp(workflowPath, join(snapshotDir, 'analytics-workflow.json')).catch(() => {});
    const uiFlowPath = await findLatestApprovedArtifactPath(UI_FLOW_APPROVED_NAME_PATTERN, reportPath);
    if (uiFlowPath) await cp(uiFlowPath, join(snapshotDir, 'analytics-ui-flow.json')).catch(() => {});
    const sequencePath = await findLatestApprovedArtifactPath(SEQUENCE_APPROVED_NAME_PATTERN, reportPath);
    if (sequencePath) await cp(sequencePath, join(snapshotDir, 'analytics-sequence-flow.json')).catch(() => {});

    res.json({ path: `archive/bdd-test-suite-${descriptor}-${timestamp}` });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Test-suite snapshot — browse, zip export/import, restore. Still the user's
// own idea from the same round as the snapshot-creation routes above; this
// is the part of it that was still open (see project_test_suite_snapshot_idea
// in memory, and D:\_My_Claude_files\Suite Snapshot ImportExport\plan-en.md
// for the full design writeup).
//
// A snapshot's own directory name (archive/bdd-test-suite-<descriptor>-
// <timestamp>) is the ONLY thing any of these routes trust as a "name" —
// always resolved by checking it's literally present in a real readdir() of
// APP_ARCHIVE_DIR, never by pattern-validating a client-supplied string and
// joining it into a path. That removes path traversal as a concern entirely
// (there is no path to validate — only a lookup into an enumerated list),
// rather than merely guarding against it.
// ---------------------------------------------------------------------------

const SNAPSHOT_DIR_PREFIX = 'bdd-test-suite-';
// Matches the timestamp format /api/generate/snapshot/preview already
// produces (`new Date().toISOString().replace(/[:.]/g, '-')`), e.g.
// 2026-08-11T06-22-17-222Z. The descriptor group is greedy — correct even
// for a hyphenated descriptor like "uptime-kuma", since the fixed-shape
// timestamp anchored at the end is what the regex engine backtracks to find.
const SNAPSHOT_DIR_NAME_PATTERN = /^bdd-test-suite-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

function parseSnapshotDirName(name: string): { descriptor: string; timestamp: string } | null {
  const m = SNAPSHOT_DIR_NAME_PATTERN.exec(name);
  return m ? { descriptor: m[1], timestamp: m[2] } : null;
}

async function listSnapshotDirNames(): Promise<string[]> {
  const entries = await readdir(APP_ARCHIVE_DIR, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && e.name.startsWith(SNAPSHOT_DIR_PREFIX)).map((e) => e.name);
}

/** Resolves a snapshot name to its absolute directory path — 404s rather
 *  than joining an unverified name into a path (see the module comment above). */
async function resolveSnapshotDirByName(name: string): Promise<string> {
  const names = await listSnapshotDirNames();
  if (!names.includes(name)) {
    throw Object.assign(new Error(`No snapshot named "${name}"`), { status: 404 });
  }
  return join(APP_ARCHIVE_DIR, name);
}

/** True iff `archive/<name>` is actually committed in this repo's own git
 *  index — the two demo snapshots (see the root .gitignore's own selective
 *  allowlist) are the only real examples today. Asks the real `git`
 *  (docker-compose.yml's own .git:ro mount) rather than re-parsing
 *  .gitignore's exact allow/deny syntax by hand — the one real source of
 *  truth, and the one thing standing between DELETE and destroying a
 *  tracked demo snapshot that CI/the hub's own demo-switch buttons depend
 *  on. `git ls-files --error-unmatch` exits 0 only when the path is
 *  tracked; anything else (untracked, a spawn error if git or the mount is
 *  ever missing) is treated as "not tracked" — the safer default for a
 *  check that gates a destructive delete, not "assume it's protected". */
async function isSnapshotGitTracked(name: string): Promise<boolean> {
  // -c safe.directory=... (per-invocation, not a persistent global config
  // write): the bind-mounted .git/ is owned by the HOST user, this
  // container runs as its own "node" user (Dockerfile.workbench) — without
  // this, git refuses every call with "detected dubious ownership" (its
  // own CVE-2022-24765 protection), confirmed live.
  const result = await runCommand('git', ['-c', `safe.directory=${APP_ROOT}`, '-C', APP_ROOT, 'ls-files', '--error-unmatch', `archive/${name}`], APP_ROOT, process.env).catch(() => null);
  return result !== null && result.code === 0;
}

app.get('/api/generate/snapshots', async (req, res) => {
  try {
    const names = await listSnapshotDirNames();
    const entries = names
      .map((name) => ({ name, parsed: parseSnapshotDirName(name) }))
      .filter((e): e is { name: string; parsed: { descriptor: string; timestamp: string } } => e.parsed !== null);
    // Same string-sort-on-ISO-timestamp latest-wins logic
    // restore-suite.mjs's own findLatestSnapshot() already relies on — not
    // reimplemented differently here, just applied per-descriptor to flag
    // which entry the "latest" badge/restore-without-a-name-arg would pick.
    const latestByDescriptor = new Map<string, string>();
    for (const { name, parsed } of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      latestByDescriptor.set(parsed.descriptor, name);
    }
    const snapshots = await Promise.all(
      entries
        .map(({ name, parsed: { descriptor, timestamp } }) => ({
          name,
          descriptor,
          timestamp,
          isLatestForDescriptor: latestByDescriptor.get(descriptor) === name,
        }))
        .sort((a, b) => b.name.localeCompare(a.name)) // newest first
        .map(async (snap) => ({ ...snap, isGitTracked: await isSnapshotGitTracked(snap.name) })),
    );
    res.json(snapshots);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.get('/api/generate/snapshots/:name/download', async (req, res) => {
  try {
    const snapshotDir = await resolveSnapshotDirByName(req.params.name);
    // Synchronous, in-memory zip build — fine at this size (a snapshot is a
    // handful of JSON/feature/steps text files, at most low hundreds of KB);
    // no need for streaming complexity for this workload.
    const zip = new AdmZip();
    zip.addLocalFolder(snapshotDir);
    const buffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.zip"`);
    res.send(buffer);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate/snapshots/:name/restore', async (req, res) => {
  try {
    const snapshotName = req.params.name;
    const parsed = parseSnapshotDirName(snapshotName);
    if (!parsed) {
      res.status(400).json({ error: `"${snapshotName}" doesn't look like a snapshot directory name` });
      return;
    }
    // Confirms it's a REAL snapshot (not just a well-formed name) before
    // spawning anything — resolveSnapshotDirByName's own 404 covers that.
    await resolveSnapshotDirByName(snapshotName);

    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');
    // Stated explicitly, not left implicit — the rest of this log is just
    // restore-suite.mjs's own raw output, which only ever touches
    // tests/features/tests/steps and says nothing about the archive's own
    // much larger bundle (descriptor/corrections/UAT/reports/analytics) —
    // confusing on its own to anyone who doesn't remember which radio
    // option they picked in the confirm modal that led here.
    send({ type: 'progress', message: 'Scope: Features & steps only' });
    send({ type: 'progress', message: `Restoring from ${snapshotName}…` });
    // Same subprocess restore-suite.mjs is already invoked through elsewhere
    // (/api/demo/switch, CI, README's Quick Start) — reused here rather than
    // re-deriving "which files go where" a second time in this file. The
    // second positional arg (an exact snapshot directory name) is new; every
    // existing call site omits it and keeps restoring "latest for this
    // descriptor", unchanged.
    const restoreResult = await runCommand(
      'node',
      ['tests/support/restore-suite.mjs', parsed.descriptor, snapshotName],
      APP_ROOT,
      process.env,
      (message) => send({ type: 'progress', message }),
    );
    if (restoreResult.code !== 0) {
      send({ type: 'error', error: `restore-suite.mjs failed (exit ${restoreResult.code}): ${restoreResult.output.slice(-800)}` });
    } else {
      send({ type: 'done', descriptor: parsed.descriptor, snapshot: snapshotName });
    }
    res.end();
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// The riskier sibling of the plain Restore route above — the user's own
// follow-up finding: a snapshot bundles the descriptor, corrections, and
// UAT notes too, but plain Restore only ever touched tests/features/tests/
// steps, leaving the rest stranded in the snapshot forever. This restores
// those too, into their LIVE per-descriptor locations (descriptorPath()
// and its .corrections.json/.uat.md siblings) — genuinely risky, since
// (unlike tests/features/tests/steps, which Write & Run's own prompt
// already offers to snapshot before every overwrite) nothing has ever
// protected these specific files before now. Mitigated two ways: an
// automatic backup of whatever's currently live for this descriptor into
// archive/pre-restore-<descriptor>-<now>/ BEFORE anything is overwritten,
// and requiring the caller to have already shown its own separate,
// scarier confirm (see generate.html's own restoreFullSnapshot()) — this
// route itself doesn't gate on confirmation, same as every other mutating
// route in this file.
//
// Deliberately NOT restored:
//  - setup-script.ts: live-verified this doesn't actually work, not just
//    skipped as a judgment call like the two below. agent-service/src/ is
//    baked into the workbench image at BUILD time (Dockerfile.workbench's
//    own COPY) — unlike descriptors/reports/archive/, docker-compose.yml
//    never bind-mounts it. A write here from inside the running container
//    lands only on that container's own ephemeral writable layer: it looks
//    like it succeeded (no error, the file reads back changed) but never
//    reaches the host's real agent-service/src/bootstrap/setup/<name>.ts,
//    and is gone the moment this container is next rebuilt. Silently
//    "succeeding" at something this misleading is worse than not
//    attempting it — still backed up (below) for reference, just never
//    written back; a progress message says so when the snapshot's own copy
//    actually differs from what's live, and the manual fix (copy
//    archive/<snapshot>/setup-script.ts over agent-service/src/bootstrap/
//    setup/<descriptor>.ts by hand) is the same either way.
//  - test-env.env: this is a flattened base+overrides VIEW built by
//    resolveTestEnvForSnapshot() (see that function's own comment), not a
//    copy of the raw descriptors/<name>.env sidecar — writing it back would
//    bake this container's own defaults (BACKEND_URL etc.) into that file
//    as if they'd always been real per-descriptor overrides.
// discovery-report.json/grouping.json/approved-spec.json/analytics-*.json
// are handled differently from the above: restored, but ADDITIVELY ONLY —
// written if (and only if) the file doesn't already exist at its
// reconstructed real path under reports/, never overwriting one that does.
// The original "skip these entirely" design assumed they're always already
// permanently on disk locally (this app never deletes them — see the
// snapshot-creation route's own comment above) — true for a same-machine
// restore, but false for a snapshot IMPORTED from a different machine (see
// /api/generate/snapshots/import): that machine's own reports/ almost
// certainly never had these specific files, so skipping them there would
// mean the Analysis tab could never show this snapshot's own workflow/UI-
// flow/sequence diagrams no matter how many times "Full context" runs. The
// destination for each is read out of another bundled file's own
// cross-reference, never independently re-derived (self-consistent by
// construction, and sidesteps grouping filenames' own optional descriptor
// suffix entirely — see restoreHistoricalArtifactIfMissing() below):
//   - discovery-report.json -> basename of grouping.json's own sourceReportPath
//   - grouping.json         -> basename of approved-spec.json's own sourceGroupingPath
//   - approved-spec.json / analytics-*.json -> each has its own approvedAt,
//     fed through the exact same `generate-<kind>-approved-<ts>.json`
//     formula their own /approve routes already use above.
app.post('/api/generate/snapshots/:name/restore-full', async (req, res) => {
  try {
    const snapshotName = req.params.name;
    const parsed = parseSnapshotDirName(snapshotName);
    if (!parsed) {
      res.status(400).json({ error: `"${snapshotName}" doesn't look like a snapshot directory name` });
      return;
    }
    const snapshotDir = await resolveSnapshotDirByName(snapshotName);
    const { descriptor } = parsed;
    const snapshotFiles = await readdir(snapshotDir).catch(() => [] as string[]);

    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');
    // Same reasoning as the plain Restore route's own "Scope:" line — stated
    // explicitly so the rest of this log is self-contained, not something
    // that only makes sense if the human remembers which radio option they
    // picked in the confirm modal.
    send({ type: 'progress', message: 'Scope: Full context' });
    send({ type: 'progress', message: `Full restore of "${descriptor}" from ${snapshotName}…` });

    // Step 1: back up whatever's currently live BEFORE any of it is
    // overwritten below. Named pre-restore-, not bdd-test-suite-, so it
    // never shows up in this tab's own snapshot list (that list only shows
    // real point-in-time suite snapshots) — still a real, findable
    // directory, and its path is in the "done" event below.
    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(APP_ARCHIVE_DIR, `pre-restore-${descriptor}-${backupTimestamp}`);
    await mkdir(backupDir, { recursive: true });
    const backedUpDescriptor = await cp(descriptorPath(descriptor), join(backupDir, 'descriptor.json')).then(() => true).catch(() => false);
    const backedUpCorrections = await cp(descriptorPath(descriptor).replace(/\.json$/, '.corrections.json'), join(backupDir, 'corrections.json')).then(() => true).catch(() => false);
    const backedUpUat = await cp(descriptorPath(descriptor).replace(/\.json$/, '.uat.md'), join(backupDir, 'uat.md')).then(() => true).catch(() => false);
    const backedUpSetup = await cp(setupScriptPath(descriptor), join(backupDir, 'setup-script.ts')).then(() => true).catch(() => false);
    const backedUpAnything = backedUpDescriptor || backedUpCorrections || backedUpUat || backedUpSetup;
    if (backedUpAnything) {
      send({ type: 'progress', message: `Backed up the current descriptor/corrections/UAT/setup-script to archive/${basename(backupDir)}` });
    } else {
      // Nothing existed live yet (e.g. this descriptor's very first
      // restore ever) — remove the now-empty backup dir rather than
      // leaving a stray empty folder behind.
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }

    // Step 2: tests/features + tests/steps, via the exact same subprocess
    // the plain Restore button already uses.
    const restoreResult = await runCommand(
      'node',
      ['tests/support/restore-suite.mjs', descriptor, snapshotName],
      APP_ROOT,
      process.env,
      (message) => send({ type: 'progress', message }),
    );
    if (restoreResult.code !== 0) {
      send({ type: 'error', error: `restore-suite.mjs failed (exit ${restoreResult.code}): ${restoreResult.output.slice(-800)}` });
      res.end();
      return;
    }

    // Step 3: the live, editable per-descriptor files this snapshot
    // bundled (see this route's own module comment for what's excluded).
    const restored: string[] = ['tests/features', 'tests/steps'];
    if (await cp(join(snapshotDir, 'descriptor.json'), descriptorPath(descriptor)).then(() => true).catch(() => false)) {
      restored.push('descriptor.json');
    }
    if (await cp(join(snapshotDir, 'corrections.json'), descriptorPath(descriptor).replace(/\.json$/, '.corrections.json')).then(() => true).catch(() => false)) {
      restored.push('corrections.json');
    }
    if (await cp(join(snapshotDir, 'uat.md'), descriptorPath(descriptor).replace(/\.json$/, '.uat.md')).then(() => true).catch(() => false)) {
      restored.push('uat.md');
    }
    send({ type: 'progress', message: `Restored: ${restored.join(', ')}` });

    // Step 4: discovery report / grouping / approved spec / analytics —
    // additive only (see this route's own module comment for the full
    // reasoning). Reads each destination out of another bundled file's own
    // cross-reference rather than re-deriving it independently.
    const restoredHistory: string[] = [];
    async function restoreHistoricalArtifactIfMissing(srcName: string, destPath: string | null): Promise<void> {
      if (!destPath || !snapshotFiles.includes(srcName)) return;
      const alreadyExists = await stat(destPath).then(() => true).catch(() => false);
      if (alreadyExists) return; // same-machine case — this app never deletes these, so it's already there
      if (await cp(join(snapshotDir, srcName), destPath).then(() => true).catch(() => false)) {
        restoredHistory.push(srcName);
      }
    }

    const groupingRaw = await readFile(join(snapshotDir, 'grouping.json'), 'utf-8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    const approvedSpecRaw = await readFile(join(snapshotDir, 'approved-spec.json'), 'utf-8')
      .then((text) => JSON.parse(text))
      .catch(() => null);

    await restoreHistoricalArtifactIfMissing(
      'discovery-report.json',
      typeof groupingRaw?.sourceReportPath === 'string' ? join(config.reportsDir, basename(groupingRaw.sourceReportPath)) : null,
    );
    await restoreHistoricalArtifactIfMissing(
      'grouping.json',
      typeof approvedSpecRaw?.sourceGroupingPath === 'string' ? join(config.reportsDir, basename(approvedSpecRaw.sourceGroupingPath)) : null,
    );
    await restoreHistoricalArtifactIfMissing(
      'approved-spec.json',
      typeof approvedSpecRaw?.approvedAt === 'string'
        ? join(config.reportsDir, `generate-spec-approved-${approvedSpecRaw.approvedAt.replace(/[:.]/g, '-')}.json`)
        : null,
    );
    // Each analytics file carries its own approvedAt — read lazily, only
    // for whichever of the three this particular snapshot actually bundled
    // (most don't have all three; see the snapshot-creation route's own
    // comment on why they're optional).
    for (const [srcName, filePrefix] of [
      ['analytics-workflow.json', 'generate-workflow-approved-'],
      ['analytics-ui-flow.json', 'generate-ui-flow-approved-'],
      ['analytics-sequence-flow.json', 'generate-sequence-approved-'],
    ] as const) {
      if (!snapshotFiles.includes(srcName)) continue;
      const raw = await readFile(join(snapshotDir, srcName), 'utf-8').then((text) => JSON.parse(text)).catch(() => null);
      await restoreHistoricalArtifactIfMissing(
        srcName,
        typeof raw?.approvedAt === 'string' ? join(config.reportsDir, `${filePrefix}${raw.approvedAt.replace(/[:.]/g, '-')}.json`) : null,
      );
    }
    if (restoredHistory.length > 0) {
      send({ type: 'progress', message: `Also added (weren't present locally): ${restoredHistory.join(', ')}` });
    }

    // Not restored (see this route's own module comment for why) — just
    // flagged here if it would actually matter, i.e. the snapshot's own
    // setup-script.ts genuinely differs from what's live right now. Diffing
    // by content rather than just "the snapshot has one" avoids a false
    // alarm on every full restore of a descriptor whose setup script simply
    // hasn't changed since this snapshot was taken.
    if (snapshotFiles.includes('setup-script.ts')) {
      const [snapshotSetup, liveSetup] = await Promise.all([
        readFile(join(snapshotDir, 'setup-script.ts'), 'utf-8').catch(() => null),
        readFile(setupScriptPath(descriptor), 'utf-8').catch(() => null),
      ]);
      if (snapshotSetup !== null && snapshotSetup !== liveSetup) {
        send({
          type: 'progress',
          message: `NOT restored: setup-script.ts — the live copy differs, but agent-service/src/ isn't ` +
            `bind-mounted into this container, so a write here can't actually persist. Copy ` +
            `archive/${snapshotName}/setup-script.ts over agent-service/src/bootstrap/setup/${descriptor}.ts ` +
            `by hand if you want this reverted too.`,
        });
      }
    }

    send({
      type: 'done',
      descriptor,
      snapshot: snapshotName,
      restored,
      restoredHistory,
      backupPath: backedUpAnything ? `archive/${basename(backupDir)}` : null,
    });
    res.end();
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// Retention — the user's own follow-up idea, same live-review round as the
// restore-scope log fix above: snapshots otherwise accumulate forever with
// no way to prune them. Deliberately narrow: refuses outright on either of
// the two git-tracked demo snapshots (isSnapshotGitTracked() above) — those
// are depended on by CI, the hub's own demo-switch buttons, and the
// README's Quick Start, so deleting one isn't a "this one archive entry"
// decision the Snapshots tab gets to make alone. Anything else is a real,
// permanent `rm -rf` — no trash/undo directory, matching this route's own
// name ("Delete", not "Archive" or "Hide") and the confirm modal's own
// wording (generate.html's own deleteSnapshot()) that says exactly that
// and suggests Export first.
app.delete('/api/generate/snapshots/:name', async (req, res) => {
  try {
    const snapshotName = req.params.name;
    const snapshotDir = await resolveSnapshotDirByName(snapshotName);
    if (await isSnapshotGitTracked(snapshotName)) {
      res.status(403).json({ error: `"${snapshotName}" is git-tracked (a shared demo snapshot) — refusing to delete it here.` });
      return;
    }
    await rm(snapshotDir, { recursive: true, force: true });
    res.status(204).end();
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// Memory storage, not disk — mirrors uatUpload above. A snapshot zip is
// bigger than a single UAT document (it bundles a discovery report,
// full corrections/UAT history, and the whole rendered suite) so this gets
// a larger cap than uatUpload's 10MB, but still comfortably in-memory-sized.
const snapshotUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/** Shared by both import routes below: reads the uploaded zip's own
 *  descriptor.json (if present) to auto-detect which descriptor this
 *  snapshot belongs to, and computes the same archive/bdd-test-suite-
 *  <descriptor>-<timestamp> naming scheme /api/generate/snapshot/preview
 *  already uses — so an imported snapshot's directory name looks exactly
 *  like a locally-created one, not a special "imported" shape. */
function inspectSnapshotZip(buffer: Buffer): { zip: AdmZip; descriptor: string; topLevelNames: string[] } {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw Object.assign(new Error(`Not a valid zip file: ${(err as Error).message}`), { status: 400 });
  }
  const entries = zip.getEntries();
  const topLevelNames = [...new Set(entries.map((e) => e.entryName.split('/')[0]))].sort();
  const descriptorEntry = entries.find((e) => e.entryName === 'descriptor.json');
  if (!descriptorEntry) {
    throw Object.assign(new Error('Zip has no descriptor.json at its root — this doesn\'t look like a suite snapshot.'), { status: 400 });
  }
  let descriptor: string;
  try {
    descriptor = JSON.parse(zip.readAsText(descriptorEntry)).name;
  } catch (err) {
    throw Object.assign(new Error(`descriptor.json in the zip isn't valid JSON: ${(err as Error).message}`), { status: 400 });
  }
  if (typeof descriptor !== 'string' || !descriptor) {
    throw Object.assign(new Error('descriptor.json in the zip has no "name" field.'), { status: 400 });
  }
  if (!NAME_PATTERN.test(descriptor)) {
    throw Object.assign(new Error(`descriptor.json's "name" ("${descriptor}") isn't a plain name — refusing to use it as part of a directory path.`), { status: 400 });
  }
  return { zip, descriptor, topLevelNames };
}

app.post('/api/generate/snapshots/import/preview', snapshotUpload.single('file'), async (req, res) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: '"file" is required' });
      return;
    }
    const { descriptor, topLevelNames } = inspectSnapshotZip(file.buffer);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.json({ descriptor, timestamp, path: `archive/bdd-test-suite-${descriptor}-${timestamp}`, topLevelNames });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate/snapshots/import', snapshotUpload.single('file'), async (req, res) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    const { timestamp } = req.body as { timestamp?: string };
    if (!file || !timestamp) {
      res.status(400).json({ error: '"file" and "timestamp" are required' });
      return;
    }
    const { zip, descriptor } = inspectSnapshotZip(file.buffer);
    const dirName = `bdd-test-suite-${descriptor}-${timestamp}`;
    const destDir = join(APP_ARCHIVE_DIR, dirName);
    // Archive entries are immutable once created — an import never
    // overwrites an existing snapshot, whether that snapshot was made
    // locally or by a previous import. Refuse rather than silently merge.
    const alreadyExists = (await listSnapshotDirNames()).includes(dirName);
    if (alreadyExists) {
      res.status(409).json({ error: `${dirName} already exists — refusing to overwrite an existing snapshot.` });
      return;
    }
    await mkdir(destDir, { recursive: true });
    zip.extractAllTo(destDir, /* overwrite */ false);
    res.status(201).json({ path: `archive/${dirName}` });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// Used by the hub's own "Keep test data" checkbox (hub/index.html) —
// unchecked (the default) means "reset before this re-run", implemented
// as cleanup.mjs's own --since mechanism with a cutoff old enough that
// literally every non-seed row matches, seed itself protected by
// cleanup.mjs's own hardcoded SEED_CUSTOMER_EMAILS/SEED_PRODUCT_NAMES
// exclusion (a name/email check, not date-based, so it holds regardless
// of how this constant compares to any real row's own createdAt).
const RESET_ALL_SINCE = '1970-01-01T00:00:00Z';

app.post('/api/tests/run', async (req, res) => {
  try {
    // Optional — whatever's currently rendered into tests/ is what actually
    // runs regardless; this is purely so an externally deployed target's own
    // FRONTEND_URL/credentials (descriptors/<name>.env) overlay the
    // orderflow-network defaults instead of silently falling back to them.
    // Omit it and behavior is unchanged from before this field existed.
    // req.body is undefined (not {}) for a POST with no body at all — a
    // real, legitimate way to call this route (confirmed live: load.html's
    // own "Run load test" button did exactly that before this guard),
    // express.json() only ever populates it when a JSON body was actually
    // sent.
    const { descriptor, resetDatabase } = (req.body ?? {}) as { descriptor?: string; resetDatabase?: boolean };
    const testEnv = await buildTestRunEnv(descriptor);
    // bddgen + the real Playwright/Cucumber suite can run for minutes with
    // nothing but a static "running…" status otherwise — stream NDJSON
    // progress (one line of real command output per event), the same
    // pattern Generate's own long-running calls use. No separate
    // request-validation phase exists here (this route takes no params), so
    // headers are streamed from the very start — any failure has to be a
    // `{"type":"error"}` line, never a status code.
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    try {
      // Reset to baseline BEFORE this run, not after — so the state a
      // human inspects right after a "Re-Run BDD tests" click reflects
      // exactly what THIS run created, not last time's leftovers layered
      // on top. resetDatabase is only ever true from the hub's OrderFlow
      // tile (its checkbox is the one UI surface that sets it); harmless
      // no-op for any other caller (generate.html's own "Run tests"
      // button never sends it) since the field is simply absent there.
      if (resetDatabase && descriptor === 'orderflow') {
        send({ type: 'progress', message: `$ node support/cleanup.mjs --since ${RESET_ALL_SINCE}` });
        const resetResult = await runCommand('node', ['support/cleanup.mjs', '--since', RESET_ALL_SINCE], TESTS_ROOT, testEnv, (line) => send({ type: 'progress', message: line }));
        if (resetResult.code !== 0) {
          send({ type: 'progress', message: `Warning: cleanup.mjs exited ${resetResult.code} — proceeding anyway.` });
        }
      }
      send({ type: 'progress', message: '$ npx bddgen && npx playwright test' });
      const testRun = await runCommand('sh', ['-c', 'npx bddgen && npx playwright test'], TESTS_ROOT, testEnv, (line) => send({ type: 'progress', message: line }));
      // Always regenerate the HTML report afterward, whether or not the run
      // above passed — the report's whole purpose is showing what failed.
      send({ type: 'progress', message: '$ node support/generate-html-report.mjs' });
      const reportRun = await runCommand('node', ['support/generate-html-report.mjs'], TESTS_ROOT, testEnv, (line) => send({ type: 'progress', message: line }));
      send({
        type: 'done',
        testsPassed: testRun.code === 0,
        testsExitCode: testRun.code,
        reportGenerated: reportRun.code === 0,
        output: (testRun.output + '\n' + reportRun.output).slice(-8000),
      });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Load — backend/API load testing (k6 -> InfluxDB -> Grafana). HTTP-only
// load against a descriptor's own rest-api component, no browser involved
// (see loadtests/*.js's own header comment, load.html's own copy, and the
// Grafana dashboard's own description panel for the same framing repeated
// everywhere this stage is visible). Descriptor-agnostic by construction:
// reuses rewriteForContainerNetwork()/restApiOrigin() (defined above, next
// to /api/discovery/run) to resolve any target's REST API base origin the
// exact same way Discovery already does — no separate networking logic for
// this stage. The one gating rule is capability-based, not a stored flag:
// a descriptor with no rest-api component has nothing to load-test.
// ---------------------------------------------------------------------------

// Same two-levels-up pattern as DESCRIPTORS_DIR above (server.ts lives at
// src/admin/server.ts, so '../..' lands at this package's own root,
// /usr/src/app inside the container) — matches the workbench service's
// own `./loadtests:/usr/src/app/loadtests` mount in docker-compose.yml.
const LOADTESTS_DIR = resolve(__dirname, '../../loadtests');

function loadTestScriptPath(name: string): string {
  return join(LOADTESTS_DIR, `${name}-load.js`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Same HOST_PROJECT_ROOT-resolved-path pattern orderflowDemoComposeFile()
// below and kafkaUiSync.ts's own repoComposeFile() already use — this one
// points at docker-compose.yml itself (where the k6/influxdb/grafana
// services live), not a separate compose file, so `docker compose run k6`
// below attaches to the same network `up` already created for
// influxdb/grafana and (for OrderFlow) `app`.
function rootComposeFile(): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) {
    throw new Error('HOST_PROJECT_ROOT is not set — docker-compose.yml should pass it into the workbench service');
  }
  return join(hostRoot, 'docker-compose.yml');
}

app.post('/api/load/:descriptor/run', async (req, res) => {
  try {
    const name = req.params.descriptor;
    const descriptor = parseSystemDescriptor(JSON.parse(await readFile(descriptorPath(name), 'utf-8')));
    const baseUrl = restApiOrigin(rewriteForContainerNetwork(await refreshDockerComposeBaseUrls(descriptor, name)));
    if (!baseUrl) {
      res.status(400).json({ error: 'This descriptor has no rest-api component — nothing to load-test.' });
      return;
    }
    const scriptFile = loadTestScriptPath(name);
    if (!(await fileExists(scriptFile))) {
      res.status(400).json({ error: `No k6 script yet for "${name}" — generate and approve one on the Load tab first.` });
      return;
    }

    // Same req.body-can-be-undefined guard as /api/tests/run above.
    const { resetDatabase } = (req.body ?? {}) as { resetDatabase?: boolean };

    // The real run can take ~2 minutes (the demo VU ramp/hold/ramp-down) —
    // stream NDJSON progress the same way /api/tests/run above does. Any
    // failure past this point has to be a `{"type":"error"}` line, never a
    // status code.
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');
    try {
      // Same hub "Keep test data" checkbox /api/tests/run's own resetDatabase
      // handles above — reset to baseline BEFORE this run, not after, so a
      // standalone "Re-Run backend load test" click (no preceding BDD
      // re-run) still starts from a clean Customer/Product table rather
      // than whatever an earlier "keep data" run left behind.
      if (resetDatabase && name === 'orderflow') {
        const testEnv = await buildTestRunEnv(name);
        send({ type: 'progress', message: `$ node support/cleanup.mjs --since ${RESET_ALL_SINCE}` });
        const resetResult = await runCommand('node', ['support/cleanup.mjs', '--since', RESET_ALL_SINCE], TESTS_ROOT, testEnv, (line) => send({ type: 'progress', message: line }));
        if (resetResult.code !== 0) {
          send({ type: 'progress', message: `Warning: cleanup.mjs exited ${resetResult.code} — proceeding anyway.` });
        }
      }

      const composeFile = rootComposeFile();
      // Real bug found live 2026-08-19: this only ever passed K6_BASE_URL —
      // nothing from the descriptor's own headers/credentials ever reached
      // the k6 container, so a rest-api component with `headers` (e.g.
      // NocoDB's xc-token, see project_restapi_auth_headers_idea) silently
      // ran unauthenticated and every single request failed (100%
      // http_req_failed, confirmed live: 2645/2645). Same descriptor-env-
      // sidecar mechanism buildTestRunEnv() already uses for BDD/E2E runs,
      // reused here directly rather than the full process.env-spread
      // version — a k6 subprocess only needs this target's own overrides
      // (BACKEND_URL/XC_TOKEN/NC_API_TOKEN/etc.), not ANTHROPIC_API_KEY and
      // everything else buildTestRunEnv() also carries.
      const descriptorEnvOverrides = expandOverrides(await loadTestEnvOverrides(descriptorPath(name)));
      const args = [
        'compose', '-p', 'agentic-qa-platform', '-f', composeFile, '--profile', 'tools', 'run', '--rm',
        '-e', `K6_BASE_URL=${baseUrl}`,
        ...Object.entries(descriptorEnvOverrides).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        'k6', 'run', `/scripts/${name}-load.js`,
        '--out', 'influxdb=http://influxdb:8086/k6', '--tag', `descriptor=${name}`,
      ];
      // Captured before the run starts, not after — used as cleanup.mjs's
      // own --since below, so only rows THIS run creates get deleted,
      // never anything older (the seed customer/product from
      // app/prisma/seed.ts, or whatever a prior BDD run's own cleanup
      // already left in place).
      const runStartedAt = new Date().toISOString();
      send({ type: 'progress', message: `$ docker ${args.join(' ')}` });
      const result = await runCommand('docker', args, APP_ROOT, process.env, (line) => send({ type: 'progress', message: line }));

      // OrderFlow's own script creates a real customer/product/order per
      // VU/iteration — thousands of rows per run, all matched by
      // tests/support/cleanup.mjs's own 'k6-%'/'K6 Load Product%' patterns
      // AND (for anything that somehow didn't) the --since cutoff above.
      // Confirmed live: without this, the leftover rows survive past this
      // run (only a full redeploy's `down -v` would otherwise clear them)
      // and silently break BDD edge-case scenarios that assume a clean
      // Customer/Product table on a later "Re-Run BDD tests" click. Always
      // runs, pass or fail — a failed load test still creates real rows.
      // OrderFlow-specific (cleanup.mjs's own schema is OrderFlow's Prisma
      // schema, same as the hand-written script it's cleaning up after) —
      // not run for any other descriptor. A plain cleanup.mjs's own
      // hardcoded DEFAULT_SINCE would have been wrong here — it assumes a
      // long-lived dev DB where "old" means "genuine seed data", not a
      // freshly deployed instance where the real seed rows are just as
      // "recent" as this run's own throwaway ones; runStartedAt is the
      // one cutoff that's actually correct for THIS run specifically.
      if (name === 'orderflow') {
        const testEnv = await buildTestRunEnv(name);
        send({ type: 'progress', message: `$ node support/cleanup.mjs --since ${runStartedAt}` });
        const cleanupResult = await runCommand('node', ['support/cleanup.mjs', '--since', runStartedAt], TESTS_ROOT, testEnv, (line) => send({ type: 'progress', message: line }));
        if (cleanupResult.code !== 0) {
          send({ type: 'progress', message: `Warning: cleanup.mjs exited ${cleanupResult.code} — load-test rows may still be in the database.` });
        }
      }

      // Nonzero exit here means k6's own thresholds failed (a legitimate
      // load-test outcome, e.g. p95 latency crept over budget under load) —
      // not necessarily an infrastructure error, so this is reported, not
      // thrown, same as /api/tests/run's own testsPassed handling above.
      send({ type: 'done', exitCode: result.code, passed: result.code === 0 });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Load — AI generation. Reuses Generate Stage 2's exact architecture (one
// LLM call, propose-then-human-approves), scaled down to one script instead
// of a grouping/budget/merge pipeline — see agents/loadtest/spec.ts's own
// header comment. Descriptor-agnostic: any target with a discovery report
// and a rest-api component can go through this, not just OrderFlow.
// ---------------------------------------------------------------------------

app.post('/api/load/:descriptor/generate', async (req, res) => {
  try {
    const name = req.params.descriptor;
    const { report } = req.body as { report?: string };
    if (!report) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const reportRaw = JSON.parse(await readFile(reportFilePath(report), 'utf-8'));
    parseDiscoveryReport(reportRaw); // validate shape before spending money on a Claude call
    const reportJson = JSON.stringify(reportRaw, null, 2);

    // Real Claude call, can take tens of seconds with nothing but a static
    // "generating…" status otherwise — stream NDJSON progress the same way
    // /api/generate/spec does, wrapping the provider so every provider.run()
    // call (just the one, here) emits its own start/end progress line.
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    const rawProvider = new ClaudeProvider();
    const provider: AgentProvider = {
      run: async (opts) => {
        opts = { ...opts, descriptor: opts.descriptor ?? name };
        const t0 = Date.now();
        send({ type: 'progress', message: `Calling Claude for "${opts.operation}"…` });
        try {
          const result = await rawProvider.run(opts);
          send({ type: 'progress', message: `"${opts.operation}" responded (${((Date.now() - t0) / 1000).toFixed(1)}s)` });
          return result;
        } catch (err) {
          send({ type: 'progress', message: `"${opts.operation}" errored after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${(err as Error).message}` });
          throw err;
        }
      },
    };

    try {
      const { scriptContent } = await generateLoadTestScript(provider, reportJson, name);
      // Propose only — never written to disk here. The human reviews/edits
      // in load.html and PUT /api/load/:descriptor/script (below) is the
      // only path that actually saves, gated by its own k6-inspect check.
      send({ type: 'done', scriptContent });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No report named "${(req.body as { report?: string }).report}"` });
      return;
    }
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Report failed validation', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.get('/api/load/:descriptor/script', async (req, res) => {
  try {
    const text = await readFile(loadTestScriptPath(req.params.descriptor), 'utf-8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    });
    res.json({ text });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.put('/api/load/:descriptor/script', async (req, res) => {
  const name = req.params.descriptor;
  let tempPath: string | null = null;
  try {
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: '"text" is required' });
      return;
    }

    // k6's own dry-run/lint — parses the script and reports its `options`
    // without running a single VU iteration. Written to a TEMP file first,
    // never the real <descriptor>-load.js — a broken paste must never even
    // briefly become the file /api/load/:descriptor/run actually executes.
    tempPath = join(LOADTESTS_DIR, `.tmp-${name}-${Date.now()}.js`);
    await writeFile(tempPath, text, 'utf-8');
    const composeFile = rootComposeFile();
    const inspectArgs = ['compose', '-p', 'agentic-qa-platform', '-f', composeFile, '--profile', 'tools', 'run', '--rm', 'k6', 'inspect', `/scripts/${basename(tempPath)}`];
    const inspectResult = await runCommand('docker', inspectArgs, APP_ROOT, process.env);
    if (inspectResult.code !== 0) {
      res.status(400).json({ error: `k6 rejected this script:\n${inspectResult.output.slice(-2000)}` });
      return;
    }

    await writeFile(loadTestScriptPath(name), text, 'utf-8');
    res.json({ text });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Hub "Demo" section — "Deploy OrderFlow/Uptime Kuma and its BDD suite"
// (hub/index.html, reached through report-nginx.conf's own same-origin
// /api/ proxy to this container, not CORS). Tears down whichever demo is
// currently up and deploys the chosen one fresh, suite included — always a
// full teardown+redeploy of the CHOSEN target too, even if it's already the
// active one, matching the button's own "completely tear down, then
// deploy" wording rather than special-casing "already deployed". Reuses
// existing pieces rather than reimplementing them:
//   - Uptime Kuma is a real docker-compose-component descriptor, deployed
//     the exact same way the Workbench's own Deploy/Setup buttons do
//     (deployTarget()/runSetup(), both already imported above).
//   - OrderFlow is NOT a docker-compose-component descriptor — it's this
//     repo's own always-present sample app, just split into its own
//     compose project now (docker-compose.demo-orderflow.yml, see that
//     file's own comment) — driven with a plain `docker compose`
//     invocation instead of deployTarget.ts's clone-based pipeline.
//   - The suite itself (tests/features/tests/steps) is restored from
//     whichever of the two git-tracked archive/bdd-test-suite-* snapshots
//     matches, via tests/support/restore-suite.mjs — the SAME script CI and
//     the README's Quick Start use, not reimplemented here.
// ---------------------------------------------------------------------------

const ORDERFLOW_DEMO_PROJECT = 'bdd-target-demo-orderflow';

// Same identical-absolute-path mirroring HOST_PROJECT_ROOT already backs
// for targets/ (deployTarget.ts's own module comment has the full
// reasoning) — docker-compose.yml's workbench service mounts this one file
// at this same path for exactly this reason. Unlike deployTarget.ts's own
// assertMirroredMount(), no extra `docker inspect` check here: a wrong
// HOST_PROJECT_ROOT makes the `docker compose -f <path>` call below fail
// immediately and clearly ("no such file"), since this container reads the
// compose file's own text directly — there's no silent-empty-directory
// failure mode to guard against the way a cloned target's bind mounts have.
function orderflowDemoComposeFile(): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) {
    throw new Error('HOST_PROJECT_ROOT is not set — docker-compose.yml should pass it into the workbench service');
  }
  return join(hostRoot, 'docker-compose.demo-orderflow.yml');
}

async function undeployOrderflowDemo(onProgress: (message: string) => void): Promise<void> {
  const composeFile = orderflowDemoComposeFile();
  // `down -v` (not plain `down`) — this route's whole point is a clean
  // slate every switch, and a fresh `pgdata` volume is exactly what
  // exercises the demo compose file's own auto-migrate-on-start fix.
  // Idempotent/safe even if nothing is currently deployed under this
  // project (unlike deployTarget.ts's undeployTarget(), which depends on a
  // per-target resolved-config file that only exists after a first real
  // deploy) — no existence check needed first.
  onProgress(`$ docker compose -p ${ORDERFLOW_DEMO_PROJECT} -f ${composeFile} down -v`);
  const { code, output } = await runCommand(
    'docker',
    ['compose', '-p', ORDERFLOW_DEMO_PROJECT, '-f', composeFile, 'down', '-v'],
    APP_ROOT,
    process.env,
    onProgress,
  );
  if (code !== 0) {
    throw new Error(`docker compose down failed for ${ORDERFLOW_DEMO_PROJECT} (exit ${code}): ${output.slice(-800)}`);
  }
}

async function deployOrderflowDemo(onProgress: (message: string) => void): Promise<void> {
  await undeployOrderflowDemo(onProgress);
  const composeFile = orderflowDemoComposeFile();
  // No `--build` — the images are already built (initial README setup);
  // rebuilding on every hub-button click would make "one click" genuinely
  // slow for no benefit, since this route never changes the Dockerfiles.
  // `--wait` blocks until db/kafka/app's own healthchecks pass, replacing
  // hand-rolled polling — but see waitForOrderflowBackendReady() below,
  // still needed even with this.
  onProgress(`$ docker compose -p ${ORDERFLOW_DEMO_PROJECT} -f ${composeFile} up -d --wait`);
  const { code, output } = await runCommand(
    'docker',
    ['compose', '-p', ORDERFLOW_DEMO_PROJECT, '-f', composeFile, 'up', '-d', '--wait'],
    APP_ROOT,
    process.env,
    onProgress,
  );
  if (code !== 0) {
    throw new Error(`docker compose up failed for ${ORDERFLOW_DEMO_PROJECT} (exit ${code}): ${output.slice(-800)}`);
  }
}

// Confirmed live (2026-08-11) that `--wait` above genuinely isn't enough on
// its own, even with app's own healthcheck added: `app`'s healthcheck runs
// FROM INSIDE its own container (`wget http://localhost:3000/`), which can
// report healthy while the very next cross-container connection — from
// `workbench`, over the docker network, exactly what the real test run
// needs — still gets a real `ECONNREFUSED`. Root cause not fully pinned
// down (a container's own loopback becoming reachable slightly before its
// externally-facing network interface, under this project's Docker
// Desktop/WSL2 setup, is the leading theory — same general class of
// cross-container-vs-loopback gap already documented for MSSQL's hairpin-
// NAT issue elsewhere in this codebase, different mechanism). Same fix
// shape as setupUptimeKuma.ts's own retry loop: probe from the SAME
// vantage point the real failure happened from (this process, i.e.
// workbench, not app's own container) before trusting it.
async function waitForOrderflowBackendReady(onProgress: (message: string) => void): Promise<void> {
  const url = 'http://app:3000/';
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      await fetch(url);
      if (attempt > 1) onProgress(`${url} reachable from workbench after ${attempt} attempts.`);
      return;
    } catch {
      if (attempt === 1) onProgress(`${url} not reachable from workbench yet — retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`${url} never became reachable from workbench after 15 attempts (30s) — see waitForOrderflowBackendReady()'s own comment.`);
}

// getRunningContainerNames() itself now lives in bootstrap/deployTarget.ts
// (factored out once bootstrap/kafkaUiSync.ts needed the identical
// "is this compose project actually live right now" check for arbitrary
// projects, not just OrderFlow's own hardcoded one) — this file just
// imports it. Its own doc comment there still has the full "why not `-a`"
// story (a real bug, caught live 2026-08-12).

// hub/index.html's Demo section polls this (on load + periodically) to
// know whether to show each tile as "Deploy ..." or "... — currently
// deployed", and whether to reveal each tile's sub-cards (Frontend/Backend/
// Kafka UI for OrderFlow, a live dashboard link for Uptime Kuma). Plain
// JSON, not streamed — both checks below are quick (`docker ps` + one
// small state-file read), same shape as the existing
// `/api/descriptors/:name/deploy/status` route this mirrors.
app.get('/api/demo/status', async (req, res) => {
  try {
    const orderflowContainers = await getRunningContainerNames(ORDERFLOW_DEMO_PROJECT);
    // uptime-kuma's own project name follows deployTarget.ts's
    // projectNameFor() convention (bdd-target-<name>) — not exported, so
    // spelled out literally here, same as ORDERFLOW_DEMO_PROJECT already is.
    const kumaContainers = await getRunningContainerNames('bdd-target-uptime-kuma');

    // Uptime Kuma's own published port is dynamically allocated
    // (assignPorts() in deployTarget.ts) — unlike OrderFlow's fixed
    // :5173/:3000/:8081, there's no way to know it without reading back
    // the real deploy state this container itself wrote. Best-effort: a
    // missing/unreadable state file (deploy still in flight, or a stale
    // leftover with no state) just means no link yet, not an error for
    // this route as a whole.
    let kumaUrl: string | null = null;
    if (kumaContainers.length > 0 && process.env.HOST_PROJECT_ROOT) {
      try {
        const { statePath } = resolveTargetPaths(join(process.env.HOST_PROJECT_ROOT, 'targets'), 'uptime-kuma');
        const state = JSON.parse(await readFile(statePath, 'utf-8')) as DeployState;
        const webPort = state.ports.find((p) => p.service === 'uptime-kuma')?.publishedPort;
        // localhost, not host.docker.internal — this URL is for a real
        // browser on the host clicking a link, not another container.
        if (webPort) kumaUrl = `http://localhost:${webPort}`;
      } catch {
        kumaUrl = null;
      }
    }

    // Whether a demo's CONTAINERS are running (checked above) and whether
    // tests/features/tests/steps actually hold ITS suite are two genuinely
    // independent facts — restoring a suite only happens inside
    // /api/demo/switch, so anything else that changes tests/ afterward
    // (Write & Run for a different target in the Workbench, a hand edit in
    // an editor) leaves the deployed containers untouched while the suite
    // on disk quietly stops matching them. `tests/.current-descriptor`
    // (kept up to date by both restore-suite.mjs and Write & Run) is the
    // one honest source for "whose suite is actually there right now" —
    // the hub compares it against each `deployed: true` tile client-side
    // to show a real mismatch warning instead of silently implying the
    // suite is still correct just because the container is still up.
    let currentSuiteDescriptor: string | null = null;
    try {
      currentSuiteDescriptor = (await readFile(join(TESTS_ROOT, '.current-descriptor'), 'utf-8')).trim() || null;
    } catch {
      currentSuiteDescriptor = null;
    }

    res.json({
      orderflow: { deployed: orderflowContainers.length > 0 },
      uptimeKuma: { deployed: kumaContainers.length > 0, url: kumaUrl },
      currentSuiteDescriptor,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/demo/switch', async (req, res) => {
  const { target } = req.body as { target?: string };
  if (target !== 'orderflow' && target !== 'uptime-kuma') {
    res.status(400).json({ error: `"target" must be "orderflow" or "uptime-kuma", got ${JSON.stringify(target)}` });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

  try {
    // Runs FIRST, before anything below reads a descriptor file — descriptors
    // aren't git-tracked themselves (see the root .gitignore's own comment),
    // so on a fresh checkout this is what actually puts descriptors/<target>.json/
    // .env on disk at all. Restore-if-missing (restore-suite.mjs's own logic),
    // so this is a no-op on an already-running instance, same script CI and
    // the Workbench's own Restore button use. Used to run right before the
    // BDD test run near the end of this route instead — moved here after a
    // real ordering bug: the uptime-kuma branch below reads
    // descriptorPath('uptime-kuma') directly a few lines in, which would 500
    // on ENOENT on a fresh checkout if this still ran after it.
    send({ type: 'progress', message: `Restoring ${target}'s suite from its archived snapshot…` });
    const restoreResult = await runCommand(
      'node',
      ['tests/support/restore-suite.mjs', target],
      APP_ROOT,
      process.env,
      (message) => send({ type: 'progress', message }),
    );
    if (restoreResult.code !== 0) {
      throw new Error(`restore-suite.mjs failed (exit ${restoreResult.code}): ${restoreResult.output.slice(-800)}`);
    }

    if (target === 'uptime-kuma') {
      send({ type: 'progress', message: 'Tearing down the OrderFlow demo…' });
      await undeployOrderflowDemo((message) => send({ type: 'progress', message }));
      // No exclude needed — the demo bundle's broker lives on the shared
      // network, kafka-ui never needs a network join for it, so this just
      // drops it from the cluster list now that its containers are gone.
      await syncKafkaUi((message) => send({ type: 'progress', message }));

      send({ type: 'progress', message: 'Deploying Uptime Kuma…' });
      const descriptor = parseSystemDescriptor(JSON.parse(await readFile(descriptorPath('uptime-kuma'), 'utf-8')));
      const component = findDockerComposeComponent(descriptor);
      // Kuma itself never has a Kafka broker, but every deployTarget() call
      // site gets the same standard treatment for consistency — see
      // /api/descriptors/:name/deploy above.
      await syncKafkaUi((message) => send({ type: 'progress', message }), { excludeTarget: 'uptime-kuma' });
      await deployTarget(component, 'uptime-kuma', (message) => send({ type: 'progress', message }));
      await syncKafkaUi((message) => send({ type: 'progress', message }));

      if (!hasSetup('uptime-kuma')) {
        send({ type: 'progress', message: 'No first-run setup script registered for uptime-kuma — skipping.' });
      } else {
        send({ type: 'progress', message: 'Running first-run setup…' });
        const env = expandOverrides(await loadTestEnvOverrides(descriptorPath('uptime-kuma')));
        await runSetup('uptime-kuma', env, (message) => send({ type: 'progress', message }));
      }
    } else {
      // Checked first, not just try/caught — unlike the orderflow leg's own
      // `down -v` (idempotent against a static compose file), undeployTarget()
      // depends on a per-target resolved-config file that only exists once
      // Kuma has actually been deployed at least once; calling it against a
      // target that's never been deployed throws, and "never deployed yet"
      // is the expected common case here (e.g. OrderFlow already active),
      // not an error worth failing the whole switch over.
      const existingKuma = await getTargetContainerNames('uptime-kuma');
      if (existingKuma.length > 0) {
        send({ type: 'progress', message: 'Tearing down Uptime Kuma…' });
        await syncKafkaUi((message) => send({ type: 'progress', message }), { excludeTarget: 'uptime-kuma' });
        await undeployTarget('uptime-kuma', (message) => send({ type: 'progress', message }));
      } else {
        send({ type: 'progress', message: 'Uptime Kuma is not currently deployed — nothing to tear down.' });
      }

      send({ type: 'progress', message: 'Deploying OrderFlow…' });
      await deployOrderflowDemo((message) => send({ type: 'progress', message }));
      await syncKafkaUi((message) => send({ type: 'progress', message }));
      await waitForOrderflowBackendReady((message) => send({ type: 'progress', message }));
    }

    // Same two commands /api/tests/run runs above — descriptor passed only
    // for uptime-kuma (so PLAYWRIGHT_WORKERS=1 etc. from
    // descriptors/uptime-kuma.env apply, avoiding the known login
    // rate-limit flakiness); orderflow has no sidecar env of its own, same
    // as every other caller of buildTestRunEnv().
    const testEnv = await buildTestRunEnv(target === 'uptime-kuma' ? 'uptime-kuma' : undefined);
    // Captured before bddgen/playwright starts, not after — used as
    // cleanup.mjs's own --since below, so only rows the suite itself
    // creates during THIS run get deleted, never the seed customer/product
    // from app/prisma/seed.ts (created earlier, at container startup).
    const bddStartedAt = new Date().toISOString();
    send({ type: 'progress', message: '$ npx bddgen && npx playwright test' });
    const testRun = await runCommand('sh', ['-c', 'npx bddgen && npx playwright test'], TESTS_ROOT, testEnv, (message) => send({ type: 'progress', message }));
    send({ type: 'progress', message: '$ node support/generate-html-report.mjs' });
    const reportRun = await runCommand('node', ['support/generate-html-report.mjs'], TESTS_ROOT, testEnv, (message) => send({ type: 'progress', message }));

    // BDD's own steps create real customer/product/order rows against
    // OrderFlow's DB (order-test-%/cust_%/etc., plus a lot of Generate-
    // Agent-authored fixtures with dynamic timestamp-suffixed names that
    // cleanup.mjs's own fixed pattern list was never going to catch,
    // confirmed live — --since bddStartedAt covers all of it regardless
    // of naming) — clean those up before hub/index.html's own
    // switchDemo() goes on to trigger a fresh backend/API load test right
    // after this route responds (see /api/load/:descriptor/run, which
    // cleans up its OWN rows the same way once IT finishes): the load
    // test's script counts on a clean-of-throwaway-data Customer/Product
    // table too, and a leftover pile from BDD is just as capable of
    // skewing it as the load test's own leftovers are capable of breaking
    // a later BDD re-run. bddStartedAt (not cleanup.mjs's own hardcoded
    // DEFAULT_SINCE) is what correctly spares the seed rows here — a
    // freshly deployed instance's seed data is just as "recent" as
    // anything BDD itself creates, so only a per-run cutoff captured at
    // the right moment (not a fixed calendar date) can tell them apart.
    // OrderFlow-specific — cleanup.mjs's schema is OrderFlow's own Prisma
    // schema; Uptime Kuma has nothing analogous.
    if (target === 'orderflow') {
      send({ type: 'progress', message: `$ node support/cleanup.mjs --since ${bddStartedAt}` });
      const cleanupResult = await runCommand('node', ['support/cleanup.mjs', '--since', bddStartedAt], TESTS_ROOT, testEnv, (message) => send({ type: 'progress', message }));
      if (cleanupResult.code !== 0) {
        send({ type: 'progress', message: `Warning: cleanup.mjs exited ${cleanupResult.code} — BDD test rows may still be in the database.` });
      }
    }

    send({
      type: 'done',
      target,
      testsPassed: testRun.code === 0,
      testsExitCode: testRun.code,
      reportGenerated: reportRun.code === 0,
    });
  } catch (err) {
    send({ type: 'error', error: (err as Error).message });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// E2E Agent — Suggest mode (run a real scenario, diagnose on failure) and
// Execute-with-approval (apply a proposed fix, typecheck, re-run), both
// already fully working as a CLI (`pnpm e2e`, `pnpm apply-fix`,
// agent-service/src/agents/e2e/). These routes are thin wrappers around
// that same code — runOneScenario/loadApplyPreview/performApply — just
// parameterized with this container's TESTS_ROOT/TEST_RUN_ENV instead of
// the CLI's host-layout constants.
// ---------------------------------------------------------------------------

const E2E_REPORT_NAME_PATTERN = /^e2e-[A-Za-z0-9:_.-]+\.json$/;
function e2eReportFilePath(name: string): string {
  if (!E2E_REPORT_NAME_PATTERN.test(name)) {
    throw Object.assign(new Error('Report name must be an exact "e2e-*.json" filename'), { status: 400 });
  }
  return join(config.reportsDir, name);
}

app.get('/api/e2e/scenarios', async (_req, res) => {
  try {
    res.json(await discoverScenarios(TESTS_ROOT));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/e2e/run', async (req, res) => {
  try {
    // Optional — E2E still only ever runs against ONE tests/ tree at a
    // time (whatever's currently rendered there), not a per-request
    // choice between several; this is purely for usage-log.jsonl
    // attribution (see diagnoseFailure()'s own comment). Omit it and
    // every diagnosis call still logs as 'orderflow', same as before this
    // field existed.
    const { scenarioIds, descriptor } = req.body as { scenarioIds?: string[]; descriptor?: string };
    const allScenarios = await discoverScenarios(TESTS_ROOT);

    let scenariosToRun;
    try {
      scenariosToRun = Array.isArray(scenarioIds) && scenarioIds.length ? resolveScenarioSelectors(allScenarios, scenarioIds) : allScenarios;
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    // Each scenario spawns its own bddgen + Playwright + cleanup cycle and,
    // on failure, one real Claude diagnosis call — can run for minutes with
    // nothing but a static "running…" status otherwise. Same NDJSON
    // streaming pattern as /api/tests/run and /api/generate/spec above.
    // Headers are only sent once scenario selection has already succeeded
    // (validated above), so a bad selector still gets a real 400.
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    const provider = new ClaudeProvider();
    const testEnv = await buildTestRunEnv(descriptor);
    try {
      const reports = [];
      for (const scenario of scenariosToRun) {
        send({ type: 'scenario-start', scenarioId: scenario.id, scenarioTitle: scenario.title });
        const { report, reportPath } = await runOneScenario(provider, 'claude', scenario, TESTS_ROOT, {
          env: testEnv,
          onProgress: (message) => send({ type: 'progress', message }),
          descriptor,
        });
        reports.push(report);
        // reportName (not the full path) is what /api/e2e/apply/preview and
        // /api/e2e/apply/confirm take — lets the UI offer "Apply fix"
        // directly off a just-finished run without a separate lookup.
        send({ type: 'scenario-done', report, reportName: reportPath.split('/').pop() });
      }
      send({ type: 'done', reports });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Lightweight summaries only (not full report bodies, which include a full
 *  Claude diagnosis + evidence dump) — covers both plain run reports
 *  (`e2e-<id>-<ts>.json`, has a `status`) and applied-fix reports
 *  (`e2e-<id>-applied-<ts>.json`, has an `outcome` instead), newest first. */
app.get('/api/e2e/reports', async (_req, res) => {
  const files = await readdir(config.reportsDir).catch(() => [] as string[]);
  const candidates = files.filter((f) => E2E_REPORT_NAME_PATTERN.test(f)).sort().reverse();

  const summaries: { name: string; scenarioId: string; scenarioTitle: string; kind: 'run' | 'applied'; status: string; startedAt: string }[] = [];
  for (const name of candidates) {
    try {
      const raw = JSON.parse(await readFile(join(config.reportsDir, name), 'utf-8'));
      const kind: 'run' | 'applied' = typeof raw.outcome === 'string' ? 'applied' : 'run';
      summaries.push({
        name,
        scenarioId: raw.scenarioId,
        scenarioTitle: raw.scenarioTitle,
        kind,
        status: kind === 'applied' ? raw.outcome : raw.status,
        startedAt: raw.startedAt,
      });
    } catch {
      // Not a usable report — omit it, same as /api/generate/reports's own philosophy.
    }
  }
  res.json(summaries);
});

app.get('/api/e2e/reports/:name', async (req, res) => {
  try {
    const raw = await readFile(e2eReportFilePath(req.params.name), 'utf-8');
    res.json(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No report named "${req.params.name}"` });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/e2e/apply/preview', async (req, res) => {
  try {
    const { report: reportName } = req.body as { report?: string };
    if (!reportName) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const result = await loadApplyPreview(e2eReportFilePath(reportName), TESTS_ROOT);
    // "Not applicable" (already applied, application_bug, no structuredFix,
    // etc.) is a normal, expected result to show the user inline — not a
    // server error. Same "expected failure is data, not a 500" philosophy
    // documented on runCommand() (util/runCommand.ts) for /api/tests/run.
    if (!result.ok) {
      res.json({ applicable: false, outcome: result.outcome, reason: result.reason });
      return;
    }
    res.json({ applicable: true, scenario: result.preview.scenario, diagnosis: result.preview.diagnosis, fix: result.preview.fix });
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/e2e/apply/confirm', async (req, res) => {
  try {
    // descriptor isn't persisted on the report itself (see runOneScenario's
    // own opts) so, unlike /api/tests/run and /api/e2e/run, there's nothing
    // to fall back on here — a caller re-verifying a fix against an
    // externally deployed target has to pass it explicitly, same optional/
    // backward-compatible shape as the other two routes otherwise.
    const { report: reportName, descriptor } = req.body as { report?: string; descriptor?: string };
    if (!reportName) {
      res.status(400).json({ error: '"report" is required' });
      return;
    }
    const reportPath = e2eReportFilePath(reportName);

    // Re-validate right before touching disk — never trust a client-held
    // preview from an earlier /apply/preview call: the report or the target
    // file could have changed, or this exact fix could already have been
    // applied, since that preview was fetched.
    const result = await loadApplyPreview(reportPath, TESTS_ROOT);
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }

    // Writes a real source file, typechecks, and re-runs the scenario — can
    // take a while, same NDJSON streaming pattern as /api/e2e/run above.
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');
    try {
      const startedAt = new Date().toISOString();
      const report = await performApply(reportPath, TESTS_ROOT, result.preview, startedAt, {
        env: await buildTestRunEnv(descriptor),
        onProgress: (message) => send({ type: 'progress', message }),
      });
      send({ type: 'done', report });
    } catch (err) {
      send({ type: 'error', error: (err as Error).message });
    }
    res.end();
  } catch (err) {
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[workbench] Descriptor editor: http://localhost:${PORT}`);
  console.log(`[workbench] Serving descriptors from ${DESCRIPTORS_DIR}`);
});

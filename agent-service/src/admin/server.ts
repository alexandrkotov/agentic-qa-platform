import express from 'express';
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { SystemDescriptorSchema, parseSystemDescriptor } from '../descriptor/schema.ts';
import type { SystemDescriptor, SystemComponent } from '../descriptor/schema.ts';
import { runDiscoveryForDescriptor } from '../bootstrap/discovery.ts';
import { parseDiscoveryReport } from '../agents/generate/reportSchema.ts';
import { proposeGrouping } from '../agents/generate/group.ts';
import { splitByBudget } from '../agents/generate/budget.ts';
import { generateGeneration } from '../agents/generate/spec.ts';
import type { AgentProvider } from '../providers/AgentProvider.ts';
import { renderGeneration, writeRenderedFiles } from '../agents/generate/render.ts';
import { compileAndVerify, collectExistingStepPatterns } from '../agents/generate/verify.ts';
import {
  ProposedGroupingSchema,
  ApprovedGroupingSchema,
  ProposedGenerationSchema,
  ApprovedGenerationSchema,
  CorrectionsSchema,
} from '../agents/generate/contract.ts';
import { loadCorrections, saveCorrections } from '../agents/generate/corrections.ts';
import { loadUatContext, saveUatContext } from '../agents/generate/uat.ts';
import { extractTextFromFile, extractTextFromGoogleUrl } from '../agents/generate/uatExtract.ts';
import multer from 'multer';
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

/** Returns a copy of the descriptor with postgres/rest-api/web-ui URLs pointed at this compose network's service names instead of "localhost". */
function rewriteForContainerNetwork(descriptor: SystemDescriptor): SystemDescriptor {
  const components: SystemComponent[] = descriptor.components.map((component) => {
    const host = CONTAINER_NETWORK_HOSTS[component.type];
    if (!host) return component;
    switch (component.type) {
      case 'postgres':
        return { ...component, connectionString: rewriteHost(component.connectionString, host) };
      case 'rest-api':
        return {
          ...component,
          swaggerUrl: rewriteHost(component.swaggerUrl, host),
          baseUrl: component.baseUrl ? rewriteHost(component.baseUrl, host) : component.baseUrl,
        };
      case 'web-ui':
        return { ...component, baseUrl: rewriteHost(component.baseUrl, host) };
      default:
        return component;
    }
  });
  return { ...descriptor, components };
}

/** Effective base origin a rest-api component's own tools/frontend would call — baseUrl if set, else the swagger URL's own origin (mirrors restApiBuilder's own doc comment). */
function restApiOrigin(descriptor: SystemDescriptor): string | null {
  const restApi = descriptor.components.find((c): c is Extract<SystemComponent, { type: 'rest-api' }> => c.type === 'rest-api');
  if (!restApi) return null;
  return new URL(restApi.baseUrl ?? restApi.swaggerUrl).origin;
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
    const rewritten = rewriteForContainerNetwork(descriptor);

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
    // A single file's own text stands alone, unchanged from before this
    // route supported more than one — only multiple files get a "## File:"
    // heading each, mirroring how uatExtract.ts already headers multiple
    // xlsx sheets the same way.
    const text =
      files.length === 1 ? extracted[0] : files.map((f, i) => `## File: ${f.originalname}\n${extracted[i]}`).join('\n\n');
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
 */
const TEST_RUN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  BACKEND_URL: 'http://app:3000',
  FRONTEND_URL: 'http://frontend:5173',
  DATABASE_URL: 'postgres://user:pass@db:5432/testdb',
  KAFKA_BROKERS: 'kafka:9092',
};

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
    const patternRegistry = await collectExistingStepPatterns(
      TESTS_STEPS_DIR,
      [...new Set(proposed.groups.map((g) => g.sourceKey))],
    );
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
    res.json({ written });
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Spec failed validation', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

/**
 * Runs a command to completion, resolving with its exit code and combined
 * stdout+stderr regardless of that code — a failing test run is a normal,
 * expected *result* to report back to the caller, not a server error. Only
 * rejects if the process itself can't be spawned at all.
 *
 * `onLine`, if given, fires once per complete line of combined stdout+stderr
 * AS IT ARRIVES (plus once more for any trailing partial line once the
 * process exits) — `npx bddgen && npx playwright test` can run for minutes
 * with nothing but a static "running…" status otherwise; this is what lets a
 * caller stream that instead.
 */
function runCommand(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onLine?: (line: string) => void): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env });
    let output = '';
    let lineBuffer = '';
    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (!onLine) return;
      lineBuffer += text;
      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf('\n')) >= 0) {
        onLine(lineBuffer.slice(0, newlineIndex));
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
      }
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (onLine && lineBuffer) onLine(lineBuffer);
      resolvePromise({ code: code ?? 1, output });
    });
  });
}

app.post('/api/tests/run', async (req, res) => {
  try {
    const testEnv = TEST_RUN_ENV;
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
    const { scenarioIds } = req.body as { scenarioIds?: string[] };
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
    try {
      const reports = [];
      for (const scenario of scenariosToRun) {
        send({ type: 'scenario-start', scenarioId: scenario.id, scenarioTitle: scenario.title });
        const { report, reportPath } = await runOneScenario(provider, 'claude', scenario, TESTS_ROOT, {
          env: TEST_RUN_ENV,
          onProgress: (message) => send({ type: 'progress', message }),
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
    // documented on runCommand() above for /api/tests/run.
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
    const { report: reportName } = req.body as { report?: string };
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
        env: TEST_RUN_ENV,
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

import express from 'express';
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
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
import { generateSpec } from '../agents/generate/spec.ts';
import {
  ProposedGroupingSchema,
  ApprovedGroupingSchema,
  ProposedSpecSchema,
  ApprovedSpecSchema,
  CorrectionsSchema,
} from '../agents/generate/contract.ts';
import { loadCorrections, saveCorrections } from '../agents/generate/corrections.ts';
import { proposeWorkflow } from '../agents/workflow/propose.ts';
import { proposeUiFlow } from '../agents/workflow/proposeUiFlow.ts';
import { proposeSequenceFlow } from '../agents/workflow/proposeSequenceFlow.ts';
import {
  renderErDiagram,
  renderStateDiagram,
  renderArchitectureDiagram,
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

    const provider = new ClaudeProvider();
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
    );
    res.json({ path: reportPath });
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
    const proposed = await proposeWorkflow(provider, report, path);
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
    const proposed = await proposeUiFlow(provider, report, path);
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
    const proposed = await proposeSequenceFlow(provider, report, path);
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
    const outPath = join(config.reportsDir, `generate-grouping-approved-${timestamp}.json`);
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
// Generate pipeline — Stage 2 (spec) proposal/approval. Makes a real LLM call
// (ClaudeProvider), unlike every other route on this server.
// ---------------------------------------------------------------------------

app.get('/api/generate/groupings', async (_req, res) => {
  const files = await readdir(config.reportsDir).catch(() => [] as string[]);
  const names = files.filter((f) => GROUPING_NAME_PATTERN.test(f)).sort();
  res.json(names);
});

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
    const report = parseDiscoveryReport(reportRaw);
    const reportJson = JSON.stringify(reportRaw, null, 2);
    const corrections = descriptor ? await loadCorrections(descriptorPath(descriptor)) : {};

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

    const provider = new ClaudeProvider();
    const { spec, failures } = await generateSpec(provider, renderGroups, report, reportJson, corrections, groupingPath);
    res.json({ spec, failures });
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
    const proposed = ProposedSpecSchema.parse(req.body);
    const approved = ApprovedSpecSchema.parse({ ...proposed, approvedAt: new Date().toISOString() });
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

app.listen(PORT, () => {
  console.log(`[workbench] Descriptor editor: http://localhost:${PORT}`);
  console.log(`[workbench] Serving descriptors from ${DESCRIPTORS_DIR}`);
});

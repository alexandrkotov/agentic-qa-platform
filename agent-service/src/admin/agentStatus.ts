// Backs GET /agent/status — polled every ~7s by the physical ESP32+ST7789
// status monitor (separate repo, github.com/alexandrkotov/agentic-qa-hardware-monitor).
// The JSON shape below is load-bearing on a device we can't hot-patch from
// here: `fetchStatus` in that repo's src/main.cpp parses these exact field
// names/types. Change this contract only alongside a firmware change.
//
//   {"descriptor":"orderflow",
//    "bdd":{"phase":"passed","passed":12,"failed":2},
//    "k6":{"vus":20,"rps":145.3,"p95Ms":230,"errorRate":0.4},
//    "ci":{"status":"success","branch":"main","commit":"a1b2c3d","runNumber":42}}
//
// Three independent sources, aggregated:
//  - bdd: the last Playwright/Cucumber run's own report.json on disk
//    (tests/reports/cucumber-json/report.json — see tests/playwright.config.ts's
//    cucumberReporter('json', ...) and support/generate-html-report.mjs, which
//    reads the same file).
//  - k6: InfluxDB, the same measurements loadtests/grafana's own k6-results.json
//    dashboard already graphs (http_reqs/vus/http_req_duration/http_req_failed,
//    tagged `descriptor=<name>` — see /api/load/:descriptor/run's own `--tag`).
//  - ci: the GitHub Actions REST API for this repo's own default branch.
//
// Any one source failing (no report yet, InfluxDB down, GitHub API
// unreachable/rate-limited) degrades that section to a documented zero
// value rather than failing the whole request — a blank display is worse
// than a stale-looking one, and the ESP32 has no fallback rendering for a
// non-200/malformed response.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentBddStatus {
  phase: string;
  passed: number;
  failed: number;
}

export interface AgentK6Status {
  vus: number;
  rps: number;
  p95Ms: number;
  errorRate: number;
}

export interface AgentCiStatus {
  status: string;
  branch: string;
  commit: string;
  runNumber: number;
}

export interface AgentStatus {
  descriptor: string;
  bdd: AgentBddStatus;
  k6: AgentK6Status;
  ci: AgentCiStatus;
}

const DEFAULT_BDD: AgentBddStatus = { phase: 'no-report', passed: 0, failed: 0 };
const DEFAULT_K6: AgentK6Status = { vus: 0, rps: 0, p95Ms: 0, errorRate: 0 };
const DEFAULT_CI: AgentCiStatus = { status: 'unknown', branch: '', commit: '', runNumber: 0 };

// ---------------------------------------------------------------------------
// bdd — read straight off the last suite run's cucumber JSON, same file
// support/generate-html-report.mjs reads (RAW_JSON_DIR = 'reports/cucumber-json',
// relative to TESTS_ROOT). Standard Cucumber JSON: one entry per feature,
// each with `elements` (scenario + background blocks), each with `steps`,
// each step carrying `result.status`. Only `type: 'scenario'` elements are
// counted — backgrounds aren't independently pass/fail.
//
// A scenario counts as failed unless every one of its steps came back
// "passed" — deliberately not just checking for a "failed" step: a step
// downstream of a real failure is reported "skipped", and an unimplemented
// step comes back "undefined"/"pending". All of those mean the scenario
// didn't actually pass, same as this repo's own /api/tests/run treats a
// nonzero Playwright exit code as testsPassed: false.
// ---------------------------------------------------------------------------

interface CucumberStep {
  result?: { status?: string };
}
interface CucumberElement {
  type?: string;
  steps?: CucumberStep[];
}
interface CucumberFeature {
  elements?: CucumberElement[];
}

function countScenarios(features: CucumberFeature[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const feature of features) {
    for (const element of feature.elements ?? []) {
      if (element.type !== 'scenario') continue;
      const steps = element.steps ?? [];
      const allPassed = steps.length > 0 && steps.every((s) => s.result?.status === 'passed');
      if (allPassed) passed++;
      else failed++;
    }
  }
  return { passed, failed };
}

async function getBddStatus(testsRoot: string): Promise<AgentBddStatus> {
  const reportPath = join(testsRoot, 'reports', 'cucumber-json', 'report.json');
  let raw: string;
  try {
    raw = await readFile(reportPath, 'utf-8');
  } catch {
    // No suite has run yet in this checkout — a legitimate, common state
    // (a fresh clone, or right after a suite swap before "Run tests" is
    // clicked again), not an error.
    return DEFAULT_BDD;
  }
  const features = JSON.parse(raw) as CucumberFeature[];
  const { passed, failed } = countScenarios(features);
  return { phase: failed > 0 ? 'failed' : 'passed', passed, failed };
}

// ---------------------------------------------------------------------------
// k6 — InfluxDB 1.x query API. Workbench and influxdb are both plain
// services in the same docker-compose.yml, on its one default network
// (`agentic-qa-platform-net`), so the bare service hostname resolves with
// no extra_hosts/rewrite dance (unlike a docker-compose-deployed *target*,
// which needs host.docker.internal — not the case here, influxdb is part of
// this project's own compose file). INFLUXDB_URL exists purely as an escape
// hatch for running server.ts directly on the host (`pnpm workbench`),
// where "influxdb" doesn't resolve at all.
//
// Deliberately a live-ish recent-window read (last 15s), not a frozen "last
// completed run" summary: this endpoint feeds a physical status monitor
// meant to visibly react while a load test is running, and a k6 run's own
// points already stop arriving the moment it ends — a short window that
// finds nothing just reads as vus/rps 0, which is exactly correct for
// "no load test running right now".
// ---------------------------------------------------------------------------

const INFLUXDB_URL = process.env.INFLUXDB_URL ?? 'http://influxdb:8086';
const INFLUXDB_DB = 'k6';
const K6_WINDOW = '15s';
const HTTP_TIMEOUT_MS = 4000;

async function influxFirstValue(query: string): Promise<number | null> {
  const url = `${INFLUXDB_URL}/query?db=${INFLUXDB_DB}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`InfluxDB query failed: ${res.status}`);
  const body = (await res.json()) as { results?: { series?: { values?: unknown[][] }[] }[] };
  const values = body.results?.[0]?.series?.[0]?.values;
  const value = values?.[0]?.[1];
  return typeof value === 'number' ? value : null;
}

async function getK6Status(descriptor: string): Promise<AgentK6Status> {
  // Same InfluxQL shape (measurement names, `descriptor` tag, GROUP BY-free
  // point read) as loadtests/grafana/dashboards/k6-results.json's own
  // panels — kept consistent on purpose so this endpoint and the Grafana
  // dashboard never quietly disagree about where these numbers come from.
  // `descriptor` is validated by the caller (server.ts's NAME_PATTERN)
  // before it ever reaches a query string here.
  const [vus, reqCount, p95, errorFrac] = await Promise.all([
    influxFirstValue(`SELECT last("value") FROM "vus" WHERE "descriptor"='${descriptor}' AND time > now() - ${K6_WINDOW}`),
    influxFirstValue(`SELECT count("value") FROM "http_reqs" WHERE "descriptor"='${descriptor}' AND time > now() - ${K6_WINDOW}`),
    influxFirstValue(`SELECT percentile("value", 95) FROM "http_req_duration" WHERE "descriptor"='${descriptor}' AND time > now() - ${K6_WINDOW}`),
    influxFirstValue(`SELECT mean("value") FROM "http_req_failed" WHERE "descriptor"='${descriptor}' AND time > now() - ${K6_WINDOW}`),
  ]);
  const windowSeconds = Number.parseInt(K6_WINDOW, 10);
  return {
    vus: vus !== null ? Math.round(vus) : 0,
    rps: reqCount !== null ? Math.round((reqCount / windowSeconds) * 10) / 10 : 0,
    p95Ms: p95 !== null ? Math.round(p95) : 0,
    errorRate: errorFrac !== null ? Math.round(errorFrac * 1000) / 10 : 0,
  };
}

// ---------------------------------------------------------------------------
// ci — GitHub Actions REST API, latest run on this repo's default branch.
// Token stays server-side by design (GITHUB_TOKEN, optional): the device
// only ever talks to this endpoint on the LAN, never to GitHub directly.
// Unauthenticated calls work fine against a public repo but are capped at
// 60/hour — getAgentStatus()'s own cache TTL (below) is sized around that
// limit whether or not a token is configured, so this function itself
// doesn't need to know which case it's in.
// ---------------------------------------------------------------------------

const GITHUB_OWNER = process.env.GITHUB_REPO_OWNER ?? 'alexandrkotov';
const GITHUB_REPO = process.env.GITHUB_REPO_NAME ?? 'agentic-qa-platform';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';

interface GitHubRun {
  status?: string;
  conclusion?: string | null;
  head_branch?: string;
  head_sha?: string;
  run_number?: number;
}

async function getCiStatus(): Promise<AgentCiStatus> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=1`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub API request failed: ${res.status}`);
  const body = (await res.json()) as { workflow_runs?: GitHubRun[] };
  const run = body.workflow_runs?.[0];
  if (!run) return DEFAULT_CI;
  // GitHub separates "is it still going" (status) from "how did it end"
  // (conclusion, only meaningful once status is "completed") — the
  // firmware's contract wants one word for both, so an in-progress/queued
  // run reports as "running" and a completed one reports its conclusion
  // (success/failure/cancelled/...) directly.
  const status = run.status === 'completed' ? (run.conclusion ?? 'unknown') : 'running';
  return {
    status,
    branch: run.head_branch ?? '',
    commit: (run.head_sha ?? '').slice(0, 7),
    runNumber: run.run_number ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Aggregate + cache. One TTL for the whole response (not per-section) —
// simplest thing that keeps the GitHub Actions call inside its rate limit;
// bdd/k6 are cheap enough that caching them too is just a side effect, not
// the reason this exists. 65s (unauthenticated) sits just past the 60
// req/hour = 1-per-60s GitHub budget; a configured GITHUB_TOKEN (5000/hour)
// gets a much shorter 15s so the display still feels reasonably live.
// ---------------------------------------------------------------------------

const STATUS_CACHE_TTL_MS = GITHUB_TOKEN ? 15_000 : 65_000;
const statusCache = new Map<string, { data: AgentStatus; expiresAt: number }>();

export async function getAgentStatus(descriptor: string, testsRoot: string): Promise<AgentStatus> {
  const cached = statusCache.get(descriptor);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const [bdd, k6, ci] = await Promise.all([
    getBddStatus(testsRoot).catch((err) => {
      console.error('[agent/status] bdd section failed:', (err as Error).message);
      return DEFAULT_BDD;
    }),
    getK6Status(descriptor).catch((err) => {
      console.error('[agent/status] k6 section failed:', (err as Error).message);
      return DEFAULT_K6;
    }),
    getCiStatus().catch((err) => {
      console.error('[agent/status] ci section failed:', (err as Error).message);
      return DEFAULT_CI;
    }),
  ]);

  const data: AgentStatus = { descriptor, bdd, k6, ci };
  statusCache.set(descriptor, { data, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
  return data;
}

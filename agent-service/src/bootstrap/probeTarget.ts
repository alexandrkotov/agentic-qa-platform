import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';
import type { SystemComponent } from '../descriptor/schema.ts';
import { resolveTargetPaths, type DeployState, type PortMapping } from './deployTarget.ts';
import { targetsDirFromEnv } from './targetsDir.ts';
import { hasSetup } from './setupTarget.ts';
import { detectKafkaServices } from './kafkaDetect.ts';

// ---------------------------------------------------------------------------
// Step (4) of the "External Target Onboarding" initiative — after a real
// deploy, mechanically probe the running stack for common signals and
// propose candidate components. Entirely mechanical: no Claude call, no
// cost, same "free, instant" precedent as this app's own Architecture/ER/
// API-Inventory diagrams. Everything needed already sits on disk the
// moment deployTarget.ts's own deployTarget() finishes — the flattened
// `docker compose config --format json` result (every service's image,
// environment, volumes, ports) and the actual allocated port map. This
// module only reads those two files plus a handful of real HTTP requests.
//
// Three real, verified-live constraints shaped this file's design —
// see memory `project_external_target_demo_idea` for the full account,
// checked directly against real `targets/wger`/`targets/uptime-kuma`
// resolved configs already on disk, not assumed:
//
// 1. A database image does NOT guarantee a published port — wger's own
//    real `db` service (postgres) has no published port at all; only
//    `nginx` does, out of its whole 7-service stack. There is no network
//    path from `workbench` to an unpublished port on a different compose
//    project's private network. So database detection only ever fires
//    when the target's own compose file chose to publish that port —
//    every other case is reported honestly as unclassified, never a
//    fabricated connection string that could never actually connect.
// 2. A sqlite `.db` file is never itself named in the compose config —
//    Uptime Kuma's own real volume entry is a *directory* bind mount
//    (`.../repo/data` -> `/app/data`); the file only exists once the app
//    has run and created it. So sqlite detection has to actually look
//    inside each bind-mounted directory, not string-match a volume path.
// 3. `postgres`/`sqlite`/`mysql`/`mongo`/`mssql` all exist as DB-shaped
//    component types in descriptor/schema.ts, and a detected image for any
//    of them becomes a real candidate. mssql is the odd one out of the
//    five: descriptor/components/mssql.ts doesn't reach a target's SQL
//    Server over a published port at all (a real Docker Desktop/WSL2
//    connectivity limitation for this engine specifically — see that
//    file's own header comment) — it joins `workbench` onto the target's
//    own Docker network on demand instead, so an mssql candidate here
//    needs no published port and proposes the target's own compose
//    service name as the connectionString host, not
//    "host.docker.internal". It also can't propose a real application
//    database name the way postgres/mysql do (`POSTGRES_DB`/
//    `MYSQL_DATABASE`) — the official mssql/server image has no
//    equivalent env var — so it proposes "master" (always exists) as an
//    explicit placeholder instead of guessing.
// ---------------------------------------------------------------------------

export interface ProbeCandidate {
  /** Ready to push straight into a descriptor's components[] as-is — the human still reviews/edits/saves, same "propose, human confirms" pattern as everywhere else in this app. */
  component: SystemComponent;
  /** Human-readable "why this was proposed" — shown next to the candidate, same spirit as this app's other proposal surfaces citing their own evidence. */
  evidence: string;
}

export interface ProbeUnclassified {
  label: string;
  reason: string;
}

/** Advisory only — see pass 4's own module comment below. Never becomes a
 *  component; there's no "this needs a setup script" type in schema.ts,
 *  and this app never writes bootstrap/setup/*.ts for you. */
export interface ProbeSetupHint {
  service: string;
  port: number;
  evidence: string;
}

export interface ProbeResult {
  candidates: ProbeCandidate[];
  unclassified: ProbeUnclassified[];
  setupHints: ProbeSetupHint[];
}

/** Distinct from a generic failure so admin/server.ts's route can tell "deploy first" apart from a real bug — same shape as deployTarget.ts's own DeployCancelledError being exported for the same reason. */
export class ProbeTargetError extends Error {}

// targetsDirFromEnv() itself now lives in ./targetsDir.ts (factored out once
// descriptor/components/mssql.ts needed the identical HOST_PROJECT_ROOT
// logic) — this thin wrapper just keeps this file's own error type
// (ProbeTargetError, not a plain Error) for anything that calls
// probeTarget() below. Its own doc-comment there still applies: nothing in
// this file starts a container or asks the daemon to resolve anything, so
// mirror-correctness genuinely doesn't matter for these reads the way it
// does for an actual deploy.
function targetsDirOrThrowProbeError(): string {
  try {
    return targetsDirFromEnv();
  } catch (err) {
    throw new ProbeTargetError((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Resolved compose config shapes this file needs beyond what
// deployTarget.ts's own ComposeConfig/ComposeService/ComposePort already
// cover (ports) — environment and volumes, confirmed live against wger's
// real resolved.json: `environment` normalizes to a plain {KEY: value}
// object (not an array of "KEY=value" strings), `volumes[].source` is
// already an absolute host path for `type: 'bind'` entries (a named
// volume's `source` is just an identifier, not a path — only `bind`
// entries are usable here).
// ---------------------------------------------------------------------------

interface ComposeVolume {
  type: string;
  source?: string;
  target?: string;
  [key: string]: unknown;
}
interface ComposePort {
  target: number;
  published?: string | number;
  protocol?: string;
  [key: string]: unknown;
}
interface ComposeService {
  image?: string;
  environment?: Record<string, string>;
  ports?: ComposePort[];
  volumes?: ComposeVolume[];
  [key: string]: unknown;
}
interface ComposeConfig {
  services?: Record<string, ComposeService>;
  [key: string]: unknown;
}

async function readJsonFile<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProbeTargetError('No deployed configuration found for this target yet — deploy it first.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pass 1 — database images. postgres/mysql/mongo/mssql can all become real
// candidates (see the module comment above for how mssql's own path
// differs from the other three, and why an unpublished port still means
// an honest unclassified note for postgres/mysql/mongo specifically).
// ---------------------------------------------------------------------------

const DB_IMAGE_PATTERNS: Array<{ engine: string; test: (image: string) => boolean }> = [
  { engine: 'postgres', test: (img) => /(^|\/)(postgres|postgis)(:|$)/i.test(img) },
  { engine: 'mysql/mariadb', test: (img) => /(^|\/)(mysql|mariadb)(:|$)/i.test(img) },
  { engine: 'mongodb', test: (img) => /(^|\/)mongo(:|$)/i.test(img) },
  { engine: 'mssql', test: (img) => /(^|\/)mssql\/server(:|$)/i.test(img) },
];

function detectDbCandidates(
  config: ComposeConfig,
  ports: PortMapping[],
  claimedPorts: Set<number>,
): { candidates: ProbeCandidate[]; unclassified: ProbeUnclassified[] } {
  const candidates: ProbeCandidate[] = [];
  const unclassified: ProbeUnclassified[] = [];

  for (const [serviceName, service] of Object.entries(config.services ?? {})) {
    const image = service.image;
    if (!image) continue;
    const match = DB_IMAGE_PATTERNS.find((p) => p.test(image));
    if (!match) continue;

    const label = `${serviceName} (image ${image})`;
    const env = service.environment ?? {};

    // mssql doesn't go through a published port at all — see the module
    // comment above — so it's handled before the published-port gate
    // below, which the other three engines still need.
    if (match.engine === 'mssql') {
      // Official mssql/server image env var: SA_PASSWORD (2019-era images,
      // e.g. nopCommerce's own compose file) / MSSQL_SA_PASSWORD (newer) —
      // check both, whichever is actually set wins.
      const password = env.MSSQL_SA_PASSWORD ?? env.SA_PASSWORD;
      if (!password) {
        unclassified.push({
          label,
          reason: 'looks like mssql, but neither MSSQL_SA_PASSWORD nor SA_PASSWORD was found in the compose environment — add the component by hand with the real "sa" password rather than guessing.',
        });
        continue;
      }
      candidates.push({
        component: {
          type: 'mssql',
          name: serviceName,
          // "master" always exists on a fresh SQL Server instance — unlike
          // postgres/mysql, the official mssql/server image has no
          // env-var-driven default application database, so there's
          // nothing real to propose there instead. The target's own
          // install process usually creates the real application database
          // later (confirmed live: nopCommerce's own install wizard does
          // exactly this) — update this once it does.
          connectionString: `mssql://sa:${password}@${serviceName}:1433/master`,
        },
        evidence: `image ${image}, credentials found in the compose environment — connects over the target's own Docker network on demand (see mssql.ts), no published port needed; "master" is a placeholder database, update it once the target's own install process creates the real one`,
      });
      continue;
    }

    const published = ports.find((p) => p.service === serviceName)?.publishedPort;

    if (!published) {
      unclassified.push({
        label,
        reason: 'looks like a database, but this service has no port published to the host — nothing for the platform to reach over the network. Publish the port in the target\'s own compose file if this needs testing, or add a component by hand.',
      });
      continue;
    }

    if (match.engine === 'postgres') {
      const user = env.POSTGRES_USER;
      const password = env.POSTGRES_PASSWORD;
      const db = env.POSTGRES_DB;
      if (!user || !password || !db) {
        unclassified.push({
          label,
          reason: 'looks like postgres with a published port, but POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB were not all found in the compose environment — add the component by hand with the real credentials rather than guessing.',
        });
        continue;
      }
      claimedPorts.add(published);
      candidates.push({
        component: {
          type: 'postgres',
          name: serviceName,
          connectionString: `postgresql://${user}:${password}@host.docker.internal:${published}/${db}`,
        },
        evidence: `image ${image} on published port ${published}, credentials found in the compose environment`,
      });
      continue;
    }

    if (match.engine === 'mysql/mariadb') {
      // Same official-image env var names for both mysql and mariadb
      // (MariaDB's own MARIADB_* aliases are newer; MYSQL_* still always
      // works) — confirmed live against Snipe-IT's real `mariadb:11.4.7`.
      const user = env.MYSQL_USER;
      const password = env.MYSQL_PASSWORD;
      const db = env.MYSQL_DATABASE;
      if (!user || !password || !db) {
        unclassified.push({
          label,
          reason: 'looks like mysql/mariadb with a published port, but MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE were not all found in the compose environment — add the component by hand with the real credentials rather than guessing.',
        });
        continue;
      }
      claimedPorts.add(published);
      candidates.push({
        component: {
          type: 'mysql',
          name: serviceName,
          connectionString: `mysql://${user}:${password}@host.docker.internal:${published}/${db}`,
        },
        evidence: `image ${image} on published port ${published}, credentials found in the compose environment`,
      });
      continue;
    }

    if (match.engine === 'mongodb') {
      // Unlike postgres/mysql, a real mongo deployment commonly runs with
      // NO root auth configured at all — confirmed live, Wekan's own
      // real-mongo compose (docker-compose-mongodb-v7.yml) sets none.
      // That's a legitimate, connectable state, not missing information
      // to fall back to unclassified for — only include the auth/database
      // segments in the connection string when they're actually present.
      const user = env.MONGO_INITDB_ROOT_USERNAME;
      const password = env.MONGO_INITDB_ROOT_PASSWORD;
      const db = env.MONGO_INITDB_DATABASE;
      const hasAuth = Boolean(user && password);
      const auth = hasAuth ? `${user}:${password}@` : '';
      const dbPath = db ? `/${db}` : '';
      // directConnection=true — confirmed live (2026-08-12) this is NOT
      // optional: Wekan's own mongod runs as a single-node replica set,
      // and the official driver's admin-level commands (listDatabases,
      // etc. — the exact shape the mongodb-mcp-server component tool
      // itself issues) trigger full topology discovery, which then tries
      // to follow the replica set's own internal hostname
      // ("wekandb:27017") reported by its config — unreachable from
      // outside the compose network, `getaddrinfo ENOTFOUND`. A plain
      // query without this flag can appear to work (matches an earlier,
      // narrower observation for this same target) but the connection
      // string proposed here needs to hold up for real component usage,
      // not just the simplest possible query.
      claimedPorts.add(published);
      candidates.push({
        component: {
          type: 'mongo',
          name: serviceName,
          connectionString: `mongodb://${auth}host.docker.internal:${published}${dbPath}?directConnection=true`,
        },
        evidence: hasAuth
          ? `image ${image} on published port ${published}, credentials found in the compose environment`
          : `image ${image} on published port ${published}, no root auth configured in the compose environment — connecting without credentials`,
      });
      continue;
    }

    // DB_IMAGE_PATTERNS currently only has entries for the three engines
    // handled above — this stays as an honest fallback rather than
    // silently dropping a future pattern that lands here without a
    // matching branch.
    unclassified.push({
      label,
      reason: `looks like ${match.engine}, but there is no matching component type in this app's schema yet — add one by hand to descriptor/schema.ts, or wire the component up manually once a type exists.`,
    });
  }

  return { candidates, unclassified };
}

// ---------------------------------------------------------------------------
// Pass 1b — Kafka brokers, by image (bootstrap/kafkaDetect.ts's own
// KAFKA_IMAGE_PATTERNS, shared with deployTarget.ts's alias injection and
// kafkaUiSync.ts). This candidate feeds a completely different consumer
// than kafkaUiSync.ts's own multi-cluster kafka-ui config: a `kafka`
// component here is for kafka-mcp-server (Discovery), which runs
// `--network=host` (descriptor/components/kafka.ts) — so it needs a
// published port and `host.docker.internal`, the exact same constraint
// pass 1 above already has for postgres/mysql/mongo, not the network-join
// + alias mechanism kafka-ui itself uses. This is best-effort, same honesty
// standard as the rest of this file: a third-party Kafka compose file can
// set `advertised.listeners` to point back at an internal-only address
// even when a port IS published, in which case a real client connecting
// via the published port still fails once it follows the broker's own
// metadata — this proposal can't detect that in advance, so the evidence
// string says so rather than implying a guarantee.
// ---------------------------------------------------------------------------

function detectKafkaCandidates(
  config: ComposeConfig,
  ports: PortMapping[],
  claimedPorts: Set<number>,
): { candidates: ProbeCandidate[]; unclassified: ProbeUnclassified[] } {
  const candidates: ProbeCandidate[] = [];
  const unclassified: ProbeUnclassified[] = [];

  for (const { serviceName, image } of detectKafkaServices(config)) {
    const label = `${serviceName} (image ${image})`;
    const published = ports.find((p) => p.service === serviceName)?.publishedPort;

    if (!published) {
      unclassified.push({
        label,
        reason: 'looks like a Kafka broker, but this service has no port published to the host — nothing for a host-network MCP client to reach. Publish the port in the target\'s own compose file if this needs testing, or add a component by hand.',
      });
      continue;
    }

    claimedPorts.add(published);
    candidates.push({
      component: { type: 'kafka', name: serviceName, brokers: [`host.docker.internal:${published}`] },
      evidence: `image ${image} on published port ${published} — best-effort: if this broker's own advertised.listeners points at an internal-only address, this connection string may still fail once a client follows the broker's own metadata; verify connectivity before relying on it.`,
    });
  }

  return { candidates, unclassified };
}

// ---------------------------------------------------------------------------
// Pass 2 — sqlite files. Filesystem-based, not network-based, so it isn't
// subject to pass 1's published-port limitation — genuinely the most
// reliable signal this whole feature has. Bounded depth/file count, same
// kind of sane limit deployTarget.ts's own port scan already uses.
// ---------------------------------------------------------------------------

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);
const MAX_READDIR_DEPTH = 3;
const MAX_FILES_SCANNED = 500;

async function findSqliteFiles(dir: string, depth: number, budget: { remaining: number }): Promise<string[]> {
  if (depth > MAX_READDIR_DEPTH || budget.remaining <= 0) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // not a real/readable directory — nothing to find, not an error worth surfacing
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    budget.remaining--;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findSqliteFiles(full, depth + 1, budget)));
    } else if (SQLITE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

async function detectSqliteCandidates(config: ComposeConfig): Promise<ProbeCandidate[]> {
  const candidates: ProbeCandidate[] = [];
  const seen = new Set<string>();
  const budget = { remaining: MAX_FILES_SCANNED };

  for (const service of Object.values(config.services ?? {})) {
    for (const volume of service.volumes ?? []) {
      if (volume.type !== 'bind' || !volume.source) continue; // a named volume's `source` is just an identifier, not a real path
      for (const file of await findSqliteFiles(volume.source, 0, budget)) {
        if (seen.has(file)) continue;
        seen.add(file);
        const base = file.split('/').pop()!.replace(extname(file), '');
        candidates.push({
          component: { type: 'sqlite', name: base, path: file },
          evidence: `found under a bind-mounted volume (${volume.source})`,
        });
      }
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Pass 3 — HTTP. Every published port pass 1 didn't already claim. Only
// the very first request to a port gets the bounded retry (absorbing
// residual container-startup lag, same spirit as deployTarget.ts's own
// postUpExec retry) — once that request gets ANY response, the port is
// confirmed alive and the rest of this pass's checks are single-shot.
// ---------------------------------------------------------------------------

const SWAGGER_PATHS = ['/swagger.json', '/openapi.json', '/v3/api-docs', '/api-docs', '/docs-json'];
const HTTP_RETRY_ATTEMPTS = 3;
const HTTP_RETRY_DELAY_MS = 2000;
const HTTP_TIMEOUT_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

async function fetchWithRetry(url: string): Promise<Response | null> {
  for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt++) {
    const res = await fetchOnce(url);
    if (res) return res;
    if (attempt < HTTP_RETRY_ATTEMPTS) await sleep(HTTP_RETRY_DELAY_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 4 — setup-wizard hint. Step 1 of the setup-script-autogen idea (see
// memory `project_setup_script_autogen_idea`): entirely mechanical/free,
// no Claude call — this only flags whether a target's root page LOOKS like
// a first-run wizard rather than a login/dashboard, so a human knows it's
// worth recording one. (Step 2 — actually generating the SetupFn script —
// is deliberately NOT built here: that memory now records a human-records,
// agent-converts design using `playwright codegen`, not the LLM-explores-
// blindly shape originally floated.)
//
// A plain `fetch` genuinely cannot see this for a client-rendered SPA —
// confirmed live against Uptime Kuma's own real wizard: `curl`'d HTML is a
// byte-identical Vite/Vue shell (`<div id="app"></div>`) whether the
// instance is pre- or post-setup; the real markup only exists once client
// JS actually runs. So this pass renders with Playwright instead of a
// plain fetch — the same `chromium` import `setup/uptime-kuma.ts` already
// uses, for the identical reason. Real cost: a headless browser launch
// plus one page load per candidate HTML port (a few seconds) — still zero
// dollars, no Claude call, so still safe to run on every probe.
//
// The heuristic below was tuned against Uptime Kuma's own real 3-step
// wizard, confirmed live across all 3 real states it can be in. A probe
// only ever sees the FIRST screen — it deliberately never clicks through
// steps, that's the future recording flow's job, not this cheap pass — and
// that first screen commonly has NO password field yet (Kuma's own step 1
// is a database picker, not account creation). So unlike an earlier draft
// of this heuristic, password-field count is corroborating evidence only,
// never a hard requirement: requiring wizard-style wording AND the absence
// of ordinary login wording is what actually keeps this from firing on a
// plain login page.
// ---------------------------------------------------------------------------

const WIZARD_KEYWORDS_RE =
  /(create (an |your )?(admin|administrator) account|initial setup|setup wizard|first[- ]run|welcome to setup|configure your installation|which .*(database|storage).*(would you like|do you want) to use|choose (a|your) database|select (a|your) database)/i;
const LOGIN_MARKERS_RE = /\b(log in|sign in|remember me|forgot password)\b/i;

/** Pure on purpose — kept separate from the Playwright rendering below so
 *  the actual matching logic can be reasoned about (and re-tuned) without
 *  touching browser plumbing. Returns null rather than a boolean so the
 *  caller gets an honest, non-fabricated evidence string straight from
 *  the real match, not a made-up one. */
function detectSetupWizardHint(bodyText: string, passwordFieldCount: number): string | null {
  const wizardMatch = bodyText.match(WIZARD_KEYWORDS_RE);
  if (!wizardMatch) return null;
  if (LOGIN_MARKERS_RE.test(bodyText)) return null; // also looks like an ordinary login page — don't second-guess it
  const fieldNote = passwordFieldCount > 0 ? `, ${passwordFieldCount} password field(s) present` : '';
  return `page text matched "${wizardMatch[0]}"${fieldNote}, no login-page wording (log in/sign in/remember me/forgot password) found`;
}

async function detectHttpCandidates(
  ports: PortMapping[],
  claimedPorts: Set<number>,
  alreadyHasSetup: boolean,
): Promise<{ candidates: ProbeCandidate[]; unclassified: ProbeUnclassified[]; setupHints: ProbeSetupHint[] }> {
  const candidates: ProbeCandidate[] = [];
  const unclassified: ProbeUnclassified[] = [];
  const setupHints: ProbeSetupHint[] = [];
  const seenPorts = new Set<number>();

  // Launched lazily, on the first HTML port that actually needs it — most
  // probe calls hit a target that either has no HTML port at all or
  // already has a registered setup script (alreadyHasSetup), so this
  // avoids paying for a browser launch on every probe regardless.
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    for (const mapping of ports) {
      if (claimedPorts.has(mapping.publishedPort) || seenPorts.has(mapping.publishedPort)) continue;
      seenPorts.add(mapping.publishedPort);

      const base = `http://host.docker.internal:${mapping.publishedPort}`;
      const rootRes = await fetchWithRetry(`${base}/`);
      if (!rootRes) continue; // never answered after retries — nothing useful to report

      let classified = false;
      const contentType = rootRes.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        candidates.push({
          component: { type: 'web-ui', name: mapping.service, baseUrl: base, routes: ['/'] },
          evidence: `service "${mapping.service}", port ${mapping.publishedPort} — "/" returned HTML`,
        });
        classified = true;

        if (!alreadyHasSetup) {
          try {
            browser ??= await chromium.launch();
            const page = await browser.newPage();
            try {
              await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: HTTP_TIMEOUT_MS * 3 });
              const [bodyText, passwordFieldCount] = await Promise.all([
                page.locator('body').innerText(),
                page.locator('input[type="password"]').count(),
              ]);
              const evidence = detectSetupWizardHint(bodyText, passwordFieldCount);
              if (evidence) {
                setupHints.push({ service: mapping.service, port: mapping.publishedPort, evidence });
              }
            } finally {
              await page.close();
            }
          } catch {
            // A page that fails to render (timeout, crash, whatever) just
            // means no hint for this port — same "honest silence, not a
            // fabricated result" spirit as every other pass in this file.
          }
        }
      }

      // Not mutually exclusive with the web-ui check above — plenty of real
      // apps serve both a UI and an API on the same port.
      for (const path of SWAGGER_PATHS) {
        const res = await fetchOnce(`${base}${path}`);
        if (!res?.ok) continue;
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          continue;
        }
        if (body && typeof body === 'object' && ('openapi' in body || 'swagger' in body)) {
          candidates.push({
            component: { type: 'rest-api', name: `${mapping.service}_rest`, swaggerUrl: `${base}${path}` },
            evidence: `service "${mapping.service}", port ${mapping.publishedPort} — real OpenAPI/Swagger response at ${path}`,
          });
          classified = true;
          break; // one swagger candidate is enough per port
        }
      }

      if (!classified) {
        unclassified.push({
          label: `port ${mapping.publishedPort} (service "${mapping.service}")`,
          reason: `responded (status ${rootRes.status}, content-type "${contentType || 'none'}") but didn't look like a web UI or a known REST API shape — add a component by hand if this needs testing.`,
        });
      }
    }
  } finally {
    await browser?.close();
  }

  return { candidates, unclassified, setupHints };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function probeTarget(name: string): Promise<ProbeResult> {
  const targetsDir = targetsDirOrThrowProbeError();
  const paths = resolveTargetPaths(targetsDir, name);

  const config = await readJsonFile<ComposeConfig>(paths.resolvedConfigPath);
  const state = await readJsonFile<DeployState>(paths.statePath);

  const claimedPorts = new Set<number>();
  const db = detectDbCandidates(config, state.ports, claimedPorts);
  const kafka = detectKafkaCandidates(config, state.ports, claimedPorts);
  const sqliteCandidates = await detectSqliteCandidates(config);
  const http = await detectHttpCandidates(state.ports, claimedPorts, hasSetup(name));

  return {
    candidates: [...db.candidates, ...kafka.candidates, ...sqliteCandidates, ...http.candidates],
    unclassified: [...db.unclassified, ...kafka.unclassified, ...http.unclassified],
    setupHints: http.setupHints,
  };
}

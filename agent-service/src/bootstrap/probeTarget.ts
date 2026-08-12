import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { SystemComponent } from '../descriptor/schema.ts';
import { resolveTargetPaths, type DeployState, type PortMapping } from './deployTarget.ts';

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
// 3. `postgres`/`sqlite`/`mysql`/`mongo` all exist as DB-shaped component
//    types in descriptor/schema.ts (mysql/mongo shipped 2026-08-11, proven
//    live against Snipe-IT/Wekan — see memory `project_external_target_demo_idea`)
//    — a detected image for any of those four becomes a real candidate.
//    `mssql` also exists as a type, but DB_IMAGE_PATTERNS below still has
//    no pattern for it (a real host.docker.internal connectivity
//    limitation for this engine in this environment, same memory entry,
//    makes a confidently-proposed candidate premature) — an MSSQL image
//    is simply not recognized at all right now, out of scope for today's
//    fix, left for later.
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

export interface ProbeResult {
  candidates: ProbeCandidate[];
  unclassified: ProbeUnclassified[];
}

/** Distinct from a generic failure so admin/server.ts's route can tell "deploy first" apart from a real bug — same shape as deployTarget.ts's own DeployCancelledError being exported for the same reason. */
export class ProbeTargetError extends Error {}

// Deliberately doesn't call deployTarget.ts's own assertMirroredMount()
// before using this path — that check exists because the HOST Docker
// daemon needs to resolve a bind-mount source to the same real directory
// `workbench` just wrote to, when STARTING a container. Nothing here
// starts a container or asks the daemon to resolve anything; every read
// below (`readFile`/`readdir`) happens directly inside `workbench` against
// a path it can already read regardless of whether the daemon would
// resolve that same string identically — mirror-correctness genuinely
// doesn't matter for this file's own reads the way it does for a deploy.
function targetsDirFromEnv(): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) {
    throw new ProbeTargetError('HOST_PROJECT_ROOT is not set — docker-compose.yml should pass it into the workbench service');
  }
  return join(hostRoot, 'targets');
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
// Pass 1 — database images. postgres/mysql/mongo can all become real
// candidates (see the module comment above for why mssql and unpublished
// ports still become unclassified notes instead).
// ---------------------------------------------------------------------------

const DB_IMAGE_PATTERNS: Array<{ engine: string; test: (image: string) => boolean }> = [
  { engine: 'postgres', test: (img) => /(^|\/)(postgres|postgis)(:|$)/i.test(img) },
  { engine: 'mysql/mariadb', test: (img) => /(^|\/)(mysql|mariadb)(:|$)/i.test(img) },
  { engine: 'mongodb', test: (img) => /(^|\/)mongo(:|$)/i.test(img) },
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
    const published = ports.find((p) => p.service === serviceName)?.publishedPort;

    if (!published) {
      unclassified.push({
        label,
        reason: 'looks like a database, but this service has no port published to the host — nothing for the platform to reach over the network. Publish the port in the target\'s own compose file if this needs testing, or add a component by hand.',
      });
      continue;
    }

    const env = service.environment ?? {};

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

async function detectHttpCandidates(
  ports: PortMapping[],
  claimedPorts: Set<number>,
): Promise<{ candidates: ProbeCandidate[]; unclassified: ProbeUnclassified[] }> {
  const candidates: ProbeCandidate[] = [];
  const unclassified: ProbeUnclassified[] = [];
  const seenPorts = new Set<number>();

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

  return { candidates, unclassified };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function probeTarget(name: string): Promise<ProbeResult> {
  const targetsDir = targetsDirFromEnv();
  const paths = resolveTargetPaths(targetsDir, name);

  const config = await readJsonFile<ComposeConfig>(paths.resolvedConfigPath);
  const state = await readJsonFile<DeployState>(paths.statePath);

  const claimedPorts = new Set<number>();
  const db = detectDbCandidates(config, state.ports, claimedPorts);
  const sqliteCandidates = await detectSqliteCandidates(config);
  const http = await detectHttpCandidates(state.ports, claimedPorts);

  return {
    candidates: [...db.candidates, ...sqliteCandidates, ...http.candidates],
    unclassified: [...db.unclassified, ...http.unclassified],
  };
}

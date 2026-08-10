import 'dotenv/config';
import { Client } from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Two real backends behind one interface (`db.query(sql, params)` returning
// `{ rows }`, same shape `pg`'s own QueryResult has) — generated step files
// never need to know or care which one they're actually talking to.
//
// SQLITE_DB_PATH (set via a descriptor's own test-run env overrides — see
// agent-service's testEnv.ts/buildTestRunEnv, same mechanism FRONTEND_URL/
// credentials already use for an externally deployed target) selects the
// sqlite path; its absence keeps the original Postgres behavior for
// orderflow and any other Postgres-backed target, completely unchanged.
//
// Confirmed live this split was actually needed, not speculative: every
// generated `db.query(...)` step against Uptime Kuma (SQLite-backed) failed
// with "relation \"monitor\" does not exist" — it was silently querying
// orderflow's own real Postgres database instead (the only backend this
// file ever supported), since DATABASE_URL always points there regardless
// of which target's tests are actually running.
// ---------------------------------------------------------------------------

const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// sqlite3's own CLI has no separate parameter-binding channel the way a real
// driver does — the bound SQL text IS the command's argument. Substituting
// $1/$2/... with properly quoted literals here (never raw string
// concatenation by the *caller*) keeps every existing `db.query(sql, [a, b])`
// call site working unmodified, with the same defense against a stray quote
// in test data that real parameter binding gives.
function bindPostgresStylePlaceholders(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_, n) => sqlLiteral(params[Number(n) - 1]));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The sqlite3 CLI is a fresh process per call with no shared connection pool
// — under Playwright's default parallel workers, concurrent writer
// invocations against the same file genuinely collide ("database is
// locked"), confirmed live against Uptime Kuma's real db under 5 workers.
// Postgres's own driver handles this itself; sqlite3 doesn't, so retry here
// with a short backoff rather than push this into every step file that
// happens to write.
const SQLITE_BUSY_RETRIES = 5;

async function sqliteQuery(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
  const bound = bindPostgresStylePlaceholders(sql, params);
  // Deliberately NOT -readonly, unlike Discovery's own sqlite component
  // (descriptor/components/sqlite.ts) — that one stays read-only because
  // exploration should never mutate a live target, but test fixture setup
  // genuinely needs INSERT/UPDATE (e.g. a status_page created directly via
  // SQL before a scenario verifies it through the UI/API). Confirmed live:
  // -readonly here made every write throw "attempt to write a readonly
  // database", the pg Client path across the same file never had this
  // restriction either.
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await execFileAsync('sqlite3', ['-json', SQLITE_DB_PATH!, bound]);
      const rows = stdout.trim() ? JSON.parse(stdout) : [];
      return { rows };
    } catch (err) {
      const locked = /database is locked/i.test((err as Error).message ?? '');
      if (!locked || attempt >= SQLITE_BUSY_RETRIES) throw err;
      await sleep(50 * 2 ** attempt); // 50, 100, 200, 400, 800ms
    }
  }
}

const pgClient = SQLITE_DB_PATH ? null : new Client({ connectionString: process.env.DATABASE_URL });

export const db = {
  query: (sql: string, params: unknown[] = []) =>
    SQLITE_DB_PATH ? sqliteQuery(sql, params) : pgClient!.query(sql, params),
};

let connected = false;
export async function ensureDbConnected(): Promise<void> {
  if (connected) return;
  if (!SQLITE_DB_PATH) await pgClient!.connect();
  connected = true;
}

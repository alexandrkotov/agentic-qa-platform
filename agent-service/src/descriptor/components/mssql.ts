import sql from 'mssql';
import type { CustomTool } from '../../providers/AgentProvider.ts';
import type { BuilderContext, ComponentBuilder } from '../registry.ts';
import type { MssqlComponent } from '../schema.ts';
import { resolveComposeServiceNetworks, joinNetwork, leaveNetwork } from '../../bootstrap/composeNetworks.ts';

/**
 * A real, live-discovered environment limitation, and the fix for it —
 * worth recording here, not just in a commit message. `host.docker.internal
 * :<published-port>` — the exact mechanism every other DB component in this
 * file's sibling files relies on — reliably fails for MSSQL specifically in
 * this Docker Desktop/WSL2 setup, with a generic "Login failed for user
 * 'sa'" / SQL Server error 18456. Confirmed this is NOT a bug in this
 * file's own code: the identical connectionString, credentials, and query
 * succeed immediately when reached via the target's own internal
 * docker-compose network (container-to-container, no published-port
 * hairpin involved) or from the true host machine's own network stack —
 * only the container→published-port→hairpin-NAT path fails, and it fails
 * identically via `sqlcmd` too, so it isn't specific to the `mssql` npm
 * package either. Best-guess root cause: TDS mandates an encrypted
 * handshake for the LOGIN7 packet itself (unlike Postgres/MySQL/Mongo,
 * where the wire protocol either has no such requirement or tolerates this
 * NAT path fine) — that handshake appears to break specifically over this
 * hairpin route.
 *
 * The fix: join `workbench` onto the target's own Docker network on demand,
 * instead of going through a published port at all — the same "container-
 * to-container, no hairpin" path already proven to work above. So
 * `connectionString`'s host here means something different than every
 * sibling component: it's the target's own docker-compose SERVICE name
 * (e.g. "nopcommerce_database"), not "host.docker.internal", and the port
 * is the container's real INTERNAL port (1433, MSSQL's fixed default),
 * never a published one. Before each query, this file:
 *   1. reads `targets/<descriptorName>/.aqap/resolved.json` (the same
 *      `docker compose config --format json` output bootstrap/probeTarget.ts
 *      already reads) to find which real Docker network(s) that compose
 *      service actually lives on — read fresh every time, never assumed
 *      from a naming convention: confirmed live that a target's own
 *      network name can still reflect a stale project-naming scheme from
 *      before deployTarget.ts's own projectNameFor() was renamed, until
 *      that target is redeployed;
 *   2. `docker network connect`s this container onto each of them (self-
 *      identified via `hostname()` — Docker sets a container's hostname to
 *      its own short ID by default, the exact same trick
 *      bootstrap/deployTarget.ts's assertMirroredMount() already uses);
 *   3. runs the query;
 *   4. disconnects again in `finally`, alongside the connection pool's own
 *      `close()`.
 * A genuine simplification over the old published-port path, not just a
 * workaround: nopCommerce's own official compose file never publishes
 * MSSQL's port at all (only its web service does) — this needs no
 * port-publish patch of any kind, on any target, ever. An in-process async
 * mutex (below) serializes this connect→query→disconnect window so two
 * concurrent MSSQL queries in this one `workbench` process — e.g. Discovery
 * running against two different MSSQL-backed targets from two browser tabs
 * at once — can't race each other's network membership; that's a real,
 * documented limit to this fix (single-process safety only, not a
 * distributed lock), same honesty-about-limits spirit as the read-only
 * guard below.
 */
function queryToolName(key: string): string {
  return `mssql_query__${key}`;
}

interface ParsedConnection {
  server: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function parseConnectionString(raw: string): ParsedConnection {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid connection string: "${raw}"`);
  }
  if (url.protocol !== 'mssql:') {
    throw new Error(`connectionString must start with "mssql://" (got "${url.protocol}//")`);
  }
  return {
    server: url.hostname,
    port: url.port ? Number(url.port) : 1433,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

// ---------------------------------------------------------------------------
// Network-join — see this file's own header comment for the why.
// resolveComposeServiceNetworks()/joinNetwork()/leaveNetwork() all live in
// bootstrap/composeNetworks.ts now (factored out once server.ts needed the
// identical join-for-a-test-run pattern for a Postgres-backed target) —
// this file just calls them.
// ---------------------------------------------------------------------------

// Serializes every mssql query's own connect→query→disconnect window
// within this one process — see this file's header comment for why this
// is a documented, deliberate single-process-only guarantee, not a
// distributed lock.
let mutexTail: Promise<void> = Promise.resolve();
function withNetworkMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutexTail.then(fn, fn);
  mutexTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Statements that must never reach the server through this tool, checked as
// whole words anywhere in the query (not just as a prefix) — a defense-in-depth
// scan on top of the leading-keyword check below, since a single string could
// still smuggle a second statement after a semicolon.
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|MERGE|EXEC|EXECUTE|CREATE|GRANT|REVOKE|DENY)\b/i;

/**
 * Best-effort, NOT a server-enforced guarantee — worth being honest about,
 * since every sibling component gets a real hard one: sqlite.ts opens the
 * file with `-readonly`, mysql.ts issues `SET SESSION TRANSACTION READ ONLY`
 * before every query, mongo.ts's official MCP server literally removes
 * write-shaped tools from its own tool list under `--readOnly`. SQL Server
 * has no equivalent session/transaction-level read-only mode (confirmed via
 * research this session — ANSI SQL's `SET TRANSACTION READ ONLY` exists in
 * Postgres/MySQL/Oracle but T-SQL never implemented it; the only genuinely
 * hard equivalent is a dedicated login with just the db_datareader role,
 * which is a connection-string/credentials decision made by whoever points
 * this component at a real server, not something this tool can provision
 * for itself). So this is the best available guard: reject anything that
 * isn't a SELECT/WITH statement, and additionally scan for write-shaped
 * keywords anywhere in the string (not just as the first word) to catch a
 * `; DROP TABLE ...` tacked onto an otherwise-innocent-looking query. A
 * deployment that wants the same hard guarantee the other engines get
 * should point connectionString at a login granted only db_datareader.
 */
function assertReadOnlyQuery(query: string): void {
  const trimmed = query.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error('Only SELECT (or a WITH ... SELECT common table expression) statements are allowed here.');
  }
  if (WRITE_KEYWORDS.test(trimmed)) {
    throw new Error('Query rejected: contains a write/DDL keyword. Only read-only SELECT statements are allowed here.');
  }
}

export const mssqlBuilder: ComponentBuilder<MssqlComponent> = {
  tools(component, key, ctx: BuilderContext): CustomTool[] {
    return [
      {
        name: queryToolName(key),
        description: `Run a read-only SQL query against the "${key}" SQL Server database. Only SELECT (or WITH ... SELECT) statements are accepted — anything else is rejected before it ever reaches the server.`,
        parameters: {
          query: { type: 'string', description: 'A SELECT statement (or a WITH ... SELECT common table expression).' },
        },
        required: ['query'],
        execute: async (input) => {
          const query = String(input.query ?? '').trim();
          if (!query) throw new Error('"query" is required.');
          assertReadOnlyQuery(query);
          const conn = parseConnectionString(component.connectionString);

          const descriptorName = ctx.descriptorName;
          if (!descriptorName) {
            throw new Error(
              'This mssql component needs its descriptor\'s own top-level "name" set — the network-join ' +
                'mechanism can\'t find targets/<name>/.aqap/resolved.json without it.',
            );
          }

          return withNetworkMutex(async () => {
            const networks = await resolveComposeServiceNetworks(descriptorName, conn.server);
            for (const network of networks) await joinNetwork(network);
            try {
              const pool = await sql.connect({
                server: conn.server,
                port: conn.port,
                user: conn.user,
                password: conn.password,
                database: conn.database,
                // The target's own SQL Server instance (e.g. a fresh docker-compose
                // deploy of mcr.microsoft.com/mssql/server) has no real TLS
                // certificate to validate — same "this is a disposable test
                // target, not a production connection" trust boundary the rest of
                // this app already operates in.
                options: { encrypt: true, trustServerCertificate: true },
              });
              try {
                const result = await pool.request().query(query);
                return JSON.stringify(result.recordset ?? []);
              } finally {
                await pool.close();
              }
            } finally {
              for (const network of networks) await leaveNetwork(network);
            }
          });
        },
      },
    ];
  },

  promptSection(_component, key): string {
    return `### SQL Server database (${key})
Use the \`${queryToolName(key)}\` tool to run:
\`\`\`sql
SELECT t.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.TABLES t
JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_NAME = t.TABLE_NAME
WHERE t.TABLE_TYPE = 'BASE TABLE'
ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION;
\`\`\`
to list every table and column. Then, for each table, run:
\`\`\`sql
SELECT TOP 3 * FROM [<table>];
\`\`\`
to see a few sample rows.

Existing rows may predate recent code changes — do not treat them as the
final word on current behavior.

Report this component's findings under \`components["${key}"]\` as:
{ "tables": [{ "name": "", "columns": [{ "name": "", "type": "", "nullable": true }], "sampleRows": [] }] }`;
  },
};

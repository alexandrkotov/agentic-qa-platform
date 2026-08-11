import sql from 'mssql';
import type { CustomTool } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { MssqlComponent } from '../schema.ts';

/**
 * A real, live-discovered environment limitation worth recording here, not
 * just in a commit message: in this Docker Desktop/WSL2 setup,
 * `host.docker.internal:<published-port>` — the exact mechanism every other
 * DB component type in this file relies on — reliably fails for MSSQL
 * specifically, with a generic "Login failed for user 'sa'" / SQL Server
 * error 18456. Confirmed this is NOT a bug in this file's own code: the
 * identical connectionString, credentials, and query succeed immediately
 * when reached via the target's own internal docker-compose network
 * (container-to-container, no published-port hairpin involved) or from the
 * true host machine's own network stack — only the
 * container→published-port→hairpin-NAT path fails, and it fails
 * identically via `sqlcmd` too, so it isn't specific to the `mssql` npm
 * package either. Ruled out: IPv4 vs IPv6 (both fail identically),
 * `AUTO_CLOSE` on the database (a real separate issue also found this
 * session — SQL Server Express defaults new databases to
 * `AUTO_CLOSE ON`, worth turning off on any real MSSQL target for
 * reliability, but not the cause of the login failures themselves).
 * Best-guess root cause: TDS mandates an encrypted handshake for the LOGIN7
 * packet itself (unlike Postgres/MySQL/Mongo, where the wire protocol either
 * has no such requirement or tolerates this NAT path fine) — that handshake
 * appears to break specifically over this hairpin route. Not resolved at
 * the platform level here; a target relying on this component type may need
 * workbench joined to its own docker-compose network directly, which this
 * codebase doesn't automate today.
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
  tools(component, key): CustomTool[] {
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

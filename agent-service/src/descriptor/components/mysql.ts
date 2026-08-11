import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CustomTool } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { MysqlComponent } from '../schema.ts';

const execFileAsync = promisify(execFile);

function queryToolName(key: string): string {
  return `mysql_query__${key}`;
}

interface ParsedConnection {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/** The real `mysql` CLI takes discrete flags, not a URI the way `psql` does — parsed once per call rather than cached, this isn't hot-path code. */
function parseConnectionString(raw: string): ParsedConnection {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid connection string: "${raw}"`);
  }
  if (url.protocol !== 'mysql:') {
    throw new Error(`connectionString must start with "mysql://" (got "${url.protocol}//")`);
  }
  return {
    host: url.hostname,
    port: url.port || '3306',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

/**
 * `mysql --batch` prints a tab-separated table (header row + data rows),
 * not JSON the way sqlite3's own `-json` flag gives for free — there's no
 * equivalent flag on the real mysql CLI. Converts it into the same
 * array-of-objects shape every other component's own query tool already
 * returns, and turns the CLI's literal "NULL" text back into a real JSON
 * null rather than leaving it as a confusing string.
 */
function parseTabSeparated(stdout: string): Record<string, string | null>[] {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    const row: Record<string, string | null> = {};
    headers.forEach((header, i) => {
      row[header] = values[i] === 'NULL' ? null : (values[i] ?? null);
    });
    return row;
  });
}

export const mysqlBuilder: ComponentBuilder<MysqlComponent> = {
  tools(component, key): CustomTool[] {
    return [
      {
        name: queryToolName(key),
        description: `Run a read-only SQL query against the "${key}" MySQL/MariaDB database. Only SELECT/SHOW/DESCRIBE statements are useful here — the session is started read-only, so anything else is rejected by the server itself.`,
        parameters: {
          query: { type: 'string', description: 'A SELECT, SHOW, or DESCRIBE statement.' },
        },
        required: ['query'],
        execute: async (input) => {
          const query = String(input.query ?? '').trim();
          if (!query) throw new Error('"query" is required.');
          const conn = parseConnectionString(component.connectionString);
          // SET SESSION TRANSACTION READ ONLY is a real, server-enforced
          // guarantee for this session — not just a description in the
          // tool's own text — same hard-guarantee spirit as sqlite.ts's own
          // `-readonly` flag, just MySQL's actual mechanism for it (the CLI
          // itself has no read-only flag the way sqlite3 does).
          const { stdout } = await execFileAsync(
            'mysql',
            [
              '--host', conn.host,
              '--port', conn.port,
              '--user', conn.user,
              '--database', conn.database,
              '--init-command', 'SET SESSION TRANSACTION READ ONLY;',
              '--batch',
              '--raw',
              '-e', query,
            ],
            // Password via env, never argv — argv is visible to anything
            // that can read this process's own command line (e.g. `ps`
            // from another process in the same container); MYSQL_PWD is
            // the real client's own documented way to avoid that.
            { env: { ...process.env, MYSQL_PWD: conn.password } },
          );
          return JSON.stringify(parseTabSeparated(stdout));
        },
      },
    ];
  },

  promptSection(_component, key): string {
    return `### MySQL/MariaDB database (${key})
Use the \`${queryToolName(key)}\` tool to run:
\`\`\`sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = DATABASE()
ORDER BY table_name, ordinal_position;
\`\`\`
to list every table and column. Then, for each table, run:
\`\`\`sql
SELECT * FROM \`<table>\` LIMIT 3;
\`\`\`
to see a few sample rows.

Existing rows may predate recent code changes — do not treat them as the
final word on current behavior.

Report this component's findings under \`components["${key}"]\` as:
{ "tables": [{ "name": "", "columns": [{ "name": "", "type": "", "nullable": true }], "sampleRows": [] }] }`;
  },
};

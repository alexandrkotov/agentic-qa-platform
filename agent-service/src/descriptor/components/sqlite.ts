import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { CustomTool } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { SqliteComponent } from '../schema.ts';

const execFileAsync = promisify(execFile);

function queryToolName(key: string): string {
  return `sqlite_query__${key}`;
}

/**
 * Resolves and validates component.path before it's ever handed to a
 * subprocess. schema.ts already rejects a non-absolute/".."-containing
 * path at save time, but a descriptor is a file a human hand-edits — this
 * is the one place that path is actually acted on, so it's checked again
 * here against something schema.ts has no way to know: which directory is
 * actually safe to read on THIS deployment. Scoped to this container's own
 * mirrored targets/ mount (see dockerCompose.ts's comment on why that path
 * is identical inside and outside the container) rather than trusting any
 * absolute path a descriptor happens to name — without this, a sqlite
 * component could just as easily point at agent-service/.env or
 * /etc/passwd and this tool would happily try to open it.
 */
function resolveSafePath(rawPath: string): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) {
    throw new Error('Refusing to open a sqlite component: HOST_PROJECT_ROOT is not set in this container.');
  }
  const targetsRoot = resolve(hostRoot, 'targets');
  const resolvedPath = resolve(rawPath);
  if (resolvedPath !== targetsRoot && !resolvedPath.startsWith(targetsRoot + '/')) {
    throw new Error(
      `Refusing to open "${resolvedPath}" — sqlite components may only point at a file under this deployment's own targets/ directory (${targetsRoot}).`,
    );
  }
  return resolvedPath;
}

export const sqliteBuilder: ComponentBuilder<SqliteComponent> = {
  tools(component, key): CustomTool[] {
    return [
      {
        name: queryToolName(key),
        description: `Run a read-only SQL query against the "${key}" SQLite database. Only SELECT and PRAGMA statements are useful here — the connection is opened read-only, so anything else fails.`,
        parameters: {
          query: { type: 'string', description: 'A SELECT or PRAGMA statement.' },
        },
        required: ['query'],
        execute: async (input) => {
          const query = String(input.query ?? '').trim();
          if (!query) throw new Error('"query" is required.');
          const path = resolveSafePath(component.path);
          // -readonly makes this a hard guarantee at the sqlite3 level, not
          // just a description in the tool's own text — even a malformed or
          // adversarial query can't write through this connection.
          const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', path, query]);
          return stdout.trim() || '[]';
        },
      },
    ];
  },

  promptSection(_component, key): string {
    return `### SQLite database (${key})
Use the \`${queryToolName(key)}\` tool to run:
\`\`\`sql
SELECT name, sql FROM sqlite_master WHERE type = 'table';
\`\`\`
to list every table and its exact schema. Then, for each table, run:
\`\`\`sql
SELECT * FROM "<table>" LIMIT 3;
\`\`\`
to see a few sample rows.

Existing rows may predate recent code changes — do not treat them as the
final word on current behavior.

Report this component's findings under \`components["${key}"]\` as:
{ "tables": [{ "name": "", "columns": [{ "name": "", "type": "", "nullable": true }], "sampleRows": [] }] }`;
  },
};

import type { McpServerConfig } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { MongoComponent } from '../schema.ts';

/**
 * Unlike mysql.ts, a genuinely official MCP server exists for this engine —
 * `mongodb-mcp-server`, published under the mongodb-js GitHub org by
 * mongodb.com-email maintainers (confirmed live via `npm view
 * mongodb-mcp-server maintainers`). So this builder hands the connection
 * string straight to it via mcpServers, the same shape postgres.ts already
 * uses, rather than hand-writing a CustomTool.
 *
 * --readOnly is a real, live-verified guarantee, not just documented
 * behavior: confirmed by diffing this server's own listTools() output with
 * and without the flag — 11 write-shaped tools (insert-many, delete-many,
 * update-many, create-collection, drop-collection, drop-database, ...) are
 * completely absent from the tool list under --readOnly, not merely
 * disabled at call time. Same hard-guarantee spirit as sqlite.ts's
 * `-readonly` and mysql.ts's `SET SESSION TRANSACTION READ ONLY`, just this
 * engine's own mechanism for it (tool-registration-level rather than a
 * session/connection-level flag, since there's no single "read-only mongo
 * session" concept the way there is for a SQL transaction).
 */
export const mongoBuilder: ComponentBuilder<MongoComponent> = {
  mcpServers(component, key): McpServerConfig[] {
    return [
      {
        name: key,
        command: 'npx',
        args: ['-y', 'mongodb-mcp-server@latest', '--readOnly'],
        env: { MDB_MCP_CONNECTION_STRING: component.connectionString },
      },
    ];
  },

  promptSection(component, key): string {
    // `list-collections`/`collection-schema`/`find` all require an explicit
    // `database` argument (confirmed live via each tool's own inputSchema)
    // — the connection string's own path segment is the one already
    // reachable at prompt-build time, so it's spelled out here rather than
    // left for the agent to guess or misparse from the raw connection string.
    let database = '<database name from the connection string>';
    try {
      database = new URL(component.connectionString).pathname.replace(/^\//, '') || database;
    } catch {
      // Malformed connection string — leave the placeholder; the agent will
      // see the real error from the MCP server's own tool call and can react.
    }
    return `### MongoDB database (${key})
This MCP server's tools take a \`connectionId\` argument — always pass the
literal string \`"preconfigured"\` (the connection string was already
supplied when this server started; that ID dials it automatically on
first use, confirmed live — no separate \`connect\` call is needed). The
target database is \`"${database}"\` — pass it as the \`database\` argument
on every call that takes one (\`list-collections\`, \`collection-schema\`,
\`find\`, ... all require it).

Use \`list-collections\` to see what collections exist. For each
collection, use \`collection-schema\` to infer its shape, then \`find\`
(with a small \`limit\`) for a few sample documents.

Existing documents may predate recent code changes — do not treat them as
the final word on current behavior.

Report this component's findings under \`components["${key}"]\` as:
{ "collections": [{ "name": "", "inferredSchema": {}, "sampleDocuments": [] }] }`;
  },
};

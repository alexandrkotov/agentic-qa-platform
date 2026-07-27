import type { McpServerConfig } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { PostgresComponent } from '../schema.ts';

export const postgresBuilder: ComponentBuilder<PostgresComponent> = {
  mcpServers(component, key): McpServerConfig[] {
    return [
      {
        name: key,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', component.connectionString],
      },
    ];
  },

  promptSection(_component, key): string {
    return `### Database (${key})
Use the \`${key}__query\` tool to run:
\`\`\`sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
\`\`\`
Then fetch 3 sample rows from each table:
\`\`\`sql
SELECT * FROM "<table>" LIMIT 3;
\`\`\`

Existing rows may predate recent code changes — do not treat them as the
final word on current behavior.

Report this component's findings under \`components["${key}"]\` as:
{ "tables": [{ "name": "", "columns": [{ "name": "", "type": "", "nullable": true }], "sampleRows": [] }] }`;
  },
};

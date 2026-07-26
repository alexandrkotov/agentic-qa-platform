import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProvider } from '../providers/AgentProvider.ts';
import type { McpServerConfig } from '../providers/AgentProvider.ts';
import { fetchSwaggerTool } from '../tools/swagger.ts';
import { config } from '../config.ts';

// ---------------------------------------------------------------------------
// MCP server configurations
// ---------------------------------------------------------------------------

/** Playwright MCP — headless browser for UI exploration */
const playwrightMcp: McpServerConfig = {
  name: 'playwright',
  // Use local binary so the Chromium installed via `playwright install chromium` is found
  command: './node_modules/.bin/playwright-mcp',
  args: ['--headless', '--browser', 'chromium'],
};

/** Postgres MCP — direct database access */
const postgresMcp: McpServerConfig = {
  name: 'postgres',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-postgres', config.databaseUrl],
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a QA System Discovery Agent. Your mission is to explore a web application and produce a comprehensive system discovery report in JSON format.

## Target Application
- Frontend UI: ${config.frontendUrl}
- Backend REST API: ${config.backendUrl}
- API Documentation (Swagger): ${config.backendUrl}/docs

## Discovery Steps — follow in order

### 1. API Discovery
Call \`fetch_swagger_spec\` to get the complete OpenAPI specification.
Extract: all endpoints (method + path + description), request body schemas, response schemas, and any validation rules (minLength, enum, required fields, etc.).

### 2. Database Schema
Use the postgres \`query\` tool to run:
\`\`\`sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
\`\`\`
Then fetch 3 rows of sample data from each table:
\`\`\`sql
SELECT * FROM "<table>" LIMIT 3;
\`\`\`

Existing rows may predate recent code changes — do not treat them as the
final word on current behavior. Step 4 below verifies behavior with fresh data.

### 3. UI Exploration
Use playwright tools to:
1. Navigate to ${config.frontendUrl} — take a snapshot
2. Navigate to ${config.frontendUrl}/customers — snapshot, note all form fields and buttons
3. Navigate to ${config.frontendUrl}/products — snapshot
4. Navigate to ${config.frontendUrl}/orders — snapshot

### 4. Verify Behavior With Fresh Data (write scenario)
Do not rely solely on existing database rows to infer business rules and
history/audit-trail behavior. Perform this minimal write scenario through the
UI, then confirm what actually happened via the postgres \`query\` tool:

1. Create a new Customer (e.g. name "Discovery Test", a unique email).
2. Create a new Product (e.g. name "Discovery Test Product", any price).
3. Create a new Order (DRAFT) for that customer with one item using that product.
4. Immediately query \`OrderStatusHistory\` for that new order's id — record
   exactly how many rows exist and their statuses right after creation
   (before any status change). Do not assume; report what you observed.
5. Submit the order (DRAFT → SUBMITTED) via the UI.
6. Query \`OrderStatusHistory\` again for that order — record the full,
   ordered sequence of entries (status + relative order).
7. Clean up: delete the test Order, then the test Product, then the test
   Customer you created in this step, so discovery does not leave test data behind.

Record the exact sequence of OrderStatusHistory entries you observed at each
point (after create, after submit) in \`businessRules\` — write the concrete
observed sequence, not a generic statement like "tracks status changes".

### 5. Report
After completing all exploration, output ONLY a valid JSON object (no markdown fences, no extra text) matching this schema exactly:

{
  "generatedAt": "<ISO 8601 timestamp>",
  "endpoints": [
    {
      "method": "GET|POST|PATCH|DELETE",
      "path": "/api/path",
      "description": "...",
      "requestBody": {},
      "responseSchema": {}
    }
  ],
  "database": {
    "tables": [
      {
        "name": "table_name",
        "columns": [{ "name": "", "type": "", "nullable": true }],
        "sampleRows": []
      }
    ]
  },
  "uiPages": [
    {
      "route": "/",
      "title": "...",
      "formFields": [],
      "actions": []
    }
  ],
  "businessRules": [
    "Description of a constraint or validation rule discovered"
  ],
  "testScenarios": [
    {
      "name": "Scenario name",
      "type": "happy_path|edge_case|security",
      "description": "What to test and expected outcome"
    }
  ]
}`;

const USER_MESSAGE = `Start system discovery on the QA platform application. Follow the 5 steps in your instructions and return the JSON report.`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runDiscovery(provider: AgentProvider): Promise<void> {
  console.log('\n=== Phase 1: System Discovery ===\n');

  const raw = await provider.run({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: USER_MESSAGE,
    mcpServers: [playwrightMcp, postgresMcp],
    tools: [fetchSwaggerTool],
    maxIterations: 60,
    operation: 'discovery',
  });

  // Save report
  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(config.reportsDir, `discovery-${timestamp}.json`);

  // Try to extract JSON from the response (agent might wrap it in prose)
  let reportContent = raw;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      reportContent = JSON.stringify(parsed, null, 2);
    } catch {
      // Leave as raw if not valid JSON
    }
  }

  await writeFile(reportPath, reportContent, 'utf-8');
  console.log(`\n=== Report saved: ${reportPath} ===\n`);
  console.log(reportContent.slice(0, 800) + (reportContent.length > 800 ? '\n...(truncated)' : ''));
}

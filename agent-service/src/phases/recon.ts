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
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest', '--headless'],
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

const SYSTEM_PROMPT = `You are a QA reconnaissance agent. Your mission is to explore a web application and produce a comprehensive reconnaissance report in JSON format.

## Target Application
- Frontend UI: ${config.frontendUrl}
- Backend REST API: ${config.backendUrl}
- API Documentation (Swagger): ${config.backendUrl}/docs

## Reconnaissance Steps — follow in order

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

### 3. UI Exploration
Use playwright tools to:
1. Navigate to ${config.frontendUrl} — take a snapshot
2. Navigate to ${config.frontendUrl}/customers — snapshot, note all form fields and buttons
3. Navigate to ${config.frontendUrl}/products — snapshot
4. Navigate to ${config.frontendUrl}/orders — snapshot

### 4. Report
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

const USER_MESSAGE = `Start reconnaissance on the QA platform application. Follow the 4 steps in your instructions and return the JSON report.`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runRecon(provider: AgentProvider): Promise<void> {
  console.log('\n=== Phase 1: Reconnaissance ===\n');

  const raw = await provider.run({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: USER_MESSAGE,
    mcpServers: [playwrightMcp, postgresMcp],
    tools: [fetchSwaggerTool],
    maxIterations: 60,
  });

  // Save report
  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(config.reportsDir, `recon-${timestamp}.json`);

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

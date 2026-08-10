import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Client } from 'pg';
import type { AgentProvider } from '../providers/AgentProvider.ts';
import type { McpServerConfig } from '../providers/AgentProvider.ts';
import { parseSystemDescriptor } from '../descriptor/schema.ts';
import type { SystemDescriptor, PostgresComponent } from '../descriptor/schema.ts';
import { assembleDiscovery } from '../descriptor/registry.ts';
import { config } from '../config.ts';

const DEFAULT_DESCRIPTOR_PATH = 'descriptors/orderflow.json';

// ---------------------------------------------------------------------------
// System prompt — component-specific exploration steps come from the
// descriptor (via assembleDiscovery); this shell just frames the task and the
// report contract, which stay the same regardless of which components a
// target system has.
// ---------------------------------------------------------------------------

function buildSystemPrompt(componentPromptSections: string[], extraInstructions?: string): string {
  return `You are a QA System Discovery Agent. Your mission is to explore a target system,
described below as a set of components, and produce a comprehensive system discovery
report in JSON format.

## Discovery Steps — explore each component below, then verify behavior if instructed

${componentPromptSections.join('\n\n')}
${extraInstructions ? `\n${extraInstructions}\n` : ''}
## Report
After completing all exploration, output ONLY a valid JSON object (no markdown fences, no extra text) matching this schema exactly:

{
  "generatedAt": "<ISO 8601 timestamp>",
  "components": {
    "<component key, as given in each section above>": { }
  },
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
}

const USER_MESSAGE = `Start system discovery on the target system described in your instructions. Follow each component's exploration steps, then any additional verification instructions, and return the JSON report.`;

// ---------------------------------------------------------------------------
// Cleanup — runs after the LLM finishes, via a direct (write-capable)
// Postgres connection, never exposed to the agent itself. Exists because the
// agent's own postgres tool is deliberately read-only (see components/postgres.ts)
// and can't remove the test fixtures a write-scenario in extraInstructions creates.
// ---------------------------------------------------------------------------

async function runCleanupSql(descriptor: SystemDescriptor): Promise<void> {
  if (!descriptor.cleanupSql || descriptor.cleanupSql.length === 0) return;

  const postgresComponent = descriptor.components.find(
    (c): c is PostgresComponent => c.type === 'postgres',
  );
  if (!postgresComponent) {
    console.warn('[cleanup] cleanupSql defined but no postgres component found — skipping');
    return;
  }

  const client = new Client({ connectionString: postgresComponent.connectionString });
  await client.connect();
  try {
    for (const sql of descriptor.cleanupSql) {
      const result = await client.query(sql);
      console.log(`[cleanup] ${result.rowCount} row(s): ${sql.slice(0, 80)}`);
    }
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Core runner, taking an already-parsed descriptor rather than a path —
 * lets a caller run discovery against a descriptor it has modified in
 * memory (see admin/server.ts's discovery route, which rewrites
 * postgres/rest-api/web-ui URLs to compose service names before calling
 * this, since it runs the agent from inside a container on the app's own
 * Docker network rather than on the host `pnpm discovery` runs on).
 * `descriptorLabel` is used only for the saved report's filename suffix.
 */
export async function runDiscoveryForDescriptor(
  provider: AgentProvider,
  descriptor: SystemDescriptor,
  descriptorLabel: string,
  /** Optional last-chance edit of the assembled MCP server list — e.g. admin/server.ts appends a browser --init-script to the web-ui entry so the frontend's own client-side API calls also get rewritten to this network's service names, not just the URL the agent navigates to. Unused (and behavior-identical to before) on the plain CLI path. */
  mcpServersOverride?: (servers: McpServerConfig[]) => McpServerConfig[],
  /** Forwarded straight into provider.run() — see AgentRunOptions.onProgress. Lets a caller like admin/server.ts stream this one long tool-using agent call's own [tool →]/[tool ←] progress to a browser instead of it only ever reaching docker logs. */
  onProgress?: (message: string) => void,
): Promise<string> {
  const startMsg = '=== Phase 1: System Discovery ===';
  console.log(`\n${startMsg}\n`);
  console.log(`Descriptor: ${descriptorLabel}`);
  onProgress?.(startMsg);
  onProgress?.(`Descriptor: ${descriptorLabel}`);

  const assembled = assembleDiscovery(descriptor);
  const { tools, componentPromptSections } = assembled;
  const mcpServers = mcpServersOverride ? mcpServersOverride(assembled.mcpServers) : assembled.mcpServers;

  const raw = await provider.run({
    systemPrompt: buildSystemPrompt(componentPromptSections, descriptor.extraInstructions),
    userMessage: USER_MESSAGE,
    mcpServers,
    tools,
    // Raised from 60 -> 70 once a real descriptor (uptime-kuma) started
    // carrying 3 explorable components (web-ui + sqlite + rest-api) instead
    // of 1 — genuinely more exploration steps needed, not a runaway-loop
    // symptom. This is a ceiling, not a fixed cost: the loop
    // (ClaudeProvider.ts) exits the moment the model reaches end_turn, so
    // most runs never get close to it — this only matters for a run that's
    // currently hitting the cap and getting cut off mid-exploration. Cost
    // does NOT scale linearly with the extra headroom, though: the full
    // conversation gets resent every iteration, so the last iterations
    // before whatever cap is hit are the most expensive ones, not the
    // cheapest — confirmed live, a single-component discovery run already
    // cost $8.99 at 1.76M input tokens before sqlite/rest-api existed.
    maxIterations: 70,
    operation: 'discovery',
    descriptor: descriptorLabel,
    onProgress,
  });

  // Save report — filename carries the descriptor name (e.g.
  // "discovery-2026-07-30T...-orderflow.json") so a report is traceable to
  // the system it describes without opening it; the timestamp stays the
  // leading, sortable part so "find the latest report" (generateGroup.ts,
  // admin/server.ts) keeps working unchanged.
  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(config.reportsDir, `discovery-${timestamp}-${descriptorLabel}.json`);

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
  onProgress?.(`Report saved: ${reportPath}`);

  await runCleanupSql(descriptor);

  return reportPath;
}

export async function runDiscovery(
  provider: AgentProvider,
  descriptorPath: string = DEFAULT_DESCRIPTOR_PATH,
): Promise<string> {
  const descriptorJson = JSON.parse(await readFile(descriptorPath, 'utf-8'));
  const descriptor = parseSystemDescriptor(descriptorJson);
  return runDiscoveryForDescriptor(provider, descriptor, basename(descriptorPath, '.json'));
}

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProvider } from '../providers/AgentProvider.ts';
import { parseSystemDescriptor } from '../descriptor/schema.ts';
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
// Runner
// ---------------------------------------------------------------------------

export async function runDiscovery(
  provider: AgentProvider,
  descriptorPath: string = DEFAULT_DESCRIPTOR_PATH,
): Promise<void> {
  console.log('\n=== Phase 1: System Discovery ===\n');
  console.log(`Descriptor: ${descriptorPath}`);

  const descriptorJson = JSON.parse(await readFile(descriptorPath, 'utf-8'));
  const descriptor = parseSystemDescriptor(descriptorJson);
  const { mcpServers, tools, componentPromptSections } = assembleDiscovery(descriptor);

  const raw = await provider.run({
    systemPrompt: buildSystemPrompt(componentPromptSections, descriptor.extraInstructions),
    userMessage: USER_MESSAGE,
    mcpServers,
    tools,
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

import { z } from 'zod';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import type { DiscoveryReport } from '../generate/reportSchema.ts';
import { ScenarioFlowSchema, type ProposedSequenceFlow } from './contract.ts';

// ---------------------------------------------------------------------------
// One LLM call, structuring a handful of the discovery report's testScenarios
// into ordered, cross-component sequence traces — the "before coding"
// whiteboard diagram: what actually happens, step by step, for one specific
// operation, tying together uiPages/endpoints/tables/kafka the same report
// already lists separately but never connects. Same single-holistic-call
// shape as propose.ts/proposeUiFlow.ts, not split by group.
// ---------------------------------------------------------------------------

function buildSystemPrompt(reportJson: string, componentKeys: string[]): string {
  return `You are a QA analyst turning a system discovery report into a small set of "before coding"
sequence diagrams — the kind of step-by-step, cross-component trace a team sketches on a whiteboard
before building a feature. A later, non-LLM step renders each one as a Mermaid sequence diagram, so
every field must be concrete and machine-usable, not prose.

## System discovery report
${reportJson}

## Component participants
The only valid participant names for "from"/"to" below are these exact report component keys:
${componentKeys.map((k) => `"${k}"`).join(', ')}
...plus the reserved name "User" for the human triggering the scenario. Never invent a participant
name outside this list — if a step doesn't clearly involve one of these, leave it out rather than guess.

## Your task
Pick 3 to 6 of the most illustrative scenarios from "testScenarios" — prioritize ones that actually
cross multiple components (e.g. a write that touches the database and, if the report has a Kafka
component, publishes an event) over a trivial single-component read. Do not produce one for every
testScenario — that's wasteful and most add no new information once a few good ones exist. For each
chosen scenario, produce:
{
  "name": "<matches the testScenarios[] entry's own name>",
  "description": "<one sentence, what this scenario demonstrates>",
  "steps": [
    { "from": "User", "to": "web_ui", "label": "Click \\"Create Order\\"" },
    { "from": "web_ui", "to": "rest_api", "label": "POST /orders" },
    { "from": "rest_api", "to": "postgres", "label": "INSERT Order, OrderItem" },
    { "from": "rest_api", "to": "web_ui", "label": "201 Created" }
  ]
}

Rules:
1. Steps must be in real chronological order — this is a sequence, not an unordered set.
2. Labels must be concrete and drawn from the report where possible: real HTTP methods/paths from
   "endpoints", real table names from "tables", the real Kafka topic name — not vague descriptions
   like "does something with the database".
3. A response step (e.g. the API replying to the UI) is a legitimate, encouraged step — don't stop at
   the write.
4. If the report has no "testScenarios" at all, or too few components to show a real cross-component
   trace, return an empty "scenarios" array rather than inventing one.
5. Never invent a step, endpoint, table, or topic not stated or clearly implied by the report.

## Output contract — read carefully
Output ONLY a single valid JSON object of the shape { "scenarios": [ <scenario>, ... ] }, no markdown
fences, no prose before or after.`;
}

const USER_MESSAGE = 'Produce the structured sequence flow model for this report per your instructions.';

export async function proposeSequenceFlow(
  provider: AgentProvider,
  report: DiscoveryReport,
  sourceReportPath: string,
  /** Which target system's descriptor sourceReportPath belongs to, for the usage log's descriptor filter — see admin/server.ts's descriptorFromReportName(). Optional; omitted callers just get an unlabeled usage entry. */
  descriptorLabel?: string,
): Promise<ProposedSequenceFlow> {
  const componentKeys = Object.keys(report.components);
  const raw = await provider.run({
    systemPrompt: buildSystemPrompt(JSON.stringify(report, null, 2), componentKeys),
    userMessage: USER_MESSAGE,
    mcpServers: [],
    tools: [],
    maxIterations: 5,
    operation: 'workflow-sequence-propose',
    descriptor: descriptorLabel,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Sequence flow proposal response did not contain a JSON object (response started with: ${raw.slice(0, 200)})`,
    );
  }
  const parsed = z.object({ scenarios: z.array(ScenarioFlowSchema) }).parse(JSON.parse(jsonMatch[0]));

  return {
    generatedAt: new Date().toISOString(),
    sourceReportPath,
    scenarios: parsed.scenarios,
  };
}

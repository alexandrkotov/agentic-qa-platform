import { z } from 'zod';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import type { DiscoveryReport } from '../generate/reportSchema.ts';
import { EntityWorkflowSchema, type ProposedWorkflow } from './contract.ts';
import { verifyWorkflow } from './verify.ts';

// ---------------------------------------------------------------------------
// One LLM call, structuring a discovery report's free-text businessRules
// (plus testScenarios/components as supporting context) into a machine-
// renderable workflow model. Not split by group the way generate/spec.ts
// is — this is a single holistic read of the whole report's business logic,
// not tied to how scenarios happen to be grouped for test generation.
// ---------------------------------------------------------------------------

function buildSystemPrompt(reportJson: string): string {
  return `You are a QA analyst turning a system discovery report's business rules into a structured
workflow model. A later, non-LLM step renders this as a flowchart a human reads to understand the
system — so every field must be concrete and machine-usable, not prose.

## System discovery report
${reportJson}

## Your task
For each entity that has a genuine state machine, transition rule, or guard condition described in
"businessRules" or implied by "testScenarios" — NOT every entity, only ones with real state/workflow
— produce:
{
  "name": "<entity name, matching a table/resource name in the report>",
  "states": ["<state1>", "<state2>", ...],
  "rules": [ <Rule>, ... ]
}

A Rule is one of:
  { "kind": "state_transition", "from": "DRAFT", "to": "SUBMITTED", "trigger": "Submit" }
  { "kind": "state_transition", "from": null, "to": "DRAFT", "trigger": "Create" } — "from": null means
    the entity is created directly into "to", with no prior state (use this instead of inventing a
    fake prior state or omitting the creation step)
  { "kind": "forbidden_transition", "from": "SUBMITTED", "to": "DRAFT", "reason": "one-way transition, explicitly disallowed" }
  { "kind": "guard", "action": "delete", "condition": "status == SUBMITTED", "description": "Only DRAFT orders can be deleted; SUBMITTED orders return 409 Conflict" }
  { "kind": "invariant", "description": "OrderItem.unitPrice is a snapshot at creation time, independent of the current Product price" }

Rules:
1. Only include an entity if the report actually describes state/transitions/guards for it — do not
   invent a workflow for an entity that's just plain CRUD with no special rules.
2. "states" must list every state name mentioned for that entity's own governing state field (e.g. an
   enum column) — do not include unrelated statuses belonging to other entities.
3. Use "forbidden_transition" for any transition the report explicitly says is disallowed/rejected —
   this is different from simply omitting it as a state_transition; be explicit when the report is.
4. Use "guard" for a condition on a non-transition action (delete, update) that depends on state or a
   cross-entity reference (e.g. "customers with orders cannot be deleted").
5. Use "invariant" for a data-integrity rule that isn't a transition or an action guard (e.g. a
   snapshot value, a uniqueness constraint).
6. Never invent a state, transition, or guard not stated or clearly implied by the report — if
   unsure, omit it rather than guess.
7. If the entity's initial state on creation is known, express it as a "state_transition" with
   "from": null rather than a fake prior state or a bare "states" entry with no way in.

## Output contract — read carefully
Output ONLY a single valid JSON array of entity workflow objects as described above, no markdown
fences, no prose before or after.`;
}

const USER_MESSAGE = 'Produce the structured workflow model for this report per your instructions.';

export async function proposeWorkflow(
  provider: AgentProvider,
  report: DiscoveryReport,
  sourceReportPath: string,
  /** Which target system's descriptor sourceReportPath belongs to, for the usage log's descriptor filter — see admin/server.ts's descriptorFromReportName(). Optional; omitted callers just get an unlabeled usage entry. */
  descriptorLabel?: string,
): Promise<ProposedWorkflow> {
  const raw = await provider.run({
    systemPrompt: buildSystemPrompt(JSON.stringify(report, null, 2)),
    userMessage: USER_MESSAGE,
    mcpServers: [],
    tools: [],
    maxIterations: 5,
    operation: 'workflow-propose',
    descriptor: descriptorLabel,
  });

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(
      `Workflow proposal response did not contain a JSON array (response started with: ${raw.slice(0, 200)})`,
    );
  }
  const entities = z.array(EntityWorkflowSchema).parse(JSON.parse(jsonMatch[0]));
  verifyWorkflow(entities);

  return {
    generatedAt: new Date().toISOString(),
    sourceReportPath,
    entities,
  };
}

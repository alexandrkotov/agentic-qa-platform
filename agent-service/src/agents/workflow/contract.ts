import { z } from 'zod';

// ---------------------------------------------------------------------------
// Structured business-rule/workflow model — same idea as agents/generate's
// Action/Assertion discriminated union: the LLM proposes structure, not
// prose, so a later step can render it deterministically instead of trying
// to parse free-text businessRules on the fly.
// ---------------------------------------------------------------------------

const RuleSchema = z.discriminatedUnion('kind', [
  /** `from: null` means the entity is created directly into `to` — there is no prior state (renders as the Mermaid [*] initial-state arrow). */
  z.object({ kind: z.literal('state_transition'), from: z.string().nullable(), to: z.string(), trigger: z.string() }),
  z.object({ kind: z.literal('forbidden_transition'), from: z.string(), to: z.string(), reason: z.string() }),
  z.object({ kind: z.literal('guard'), action: z.string(), condition: z.string(), description: z.string() }),
  z.object({ kind: z.literal('invariant'), description: z.string() }),
]);
export type Rule = z.infer<typeof RuleSchema>;

export const EntityWorkflowSchema = z.object({
  /** Should match a table/resource name from the source report. */
  name: z.string(),
  /** Every state name mentioned for this entity's own governing state field — not other entities' statuses. */
  states: z.array(z.string()),
  rules: z.array(RuleSchema),
});
export type EntityWorkflow = z.infer<typeof EntityWorkflowSchema>;

export const ProposedWorkflowSchema = z.object({
  generatedAt: z.string(),
  sourceReportPath: z.string(),
  /** Only entities the report actually describes state/transitions/guards for — plain-CRUD entities are omitted, not padded with an empty workflow. */
  entities: z.array(EntityWorkflowSchema),
});
export type ProposedWorkflow = z.infer<typeof ProposedWorkflowSchema>;

export const ApprovedWorkflowSchema = ProposedWorkflowSchema.extend({
  approvedAt: z.string(),
});
export type ApprovedWorkflow = z.infer<typeof ApprovedWorkflowSchema>;

// ---------------------------------------------------------------------------
// UI navigation flow — same propose-structure-not-prose idea as Rule above,
// but for `components.*.uiPages[]` instead of `businessRules`. A page's own
// action list is already structured in the report; what's missing is which
// actions navigate to another route vs. stay in place, which requires
// interpretation the report doesn't spell out.
// ---------------------------------------------------------------------------

const UiTransitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigation'), action: z.string(), to: z.string() }),
  z.object({ kind: z.literal('in_place_action'), action: z.string(), description: z.string() }),
]);
export type UiTransition = z.infer<typeof UiTransitionSchema>;

export const UiPageFlowSchema = z.object({
  /** Should match a `uiPages[].route` from the source report. */
  route: z.string(),
  transitions: z.array(UiTransitionSchema),
});
export type UiPageFlow = z.infer<typeof UiPageFlowSchema>;

export const ProposedUiFlowSchema = z.object({
  generatedAt: z.string(),
  sourceReportPath: z.string(),
  pages: z.array(UiPageFlowSchema),
});
export type ProposedUiFlow = z.infer<typeof ProposedUiFlowSchema>;

export const ApprovedUiFlowSchema = ProposedUiFlowSchema.extend({
  approvedAt: z.string(),
});
export type ApprovedUiFlow = z.infer<typeof ApprovedUiFlowSchema>;

// ---------------------------------------------------------------------------
// Sequence flow — the "before coding" whiteboard diagram: an ordered,
// cross-component trace of what happens for one specific scenario, unlike
// Architecture's static topology or UI Inventory's unordered action list.
// Which UI action calls which endpoint, which writes which tables, which
// publishes which Kafka topic isn't spelled out anywhere in the report — it
// has to be inferred, same reasoning as the other two propose/approve steps.
// ---------------------------------------------------------------------------

const SequenceStepSchema = z.object({
  /** A report component key (e.g. "web_ui", "rest_api", "postgres") exactly as it appears in the source report, or the literal "User" for the human actor — never an invented participant name. */
  from: z.string(),
  to: z.string(),
  /** What happens on this step, concretely — e.g. "POST /orders", "INSERT Order, OrderItem", "publish orders.status-changed". */
  label: z.string(),
});
export type SequenceStep = z.infer<typeof SequenceStepSchema>;

export const ScenarioFlowSchema = z.object({
  /** Ideally matches a testScenarios[].name from the source report. */
  name: z.string(),
  description: z.string(),
  steps: z.array(SequenceStepSchema),
});
export type ScenarioFlow = z.infer<typeof ScenarioFlowSchema>;

export const ProposedSequenceFlowSchema = z.object({
  generatedAt: z.string(),
  sourceReportPath: z.string(),
  /** A handful of representative cross-component scenarios, not every testScenario — see proposeSequenceFlow.ts's prompt. */
  scenarios: z.array(ScenarioFlowSchema),
});
export type ProposedSequenceFlow = z.infer<typeof ProposedSequenceFlowSchema>;

export const ApprovedSequenceFlowSchema = ProposedSequenceFlowSchema.extend({
  approvedAt: z.string(),
});
export type ApprovedSequenceFlow = z.infer<typeof ApprovedSequenceFlowSchema>;

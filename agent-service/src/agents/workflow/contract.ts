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

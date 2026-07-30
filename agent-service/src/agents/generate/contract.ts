import { z } from 'zod';

// ---------------------------------------------------------------------------
// Stage 1 — grouping (deterministic heuristic, group.ts)
// ---------------------------------------------------------------------------

export const GroupSchema = z.object({
  key: z.string(),
  scenarioNames: z.array(z.string()).min(1),
  /** Why these scenarios ended up together — shown to the human reviewer, e.g. "cross-functional: security" or "entity: orders". */
  rationale: z.string().optional(),
});
export type Group = z.infer<typeof GroupSchema>;

export const ProposedGroupingSchema = z.object({
  generatedAt: z.string(),
  sourceReportPath: z.string(),
  crossFunctionalTypes: z.array(z.string()),
  /** Ungrouped-ratio threshold that was in effect when this was computed — see group.ts. */
  threshold: z.number(),
  groups: z.array(GroupSchema),
  ungrouped: z.array(z.string()),
  /** true when ungrouped scenarios exceeded `threshold` — a warning that `groups` below may not be reliable, not a data transform: `groups`/`ungrouped` are still the real heuristic output either way, so a human can actually act on the warning (reassign by hand) instead of it being replaced by a single opaque group. */
  flatFallback: z.boolean(),
});
export type ProposedGrouping = z.infer<typeof ProposedGroupingSchema>;

export const ApprovedGroupingSchema = ProposedGroupingSchema.extend({
  approvedAt: z.string(),
});
export type ApprovedGrouping = z.infer<typeof ApprovedGroupingSchema>;

// ---------------------------------------------------------------------------
// Mechanical token-budget split (budget.ts) — output unit consumed by Stage 2
// ---------------------------------------------------------------------------

export const RenderGroupSchema = z.object({
  key: z.string(),
  scenarioNames: z.array(z.string()).min(1),
});
export type RenderGroup = z.infer<typeof RenderGroupSchema>;

// ---------------------------------------------------------------------------
// Stage 2 — structured scenario spec (LLM, spec.ts)
// ---------------------------------------------------------------------------

const ApiActionSchema = z.object({
  kind: z.literal('api'),
  method: z.string(),
  path: z.string(),
  requestBody: z.record(z.string(), z.unknown()).nullable().optional(),
});

const UiActionSchema = z.object({
  kind: z.literal('ui'),
  /** Accessibility role, e.g. "textbox", "button", "combobox" — matches Playwright's getByRole. */
  role: z.string(),
  /** Accessible name / label text — matches Playwright's getByLabel or getByRole's name option. */
  label: z.string(),
  route: z.string().optional(),
  value: z.string().optional(),
  /** Distinguishing visible text of the specific row/card to act within, when the page shows more than one (e.g. an order id) — omit on pages with only one instance of the target. */
  scope: z.string().optional(),
});

const ActionSchema = z.discriminatedUnion('kind', [ApiActionSchema, UiActionSchema]);
export type Action = z.infer<typeof ActionSchema>;

const AssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status_code'), statusCode: z.number() }),
  z.object({ kind: z.literal('body_field'), field: z.string(), expected: z.unknown() }),
  z.object({ kind: z.literal('error_message'), matches: z.string() }),
  z.object({
    kind: z.literal('db_row'),
    table: z.string(),
    where: z.record(z.string(), z.unknown()),
    expectedFields: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('ui_text'),
    role: z.string(),
    label: z.string(),
    expectedText: z.string(),
    scope: z.string().optional(),
  }),
  z.object({
    kind: z.literal('ui_visible'),
    role: z.string(),
    label: z.string(),
    visible: z.boolean(),
    scope: z.string().optional(),
  }),
  z.object({
    kind: z.literal('kafka_message'),
    topic: z.string(),
    expectedFields: z.record(z.string(), z.unknown()),
  }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

export const ScenarioSpecSchema = z.object({
  /** Must match a testScenarios[].name from the source report verbatim — this is how corrections.ts and templates key back to it. */
  scenarioName: z.string(),
  group: z.string(),
  type: z.string(),
  given: z.array(ActionSchema),
  when: ActionSchema,
  then: z.array(AssertionSchema).min(1),
  /** Set instead of a guessed assertion when the report itself is genuinely uncertain about the expected behavior — mirrors today's generate.ts rule 5. */
  unconfirmed: z.string().nullable().optional(),
});
export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;

export const ProposedSpecSchema = z.object({
  generatedAt: z.string(),
  sourceGroupingPath: z.string(),
  scenarios: z.array(ScenarioSpecSchema).min(1),
});
export type ProposedSpec = z.infer<typeof ProposedSpecSchema>;

export const ApprovedSpecSchema = ProposedSpecSchema.extend({
  approvedAt: z.string(),
});
export type ApprovedSpec = z.infer<typeof ApprovedSpecSchema>;

// ---------------------------------------------------------------------------
// Manual scenario corrections (corrections.ts) — keyed by scenario name,
// stored per target system next to its descriptor. Survives regrouping
// because it's keyed by name, not by group.
// ---------------------------------------------------------------------------

export const CorrectionsSchema = z.record(z.string(), z.string());
export type Corrections = z.infer<typeof CorrectionsSchema>;

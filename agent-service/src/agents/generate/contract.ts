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
  /** The Stage 1 group's own key this render-group was split from (equal to `key` when the group wasn't split) — lets Stage 3 merge sibling render-groups back into one file per Stage 1 group, see merge.ts. */
  sourceKey: z.string(),
  scenarioNames: z.array(z.string()).min(1),
});
export type RenderGroup = z.infer<typeof RenderGroupSchema>;

// ---------------------------------------------------------------------------
// Stage 2 — freeform generation (LLM, spec.ts). One LLM call per render-group
// writes the real .feature and .steps.ts content directly — no structured
// Action/Assertion DSL, no deterministic template renderer downstream (see
// verify.ts for the deterministic safety net that replaces that guarantee,
// and render.ts for how these two strings become real files on disk).
// ---------------------------------------------------------------------------

export const GeneratedGroupSchema = z.object({
  key: z.string(),
  /** Copied straight from the RenderGroup that produced this — see RenderGroupSchema. */
  sourceKey: z.string(),
  /** Must match this render-group's own scenarioNames exactly — verified against Scenario: lines actually present in featureContent, see verify.ts. */
  scenarioNames: z.array(z.string()).min(1),
  featureContent: z.string().min(1),
  stepsContent: z.string().min(1),
});
export type GeneratedGroup = z.infer<typeof GeneratedGroupSchema>;

export const ProposedGenerationSchema = z.object({
  generatedAt: z.string(),
  sourceGroupingPath: z.string(),
  groups: z.array(GeneratedGroupSchema).min(1),
});
export type ProposedGeneration = z.infer<typeof ProposedGenerationSchema>;

export const ApprovedGenerationSchema = ProposedGenerationSchema.extend({
  approvedAt: z.string(),
});
export type ApprovedGeneration = z.infer<typeof ApprovedGenerationSchema>;

// ---------------------------------------------------------------------------
// Manual scenario corrections (corrections.ts) — keyed by scenario name,
// stored per target system next to its descriptor. Survives regrouping
// because it's keyed by name, not by group.
// ---------------------------------------------------------------------------

export const CorrectionsSchema = z.record(z.string(), z.string());
export type Corrections = z.infer<typeof CorrectionsSchema>;

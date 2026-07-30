import { z } from 'zod';

// ---------------------------------------------------------------------------
// The discovery report is free-form JSON produced by an LLM (see
// bootstrap/discovery.ts) and is never validated against a schema at the
// source — its shape can vary between target systems (not every system has,
// say, a kafka_consumer component) and even between runs of the same system.
// This schema only pins down the handful of fields the generate pipeline
// itself reads (testScenarios, and — where present — a component's
// `.tables[]`/`.endpoints[]`); everything else is preserved as-is via
// `.passthrough()` rather than rejected.
// ---------------------------------------------------------------------------

const ColumnSchema = z.object({ name: z.string() }).passthrough();

const TableSchema = z
  .object({
    name: z.string(),
    columns: z.array(ColumnSchema).optional(),
  })
  .passthrough();

const EndpointSchema = z
  .object({
    method: z.string().optional(),
    path: z.string(),
  })
  .passthrough();

/**
 * A component's reported shape depends on its type (postgres reports
 * `.tables[]`, rest-api reports `.endpoints[]`, web-ui reports `.uiPages[]`,
 * kafka-consumer reports `.sampleMessages[]`/`.inferredSchema`, etc.) — the
 * grouping heuristic only cares about `.tables[]` and `.endpoints[]` when
 * present, on whichever component happens to have them, so those are the only
 * fields pinned here. Deliberately not keyed by a fixed set of component
 * names: the real key in a report is sanitized by `componentKey()` in
 * descriptor/schema.ts (hyphens -> underscores) and can be a custom `name`,
 * so callers must find components by shape, not by a literal string like
 * "postgres" or "rest-api".
 */
const ReportComponentSchema = z
  .object({
    tables: z.array(TableSchema).optional(),
    endpoints: z.array(EndpointSchema).optional(),
  })
  .passthrough();

const TestScenarioSchema = z
  .object({
    name: z.string(),
    // "happy_path" | "edge_case" | "security" by the discovery prompt's own
    // contract (see buildSystemPrompt in bootstrap/discovery.ts), but kept as
    // an open string here rather than a strict enum — the LLM is not
    // guaranteed to comply, and a typo'd type should not fail report parsing.
    type: z.string(),
    description: z.string().default(''),
  })
  .passthrough();

export const DiscoveryReportSchema = z
  .object({
    generatedAt: z.string().optional(),
    components: z.record(z.string(), ReportComponentSchema).default({}),
    businessRules: z.array(z.string()).default([]),
    testScenarios: z.array(TestScenarioSchema).min(1),
  })
  .passthrough();

export type DiscoveryReport = z.infer<typeof DiscoveryReportSchema>;
export type ReportComponent = z.infer<typeof ReportComponentSchema>;
export type TestScenario = z.infer<typeof TestScenarioSchema>;

export function parseDiscoveryReport(json: unknown): DiscoveryReport {
  return DiscoveryReportSchema.parse(json);
}

import { z } from 'zod';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import type { DiscoveryReport } from './reportSchema.ts';
import { ScenarioSpecSchema, type Corrections, type ProposedSpec, type RenderGroup, type ScenarioSpec } from './contract.ts';

// ---------------------------------------------------------------------------
// Stage 2 — structured Given/When/Then spec, one LLM call per render-group
// (produced by budget.ts). A later, non-LLM step (templates/ + render.ts)
// turns this into actual Gherkin and Playwright code, so every field here
// must be concrete and machine-usable rather than prose.
//
// The model is deliberately NOT trusted with `group` or `type` — both are
// already known from data (the render-group's own key, and the source
// report's testScenarios[].type by exact name) and are filled in by code
// after validation, the same "never trust the model to have followed the
// prompt's rules perfectly" principle agents/e2e/diagnose.ts applies to
// structuredFix.
// ---------------------------------------------------------------------------

const ModelScenarioSpecSchema = ScenarioSpecSchema.omit({ group: true, type: true });
type ModelScenarioSpec = z.infer<typeof ModelScenarioSpecSchema>;

function buildCorrectionsBlock(renderGroup: RenderGroup, corrections: Corrections): string {
  const relevant = renderGroup.scenarioNames
    .filter((name) => corrections[name])
    .map((name) => `### "${name}"\n${corrections[name]}`);
  if (relevant.length === 0) return '';
  return `\n## Known corrections — apply these OVER the report's own text for these scenarios\n${relevant.join('\n\n')}\n`;
}

function buildSystemPrompt(renderGroup: RenderGroup, reportJson: string, correctionsBlock: string): string {
  return `You are a QA test-specification agent. You convert a system discovery report (JSON) into a
structured Given/When/Then specification for a BDD test suite, one group of scenarios at a time. A
later, non-LLM step turns your structured output into actual Gherkin and Playwright code — so every
field must be concrete and machine-usable, not prose.

## System discovery report (source of truth for endpoints, schema, business rules)
${reportJson}
${correctionsBlock}
## Your task for THIS call
Produce a structured spec for the "${renderGroup.key}" group ONLY. Cover exactly these testScenarios
entries (by report name) and no others:
${renderGroup.scenarioNames.map((n) => `- "${n}"`).join('\n')}

## Output shape — one object per scenario listed above
{
  "scenarioName": "<exact name from the list above>",
  "given": [ <Action>, ... ],
  "when": <Action>,
  "then": [ <Assertion>, ... ],
  "unconfirmed": "<short note on what's unconfirmed>" | omit this key if confident
}

An Action is either:
  { "kind": "api", "method": "GET|POST|PATCH|DELETE", "path": "/orders/{id}", "requestBody": {...} or null }
  { "kind": "ui", "role": "<accessibility role, e.g. textbox/button/combobox>", "label": "<accessible name>", "route": "/orders" (optional), "value": "<value to fill/select>" (optional) }

An Assertion is one of:
  { "kind": "status_code", "statusCode": 201 }
  { "kind": "body_field", "field": "status", "expected": "SUBMITTED" }
  { "kind": "error_message", "matches": "Cannot transition order {id} from SUBMITTED to DRAFT" }
  { "kind": "db_row", "table": "OrderStatusHistory", "where": {"orderId": "<id>"}, "expectedFields": {"status": "DRAFT"} }
  { "kind": "ui_text", "role": "cell", "label": "Status", "expectedText": "SUBMITTED" }
  { "kind": "ui_visible", "role": "button", "label": "Submit", "visible": false }

Rules:
1. "given" lists setup actions in order (e.g. create a customer, then a product, then an order) — an
   empty array if the scenario needs no setup beyond what "when" itself creates.
2. "when" is the single action under test.
3. "then" must have at least one assertion, using concrete values from the report or a Known correction
   above — never invent a status code, field name, or table name not present in either.
4. API-only scenarios (validation errors, 404s, 409s) use "api" actions exclusively — do not invent a UI
   path for something the report only exposes via the API.
5. UI scenarios use the accessibility roles/labels noted in the report's uiPages (textbox, spinbutton,
   combobox, button).
6. Where the report itself is genuinely uncertain (says "verify behavior", "may be allowed or blocked",
   etc.) and no Known correction above resolves it, set "unconfirmed" to a short note instead of
   inventing a confident assertion.
7. Do not include "group" or "type" fields in your output — those are filled in mechanically afterward.

## Output contract — read carefully
Output ONLY a single valid JSON array of the scenario objects described above, no markdown fences, no
prose before or after.`;
}

const USER_MESSAGE = (renderGroup: RenderGroup) =>
  `Produce the structured spec for the "${renderGroup.key}" group per your instructions. Return the JSON array with exactly those scenario objects.`;

function parseModelSpecResponse(raw: string, renderGroup: RenderGroup): ModelScenarioSpec[] {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(
      `[${renderGroup.key}] Agent response did not contain a JSON array (likely truncated — response started with: ${raw.slice(0, 200)})`,
    );
  }
  const parsed = JSON.parse(jsonMatch[0]);
  const specs = z.array(ModelScenarioSpecSchema).parse(parsed);

  const returnedNames = new Set(specs.map((s) => s.scenarioName));
  const expectedNames = new Set(renderGroup.scenarioNames);
  const missing = [...expectedNames].filter((n) => !returnedNames.has(n));
  const extra = [...returnedNames].filter((n) => !expectedNames.has(n));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `[${renderGroup.key}] Scenario name mismatch — missing: [${missing.join(', ')}], unexpected: [${extra.join(', ')}]`,
    );
  }
  return specs;
}

export async function generateSpecForGroup(
  provider: AgentProvider,
  renderGroup: RenderGroup,
  report: DiscoveryReport,
  reportJson: string,
  corrections: Corrections,
): Promise<ScenarioSpec[]> {
  const raw = await provider.run({
    systemPrompt: buildSystemPrompt(renderGroup, reportJson, buildCorrectionsBlock(renderGroup, corrections)),
    userMessage: USER_MESSAGE(renderGroup),
    mcpServers: [],
    tools: [],
    maxIterations: 5,
    operation: `generate-spec:${renderGroup.key}`,
  });

  const modelSpecs = parseModelSpecResponse(raw, renderGroup);
  const typeByName = new Map(report.testScenarios.map((s) => [s.name, s.type]));
  return modelSpecs.map((spec) => ({
    ...spec,
    group: renderGroup.key,
    type: typeByName.get(spec.scenarioName) ?? 'unknown',
  }));
}

export interface GenerateSpecResult {
  spec: ProposedSpec;
  failures: string[];
}

export async function generateSpec(
  provider: AgentProvider,
  renderGroups: RenderGroup[],
  report: DiscoveryReport,
  reportJson: string,
  corrections: Corrections,
  sourceGroupingPath: string,
): Promise<GenerateSpecResult> {
  const scenarios: ScenarioSpec[] = [];
  const failures: string[] = [];

  for (const renderGroup of renderGroups) {
    console.log(`\n--- Render group: ${renderGroup.key} (${renderGroup.scenarioNames.length} scenario(s)) ---`);
    try {
      scenarios.push(...(await generateSpecForGroup(provider, renderGroup, report, reportJson, corrections)));
    } catch (err) {
      console.error(`  [${renderGroup.key}] FAILED: ${(err as Error).message}`);
      failures.push(renderGroup.key);
    }
  }

  return {
    spec: { generatedAt: new Date().toISOString(), sourceGroupingPath, scenarios },
    failures,
  };
}

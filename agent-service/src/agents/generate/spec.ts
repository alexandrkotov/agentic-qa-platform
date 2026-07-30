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
  { "kind": "ui", "role": "<accessibility role, e.g. textbox/button/combobox>", "label": "<accessible name>", "route": "/orders" (optional), "value": "<value to fill/select>" (optional), "scope": "<distinguishing visible text of the row/card>" (optional, see below) }

An Assertion is one of:
  { "kind": "status_code", "statusCode": 201 }
  { "kind": "body_field", "field": "status", "expected": "SUBMITTED" }
  { "kind": "error_message", "matches": "Cannot transition order {id} from SUBMITTED to DRAFT" }
  { "kind": "db_row", "table": "OrderStatusHistory", "where": {"orderId": "<id>"}, "expectedFields": {"status": "DRAFT"} }
  { "kind": "ui_text", "role": "cell", "label": "Status", "expectedText": "SUBMITTED", "scope": "..." (optional) }
  { "kind": "ui_visible", "role": "button", "label": "Submit", "visible": false, "scope": "..." (optional) }
  { "kind": "kafka_message", "topic": "orders.status-changed", "expectedFields": {"orderId": "{orders.id}", "status": "SUBMITTED"} }

"scope" (on any "ui" action or "ui_text"/"ui_visible" assertion): pages that list more than one instance
of the same thing (e.g. an "orders" page showing one card per order, each with its own "Show history"
button) have more than one element with the same role+label — omitting "scope" there gets a strict-mode
locator error at runtime, not a single unambiguous element. Set "scope" to visible text that uniquely
identifies the ONE row/card to act within — typically the id of the entity this scenario itself just
created (e.g. "{orders.id}", which resolves to the real id at runtime) or another value from "given" you
know is unique on the page. Omit "scope" only when the report shows the target page/section has just
one instance of the role+label (e.g. a single "Create Order" button, a single form).

Rules:
1. "given" lists setup actions in order (e.g. create a customer, then a product, then an order) — an
   empty array if the scenario needs no setup beyond what "when" itself creates.
1a. Referencing an entity a "given" step just created: NEVER invent a literal id number for it in a
   later requestBody field (e.g. "customerId", "productId") or an assertion's "where"/"expected" value.
   Use the literal placeholder string "{<resource>.id}", where <resource> is the plural resource name
   from that entity's own creating endpoint's path (e.g. "{customers.id}", "{products.id}",
   "{orders.id}") — it means "the id returned by the most recent given/when POST to that resource in
   THIS scenario". Example: given steps create a customer then a product; the "when" step creates an
   order: "requestBody": { "customerId": "{customers.id}", "items": [{"productId": "{products.id}",
   "quantity": 1}] }. Path parameters (e.g. "/orders/{id}") keep the literal "{id}" form already shown
   in the report's endpoint path — that is resolved separately, against the path's own resource. If
   "given" creates MORE THAN ONE of the same resource (e.g. two different products) and a later step
   must refer to a specific one, not just the latest, use "{<resource>[N].id}" with a 0-based index in
   creation order — e.g. the first product created is "{products[0].id}", the second is
   "{products[1].id}". Do not invent any other indexing/reference syntax — only "{<resource>.id}" (=
   the latest) and "{<resource>[N].id}" (= the Nth created) are supported.
1b. Any field value a real system is likely to enforce as unique (an email address, a username, a SKU,
   a slug, etc.) must NOT be a fixed literal you invent (e.g. "jane@example.com") — the same generated
   test runs more than once, and a fixed value collides with data a previous run already created. Embed
   the literal token "{{unique}}" at the point in the string where a fresh value must go instead, e.g.
   "jane-{{unique}}@example.com". Do NOT invent your own "unique-looking" value (like a fake timestamp)
   — only the runtime can guarantee true uniqueness across runs. If a scenario needs two DIFFERENT
   unique values in the same scenario (e.g. two distinct customers), give each its own distinguishing
   literal text around the token (e.g. "customer-a-{{unique}}@example.com" and
   "customer-b-{{unique}}@example.com") — "{{unique}}" itself resolves to the SAME value everywhere it
   appears within one scenario run, which is required when a scenario's whole point is reusing the same
   value twice (e.g. "Duplicate email" creates it once, then reuses the exact same value on purpose).
2. "when" is the single action under test.
3. "then" must have at least one assertion, using concrete values from the report or a Known correction
   above — never invent a status code, field name, or table name not present in either.
3a. The 7 Action/Assertion "kind" values shown above are the ONLY ones that exist — never write a "kind"
   that isn't one of them (e.g. there is no "kafka_message" unless the report/component actually shows a
   Kafka topic to check against). Likewise, a "ui" action/assertion always needs a concrete, real "role"
   and "label" you can point to in the report's uiPages — if you cannot name both, do not use "ui" at
   all. If NONE of the 7 kinds can express what a scenario needs to verify, do not force one anyway
   (an invalid or empty-ish shape breaks this ENTIRE call, discarding every other scenario in this
   batch too) — instead assert whatever you CAN confidently express with an existing kind (even if it's
   only a partial check, e.g. the status code but not the side effect), and use "unconfirmed" to name
   the aspect you couldn't cover and why.
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

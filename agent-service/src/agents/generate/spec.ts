import { z } from 'zod';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import { GeneratedGroupSchema, type Corrections, type GeneratedGroup, type ProposedGeneration, type RenderGroup } from './contract.ts';
import { compileAndVerify, collectExistingStepPatterns } from './verify.ts';

// ---------------------------------------------------------------------------
// Stage 2 — one LLM call per render-group (produced by budget.ts), writing
// the real .feature and real .steps.ts content directly — real parameterized
// Gherkin, real Playwright/DB step implementations, no intermediate
// Action/Assertion JSON DSL. A later, no-LLM step (render.ts) writes exactly
// those two strings to disk unchanged.
//
// Freeform generation loses the structural "step text can never mismatch its
// step definition" guarantee the old DSL-based design had by construction
// (see the git history of templates/phrases.ts). verify.ts is the
// deterministic replacement: every response is checked — scenario-name
// coverage, every Gherkin step actually matching a step definition compiled
// via @cucumber/cucumber-expressions, and no step-pattern text colliding
// with another group — before it's accepted. A group that fails is added to
// this call's `failures: string[]` and skipped, same pattern this file
// already used pre-rewrite; no retry loop.
// ---------------------------------------------------------------------------

const ModelGenerationSchema = GeneratedGroupSchema.omit({ key: true, sourceKey: true, scenarioNames: true });
type ModelGeneration = z.infer<typeof ModelGenerationSchema>;

function buildCorrectionsBlock(renderGroup: RenderGroup, corrections: Corrections): string {
  const relevant = renderGroup.scenarioNames
    .filter((name) => corrections[name])
    .map((name) => `### "${name}"\n${corrections[name]}`);
  if (relevant.length === 0) return '';
  return `\n## Known corrections — apply these OVER the report's own text for these scenarios\n${relevant.join('\n\n')}\n`;
}

function buildSystemPrompt(renderGroup: RenderGroup, reportJson: string, correctionsBlock: string): string {
  return `You are a QA test-automation agent. You convert a system discovery report (JSON) into a REAL,
readable BDD test suite, one group of scenarios at a time — a real Gherkin .feature file and a real
Playwright/playwright-bdd .steps.ts file. There is no intermediate JSON format and no generic phrase
template downstream: whatever Gherkin step text and step-definition code you write is exactly what ends
up on disk and what actually runs.

## System discovery report (source of truth for endpoints, schema, business rules)
${reportJson}
${correctionsBlock}
## Your task for THIS call
Produce the .feature and .steps.ts content for the "${renderGroup.key}" group ONLY. Cover exactly these
testScenarios entries (by report name) and no others:
${renderGroup.scenarioNames.map((n) => `- "${n}"`).join('\n')}

## Tech stack and fixtures
- Playwright Test + playwright-bdd, TypeScript/ESM.
- .steps.ts starts with \`import { createBdd } from 'playwright-bdd';\` and
  \`const { Given, When, Then, Before } = createBdd();\`.
- Fixtures available in a step definition's second argument: \`{ request, page }\` (Playwright's own
  APIRequestContext and Page).
- \`playwright.config.ts\`'s own \`baseURL\` points at the FRONTEND dev server, not the API — so
  \`page.goto(...)\` with a relative path (e.g. \`page.goto('/products')\`) resolves correctly, but
  \`request.post/get/patch/delete(...)\` with a bare relative path does NOT reach the real backend and
  will silently hit the frontend server instead. Declare a constant
  \`BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000'\` once near the top of the file
  (after the imports), and prefix every API request URL with it — e.g. for POST /products, write
  \`request.post(BACKEND_URL + '/products', { data: {...} })\` (string concatenation or a template
  literal, either is fine) — never call request.post/get/patch/delete with a bare relative path like
  \`'/products'\` on its own.
- \`import { db, ensureDbConnected } from '../support/db';\` for real Postgres assertions — call
  \`await ensureDbConnected();\` once before the first \`db.query(...)\`, then use \`db.query(sql, params)\`
  (parameterized, never string-concatenate a value into the SQL).
- \`import { expect } from '@playwright/test';\` for every assertion.
- Only if this group's scenarios need it: \`import { ensureKafkaConsumerReady, waitForKafkaMessage } from
  '../support/kafka';\` — call \`await ensureKafkaConsumerReady([...topics])\` in \`Before\`, before any
  action that could trigger the message, not inside the assertion step itself.
- Only for a UI scenario whose target page repeats the same role+label more than once (e.g. one "Show
  history" button per order card): \`import { findScopedLocator } from '../support/ui';\` — call
  \`await findScopedLocator(page, distinguishingScopeText, role, label)\` instead of a bare
  \`page.getByRole(...)\`. Every other UI interaction uses plain \`page.getByRole\`/\`getByPlaceholder\`/
  \`getByLabel\` directly — do not import this for pages with only one instance of the target element.

## Gherkin rules (the .feature file)
1. Write real, idiomatic, parameterized Gherkin — concrete business language, not a generic phrase
   template. Use Cucumber expression placeholders (\`{string}\`, \`{int}\`, \`{float}\`) for values that
   vary, e.g. \`When I send a POST request to create a product named {string} with price {float}\`.
2. Reuse the exact same step text within THIS group's own file whenever two scenarios genuinely need
   the identical action/assertion — e.g. two scenarios both asserting "the response status should be 400
   with a validation error" should use that literal step text verbatim in both, so they share one step
   definition. Do not invent a slightly different phrasing for the same thing.
3. Tag every scenario \`@<type> @${renderGroup.key}\` on the line above \`Scenario:\`, where \`<type>\` is
   that scenario's exact \`type\` from the report (e.g. \`@happy_path @${renderGroup.key}\`).
4. Where the report itself is genuinely uncertain (says "verify behavior", "may be allowed or blocked",
   etc.) and no Known correction above resolves it, write a \`# TODO (unconfirmed): ...\` comment line
   directly above that scenario's first step, explaining what's unconfirmed and what you assumed — never
   invent a confident assertion for something the report doesn't actually support.
5. Word steps in THIS group's own entity vocabulary, not generic wording that could apply to any group —
   e.g. this group's steps should read like "a product ...", "the product ...", not "an item ..." or
   generic wording that could just as easily belong to a different entity. This matters beyond style:
   playwright-bdd step text is global across every .steps.ts file the suite loads, not scoped per group
   or tag — two different groups' files defining the exact same step wording (even unintentionally) will
   collide/shadow each other at runtime. Two scenarios in DIFFERENT groups needing a similar-sounding
   assertion (e.g. "the response status should be 400 with a validation error") should still each phrase
   it using their own group's entity name if there's any risk of an exact duplicate, e.g. "the product
   creation response should be a 400 validation error" vs "the order creation response should be a 400
   validation error" — when genuinely generic wording is unavoidable, that's fine too, just be aware it
   is a real collision risk across groups, not just a style preference.
6. Never invent a status code, field name, table name, or business rule not present in the report or a
   Known correction above.
7. UI scenarios must use accessibility roles/labels you can point to in the report's own \`uiPages\`
   (textbox, spinbutton, combobox, button, etc.) — if you cannot name a concrete role and label from the
   report, do not write a UI scenario for it.
8. API-only scenarios (validation errors, 404s, 409s) use only API steps — do not invent a UI path for
   something the report only exposes via the API.

## Step-definition rules (the .steps.ts file)
1. Every step definition is REAL, working code — a real \`await request.post(...)\`/\`.get(...)\`/
   \`.patch(...)\`/\`.delete(...)\` with a real URL built from the report's own endpoint paths, real
   \`page.getByRole(...)\`/\`getByPlaceholder(...)\`/\`getByLabel(...)\` interactions, real
   \`await db.query(...)\` lookups, real \`expect(...)\` assertions with the actual value being checked —
   never a one-line dispatcher that just forwards a payload to a shared generic helper.
2. Scenario-scoped state: declare \`let ctx: Record<string, any> = {};\` once, reset it in
   \`Before({ tags: '@${renderGroup.key}' }, async () => { ctx = {}; });\`, and use real, specifically-named
   properties for whatever this group's scenarios need to remember between steps — e.g. \`ctx.productId\`,
   \`ctx.response\`, \`ctx.customerId\` — never a generic id array or lookup-by-resource-name scheme.
3. Uniqueness: any field value a real system is likely to enforce as unique (an email, a SKU, a slug,
   etc.) must be a real inline expression that's actually unique per run — e.g.
   \`\\\`product-\${Date.now()}@example.com\\\`\` — never a fixed literal you invent, and never a placeholder
   string resolved by something else later. Reuse the exact same generated value within one scenario
   wherever the scenario's own point is reusing it on purpose (e.g. a "duplicate email" scenario), by
   computing it once into a \`ctx\` property and reading that property both times, not by regenerating it.
4. Postgres NUMERIC columns come back from \`db.query\` as fixed-scale strings (e.g. \`"75.00"\`) — compare
   them with \`Number(actual)\` against the expected numeric value, not strict/string equality.
5. Kafka: only import and subscribe if a scenario in this group actually needs to check a Kafka message;
   subscribe in \`Before\`, before any step that could trigger the message.

## Output contract — read carefully
Output ONLY a single valid JSON object with exactly two string keys, no markdown fences, no prose before
or after:
{
  "featureContent": "<the full, complete .feature file content, starting with \\"Feature: ${renderGroup.key}\\">",
  "stepsContent": "<the full, complete .steps.ts file content, starting with the createBdd import>"
}
Both values are the LITERAL file contents as JSON strings (newlines as \\n, quotes escaped normally) —
not a summary, not truncated. Do not wrap either value in markdown code fences inside the JSON string.`;
}

const USER_MESSAGE = (renderGroup: RenderGroup) =>
  `Produce the .feature and .steps.ts content for the "${renderGroup.key}" group per your instructions. Return the JSON object with exactly those two keys.`;

function parseModelGenerationResponse(raw: string): ModelGeneration {
  const fenceMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  const jsonText = fenceMatch ? fenceMatch[1] : raw;
  const parsed = JSON.parse(jsonText);
  return ModelGenerationSchema.parse(parsed);
}

export async function generateGenerationForGroup(
  provider: AgentProvider,
  renderGroup: RenderGroup,
  reportJson: string,
  corrections: Corrections,
  patternRegistry: Map<string, string>,
): Promise<GeneratedGroup> {
  const raw = await provider.run({
    systemPrompt: buildSystemPrompt(renderGroup, reportJson, buildCorrectionsBlock(renderGroup, corrections)),
    userMessage: USER_MESSAGE(renderGroup),
    mcpServers: [],
    tools: [],
    maxIterations: 5,
    operation: `generate:${renderGroup.key}`,
  });

  const modelGeneration = parseModelGenerationResponse(raw);
  const group: GeneratedGroup = {
    key: renderGroup.key,
    sourceKey: renderGroup.sourceKey,
    scenarioNames: renderGroup.scenarioNames,
    ...modelGeneration,
  };

  const ownPatterns = compileAndVerify(group, patternRegistry);
  for (const [pattern, owner] of ownPatterns) patternRegistry.set(pattern, owner);

  return group;
}

export interface GenerateGenerationResult {
  generation: ProposedGeneration;
  failures: string[];
}

export async function generateGeneration(
  provider: AgentProvider,
  renderGroups: RenderGroup[],
  reportJson: string,
  corrections: Corrections,
  sourceGroupingPath: string,
  testsStepsDir: string,
): Promise<GenerateGenerationResult> {
  const groups: GeneratedGroup[] = [];
  const failures: string[] = [];

  // Excludes by sourceKey, not each render-group's own (possibly split) key —
  // on-disk .steps.ts files are named by sourceKey (see merge.ts/render.ts),
  // so a group split into "customers-1"/"customers-2" must still exclude the
  // single on-disk "customers.steps.ts" it's about to replace.
  const patternRegistry = await collectExistingStepPatterns(
    testsStepsDir,
    [...new Set(renderGroups.map((g) => g.sourceKey))],
  );

  for (const renderGroup of renderGroups) {
    console.log(`\n--- Render group: ${renderGroup.key} (${renderGroup.scenarioNames.length} scenario(s)) ---`);
    try {
      groups.push(await generateGenerationForGroup(provider, renderGroup, reportJson, corrections, patternRegistry));
    } catch (err) {
      console.error(`  [${renderGroup.key}] FAILED: ${(err as Error).message}`);
      failures.push(renderGroup.key);
    }
  }

  return {
    generation: { generatedAt: new Date().toISOString(), sourceGroupingPath, groups },
    failures,
  };
}

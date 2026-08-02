import { z } from 'zod';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import { GeneratedGroupSchema, type Corrections, type GeneratedGroup, type ProposedGeneration, type RenderGroup } from './contract.ts';
import { compileAndVerify, collectExistingStepPatterns } from './verify.ts';
import { mergeGroups } from './merge.ts';

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

function buildClaimedPatternsBlock(claimedPatterns: string[]): string {
  if (claimedPatterns.length === 0) return '';
  return `\n## Step wording already claimed by OTHER groups (do not reuse verbatim)
playwright-bdd step text is global across every .steps.ts file the suite loads, not scoped per group or
tag — every line below is a step-definition pattern another group already defined (either already on disk,
or generated earlier in this same batch). Writing the exact same wording again for a similar action in THIS
group will collide and fail an automated check before this generation is even accepted. If this group needs
a similar or identical real-world action (e.g. another group already has "a customer exists with email
{string} and name {string}" and this group also needs a customer to exist as a precondition), phrase THIS
group's version distinctly — tie it to what this group is actually testing, e.g. "an existing customer with
email {string} and name {string} is available for the order", not a copy of another group's exact words:
${claimedPatterns.map((p) => `- ${p}`).join('\n')}
`;
}

function buildSystemPrompt(renderGroup: RenderGroup, reportJson: string, correctionsBlock: string, claimedPatterns: string[]): string {
  return `You are a QA test-automation agent. You convert a system discovery report (JSON) into a REAL,
readable BDD test suite, one group of scenarios at a time — a real Gherkin .feature file and a real
Playwright/playwright-bdd .steps.ts file. There is no intermediate JSON format and no generic phrase
template downstream: whatever Gherkin step text and step-definition code you write is exactly what ends
up on disk and what actually runs.

## System discovery report (source of truth for endpoints, schema, business rules)
${reportJson}
${correctionsBlock}${buildClaimedPatternsBlock(claimedPatterns)}
## Your task for THIS call
Produce the .feature and .steps.ts content for the "${renderGroup.key}" group ONLY. Cover exactly these
testScenarios entries (by report name) and no others:
${renderGroup.scenarioNames.map((n) => `- "${n}"`).join('\n')}

Each \`Scenario:\` line's title must be the corresponding name above reproduced EXACTLY,
character-for-character — same punctuation, same capitalization, nothing reworded, nothing "cleaned up".
This applies even when a name itself contains a colon, e.g. the report name \`API: Create order with
invalid customerId\` becomes exactly \`Scenario: API: Create order with invalid customerId\` (the second
colon is just part of the title text, not a syntax problem — do not change it to a dash or drop it, and do
not drop the "API:" prefix some names have). A title that doesn't match one of the names above
character-for-character will fail an automated check before this generation is ever accepted.

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
   template. \`{string}\`/\`{int}\`/\`{float}\` are placeholder syntax that belongs ONLY in a step
   DEFINITION's pattern string in .steps.ts (e.g. \`When('I send a POST request to create a product named
   {string} with price {float}', ...)\`) — the actual Gherkin STEP TEXT in .feature must always contain a
   real, concrete example value in that position, never the literal placeholder token itself. Correct:
   \`When I send a POST request to create a product named "Zero Price Item" with price 0\`. WRONG (do not
   do this): \`When I send a POST request to create a product named {string} with price {float}\` — that
   line does not describe a real scenario and will fail an automated check.
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
6. Handler-function arity must exactly match its own pattern's placeholder count, in order: a pattern with
   N \`{string}\`/\`{int}\`/\`{float}\` placeholders needs exactly N parameters (after the fixtures argument)
   in that handler, one per placeholder, in the same left-to-right order — e.g.
   \`Then('the order status should be {string}', async ({}, status: string) => { ... })\`, not
   \`async ({}) => { ... }\` with zero parameters for a pattern that captures one. Before finishing, mentally
   count each pattern's own placeholders against its handler's own parameter list.
7. Never define two step patterns whose wording is similar enough that one real Gherkin step text could
   match both (most commonly the same wording with two different placeholder types, e.g. both
   \`I send a POST request to create a product with price {int}\` and
   \`... with price {float}\` — a literal \`0\` in the step text matches either). If two scenarios need the
   same action worded the same way, write exactly ONE step definition and let both scenarios' Gherkin text
   use it (see Gherkin rule 2) — never write a second, slightly different pattern for what is really the
   same step.
8. The most common way rule 7 gets violated: picking a placeholder type per SCENARIO's example value
   instead of per FIELD. Decide each field's placeholder type ONCE, the first time you write a step
   touching it, based on the field's real domain type (price/amount/total → \`{float}\` always, a count or
   id → \`{int}\` always, free text → \`{string}\`) — then reuse that exact same pattern for every other
   scenario needing that field, even when a specific scenario's own example value happens to look like a
   whole number. \`{float}\` already matches whole-number text like \`0\` fine, so a decimal-typed field
   never needs a separate \`{int}\` version just because one scenario's example is round.
9. Before finishing, check for the even more basic mistake underlying rules 7-8: registering the EXACT
   SAME pattern string (byte-for-byte identical, not just similar) in two separate \`Given\`/\`When\`/\`Then\`
   calls in this file — e.g. writing \`When('I create a product with the generated name and price
   {float}', ...)\` once for a happy-path scenario and then again, verbatim, for an edge-case scenario
   further down, forgetting the first one already exists. One scenario needing the same action as an
   earlier scenario is a reason to reuse that earlier step definition (see Gherkin rule 2), never a reason
   to write it a second time.

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
    systemPrompt: buildSystemPrompt(renderGroup, reportJson, buildCorrectionsBlock(renderGroup, corrections), [...patternRegistry.keys()]),
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
  // Mirrors this function's own console.log/console.error calls (not
  // ClaudeProvider's lower-level per-call logging, which the admin server
  // surfaces separately by wrapping the provider it passes in) — lets a
  // caller like the admin server stream this pipeline's own progress to a
  // browser instead of it only ever reaching docker logs.
  onProgress?: (message: string) => void,
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

  // budget.ts may have split one Stage 1 group across several render-groups
  // purely to stay under a single call's token budget — cluster back by
  // sourceKey so each cluster's pieces can be merged and re-verified as the
  // one real file they'll actually become, before the human ever reviews
  // them (see merge.ts's own header comment for why the merge itself is
  // safe; the re-verify below is about something merge.ts does NOT check).
  const clusters = new Map<string, RenderGroup[]>();
  for (const renderGroup of renderGroups) {
    const list = clusters.get(renderGroup.sourceKey) ?? [];
    list.push(renderGroup);
    clusters.set(renderGroup.sourceKey, list);
  }

  for (const [sourceKey, pieces] of clusters) {
    const pieceGroups: GeneratedGroup[] = [];
    let clusterFailed = false;
    for (const renderGroup of pieces) {
      const startMsg = `--- Render group: ${renderGroup.key} (${renderGroup.scenarioNames.length} scenario(s)) ---`;
      console.log(`\n${startMsg}`);
      onProgress?.(startMsg);
      try {
        pieceGroups.push(await generateGenerationForGroup(provider, renderGroup, reportJson, corrections, patternRegistry));
      } catch (err) {
        const failMsg = `[${renderGroup.key}] FAILED: ${(err as Error).message}`;
        console.error(`  ${failMsg}`);
        onProgress?.(failMsg);
        failures.push(renderGroup.key);
        clusterFailed = true;
      }
    }
    // A partially-generated cluster can't become a complete final file —
    // failing the whole cluster here (instead of silently merging whatever
    // pieces did succeed at render time) surfaces that loudly instead of
    // producing a customers.feature quietly missing customers-2's scenarios.
    if (clusterFailed) continue;

    const merged = pieces.length === 1 ? pieceGroups[0] : mergeGroups(pieceGroups)[0];
    if (pieces.length > 1) {
      const mergeMsg = `  → merged into "${sourceKey}" (${merged.scenarioNames.length} total scenario(s))`;
      console.log(mergeMsg);
      onProgress?.(mergeMsg);
      // Each piece was just verified in isolation against patternRegistry,
      // so it now holds this cluster's OWN patterns keyed by each piece's
      // own pre-merge key (e.g. "customers-1") — re-checking the merged file
      // against those entries would flag every one of its own steps as
      // colliding with itself. Drop them first, then verify the merged file
      // as the one real unit it actually is: this is what catches step-match
      // ambiguity or handler-arity mismatches between sibling pieces that
      // isolated per-piece verification could never see (they only share a
      // file after merging).
      const pieceKeys = new Set(pieces.map((p) => p.key));
      for (const [pattern, owner] of patternRegistry) {
        if (pieceKeys.has(owner)) patternRegistry.delete(pattern);
      }
      try {
        const ownPatterns = compileAndVerify(merged, patternRegistry);
        for (const [pattern, owner] of ownPatterns) patternRegistry.set(pattern, owner);
      } catch (err) {
        const failMsg = `[${sourceKey}] FAILED after merge: ${(err as Error).message}`;
        console.error(`  ${failMsg}`);
        onProgress?.(failMsg);
        // Push every piece's own key, not sourceKey — callers' --group retry
        // filter matches against render-group keys (e.g. "customers-1"), and
        // a merge-time failure means the whole cluster needs regenerating
        // together anyway, not just one arbitrary piece of it.
        failures.push(...pieces.map((p) => p.key));
        continue;
      }
    }
    groups.push(merged);
  }

  return {
    generation: { generatedAt: new Date().toISOString(), sourceGroupingPath, groups },
    failures,
  };
}

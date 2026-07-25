import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import type { AgentProvider } from '../providers/AgentProvider.ts';
import { config } from '../config.ts';

// ---------------------------------------------------------------------------
// Where generated tests land. Assumes repo layout:
//   <repo>/agent-service/reports/   <- config.reportsDir
//   <repo>/tests/                   <- output target
// ---------------------------------------------------------------------------
const TESTS_ROOT = resolve(config.reportsDir, '..', '..', 'tests');

// ---------------------------------------------------------------------------
// Domains — one agent call per domain. ClaudeProvider.ts hardcodes
// max_tokens: 8096, so "orders" (19 scenarios) is split into two sub-domains
// to comfortably fit; the other domains (<=6 scenarios) are fine as single
// calls (confirmed by the first successful run: customers/products/security
// all wrote cleanly).
//
// Each orders sub-domain uses its OWN setup step vocabulary (prefixed
// "an order test ...") rather than trying to reuse phrasing from
// customers.steps.ts / products.steps.ts — safer than hoping the model
// guesses byte-identical step text for reuse, at the cost of a little
// duplicated setup code between the two orders files.
// ---------------------------------------------------------------------------
interface Domain {
  key: string;
  featurePath: string;
  stepsPath: string;
  scenarioNames: string[];
  extraInstructions?: string;
}

const DOMAINS: Domain[] = [
  {
    key: 'customers',
    featurePath: 'tests/features/customers.feature',
    stepsPath: 'tests/steps/customers.steps.ts',
    scenarioNames: [
      'Create customer with valid data',
      'Create customer with duplicate email',
      'Create customer with empty email',
      'Create customer with empty name',
      'Delete customer with existing orders',
      'Invalid customer ID in API',
    ],
  },
  {
    key: 'products',
    featurePath: 'tests/features/products.feature',
    stepsPath: 'tests/steps/products.steps.ts',
    scenarioNames: [
      'Create product with valid data',
      'Create product with zero price',
      'Create product with negative price',
      'Create product with empty name',
      'Delete product used in existing orders',
      'Invalid product ID in API',
    ],
    extraInstructions: `
## Known issue to avoid
Do NOT register two separate Given steps that only differ by parameter type for
the same phrase (e.g. one with {int} and one with {float} for a price). Cucumber
expressions' {float} type also matches plain integers, so registering both
creates an AmbiguousStepDefinitionError at runtime. Use a single {float} step
for any numeric price parameter.`,
  },
  {
    key: 'orders-status',
    featurePath: 'tests/features/orders-status.feature',
    stepsPath: 'tests/steps/orders-status.steps.ts',
    scenarioNames: [
      'Submit DRAFT order',
      'Delete SUBMITTED order via UI',
      'Delete SUBMITTED order via API',
      'View order status history',
      'Change order status via API from SUBMITTED to DRAFT',
    ],
    extraInstructions: `
## Known correction — apply this OVER the report's own text for this scenario

"Change order status via API from SUBMITTED to DRAFT" — the report's description
("verify it succeeds") is OUTDATED. Fixed via an explicit ALLOWED_STATUS_TRANSITIONS
map in OrdersService.updateStatus() (commit "fix(orders): reject SUBMITTED -> DRAFT
status rollback (409)"). Correct behavior: PATCH /orders/{id}/status changing
SUBMITTED -> DRAFT MUST return 409 Conflict, message matching
"Cannot transition order {id} from SUBMITTED to DRAFT". Write this as @edge_case
asserting the 409 and the message — NOT success.

## State management (follow this pattern exactly)
Use a single mutable \`ctx: any = {}\` object reset in a \`Before(async () => { ctx = {}; })\`
hook (imported from 'playwright-bdd' alongside Given/When/Then), NOT bare module-level
\`let\` variables with no reset.

## Setup step naming (avoid collisions with other domains' steps files)
Name setup steps with an "order test" prefix, e.g.:
  Given('an order test customer exists', ...)
  Given('an order test product exists with price {float}', ...)
  Given('an order test order exists in DRAFT status with one item', ...)
Do not reuse or guess at step text from other domains' steps files — define everything
this domain needs, self-contained, under the "order test ..." prefix.

## Output budget
This response has a hard ~8000 output-token ceiling and previously truncated on a
larger scenario set. Be terse: minimal comments, no padding, compact but correct
code. Prefer short helper reuse within the file over repeating boilerplate per scenario.`,
  },
  {
    key: 'orders-items',
    featurePath: 'tests/features/orders-items.feature',
    stepsPath: 'tests/steps/orders-items.steps.ts',
    scenarioNames: [
      'Delete DRAFT order',
      'Edit DRAFT order items',
      'Edit SUBMITTED order items via API',
      'Order unitPrice snapshot',
      'Add multiple items to order',
    ],
    extraInstructions: `
## Known correction — apply this OVER the report's own text for this scenario

"Edit SUBMITTED order items via API" — the report is ambiguous ("may be allowed or
blocked"). It is not ambiguous in reality: OrdersService.updateItems() rejects any
order where status !== 'DRAFT' with the same 409 Conflict pattern as delete. Write
this as @edge_case asserting 409.

## State management (follow this pattern exactly)
Use a single mutable \`ctx: any = {}\` object reset in a \`Before(async () => { ctx = {}; })\`
hook (imported from 'playwright-bdd' alongside Given/When/Then), NOT bare module-level
\`let\` variables with no reset.

## Setup step naming (avoid collisions with other domains' steps files)
Name setup steps with an "order test" prefix, e.g.:
  Given('an order test customer exists', ...)
  Given('an order test product exists with price {float}', ...)
  Given('an order test order exists in DRAFT status with one item', ...)
Do not reuse or guess at step text from other domains' steps files — define everything
this domain needs, self-contained, under the "order test ..." prefix.

## Output budget
This response has a hard ~8000 output-token ceiling. Be terse: minimal comments, no
padding, compact but correct code.`,
  },
  {
    key: 'orders-validation',
    featurePath: 'tests/features/orders-validation.feature',
    stepsPath: 'tests/steps/orders-validation.steps.ts',
    scenarioNames: [
      'Create order with valid customer and items',
      'Create order without selecting customer',
      'Create order without selecting product',
      'Create order with quantity zero',
      'Create order with negative quantity',
      'Create order with non-existent customerId',
      'Create order with non-existent productId',
      'Invalid order ID in API',
      'Invalid status value in order status update',
    ],
    extraInstructions: `
## State management (follow this pattern exactly)
Use a single mutable \`ctx: any = {}\` object reset in a \`Before(async () => { ctx = {}; })\`
hook (imported from 'playwright-bdd' alongside Given/When/Then), NOT bare module-level
\`let\` variables with no reset.

## Setup step naming (avoid collisions with other domains' steps files)
Name setup steps with an "order test" prefix so they can't collide with similarly-worded
steps already defined elsewhere in the suite, e.g.:
  Given('an order test customer exists', ...)
  Given('an order test product exists with price {float}', ...)
Do not reuse or guess at step text from other domains' steps files — define everything
this domain needs, self-contained, under the "order test ..." prefix.`,
  },
  {
    key: 'security',
    featurePath: 'tests/features/security.feature',
    stepsPath: 'tests/steps/security.steps.ts',
    scenarioNames: [
      'SQL injection in customer email',
      'SQL injection in product name',
      'XSS in customer name',
      'XSS in product name',
    ],
  },
];

// ---------------------------------------------------------------------------
// System prompt — built per domain
// ---------------------------------------------------------------------------

function buildSystemPrompt(domain: Domain, reportJson: string): string {
  return `You are a QA test-generation agent. You convert a system discovery report (JSON) into an executable BDD test suite, one domain at a time.

## Stack
- Test runner: Playwright Test
- BDD layer: playwright-bdd (createBdd from 'playwright-bdd'; NOT @cucumber/playwright, no separate CLI)
- Language: TypeScript, ESM
- DB assertions (E2E scenarios only): a shared helper already exists at 'tests/support/db.ts' exporting \`db\` (a connected pg Client) and \`ensureDbConnected()\` — import and reuse it, do not redefine it
- API scenarios: Playwright's APIRequestContext (request fixture)
- UI scenarios: Playwright's page fixture

## System discovery report (source of truth for endpoints, schema, business rules)
${reportJson}
${domain.extraInstructions ?? ''}

## Your task for THIS call
Generate BDD coverage for the "${domain.key}" domain ONLY. Cover exactly these
testScenarios entries (by report name) and no others:
${domain.scenarioNames.map((n) => `- "${n}"`).join('\n')}

Output exactly two files:
- ${domain.featurePath}
- ${domain.stepsPath}

Rules:
1. Each Gherkin scenario: clear Given/When/Then, one behavior per scenario, tagged with @happy_path, @edge_case, or @security matching the report's "type" field for that scenario (unless a Known correction above overrides the type).
2. Steps file uses playwright-bdd conventions:
   import { createBdd } from 'playwright-bdd';
   const { Given, When, Then } = createBdd(); // add Before too if instructed above
   Steps take ({ page, request }) fixtures as needed; do not invent custom fixtures.
3. API-only scenarios (validation errors, 404s, 409s) use the request fixture directly against ${config.backendUrl} and assert status code + response body shape — do not drive these through the UI.
4. UI scenarios (from uiPages) use role-based locators (getByRole/getByLabel), matching the accessibility roles noted in the report (textbox, spinbutton, combobox).
5. Where the report itself says "verify behavior" / is genuinely uncertain about an exact status code (and it's not covered by a Known correction above), do not invent a confident assertion — write the scenario with a clearly marked TODO comment stating what's unconfirmed, rather than asserting an unverified status code as fact.
6. Do not fabricate business rules or endpoints not present in the report or in Known corrections above.
7. Keep it concise where possible — this response has a hard output budget, so favor compact, working step implementations over exhaustive comments.

## Output contract — read carefully
Output ONLY a single valid JSON object with exactly these two keys, no markdown fences, no prose before or after:

{
  "${domain.featurePath}": "Feature: ...",
  "${domain.stepsPath}": "import { createBdd } ..."
}`;
}

const USER_MESSAGE = (domain: Domain) =>
  `Generate the "${domain.key}" domain's .feature and .steps.ts files per your instructions. Return the JSON file map with exactly those two keys.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findLatestReport(): Promise<string> {
  const files = await readdir(config.reportsDir);
  const discoveryFiles = files.filter((f) => f.startsWith('discovery-') && f.endsWith('.json'));
  if (discoveryFiles.length === 0) {
    throw new Error(`No discovery-*.json reports found in ${config.reportsDir}. Run 'pnpm discovery' first.`);
  }
  discoveryFiles.sort();
  return join(config.reportsDir, discoveryFiles[discoveryFiles.length - 1]);
}

function parseFileMap(raw: string, domainKey: string): Record<string, string> {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `[${domainKey}] Agent response did not contain a JSON object (likely truncated — response started with: ${raw.slice(0, 200)})`,
    );
  }
  const parsed = JSON.parse(jsonMatch[0]);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[${domainKey}] Parsed JSON is not a file map object.`);
  }
  return parsed as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * @param domainFilter Optional list of domain keys to (re-)run, e.g. ['orders-lifecycle'].
 *   Omit to run all domains. Use this to retry a single failed domain without
 *   re-billing / overwriting domains that already succeeded.
 */
export async function runGenerate(
  provider: AgentProvider,
  reportPath?: string,
  domainFilter?: string[],
): Promise<void> {
  console.log('\n=== Phase 2: Test Generation ===\n');

  const resolvedReportPath = reportPath ?? (await findLatestReport());
  console.log(`Using report: ${resolvedReportPath}`);
  const reportJson = await readFile(resolvedReportPath, 'utf-8');

  const domainsToRun = domainFilter?.length
    ? DOMAINS.filter((d) => domainFilter.includes(d.key))
    : DOMAINS;

  if (domainFilter?.length) {
    const unknown = domainFilter.filter((k) => !DOMAINS.some((d) => d.key === k));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown domain(s): ${unknown.join(', ')}. Valid keys: ${DOMAINS.map((d) => d.key).join(', ')}`,
      );
    }
  }

  const allWritten: string[] = [];
  const failures: string[] = [];

  for (const domain of domainsToRun) {
    console.log(`\n--- Domain: ${domain.key} ---`);
    try {
      const raw = await provider.run({
        systemPrompt: buildSystemPrompt(domain, reportJson),
        userMessage: USER_MESSAGE(domain),
        mcpServers: [],
        tools: [],
        maxIterations: 5,
        model: 'claude-sonnet-5',
      });

      const fileMap = parseFileMap(raw, domain.key);

      for (const [relativePath, content] of Object.entries(fileMap)) {
        const absolutePath = join(TESTS_ROOT, '..', relativePath);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, 'utf-8');
        allWritten.push(absolutePath);
        console.log(`  wrote ${absolutePath}`);
      }
    } catch (err) {
      console.error(`  [${domain.key}] FAILED: ${(err as Error).message}`);
      failures.push(domain.key);
    }
  }

  console.log(
    `\n=== Generated ${allWritten.length} files across ${domainsToRun.length - failures.length}/${domainsToRun.length} domains ===`,
  );
  for (const f of allWritten) console.log(` - ${f}`);

  if (failures.length > 0) {
    console.log(`\nFailed domains (retry with --domain ${failures.join(',')}): ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}
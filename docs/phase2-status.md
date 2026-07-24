# Agentic QA Platform — Phase 2: Test Generation — Status Summary

Companion to `agentic-qa-platform-summary.md` and `frontend-ui-summary.md`.
Covers Phase 2 (BDD test suite generation + first live runs) as of this session,
conducted in the `Home` (chat) tab before moving to `</> Code` for continued
hands-on debugging.

## What Phase 2 does

`agent-service/src/phases/generate.ts` — a script (sibling to `recon.ts`) that
reads the Phase 1 recon report (`agent-service/reports/recon-*.json`) and calls
Claude once per **domain** to generate a Playwright + `playwright-bdd` test
suite (`.feature` + `.steps.ts` pairs), rather than one giant call for
everything.

### Why per-domain instead of one call
`ClaudeProvider.ts` hardcodes `max_tokens: 8096` (not exposed via
`AgentRunOptions`). A single call asking for all ~35 scenarios across 8 files
in one flat JSON object (no nested closing braces until the very end)
truncated mid-response with no valid JSON at all. Splitting by domain keeps
each response comfortably under budget, and a failure in one domain doesn't
lose the others (`generate.ts` writes files domain-by-domain and reports
which domains failed at the end).

### Domains (in `generate.ts`)
- `customers` (6 scenarios)
- `products` (6 scenarios)
- `orders-status` (5 scenarios — split out of an original `orders-lifecycle`
  that still truncated even at 10 scenarios)
- `orders-items` (5 scenarios — the other half of `orders-lifecycle`)
- `orders-validation` (9 scenarios)
- `security` (4 scenarios)

Domain scenario names are hardcoded in `generate.ts` (from the recon report's
`testScenarios[].name`) rather than left for the model to select, so domain
membership is deterministic across runs.

### `--domain` filter
`pnpm testgen -- --domain orders-status,orders-items` regenerates only the
listed domains, so a retry doesn't re-bill (and doesn't overwrite) domains
that already succeeded.

### Known corrections baked into the prompt
Two facts that are true now but were stale/ambiguous in the recon report
(report predates or doesn't confirm current backend behavior):

1. `PATCH /orders/{id}/status` `SUBMITTED → DRAFT` must return **409**
   (`ALLOWED_STATUS_TRANSITIONS` map in `OrdersService.updateStatus()`,
   commit `fix(orders): reject SUBMITTED -> DRAFT status rollback (409)`).
   Report said "verify it succeeds" — that was the old, since-fixed bug.
2. `PATCH /orders/{id}/items` on a non-DRAFT order must return **409**
   (`OrdersService.updateItems()` checks `status !== 'DRAFT'`, same pattern
   as delete). Report marked this "ambiguous" — it isn't in the actual code.

Both corrections are verified working via passing tests (`orders-status`,
`orders-validation` domains).

## `tests/` project scaffolding (built from scratch this session)

`tests/` had no `package.json`/`tsconfig.json`/`playwright.config.ts` at the
start of Phase 2 — only empty `features/`/`steps/` output from `generate.ts`.
Built out as a standalone project:

- `tests/package.json` — devDependencies: `@playwright/test`, `playwright-bdd`
  (**must be `^9.2.0`, not `^7.5.0`** — 7.5.0's internal Playwright module
  path doesn't exist in `@playwright/test@1.61.1`, causes an immediate
  `MODULE_NOT_FOUND` on config load), `pg`, `@types/pg`, `typescript`,
  `dotenv`. Scripts: `test` (`bddgen && playwright test` — see note below),
  `typecheck`.
- `tests/tsconfig.json` — `lib: ["ES2022", "DOM"]` (DOM needed for
  `page.evaluate(() => window...)` callbacks to typecheck).
- `tests/playwright.config.ts` — `defineBddConfig({ features: 'features/*.feature', steps: 'steps/*.steps.ts' })`;
  `use.baseURL` defaults to `http://localhost:5173` (the frontend, **not**
  the backend on 3000 — this distinction caused a real bug, see below).
- `tests/support/db.ts` — shared `pg` `Client` + `ensureDbConnected()`, now
  loads `dotenv/config` at the top so `DATABASE_URL` survives across
  terminal sessions/reboots (previously had to be `export`ed manually every
  session — easy to forget, causes a `SASL: client password must be a
  string` error that looks unrelated to the real cause).
- `tests/.env` — `DATABASE_URL=postgresql://user:pass@localhost:5432/testdb`
  (gitignored).
- `tests/support/orderCtx.ts` + `tests/steps/orders-common.steps.ts` — see
  "shared order fixtures" below.

**`playwright-bdd` workflow note:** `npx bddgen` must be run to convert
`.feature` files into real Playwright specs under `.features-gen/` before
`npx playwright test` can find anything — this is a separate, required step,
not automatic just from `defineBddConfig()` being called in the config.

## Bugs found and fixed during generation + first runs

Roughly in the order encountered — useful as a "known failure modes" list if
similar issues recur while finishing the remaining domains in `</> Code`.

1. **`db.ts` path mismatch** — first placed at `agent-service/src/support/db.ts`,
   but the generation prompt told the model the helper lives at
   `tests/support/db.ts`. Steps files' imports were correct; the file was in
   the wrong place. (The stray copy under `agent-service/` is unused and can
   be deleted.)
2. **`import { Before } from 'playwright-bdd'`** — invalid; `Before` must be
   destructured from `createBdd()`'s return value, like `Given`/`When`/`Then`,
   not imported directly from the package.
3. **Ambiguous step definition** in `products.steps.ts` — two `Given`s for
   the same phrase differing only in `{int}` vs `{float}` parameter type;
   `{float}` also matches plain integers, so both matched simultaneously.
   Fixed by keeping only the `{float}` version.
4. **Duplicate step definitions across independently-generated domains** —
   `customers`/`security` both defined `Given('I am on the Customers page', ...)`
   verbatim; `products`/`security` defined the products-page equivalent with
   *different casing* (`Products` vs `products`), which is why `bddgen`
   didn't flag it as ambiguous but would have failed as "step not found" if
   the case mismatch had gone the other way. Fixed by keeping one canonical
   definition per phrase and deleting the duplicate(s), aligning casing with
   the `.feature` file text.
5. **Triple-duplicated order test fixtures** — `orders-items`, `orders-status`,
   and `orders-validation` each independently defined `Given('an order test
   customer exists', ...)` and `Given('an order test product exists with
   price {float}', ...)` verbatim (plus a near-duplicate order-exists step
   that only differed by a literal `DRAFT` vs a `{word}` placeholder, which
   `{word}` also matches). **Fixed by extracting a shared module**:
   `tests/support/orderCtx.ts` (plain mutable state object + reset function,
   *not* a steps file so `bddgen` doesn't scan it) and
   `tests/steps/orders-common.steps.ts` (the one canonical definition of each
   shared `Given`, importing/writing to `orderCtx`). All three domain steps
   files now import `orderCtx` instead of keeping customer/product/order IDs
   in their own local `ctx`.
6. **`playwright-bdd@7.5.0` incompatible with `@playwright/test@1.61.1`** —
   `MODULE_NOT_FOUND` on an internal Playwright path at config-load time.
   Bumped to `^9.2.0` (confirmed no breaking changes to the small API surface
   used here: `defineBddConfig`, `createBdd()` → `Given/When/Then/Before`).
7. **Strict arity checking (new in playwright-bdd 9.0.0)** — step functions'
   parameter count must exactly match the number of `{placeholder}`s in the
   Gherkin text, and the first parameter must be a literal object-destructuring
   pattern (`{}` or `{ page }`), not just any identifier (`_: any` was
   rejected even though it's a valid, unused TS parameter). Also caught a
   design flaw this surfaced: `security.steps.ts` was smuggling scenario
   state through Playwright's `testInfo` as a second positional argument
   (`async ({}, testInfo) => { testInfo._foo = ... }`) — not a valid step
   signature in playwright-bdd (no Cucumber placeholder corresponds to it).
   Rewritten to use a local `ctx` object + `Before()` reset, consistent with
   the rest of the suite, instead of hijacking `testInfo` as ad-hoc storage.
8. **`BASE_URL` reused for both API calls and browser navigation** in
   `orders-status.steps.ts` — `page.goto(`${BASE_URL}/orders`)` opened the
   *backend* (`localhost:3000/orders`, raw JSON) instead of the *frontend*
   (`localhost:5173/orders`, the actual UI) because `BASE_URL` was defined
   for API use and mistakenly reused for UI navigation. Fixed to use a
   relative path (`page.goto('/orders')`), which resolves via
   `playwright.config.ts`'s `use.baseURL`.
9. **Order-card locator saga** (the longest debugging thread this session):
   `page.getByRole('row', { name: /<orderId>/ })` never matches — `role="row"`
   only applies to the item sub-table's `<tr>`s inside each card, not to the
   card itself (which is a generic container, ARIA role `"generic"`).
   Escalated through a few failed heuristics before landing on a working
   pattern:
   - ~~`page.locator('row', ...)`~~ — wrong role entirely.
   - ~~`page.locator('div').filter({hasText}).filter({has}).last()`~~ — wrong
     tag assumption; ARIA `"generic"` doesn't reveal the real HTML tag name,
     so `'div'` silently matched nothing if the real element is e.g. a
     `<section>`/`<li>`/`<article>`.
   - ~~Same filter with `page.locator('*')`~~ (tag-agnostic) — still didn't
     resolve; likely an issue with the page-wide filter+`.last()` ordering
     heuristic itself, not just the tag.
   - **Working fix**: anchor on the specific `"Order #<id>"` text node via
     `page.getByText(...)`, then walk up with
     `.locator('xpath=ancestor::*[contains(., "Show history")][1]')` — XPath's
     `ancestor::` axis returns nearest-ancestor-first, so `[1]` gets the
     closest containing element that also has the "Show history" button,
     which is exactly the card boundary. This targets one known starting
     point instead of filtering/guessing across the whole page.
   - This `orderCardLocator()` pattern now lives in `orders-status.steps.ts`
     only — `orders-items.steps.ts` still uses its own, different approach
     (`:has-text("<customerEmail>")`), which has worked so far for its
     scenarios but hasn't been stress-tested the way the card locator was.
10. **`DATABASE_URL` lost across terminal sessions** — was only ever set via
    manual `export` in one shell session; a reboot (or any new terminal)
    loses it, producing a confusing `SASL: SCRAM-SERVER-FIRST-MESSAGE: client
    password must be a string` error that doesn't obviously point at a
    missing env var. Fixed via `tests/.env` + `dotenv/config` import at the
    top of `db.ts` (see scaffolding section above).

## Real backend bug found (not a test bug) — fixed and committed

`OrdersService.create()` validated `productId` existence (`BadRequestException`
if not found) but **not** `customerId` — a non-existent `customerId` fell
through to an unhandled Prisma FK-constraint violation, returning a raw
`500` instead of a handled `400`. Found by the `orders-validation` domain's
"Create order with non-existent customerId" scenario. Fixed with a symmetric
`this.prisma.customer.findUnique(...)` check before the existing product
check, committed as:

```
fix(orders): validate customerId exists on order creation (400)
```

## Current test run status (live app, Docker Compose stack)

| Domain | Status | Notes |
|---|---|---|
| `orders-validation` | ✅ 9/9 passing | Confirmed the customerId fix above. |
| `orders-status` | ✅ 5/5 passing | Confirmed both known-correction scenarios (409 on rollback, 409 on edit-SUBMITTED-adjacent scenario is actually in orders-items — see below). Uses the working XPath `orderCardLocator`. |
| `orders-items` | ⚠️ 2/5 passing | **Not yet diagnosed** — 3 of 5 scenarios failing as of the last run in the `Home` tab, before switching to `Code`. Uses a different (older, `:has-text(customerEmail)`-based) locator strategy than `orders-status`; failures not yet triaged to know if it's the same class of locator issue or something new. **This is the immediate next task.** |
| `customers` | ❓ Not yet run | `typecheck` passes; never executed against the live app. |
| `products` | ❓ Not yet run | `typecheck` passes; never executed against the live app. |
| `security` | ❓ Not yet run | `typecheck` passes; never executed against the live app. |

## Known loose ends / risks (not yet addressed)

- **Test data accumulation, no cleanup**: every run creates new `Customer`/
  `Product`/`Order` rows (`order-test-...` / `Order Test Customer` /
  `Order Test Product ...` prefixes) with no `afterEach`/global teardown.
  As of the last check there were 30+ orders and 40+ customers/products
  accumulated purely from test runs during this session. Not yet a hard
  blocker, but will eventually slow the `/orders` page down and should get
  a cleanup strategy (delete-by-prefix teardown, or a dedicated test DB
  schema/reset between runs) before this suite is run repeatedly in CI.
- **Fragile implicit ordering dependency** in `orders-validation.steps.ts`:
  the "Invalid status value in order status update" scenario's step reads
  `ctx.orderId`, which is only set by a *different* step
  (`I create an order test order with valid customerId and items`) assumed
  to have run earlier in the same scenario. Not yet verified against the
  actual `.feature` file that this ordering always holds.
- **`orders-items.steps.ts`'s locator strategy is unverified under stress** —
  it has passed 2/5 so far but the 3 failures aren't diagnosed yet, so it's
  unknown whether they're locator-related (like the `orders-status` saga) or
  something else entirely (data setup, timing, a real app bug, etc.).
- **`customers.steps.ts` still uses bare module-level `let` state with a
  `Before()` reset patch** (applied earlier this session) rather than the
  cleaner `ctx: any = {}` object pattern used everywhere else. Not broken,
  but inconsistent style; low priority.
- **No CI wiring yet** — GitHub Actions integration (mentioned in the
  original architecture doc) hasn't been started; this whole session was
  local, manual `npx playwright test` runs.

## Immediate next steps (recommended order)

1. Diagnose and fix the 3 failing `orders-items` scenarios.
2. Run `customers`, `products`, and `security` domains for the first time
   against the live app — expect UI-locator mismatches similar to the
   `orders-status` saga, since none of these have been executed yet.
3. Decide on and implement a test-data cleanup strategy.
4. Verify the `orders-validation` step-ordering assumption noted above.
5. Once all 6 domains are green, consider: `multiple-cucumber-html-reporter`
   wiring (Phase 3 per the original architecture doc), GitHub Actions CI.
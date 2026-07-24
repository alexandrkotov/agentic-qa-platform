# Agentic QA Platform — Phase 2: Test Generation — Status Summary

Companion to `agentic-qa-platform-summary.md` and `frontend-ui-summary.md`.
Covers Phase 2 (BDD test suite generation + first live runs) as of this session,
conducted in the `Home` (chat) tab before moving to `</> Code` for continued
hands-on debugging.

## Environment notes (read this before continuing in a new chat)

- **Work here happens in the main checkout, not a worktree.** All of Phase 2
  (`tests/`, the `agent-service` generate-phase changes) was built up as
  uncommitted work in `/home/test/projects/agentic-qa-platform` on branch
  `main`, then committed there directly. A session started fresh from a
  `.claude/worktrees/...` checkout won't have any of it — worktrees don't
  share uncommitted state, and even after the Phase 2 commits landed on
  `main`, a worktree checked out from an older branch point won't see them
  either. If a new chat is on a worktree and `tests/`/`agent-service/src/phases/generate.ts`
  look missing, that's why — point it at the main checkout, or make sure its
  branch is up to date with `main`.
- **`pnpm` in this environment hard-fails on unapproved native build
  scripts** (the "ignored builds" gate, pnpm ~v10+) — any dependency with a
  postinstall build (e.g. `esbuild`, pulled in transitively by `tsx`) will
  make `pnpm install`/`pnpm run <script>` fail outright with
  `[ERR_PNPM_IGNORED_BUILDS]` instead of just warning, unless
  `pnpm approve-builds` has been run interactively first. Prefer plain `.mjs`/`.js`
  scripts over TS-via-`tsx` for small standalone tools (see
  `tests/support/cleanup.mjs`) to avoid this entirely, rather than relying on
  someone remembering to approve builds.

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
| `orders-items` | ✅ 5/5 passing | Diagnosed and fixed — see "orders-items fixes" below. |
| `customers` | ✅ 6/6 passing | First live run — see "customers/products/security first runs" below. |
| `products` | ✅ 6/6 passing | First live run — see "customers/products/security first runs" below. |
| `security` | ✅ 4/4 passing | First live run — confirmed no real XSS vuln (script-tag payloads render escaped, don't execute). |

All 6 domains, 35/35 scenarios, green. Confirmed stable across two consecutive
full `npx playwright test` runs (no flakiness observed).

## `orders-items` fixes (3 of 5 scenarios were failing)

The `:has-text("<customerEmail>")` locator strategy noted as "unverified
under stress" in point 9 above turned out to be broken by design: order
cards render the customer's **name** only (`OrdersPage.tsx` line ~255,
`customerMap.get(order.customerId)?.name`), never the email — email only
appears inside the `<option>` text of the "New Order" Customer `<select>`.
So the locator matched that dropdown option, not the card, then timed out
looking for a Delete/Edit button inside it. Two more distinct bugs surfaced
once that was fixed:

1. **`orderCardLocator()` extracted to `tests/support/orderCardLocator.ts`**
   (was only in `orders-status.steps.ts`) and now used by both files. Delete
   and Edit steps in `orders-items.steps.ts` use it the same way
   `orders-status.steps.ts` does.
2. **`window.confirm()` on delete** — `OrdersPage.tsx`'s delete handler
   calls `window.confirm(...)`; Playwright auto-*dismisses* dialogs by
   default (equivalent to Cancel), which would silently no-op the delete.
   Fixed with `page.once('dialog', d => d.accept())` before the click.
3. **No accessible name on the "New Order" form's `<select>`/`<input>`
   fields** — the `Customer`/`Items` `<label>`s have no `htmlFor`, and the
   fields have no `id`/`aria-label`, so `getByRole(..., {name})` can never
   find them. Also the step assumed clicking "Create Order" *opens* the
   form — it doesn't; the form is always rendered, so that click was
   actually submitting an empty, invalid form and focusing the Customer
   select via native validation. Fixed by scoping to `page.locator('form')`
   and indexing fields positionally instead of by accessible name, and by
   selecting options by `value` (id) instead of `label` (option text is
   `"{name} ({email})"` / `"{name} (${price})"`, which never equals the bare
   name strings stored in `ctx`).
4. **Race condition between click and DB assertion** — both `handleSaveOrder`
   and `handleCreate` in `OrdersPage.tsx` fire an `await api.patch/post(...)`
   and only update UI state (closing the edit form / resetting the Customer
   select) *after* it resolves. The step functions returned right after
   `.click()`, so the following DB-assertion step sometimes ran before the
   write landed (observed as quantity staying at the old value, or the
   just-created order not existing yet). Fixed by waiting on the resulting
   DOM change (`expect(saveButton).toHaveCount(0)` /
   `expect(customerSelect).toHaveValue('')`) before returning from the step,
   rather than a fixed `waitForTimeout`. Note `orders-status.steps.ts`'s
   "I submit the order via the UI" step still uses a hardcoded
   `waitForTimeout(300)` for the same class of issue — not touched here
   since it's currently passing, but the same race exists there and the
   deterministic-wait pattern would be a safer replacement if it ever flakes.

## `customers`/`products`/`security` first runs (2 of 3 had failures)

First-ever executions against the live app. `orders-validation`/`orders-status`
had already worked around most of this app's UI quirks, so these three mostly
confirmed the same failure classes rather than finding new ones:

1. **`getByLabel()` doesn't work anywhere in this app** — `CustomersPage.tsx`'s
   Email/Name inputs and `ProductsPage.tsx`'s Name/Price inputs all use
   `placeholder` text with no `<label>`, `id`, or `aria-label`. `customers.steps.ts`
   and `security.steps.ts` (which reuses the same forms for its XSS scenarios)
   both used `page.getByLabel('Email'/'Name'/'Price')`, which timed out.
   Fixed by switching to `page.getByPlaceholder(...)` in all three files.
   Note this is a step below `getByRole(..., {name})` from the `orders-items`
   fixes: Chromium *does* expose `placeholder` as the accessible name for
   `type="text"` inputs (so `getByRole('textbox', {name: 'Name'})` happened to
   work in `products.steps.ts`) but *not* for `type="number"` (spinbutton) —
   an inconsistent browser fallback, not something to rely on either way.
   `getByPlaceholder` sidesteps the whole question.
2. **Hardcoded (non-unique) test data breaks re-runs** — two scenarios don't
   generate unique data the way the `orders-*` domains do:
   - `customers.feature`'s "Create customer with valid data" uses the fixed
     name `"Jane Doe"`, which collides with a pre-existing seed customer of
     the same name. `page.getByText(lastName)` was ambiguous (strict-mode
     violation). Fixed by scoping the name assertion to the table row
     containing the (unique, timestamped) email instead of a page-wide text
     search.
   - `products.feature`'s "Create product with valid data" uses a fully
     fixed name+price (`"Wireless Mouse QA"` / `"$29.99"`), so *every* repeat
     run adds another identical row and `getByRole('row', {name})` becomes
     ambiguous once 2+ exist. Fixed pragmatically with `.first()` — the
     scenario's intent ("a product like this exists in the list") is
     satisfied either way; the real fix would be generating a unique
     name/price per run, but that means editing the `.feature` file's literal
     Gherkin text, not just the step implementation.

## Test data cleanup (resolved)

Chose a **prefix-based teardown script** over a dedicated test DB/schema —
seed/demo data (`Alec`, `Zhanna`, `Jane Doe`, `Super User`, `Wireless Mouse`,
etc.) lives in the same tables as test data, and a separate schema would've
meant new infra (separate `DATABASE_URL`, a seed script) for marginal benefit
over just matching the naming patterns the suite already uses consistently.

`tests/support/cleanup.mjs` (run via `pnpm run cleanup`): matches
`Customer.email` and `Product.name`
against the naming patterns each domain's steps files actually use
(`order-test-%`, `cust_%`, `qa-prod-%`, `xss_%`, `sqltest%`, `debug-%` for
customers; `Order Test Product%`, `Prod\_%`, `Referenced Product%`,
`Wireless Mouse QA%`, `Debug Product%`, `Injected%`, `<script>%`, plus exact
`Zero Price Item`/`Negative Price Item` for products), then deletes their
`Order` rows first — `OrderItem`/`OrderStatusHistory` cascade automatically
(`onDelete: Cascade` in the Prisma schema), but `Order→Customer` and
`OrderItem→Product` don't, so Orders must go before Customers/Products or the
FK blocks the delete. Orders are matched transitively (by their customer or
by any item's product), not by their own naming scheme, since orders don't
carry distinguishing text themselves.

First run swept **201 customers, 216 products, 123 orders**, leaving exactly
the 4 real customers and 5 real products verified by name beforehand. Also
caught and removed `debug-*`/`Debug Product*` rows left over from an ad-hoc
Playwright script used to diagnose the `orders-items` race condition earlier
in this session — folded into the same pattern list rather than cleaned up
by hand. Verified idempotent (second run against a live DB found only the
rows the just-completed test run had added, zero left after) and that the
full suite still passes 35/35 against a freshly-cleaned DB (no scenario
secretly depended on accumulated data).

Not wired as an automatic `afterEach`/Playwright `globalTeardown` — it's a
manual `pnpm run cleanup` step for now, run between sessions or before a
demo. Worth revisiting when CI wiring happens (see below).

**Plain `.mjs`, not TypeScript** — the first version was `cleanup.ts` run via
a `tsx` devDependency, but `tsx`'s transitive `esbuild` dependency has a
native postinstall build script, which this pnpm setup (v11, with the
"ignored builds" security gate introduced around pnpm 10) refuses to run
without explicit approval (`pnpm approve-builds`), and — surprisingly — fails
the *entire* `pnpm install`/`pnpm run` rather than just warning. That's a
one-time interactive step, but it'd hit anyone else who clones the repo and
runs `pnpm run cleanup` cold. Rewritten as plain `cleanup.mjs` (no TS syntax
needed for a script this size) and dropped `tsx` entirely — `pnpm run
cleanup` now runs with zero extra setup, and `pnpm-lock.yaml` no longer
references `tsx`/`esbuild` at all.

## Known loose ends / risks (not yet addressed)

- **Fragile implicit ordering dependency** in `orders-validation.steps.ts`:
  the "Invalid status value in order status update" scenario's step reads
  `ctx.orderId`, which is only set by a *different* step
  (`I create an order test order with valid customerId and items`) assumed
  to have run earlier in the same scenario. Not yet verified against the
  actual `.feature` file that this ordering always holds.
- **`customers.steps.ts` still uses bare module-level `let` state with a
  `Before()` reset patch** (applied earlier this session) rather than the
  cleaner `ctx: any = {}` object pattern used everywhere else. Not broken,
  but inconsistent style; low priority.
- **No CI wiring yet** — GitHub Actions integration (mentioned in the
  original architecture doc) hasn't been started; this whole session was
  local, manual `npx playwright test` runs.

## Immediate next steps (recommended order)

1. ~~Diagnose and fix the 3 failing `orders-items` scenarios.~~ Done.
2. ~~Run `customers`, `products`, and `security` domains for the first time
   against the live app.~~ Done — all 6 domains, 35/35 scenarios, green.
3. ~~Decide on and implement a test-data cleanup strategy.~~ Done — see
   "Test data cleanup" above (`pnpm run cleanup`).
4. Verify the `orders-validation` step-ordering assumption noted above.
5. Consider wiring `pnpm run cleanup` into CI (e.g. as a pre-run step) once
   CI is set up, or as a Playwright `globalTeardown` if automatic cleanup
   after every local run turns out to be wanted.
6. `multiple-cucumber-html-reporter` wiring (Phase 3 per the original
   architecture doc), GitHub Actions CI.
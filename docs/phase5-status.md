# Agentic QA Platform — Phase 5: Generate Agent Redesign — Status Summary

Companion to `phase2-status.md` (documents the original Generate Agent this work replaces) and
`phase4-status.md` (the E2E Agent's `diagnose.ts` → human approves → `apply.ts` pattern, the direct
architectural precedent for everything below). Covers the full redesign — problem, design, all
seven build milestones, and the final live verification — conducted in a single session on
2026-07-29, in a worktree (`.claude/worktrees/generate-agent-redesign-e583ae`), merged to `main`
afterward.

## Environment notes (read this before continuing in a new chat)

- **`agent-service/reports/` is gitignored and not shared between the main checkout and any
  worktree.** Every discovery report, and every `generate-grouping-*`/`generate-spec-*` file this
  session refers to by exact filename, may not exist by the time you read this — they were either
  cleaned up after verification (see "sandboxing" note below) or superseded by later discovery
  runs. Re-run `pnpm discovery` to get a fresh one; don't go looking for the specific timestamped
  filenames named in this document.
- **The `.env` with `ANTHROPIC_API_KEY` lives only in the main checkout**
  (`/home/test/projects/agentic-qa-platform/agent-service/.env`), not in worktrees. Every live
  Claude call made from the worktree during this session sourced it explicitly
  (`set -a; source /home/test/.../.env; set +a`) rather than relying on `tsx`'s own `dotenv/config`
  finding one in the worktree.
- **Verification sandboxing.** Because this redesign's whole point is regenerating
  `tests/features/*.feature` + `tests/steps/*.steps.ts`, and the real committed suite already has
  real hand-applied fixes on top of it (see Known loose ends below), every live pipeline run in
  this session used renamed group keys (e.g. `customers-verify`, `orders-sandbox7-1`) so the
  generated files never collided with or overwrote the real ones. All such throwaway files, and
  the `generate-*.json` artifacts in `reports/`, were deleted after each verification pass — search
  git history/this document for what was actually proven, not the live filesystem for leftover
  scratch files.
- `pnpm` in this environment hard-fails on unapproved native build scripts (see `phase2-status.md`
  for the `[ERR_PNPM_IGNORED_BUILDS]` detail) — still relevant, unchanged by this work.

## Problem: why the old Generate Agent had to go

`bootstrap/generate.ts` hardcoded a `DOMAINS` array: for every domain (customers, products,
orders-status, orders-items, orders-validation, security), a hand-typed list of exact
`testScenarios[].name` strings copied from one specific discovery report, plus hand-typed
`featurePath`/`stepsPath` and (for orders) hand-typed "Known correction" prose. Nothing checked
these names against the report programmatically — if discovery ever reformulated a scenario name,
`generate.ts` would silently stop covering it, with no error, no warning.

**This is not hypothetical — it happened during this very session.** The real committed suite has
**35 scenarios** (6 customers + 6 products + 5 orders-status + 5 orders-items + 9
orders-validation + 4 security), matching `DOMAINS` exactly, generated from whatever discovery
report existed at the time (no longer present in `reports/` — see Environment notes). A **later**
discovery run of the same live app, used throughout this session for pipeline verification
(`discovery-2026-07-29T01-34-42-142Z.json`), produced **24 scenarios** — different names
(`"Prevent backward status transition"` instead of `"Change order status via API from SUBMITTED to
DRAFT"`, etc.), different grouping, and a `kafka_consumer` component the old report apparently
didn't have. Had someone re-run the old `generate.ts` against this newer report with `--domain`
retry logic expecting the old names, more than half the real scenarios would have silently
vanished from generated coverage. Discovery's output is inherently non-deterministic (it's an LLM
exploring a live system); anything downstream that hardcodes its exact wording is fragile by
construction.

## Design: propose → approve → apply, twice in a row

Direct precedent, not a new pattern: `agents/e2e/diagnose.ts` (Claude proposes a diagnosis + a
machine-applicable fix) → a human explicitly approves → `agents/e2e/apply.ts` (deterministic,
guarded file edit, never trusting the model's own claim that it followed the rules). This redesign
applies the same shape one step earlier in the pipeline, twice:

1. **Group** (deterministic, no LLM) → human approves/edits → **budget-split** (deterministic,
   no LLM, no approval needed — packaging, not a decision).
2. **Spec** (one LLM call per group) → human approves/edits → **render** (deterministic template
   layer, no LLM).

Approval happens via a web UI (`agent-service/src/admin/static/generate.html`), extending the
existing descriptor editor rather than a new app — matching how the System Descriptor
(`descriptor/schema.ts`) already made Discovery declarative instead of hardcoded, the explicit model
for this whole redesign.

## What was built

### Milestone 1 — report schema + pipeline contracts (2026-07-29 17:41, `0674cce`)

`agents/generate/reportSchema.ts`: a **non-strict** zod schema for the discovery report — pins down
only `testScenarios[]` and, per component, optional `.tables[]`/`.endpoints[]`, with
`.passthrough()` everywhere else. Discovery's report was never schema-validated before this and its
shape legitimately varies per target system; the schema exists only for this pipeline's own
consumption, `discovery.ts` itself is untouched.

`agents/generate/contract.ts`: zod schemas for every artifact the pipeline passes between stages —
`ProposedGrouping`/`ApprovedGrouping`, `RenderGroup`, and `ScenarioSpec` (a discriminated-union
`Action` — `api`/`ui` — and `Assertion` — `status_code`/`body_field`/`error_message`/`db_row`/
`ui_text`/`ui_visible`, later joined by `kafka_message` in Milestone 7).

Verified: parsed all 5 real (non-corrupted) historical discovery reports in `reports/` without
error, including the one with all four component types and the four Kafka-only ones.

### Milestone 2 — Stage 1 grouping heuristic (same commit, `0674cce`)

`agents/generate/group.ts`, no LLM call:

1. Scenarios whose `type` is in a configurable cross-functional list (default: just `security`) go
   into one group by type, regardless of entity.
2. Everything else: entities are extracted from **whichever components have `.tables[]`/
   `.endpoints[]`**, never by a hardcoded key like `"postgres"` — the real key in a report is
   sanitized by `componentKey()` (hyphens → underscores) and can be a custom `name`. REST top-level
   path segments become canonical entities first; table names merge into an existing entity when
   their camelCase-split words overlap it (`OrderItem` → `order`+`item` overlaps the `orders`
   entity), or become their own fallback entity otherwise.
3. A scenario matching exactly one entity (by word overlap between its name+description and the
   entity's words) joins that group; zero or multiple matches → `ungrouped`.
4. If too many scenarios end up `ungrouped` (configurable ratio, default 0.3), the whole result
   collapses to one flat group (`flatFallback: true`) rather than presenting fake structure.

Verified against all 5 real reports: the 4 Kafka-only ones correctly hit `flatFallback` (zero
extractable entities). The rich 24-scenario report, at the default threshold, also hit
`flatFallback` (8/24 ungrouped); raising the threshold for inspection showed the underlying
security/orders/customers/products split was sound, and all 8 "ungrouped" cases were traced by hand
to genuine multi-entity mentions (mostly `customerId`/`productId` appearing in a scenario's own
description). User decision: keep the literal name+description matching as specified — a human
resolves the borderline cases in the UI in seconds, rather than the heuristic guessing.

### Milestone 3 — corrections store + admin UI for grouping review (17:51, `50bd28e`)

`agents/generate/corrections.ts`: `loadCorrections`/`saveCorrections` read/write a sibling file
next to a descriptor (`descriptors/orderflow.json` → `descriptors/orderflow.corrections.json`),
`Record<scenarioName, string>`. Keyed by name, not by group, so a correction survives regrouping;
tied to one target system, since the same scenario name in a different system's report is a
different fact. The two "Known correction" prose blocks previously hardcoded per-orders-domain in
the old `generate.ts` were migrated here as the first real data.

`admin/server.ts` gained `/api/generate/group`, `/api/generate/group/approve`,
`/api/generate/corrections/:name` (GET/PUT); `admin/static/generate.html` is a new page (plain
HTML/JS, no framework, matching `index.html`'s style) with a report picker, adjustable threshold,
per-scenario "move to another group" dropdowns, and an approve button.

Verified live: a headless-browser run (`playwright-core`, no `chromium-cli` available in this
environment) against the real admin server and a real report — recompute, move a scenario, approve
(wrote a real `generate-grouping-approved-*.json`), then load/edit the migrated corrections — zero
console/network errors.

### Milestone 4 — mechanical token-budget split (17:53, `6f5423f`)

`agents/generate/budget.ts`, no LLM, no human review (packaging, not a decision): splits any
*approved* group whose scenario count exceeds a configurable ceiling (default 6) into
`<key>-1`, `<key>-2`, … evenly. Default chosen empirically, not derived from
`ClaudeProvider.ts`'s hardcoded `max_tokens: 8096` — the two numbers are cross-referenced with
comments in both files (added properly in Milestone 7) precisely because nothing keeps them in
sync automatically, and the user specifically asked about this coupling. Leftover `ungrouped`
scenarios a human approved without resolving get their own `ungrouped-N` group(s) rather than
silently vanishing from the generated suite.

Verified: the real `orders` group (8 scenarios) → 4+4; a synthetic 19-scenario group (matching
today's real orders domain's scale) → 5/5/5/4, noticeably more even than the old hand-split
5/9/5.

### Milestone 5 — structured spec generation + admin UI (18:02, `849e647`)

`agents/generate/spec.ts`: one LLM call per render-group. The model is explicitly *not* trusted
with the `group`/`type` fields (both are known data, filled in mechanically from the render-group's
own key and the source report's `testScenarios[].type` by exact name) — the same "never trust the
model to have followed the prompt's rules perfectly" principle `agents/e2e/diagnose.ts` applies to
`structuredFix`. Response validated with `z.array(ScenarioSpecSchema.omit({group, type}))`, plus a
code-level check that the returned scenario-name set exactly matches what was requested.

Two placeholder conventions introduced here (both because a spec is written before any test run, so
it can't contain a real runtime value):
- `"{<resource>.id}"` — the id from the most recent `given`/`when` POST to that resource in this
  scenario, resolved by the runtime (Milestone 6).
- (Later extended in Milestone 7 with `"{<resource>[N].id}"` and `"{{unique}}"` — see below.)

Admin UI gained `/api/generate/spec`, `/api/generate/spec/approve`, `/api/generate/groupings`, and
a Stage 2 section in `generate.html`: pick an approved grouping, generate (a real, costed Claude
call), hand-edit any scenario's `{given, when, then, unconfirmed}` as raw JSON in a textarea,
approve.

Verified live: real Claude calls against `security` + `customers` (7 scenarios) produced concrete,
correctly-scoped specs, including an honest `unconfirmed` note on "XSS in product name" ("UI output
escaping verification requires browser-level check not expressible in current assertion kinds") —
the report is genuinely uncertain, and the model said so instead of guessing. A browser run
generated a spec, hand-edited a `statusCode` to `999` in its JSON textarea, approved, and confirmed
`999` landed in the written `generate-spec-approved-*.json`.

### Milestone 6 — Stage 3 mechanical templater/renderer (18:52, `3fb5f7d`)

`agents/generate/templates/phrases.ts` is the single source of truth for 8 (later 9) literal,
group-key-scoped step-text phrases (e.g. `an API request is sent for "customers":`) — imported by
both `templates/gherkin.ts` (writes `.feature` files) and `templates/steps.ts` (registers matching
step definitions), so the two can never drift apart the way report-vs-code drifted in the old
design. The actual data for each step travels in a JSON docstring, not Cucumber-expression
parameters — this trades a little Gherkin "prose" readability for zero step-collision risk, since
group keys are already guaranteed unique by construction (unlike the old suite's manual "order
test …" prefix convention, which worked by discipline, not by structure).

`tests/support/generateRuntime.ts` (new; mirrors the existing `support/db.ts`/`support/orderCtx.ts`
role): the actual HTTP/DB/UI execution for every group's 8 shared step definitions, in one place.

Bugs found and fixed while building this:
- playwright-bdd requires a destructuring first parameter even for steps needing no fixtures —
  `(_fixtures, docString)` throws at `bddgen` time; `({}, docString)` is required.
- The Gherkin renderer always writes an explicit `"value": null` for a value-less UI action (not an
  omitted key) — the runtime's `=== undefined` check missed it (`typeof null === 'object'` in JS),
  sending `null` into `.fill()` instead of clicking.

Verified against the real, running OrderFlow Docker stack: rendered a `customers`-shaped group
under the throwaway key `customers-verify` (see sandboxing note above), ran it twice back-to-back
with no cleanup in between — 3/4 scenarios passed both times with no collision-related failures;
the 4th failed identically both runs because the real app returns 500 instead of the model's
guessed 409 for a duplicate email — a real, honestly-surfaced application finding (the model had
already marked it `unconfirmed`), not a pipeline bug. The "run twice" step specifically validated
the `"{{unique}}"` fix (below), added in response to this exact finding.

**`"{{unique}}"` placeholder** (added same milestone, before commit): any field a real system
likely enforces as unique (email, username, …) — the model embeds the literal token
`"{{unique}}"` at the point a fresh value belongs; the runtime resolves every occurrence to the
same per-scenario-run token (so a "create X, then try to create the same X again" scenario still
works — both occurrences resolve identically), but that token differs across separate test runs.

### Milestone 7 — full live pipeline verification, hardening, cutover (20:00, `fd27f2f`)

The last milestone ran the *entire* pipeline live, once, top to bottom, on all 7 render-groups of
the real 24-scenario report (sandboxed under `-sandbox7`/sequential-suffix keys), specifically to
prove the redesign as a whole before deleting the old code. This surfaced a cluster of real gaps —
each fixed, then re-verified live before moving on:

- **No way to express a Kafka check.** The 6 assertion kinds had nothing for "a Kafka message was
  published" — the model tried to invent an unsupported `"kind"` value, which is a schema
  violation that killed the *entire* render-group's response, not just that one scenario. Added a
  7th kind, `kafka_message` (`{topic, expectedFields}`), end to end: `contract.ts`, `spec.ts`'s
  prompt (with an example), `templates/phrases.ts` + `gherkin.ts` + `steps.ts` (the Kafka step/
  import/`Before`-hook subscription is only emitted for groups whose own approved spec actually
  references a topic — `render.ts` computes that set from the spec itself, never hardcoded), and
  `expectKafkaMessage()` in `generateRuntime.ts` (reusing the pre-existing `tests/support/kafka.ts`
  consumer helper).
- **Prompt hardened against inventing invalid output generally**: an explicit rule now forbids any
  `"kind"` outside the (now 7) supported ones and forbids an underspecified `"ui"` action/assertion
  (missing concrete `role`+`label`) — the model must fall back to `"unconfirmed"` instead of
  producing something that fails validation and drops an entire batch.
- **No way to reference "the *second* of several created entities.**" A "create order with two
  different products" scenario needs both products' ids, not just "the latest" — the model had
  already started improvising `"{products[0].id}"` unprompted before this was fixed. Added
  `"{<resource>[N].id}"` (0-indexed, creation order) alongside the existing `"{<resource>.id}"`
  ("the latest"), and documented the official syntax in the prompt so the model doesn't need to
  improvise.
- **UI role+label ambiguity on any page listing more than one instance of the same thing** (e.g.
  one "Show history ▼" button per order card). Added an optional `"scope"` field (on `ui` actions
  and on `ui_text`/`ui_visible` assertions): distinguishing visible text (typically the entity's own
  id) the target must be found near. `findScopedLocator()` in `generateRuntime.ts` climbs DOM
  ancestors from every occurrence of that text (not just the first — a numeric scope can
  coincidentally also match unrelated text, e.g. order id `50` inside a `$50.00` price cell
  elsewhere on the page) until exactly one target matches — verified against this project's *real*
  DOM (order cards are plain `bg-slate-800…` `<div>`s with no row/card CSS convention to key off,
  confirmed by inspecting the live page before choosing this algorithm over guessing class names).
- **Numeric-formatting false failures.** Postgres returns `NUMERIC` columns as fixed-scale strings
  (`"75.00"`) while a spec's author-written expectation is a plain number (`75`) — `expectDbRow`
  and `expectBodyField` now compare numerically when both sides look like numbers, string-equal
  otherwise.
- **A real, undocumented API quirk**, captured as data instead of code: `PATCH
  /orders/{id}/status` returns a JSON *array* `[updatedOrder, newHistoryEntry]`, not the order
  object directly — the report's own `responseSchema` for that endpoint was empty, so the model's
  `body_field` assumption was reasonable but wrong. Added as a
  `descriptors/orderflow.corrections.json` entry (steering future spec generations for that
  scenario name toward a `db_row` check instead) — exactly the scenario this mechanism exists for.

**Final live tally**, full 24-scenario report, all fixes applied: **19 passed, 5 failed** — every
failure already diagnosed above as a genuine finding (duplicate-email 500, the PATCH array shape
under a scenario name the correction wasn't keyed to yet, invalid-id 400-vs-404, and the
order-history UI structure the model had already flagged `unconfirmed`), none a pipeline defect.

**Cutover**: deleted `bootstrap/generate.ts` and its `DOMAINS` array entirely.
`generate-group`/`generate-spec`/`generate-render` are now the permanent CLI surface (their
bootstrap files' comments were updated from "temporary, superseded once generate.ts is rewritten"
to describe the real, final architecture). `package.json` lost `testgen`/`testgen:openai`, gained
`generate:spec:openai`. Root and `agent-service/` READMEs updated (architecture table, "Generate
Agent, in detail" section mirroring the existing E2E one, quickstart commands).
`docs/phase2-status.md` was deliberately **not** updated — it's a dated historical session log of
the system this replaced, not living documentation.

## Known loose ends / risks (not yet addressed)

- **Order-history UI scenario still fails.** `findScopedLocator` now correctly finds the right
  order card (proven — the "Show history ▼" click succeeds), but the expanded history panel's real
  DOM has no `role="cell"`/accessible-name-"Status" structure the model assumed (inspected live:
  it's a plain `<span>` status badge plus a separate items `<table>`, no history-entries table at
  all in the current UI). The model already flagged this scenario `unconfirmed`; fixing it for real
  needs a human to inspect the actual expanded-history markup and either fix the app's
  accessibility semantics or write a corrections.json entry with the real structure.
- **Two real application bugs surfaced, not filed as such**: duplicate customer email returns 500
  (unhandled Postgres unique-constraint violation) instead of a graceful 409/400; invalid
  `customerId`/`productId` in order creation returns 400 rather than the model's guessed 404 (this
  one may simply be intentional API design, not a bug — worth a human's judgment call either way).
- **`{{unique}}`/`"{resource[N].id}"`/`"scope"` are new and only lightly exercised** — verified on a
  handful of real scenarios each, not the full breadth of shapes a different target system's report
  might produce.
- **`kafka_message` has real but thin coverage** — exercised by exactly 2 scenarios so far.
- **Corrections are keyed by exact scenario name, tied to one discovery run's wording** — by
  design (see Problem section), but worth restating: a full re-discovery that renames a scenario
  silently drops its existing correction rather than erroring, exactly as accepted up front.
- **Budget split is a scenario-count proxy for a token budget, not an actual token count** — a
  verbose scenario costs more output tokens than a terse one, but both count as "1".

## Addendum: "why did scenario count go from 35 to 24?" (2026-07-29, post-completion)

Asked directly after wrap-up. Answer, for the record: these are two *different* discovery reports,
not a regression. 35 is what the real committed suite has, from whatever discovery report existed
when the old `DOMAINS` array was hand-written (that report is no longer in `reports/` —
gitignored, overwritten by later runs). 24 is from a separate, later discovery run of the same live
app (`discovery-2026-07-29T01-34-42-142Z.json`), used throughout this session for pipeline
verification, which happened to add a `kafka_consumer` component and formulate/group scenarios
differently. See the Problem section above — this exact discrepancy is the concrete evidence that
motivated the whole redesign, not something introduced by it.

## Addendum: admin UI fixes after the first real look (2026-07-30)

Everything above was verified via the CLI and one headless-browser pass; the first time a human
actually opened the admin UI in a real browser surfaced several more issues, all fixed the same
day:

- **`docker-compose.yml`'s `descriptor-admin` service was stale and crash-looping.** It builds a
  separate image from `Dockerfile.admin` with a hand-picked `COPY` list, written back when the
  admin server only imported `express` + `zod`. Once it started running Stage 2 spec generation
  itself (the same `ClaudeProvider`/MCP/pricing/usage-log machinery the main CLI uses), that list
  was missing most of what it now needs, and the container failed at startup with
  `MODULE_NOT_FOUND`. Fixed by copying the whole `src/` tree and installing from the real
  `package.json` instead of maintaining a hand-picked list — the exact same "hand-maintained list
  silently drifts from reality" failure class this whole redesign exists to eliminate elsewhere,
  just found one layer down in the Docker build.
- **The service was renamed `descriptor-admin` → `admin`**, and every doc reference updated — it
  now serves two pages (descriptor editor + Test Generation), not one.
- **`reports/` was never bind-mounted into the container** — only `descriptors/` was — so
  `/api/generate/reports` and `/api/generate/groupings` silently returned `[]` inside Docker (the
  directory didn't exist at all in the container), even though the exact same code worked
  correctly when run locally via `pnpm admin` against a real `reports/` on disk. Added the mount.
- **A real, unrelated bug**: `GET /api/descriptors` listed *every* `*.json` file in
  `descriptors/`, including `orderflow.corrections.json` — so it showed up in the descriptor
  sidebar as a selectable (but not actually openable — `NAME_PATTERN` rejects the dot) descriptor
  named `orderflow.corrections`. Excluded `*.corrections.json` from that listing.
- **No shared visual identity between the two admin pages** — "System Descriptors" was a compact
  sidebar `h1`, "Generate Pipeline — Stage 1: Grouping" was an unrelated full-width page title that
  also mislabeled the whole page as just its first section (it covers all three stages). Added a
  shared top nav (identical markup/CSS on both pages, current page highlighted) and renamed the
  page's own heading to "Test Generation" at the same size/weight as "System Descriptors".
- **The ungrouped-fallback threshold field went through three iterations before it read clearly to
  someone unfamiliar with the heuristic**: `"Ungrouped fallback threshold"` (0.3) → `"Flatten to
  one group if ungrouped share is above"` (0.3) → its final form, a plain-language label with a
  0–100 `%` input (`"Give up and show one flat list if more than this % of scenarios don't fit a
  group"`, 30%), converting to the 0–1 fraction the API expects only at request time. Worth noting
  as a data point on its own: jargon-free UI copy for a technical concept took real iteration, not
  one pass.
- **A genuine design defect in `flatFallback` itself**, not just wording: `proposeGrouping()`
  collapsed the entire result into one opaque `"all"` group whenever `flatFallback` was true — which
  also destroyed the only information a human needs to act on the accompanying UI banner ("reassign
  scenarios below by hand"). With no other group in the response, every scenario's dropdown had
  exactly one option (`"all"`), making the banner's own suggestion impossible to follow. Fixed by
  making `flatFallback` a pure warning flag: `groups`/`ungrouped` are now always the real heuristic
  output, `flatFallback: true` just means "trust this less, review before approving" rather than
  "structure has been discarded." This reverses part of Milestone 2's original design (which
  deliberately collapsed to one group "without pretending there's structure") — the *problem* that
  design was solving (don't silently present fake confidence) was correct, but the specific
  *mechanism* it used (deleting the underlying data) turned out to make the human's actual review
  task impossible rather than honest.

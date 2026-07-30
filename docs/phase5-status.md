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

## Addendum: DB cleanup, hub rename, Discovery from the web UI (2026-07-30)

Three follow-up tasks, unrelated to each other, done in one session after a night's pause.

**1. Time-based DB cleanup.** `tests/support/cleanup.mjs`'s naming-pattern matching only covers the
hand-written suite's own conventions — the Generate Agent pipeline's `{{unique}}` runtime fills a
model-chosen literal prefix each time, matching none of them. Confirmed live: 56 `Customer` rows, 1
real seed; 58 `Product`, 3 real seed; 29 `Order`, 0 real (including 3 stray test orders placed
against the *real* seed customer, which no naming pattern could ever have caught since the customer
itself isn't test data). Added `--since <ISO8601>` (default `2026-07-23T00:00:00Z` — just after the
last real seed row, well before the first pipeline-run garbage) as a second, complementary sweep:
anything created at/after the cutoff goes regardless of name. Ran it for real; left exactly the 4
seed rows.

**2. Hub page.** `hub/index.html`'s `:4400` card renamed "Descriptor editor" → "Admin", pencil icon →
gear, description switched to a comma list (room to extend later without a rewrite).

**3. Discovery from the web UI.** New "Run Discovery" block on the (renamed) Discovery page, backed
by `POST /api/discovery/run` → `runDiscovery()` (now returns the written path; report filenames
gained a `-<descriptor>` suffix, e.g. `discovery-<ts>-orderflow.json`, timestamp still leading so
"find the latest" sorting is unaffected). Getting this to actually *run* inside the Dockerized admin
container — not just have the route exist — needed real infrastructure changes, each forced by a
constraint found while building, not decided upfront:

- Kafka's MCP server is itself a sibling Docker container the discovery agent launches on demand
  (`kafka.ts`/`kafkaConsumer.ts`, `docker run --network=host ...`) — the admin container needs the
  host's Docker socket mounted (`/var/run/docker.sock`) to start it.
- Every descriptor's component URLs are plain `localhost:PORT`, written assuming host networking
  (the same reason the Kafka MCP server's own spawned container already uses `--network=host`).
  Switched the `admin` service to `network_mode: host` rather than rewriting every descriptor.
- `web-ui` discovery needs a real browser; Alpine doesn't support Playwright's Chromium build (musl
  libc — a compatibility wall, not a size choice). `Dockerfile.admin` moved to
  `node:22-bookworm-slim` + `playwright install --with-deps chromium`; the `docker` CLI itself is
  copied in from `docker:27-cli` (client only, no daemon — talks to the mounted socket).
- Found and fixed a **latent, pre-existing bug** while verifying this: the `admin` service had *no*
  environment variables at all — `ANTHROPIC_API_KEY` included. Stage 2 spec generation (built
  earlier the same overall session) had the exact same problem and had simply never been caught,
  because every previous live check of it ran through `pnpm admin` on the host (which loads
  `agent-service/.env` itself via `dotenv/config`), never through the actual Docker container. Fixed
  both at once with `env_file: ./agent-service/.env` — the same file the CLI already needs, so
  container and host can't drift apart on config.
- **A verification-tooling limitation, not a deployment problem**: this agent's own shell sandbox
  runs in a different network namespace than the real Docker host, so `network_mode: host`
  containers (unlike ordinary `ports:`-published ones) aren't reachable from it directly — confirmed
  via `docker exec ... node -e "fetch(...)"` returning 200 from *inside* the container while `curl`
  from the sandbox got connection-refused. Live verification of `/api/discovery/run` was done the
  same way: triggered from inside the container, which exercises the identical code path a real
  browser's request would (Express doesn't care which network namespace the client is in). Real run
  against `kafka-consumer-demo.json` (chosen specifically to exercise the new socket + host-network
  path cheaply): the sibling Kafka MCP container connected, consumed 5 real messages, produced a
  full report, disconnected cleanly, and the file landed on the host filesystem at
  `agent-service/reports/discovery-2026-07-30T14-36-53-210Z-kafka-consumer-demo.json` exactly as
  named.

## Addendum: `network_mode: host` was wrong, and three more layers under it (2026-07-30)

The very next thing after the addendum above — the user's own real browser got
`ERR_CONNECTION_REFUSED` on `:4400`. `network_mode: host` (chosen specifically to make Discovery work
in Docker) does not reliably forward to a real host browser under Docker Desktop/WSL2 the way it does
on native Linux; this agent's own verification had looked fine only because its shell sandbox happens
to share the Docker daemon's network namespace directly, which a real Windows/WSL2 browser does not.
**Reverted** to plain bridge networking + `ports: ["4400:4400"]`, the same setup every other service
in this stack already uses.

That reopened the problem `network_mode: host` was meant to solve — descriptor URLs are plain
`localhost:PORT`, wrong from inside a bridge-network container. Fixed at the right layer instead:
`discovery.ts` split into a path-based `runDiscovery()` (CLI, unchanged) and
`runDiscoveryForDescriptor()` (takes an already-parsed descriptor); `admin/server.ts`'s discovery
route rewrites postgres/rest-api/web-ui hostnames to this compose network's service names
(`db`/`app`/`frontend`) before calling it. Kafka is deliberately untouched — its MCP server is a
*sibling* container spawned via the mounted socket with its own `--network=host`
(`kafka.ts`/`kafkaConsumer.ts`), a peer of the daemon rather than a child of this container's network
namespace, so it already reaches the real host-published broker port regardless of what network this
container is on.

Getting an actual live discovery run of `orderflow.json` to complete then surfaced three more real,
separate problems — each found by watching a live run in progress and intervening, not decided
upfront:

1. **Vite's Host-header allowlist** (anti DNS-rebinding hardening) returned 403 to anything reached
   via `frontend:5173` instead of `localhost:5173`. `frontend/vite.config.ts` gained
   `server.allowedHosts: true` — a local-only dev stack, not exposed beyond this machine.
2. **The frontend's own client-side JS hardcodes its backend origin**
   (`frontend/src/api/client.ts`: `API_BASE_URL = 'http://localhost:3000'`) — correct for a real
   user's browser, wrong once the page itself is loaded from inside a different container. A live run
   burned real API iterations watching the model try, and mostly fail, to work around this itself via
   ad-hoc Playwright network interception (`page.route()`, spoofed Host headers, raw `http.request`
   attempts) before the run was aborted mid-flight specifically to stop paying for a doomed approach.
   Fixed deterministically instead: `runDiscoveryForDescriptor()` gained an optional
   `mcpServersOverride` hook; the discovery route uses it to append a generated `--init-script` to the
   web-ui MCP server's Chromium launch (`playwright-mcp` already exposes this flag) — a small
   fetch/XHR monkey-patch, evaluated before the app's own scripts run, redirecting requests from the
   *original* rest-api origin to the *rewritten* one.
3. **CORS**: `app/src/main.ts` only allowed `origin: 'http://localhost:5173'`. Once (1) and (2) were
   both fixed, the browser's own fetch succeeded at the network level but was blocked client-side as
   cross-origin, since the page's own origin is `http://frontend:5173` from inside this network.
   Added that origin alongside the existing one.
4. **A fourth, subtler one, found only after (1)–(3) were all fixed and the rewritten fetch *still*
   failed**: Chromium's browser-context networking (unlike Node's own `fetch`, and unlike
   Playwright's out-of-page `page.request` client — neither affected) silently upgrades cross-origin
   sub-resource requests to bare, dot-less hostnames like `app` to HTTPS, with no fallback on
   failure. Confirmed via the failed response's own `non-authoritative-reason: HSTS` header — a
   Chromium-internal label this network never sends itself, so it could only be the browser
   synthesizing the redirect. Confirmed the fix the same way: the *resolved IP address* of the same
   service is exempt from the heuristic (bare hostnames look "upgradeable" to Chromium in a way IPs
   don't). The frontend-rewrite target in `admin/server.ts` now resolves via `dns/promises.lookup()`
   to an IP before being baked into the init script — the only rewrite path this affects, since it's
   the only one a real browser's own networking stack touches.

All four were found and fixed one at a time by actually watching a live run's tool-call log in real
time, not by reasoning about it in the abstract — each fix looked complete on its own until the next
layer's failure showed up. (3) and (4) were confirmed with **zero further LLM cost**: a standalone
Playwright script, run directly inside the admin container against the real (now-fixed) frontend and
backend, reproduced the exact browser-context request the discovery agent's own web-ui MCP tool makes
and confirmed a real page load renders real data — before spending anything on another live agent
run to prove the same thing.

## Addendum: Visualize — entity diagram + business workflow (2026-07-30)

A fourth, unrelated request: turn a discovery report into diagrams a human can read *before* working
with the raw report or grouping its scenarios. Added a "Visualize" tab (placed between Discovery and
Test Generation in the nav on purpose — understand the system first) with two independent halves:

- **Entity relationships** — fully mechanical, no LLM: `agents/workflow/render.ts`'s
  `renderErDiagram()` builds a Mermaid `erDiagram` straight from whichever components have
  `.tables[]` (shape-based, same convention `group.ts` already uses — never a hardcoded component
  key), inferring foreign keys from the `<name>Id` column convention. No approval step — it's
  rendering, not a decision, same reasoning as `budget.ts`'s split in the generate pipeline.
- **Business workflow** — the same `businessRules` free text Test Generation's corrections mechanism
  already treats as untrustworthy-as-code applies here too: parsing prose to draw a flowchart on the
  fly would be exactly the kind of fuzzy, unreviewable step this whole redesign avoids elsewhere. So
  it gets the same treatment as Given/When/Then: a `Rule` discriminated union
  (`state_transition`/`forbidden_transition`/`guard`/`invariant`, `agents/workflow/contract.ts`) the
  model proposes, a human reviews/edits (same JSON-in-a-textarea pattern as Stage 2) and approves
  (`generate-workflow-approved-*.json`), then `renderStateDiagram()` — no LLM — turns the approved
  structure into a Mermaid `stateDiagram-v2` per entity; guards/invariants aren't real graph edges so
  they render as plain text lists next to the diagram instead of being forced into ambiguous syntax.

Found live, on the very first real proposal call: the model tried to express "an order is created
directly into DRAFT" as a `state_transition` with `from: null` — a real, sensible case the schema
hadn't accounted for (`from` was required as a non-null string). Fixed by making `from` nullable and
documenting the convention in the prompt (`null` = "no prior state, this is creation"), and — since
the model's explicit signal is more reliable than assuming array order is meaningful — preferring it
in `render.ts` over the previous `states[0]`-is-the-entry-point fallback.

Mermaid.js is vendored locally (`admin/static/vendor/mermaid.min.js`) rather than loaded from a CDN,
matching every other admin page never fetching anything over the network.

Verified live: the ER diagram (free) and the approved workflow model (one real Claude call, after the
`from: null` fix) both confirmed via a headless browser actually rendering real `<svg>` output with
zero console errors — not just that the Mermaid text looked plausible. The real orderflow report
produced exactly the expected Order state machine: created into DRAFT, DRAFT→SUBMITTED, the
SUBMITTED→DRAFT reversal explicitly forbidden, delete/edit guards scoped to non-DRAFT status, and the
`unitPrice` snapshot invariant.

### Follow-up: ER diagram contrast bug (2026-07-30)

The ER diagram's zebra-striped attribute rows were unreadable in practice — one stripe rendered
correctly, the other rendered near-white text-on-background in dark mode (and the inverse relationship
in light mode). First attempted fix, setting Mermaid's documented
`attributeBackgroundColorOdd`/`attributeBackgroundColorEven` theme variables, had no visible effect.
Proved it empirically rather than guessing again: fed the vendored `mermaid.min.js` build extreme,
unmistakable colors (`#ff00ff`/`#00ff00`) for those two keys in an isolated test page and got back an
unrelated computed color — the vendored erDiagram renderer silently ignores those theme keys and
derives its own row fill regardless of what's passed in. The renderer does reliably emit
`row-rect-odd`/`row-rect-even` classes on each row's own `<path>`, so the real fix overrides the fill
directly via CSS (`#er-diagram .row-rect-odd/.row-rect-even path:first-of-type`) instead of going
through Mermaid's theme layer. Verified with real screenshots in both color schemes after the fix.

## Addendum: Visualize — architecture + UI flow diagrams (2026-07-30)

Two more diagrams added to the same page, both answering "how does the tested application itself
work" — split the same way as before by whether the answer requires interpretation:

- **Architecture** — fully mechanical, no LLM: `renderArchitectureDiagram()` classifies each report
  component by shape (`.uiPages`/`.endpoints`/`.tables`/`.topic`/`.topics` — same shape-based
  convention as the ER diagram, never a hardcoded component key) and draws a generic three-layer
  `flowchart` (UI → API via HTTP, API → DB via SQL, API → Kafka via events). These edges are a
  standard-architecture assumption given which layers are present, not a report-verified claim — the
  same kind of inference the ER diagram already makes for foreign keys by naming convention. Returns
  `null` (same empty-state UX as the ER diagram) when fewer than two components were classified.
- **UI flow** — a report's `uiPages[]` already lists each page's actions, but not which ones navigate
  to another route vs. stay in place; that's a real interpretation step, so it gets the same
  propose → human edits → approve cycle as Business workflow (`ProposedUiFlowSchema`/
  `ApprovedUiFlowSchema`, `agents/workflow/proposeUiFlow.ts`, approved files as
  `generate-ui-flow-approved-*.json`). Renders as **one** combined `flowchart` (navigation is
  inherently cross-page, unlike per-entity state diagrams) via `renderUiFlowDiagram()`. The editable
  unit in the UI is a single textarea over the whole `pages[]` array rather than one per page,
  matching what actually gets rendered.

In-place actions (don't navigate) went through two designs before landing: first a separate text list
below the diagram, then — after live feedback that a flat app like orderflow produces a graph of
mostly-disconnected boxes with all the real content hidden in the list below — self-loop edges on
each page's own node. The self-loop version turned out to have a real Mermaid limitation, confirmed
live rather than assumed: the flowchart layout only keeps the *last* self-loop when a node has more
than one, silently dropping the rest (`/orders`, with seven in-place actions, only ever showed one on
screen). Landed on listing every in-place action directly inside its page's own node label instead —
no such limit, and every action is visible on the graph itself rather than in a separate list.

Verified live: the architecture diagram (free) on the real orderflow report produced exactly the
expected four nodes and edges (Web ui → HTTP → Rest api → SQL → Postgres, → events → Kafka consumer),
and correctly fell back to the empty-state message on the kafka-only demo report (one component, no
edges to draw). The UI flow model (one real Claude call, confirmed with the user first) correctly
identified the orderflow app's only real navigation (`/` redirects to `/customers`) and correctly
classified all thirteen other actions across `/customers`, `/products`, and `/orders` as in-place —
matching the actual (fairly flat, single-page-per-resource) app being tested. Both confirmed via a
headless browser rendering real `<svg>` output with zero console errors, not just plausible-looking
Mermaid text.

### Follow-up: same-report reselect didn't collapse the section (2026-07-30)

Reselecting the *same* report from any of the report dropdowns left a stale diagram/model on screen —
first fix attempt (listening on `blur` in addition to `change`) turned out wrong on live testing:
picking the same option in a native `<select>` closes the popup but never moves focus off the element,
so `blur` never fires for that case either. The real, verified-live signal is `click` — exactly one
click event fires on a `<select>` for the whole open-dropdown-then-pick gesture, regardless of whether
the picked value changed. All four report dropdowns (and the two more added below) now listen on both
`change` and `click`.

## Addendum: Visualize — Sequence flow diagram + page reorder (2026-07-30)

A fifth diagram, closing the gap the first four didn't cover: a "before coding" whiteboard-style
diagram — an ordered, cross-component trace of what happens for one specific scenario (`User` clicks
something → which endpoint → which tables → which Kafka topic), not Architecture's static topology or
UI Inventory's unordered action list. Same reasoning as the other two propose/approve steps: the
report lists `uiPages`/`endpoints`/`tables`/Kafka topics separately, but never says which UI action
calls which endpoint or writes which table — that's inferred, not given.

`agents/workflow/proposeSequenceFlow.ts` deliberately asks for **3–6 representative cross-component
scenarios**, not one per `testScenarios[]` entry — most of a typical report's scenarios are trivial
single-component reads that would just be redundant, costed diagrams. Participants are constrained to
the report's own component keys (explicitly listed in the prompt) plus a reserved `"User"` actor for
the human — never invented names, same shape-driven discipline as Architecture. `renderSequenceDiagram`
renders **one Mermaid `sequenceDiagram` per scenario** (like Business workflow's per-entity diagrams,
not UI Inventory's single combined graph) — a sequence is inherently about one scenario, so combining
several would just be a tangle.

Also reordered the whole page from general to specific, free tier first: **Architecture → Entity
relationships → UI Inventory → Sequence flow → Business workflow** (Sequence flow sits right after UI
Inventory since it traces from a UI action; Business workflow — entity-level state/rule detail — stays
last as the deepest dive). The new section reused every already-hardened pattern from the start (the
`click`+`change` listener fix above, the "flip button to Show instead of auto-displaying" UX) rather
than repeating the earlier debugging.

Verified live: page order confirmed correct after the reorder, all four pre-existing sections still
worked. The sequence flow model (one real Claude call, confirmed with the user first) on the real
orderflow report produced five sensible scenarios (Create Order, Submit DRAFT order, Delete DRAFT
order, Create Customer, Update product price), each using real component keys as participants plus
`User`, concrete labels (`POST /orders`, `INSERT Order (status=DRAFT, customerId)`, `Publish to
orders.status-changed {...}`), and correct request/response step ordering. All five diagrams rendered
as real `<svg>` output with zero console errors.

## Addendum: click-to-enlarge diagram modal + zoom (2026-07-30)

All five diagrams render small and dense inline, worse in a non-maximized browser window. Clicking any
rendered diagram (all five sections, one delegated click listener on `<main>` keyed off a
`data-source`/`data-title` pair each render site stamps onto its own `<pre class="mermaid">`) now opens
a shared modal that re-renders the same Mermaid source at a bigger font size (Mermaid lays the whole
diagram out larger, not a blurry CSS zoom on the small version) inside a scrollable container.

Interactive +/- zoom controls (semi-transparent, floating over the diagram, positioned as a sibling of
the scroll container so they stay put regardless of scroll offset) let the human zoom further from that
100% baseline — needed because the modal itself is still capped by the actual browser window size, so a
fixed "bigger" render alone isn't enough on a small window. Getting the zoom to actually produce
scrollbars took three failed attempts, each found and diagnosed live rather than assumed away:

1. **`transform: scale()` on a wrapper** — didn't grow the scroll container's `scrollWidth`/
   `scrollHeight` at all; confirmed via direct measurement before and after zooming in.
2. **CSS `zoom` on the same wrapper** — same null result, despite `zoom` normally being a real
   layout-affecting property (unlike `transform`). Turned out irrelevant to the actual bug (see below).
3. **Setting the `<svg>`'s own pixel width/height directly** — still no scrollbars, and a full DOM chain
   dump (computed `overflow-x`/`overflow-y` at every ancestor) found the real cause: the shared
   `pre.mermaid` rule sets `overflow-x: auto` for the page's small inline diagrams; per CSS 11.1.1,
   mixing that with the default `overflow-y: visible` makes browsers compute `overflow-y` as `auto` too
   — so the modal's own `<pre>` was quietly acting as its own private scroll container the whole time,
   swallowing the zoomed `<svg>`'s overflow internally no matter which of the three techniques was used,
   before it ever reached the outer modal container.

Fixing that (`.diagram-modal-scroll pre.mermaid { overflow: visible; }`, making the outer modal
container the sole scroll owner) still wasn't enough on its own — a second bug stacked on top of it: a
`.diagram-zoom-wrap` div (an `inline-block` with no explicit width, left over from the abandoned
`transform` attempt) sat between the scroll container and the `<pre>`. Mermaid's `<svg>` uses
`width="100%"`, a percentage that needs a definite containing-block width to resolve against; with an
indeterminate-width `inline-block` in the chain, the browser fell back to the SVG spec's default
300×150 replaced-element size — so even the *un-zoomed* baseline render was tiny, confirmed by dumping
the `<svg>`'s actual attributes/computed size at each step. Removing the now-redundant wrapper (the
zoom logic already targets the `<svg>` element directly, not a wrapper) restored the direct
scroll-container → `pre` → `svg` chain that resolves percentages correctly.

Verified live end to end after both fixes, in a deliberately small (900×600) viewport — the exact
"non-maximized window" scenario that prompted this: at 100% the modal `<svg>` measured a correct ~768px
(matching the container), zooming to 220% grew it to ~1690px, `scrollWidth` (1714) exceeded
`clientWidth` (811) in both axes, and setting `scrollLeft`/`scrollTop` programmatically actually moved
the visible content — not just that the numbers looked right. Zoom clamps correctly at 40%/400%, and a
screenshot in a large (1600×1000) viewport confirmed the same zoom controls work with no unwanted
scrollbars when the diagram already fits.

Also added click-and-drag panning as an alternative to the scrollbars: `mousedown` on the scroll
container starts a drag (cursor flips `grab` → `grabbing`), `mousemove` adjusts `scrollLeft`/
`scrollTop` by the drag delta, listening on `document` rather than the container itself so a fast drag
that leaves the container mid-gesture keeps panning instead of stopping dead at the edge. Verified live
with real synthesized mouse events (`page.mouse.down()`/`move()`/`up()`, not just direct DOM property
pokes): cursor and a `panning` class toggle correctly across the gesture, and a 150×100px drag actually
moved `scrollLeft`/`scrollTop` by exactly that delta.

User feedback caught a follow-up bug: the grab cursor only showed over the empty canvas around a
diagram, staying a plain arrow over the diagram's own body. Cause was another leftover from an earlier
fix — the modal's `<pre>` (which visually covers the whole diagram) had `cursor: default`, set to
override the small-page-diagrams' `cursor: zoom-in` hint before panning existed; that `default` value
won over the scroll container's `grab`/`grabbing` by CSS source order. Changed to `cursor: inherit`, so
the `<pre>` now correctly picks up whichever grab/grabbing state its ancestor is in. Verified live by
checking the *computed* cursor with the mouse positioned over an actual drawn shape inside the
`<svg>` (a participant box's text node, via `document.elementFromPoint`), not just the SVG's own empty
padding area — `grab` at rest, `grabbing` mid-drag.

## Addendum: confirm-before-paid-action rule + 3 UI fixes across all admin pages (2026-07-30)

Before returning to Generate-agent work proper, a standing rule and three small fixes across all three
admin pages (`index.html`, `generate.html`, `visualize.html` — each self-contained with its own
duplicated CSS/JS, the established convention on this project; no shared bundle to hang a single
component off of).

**Rule**: every button wired to a real Claude API call now shows a confirmation modal ("this calls
Claude and costs real money") before doing anything, plus a green `$` badge on its label. Checked
against `admin/server.ts` for which routes actually construct a `ClaudeProvider` (not just say "costs
money" in a subtitle) — five buttons qualify: `run-discovery-btn` (index.html), `spec-generate-btn`
(generate.html), and `wf-propose-btn`/`uf-propose-btn`/`seq-propose-btn` (visualize.html). The three
Visualize buttons are dual-mode (`Generate ...` = a real paid call; `Show ...` = free, reuses an
already-approved model) — the modal and badge apply only to the `Generate ...` state, wired via a new
`setButtonLabel(btn, label, costsMoney)` helper replacing the plain `btn.textContent = ...` assignments
that would otherwise wipe out the badge span on every toggle. Deliberately *not* wired: `recompute-btn`
("Generate grouping") — mechanical heuristic, no `ClaudeProvider` involved despite the similar name —
and every `Approve` button, which only validates and writes an already-paid-for result to disk.

**Fix 1**: `arch-render-btn`/`er-render-btn` (Visualize) restyled from `ghost` to `primary` — free vs.
paid is now signaled by the `$` badge alone, not by button color, so every button can look the same.

**Fix 2**: all five `Approve` buttons (grouping, spec, workflow, UI inventory, sequence flow) now
`display: none` while their block is empty/collapsed, not just `disabled`-but-visible — a disabled
button sitting there implied something to approve once enabled, which wasn't true until a proposal
actually loaded.

Verified live and entirely for free: every check exercises the Cancel branch of the new modal (a
`page.on('request')` guard confirmed zero requests to any of the five paid routes fired during the
whole run), plus DOM/CSS assertions — modal message text, `$` badge presence/absence in each button
mode, Render/Hide's computed background color matching `.primary` exactly, and all five Approve
buttons' `display` before/after their block gets data.

## Addendum: toolbox icon, safe-default confirm modal, admin container renamed to workbench (2026-07-30)

Three more small fixes on the heels of the rule/renaming pass above. Render/Hide buttons in Analysis
got unified to just "Show" (matching the also-shortened "Show" label on the workflow/UI
inventory/sequence flow toggle buttons, which used to read "Show workflow model" etc.) — one consistent
verb for "show me the free thing" everywhere on the page.

Hub's Workbench card still had the old gear icon, a leftover from when it was called "Admin" — replaced
with a hand-drawn toolbox pictogram (box + handle + split line + latch, same stroke-based style as
every other hub icon) rather than trying to recall an exact third-party icon set's path data from
memory. Verified live via a real Chromium screenshot, not just eyeballing the SVG source.

The confirm-before-paid-action modal's default (Enter-triggered) button was "Yes, proceed" — backwards
for a modal whose whole purpose is warning about real spending. Now focuses Cancel when it opens, in
all three admin pages; verified live by checking `document.activeElement.id` right after the modal
opens, not just that `.focus()` appears in the source.

Renamed the docker-compose service itself from `admin` to `workbench`, plus everything that names it:
`Dockerfile.admin` → `Dockerfile.workbench`, the `admin` npm script → `workbench`, `server.ts`'s log
prefixes, and every README mention of the service/Dockerfile/pnpm script. Deliberately left
`agent-service/src/admin/` (the source directory) alone — renaming it would touch many more files for
no user-visible difference, unlike the container name a human actually sees in `docker ps`. Verified
live: rebuilt and swapped the container (`docker compose up -d --build workbench --remove-orphans`,
which cleanly stopped and removed the stale `agentic-qa-platform-admin-1` container since it's no
longer in the compose file), confirmed `agentic-qa-platform-workbench-1` is what's actually running.

### Follow-up: the confirm modal's default was still visually wrong (2026-07-30)

Focusing Cancel by keyboard turned out to be half the fix — a live screenshot from the user showed
"Yes, proceed" still rendered as the blue/prominent `.primary` button, so it still read as the default
at a glance regardless of which one Enter actually triggered. Swapped classes (Cancel → `primary`,
"Yes, proceed" → `ghost`) so the visual default agrees with the keyboard default. Verified live: both
`document.activeElement.id` (still `confirm-modal-cancel`) and the two buttons' actual computed
`background-color` (Cancel now `rgb(124, 155, 239)`, "Yes, proceed" now transparent) in the same check.

### Follow-up: two more hub icons (2026-07-30)

AI usage/cost log's generic bar-chart icon became a dollar sign (Feather's actual `dollar-sign` glyph
— vertical line + S-curve) — unambiguous "this is a cost report" at a glance.

Workbench's icon needed to go further than the earlier toolbox attempt: an *open* box with tools
visibly sticking out, not a closed case. First attempt (trapezoid body, one tool-ish shape at each top
corner) looked fine described in words but rendered as a shopping basket — only caught by actually
rendering it at 120px in an isolated test page instead of trusting the path data by eye at the real
21px card size (`.card-icon svg` is that small; no amount of small-detail path data reads at that
scale). Fixed by rendering test pages at both true size (21px) and magnified (120px) before touching
the real file: switched the body to a plain rectangle with a seam line (a trapezoid reads as a basket;
a rectangle doesn't) and moved the two tools to cross centrally over the opening instead of attaching
to the rim corners like basket handles. Confirmed by screenshotting the actual hub card afterward, not
just the isolated test page.

### Follow-up: modal SVG clipping a long edge label, thicker dollar icon (2026-07-30)

A real bug this time, caught from a user screenshot: Business workflow's enlarged diagram modal
cropped the "✗ Forbidden — SUBMITTED orders cannot be reverted to DRAFT" edge label hard at a vertical
edge, with acres of unused space visible in the rest of the modal. Not a scroll problem — the scroll
container had already sized itself correctly to the `<svg>`'s own (303×393px) bounding box, which was
simply too narrow for that label's actual rendered width at the modal's bumped font size. Mermaid's
`<svg>` keeps the browser's UA-default `overflow: hidden`, so content painted past its own
self-computed viewBox — plausible for a `stateDiagram-v2` edge label, HTML-rendered via foreignObject —
just vanished instead of pushing the box wider. `#diagram-modal-scroll svg { overflow: visible; }`
fixes it for free, since the container already had room to spare. Confirmed live: the full label text
now renders, screenshot in hand.

Also thickened the hub's cost-log dollar icon with a second vertical stroke (matching a common "$"
style) per feedback that the single-line version read less clearly at a glance — verified in an
isolated test page at both 21px and 120px before touching the real file, the lesson from the toolbox
icon saga just above.

The toolbox saga's actual ending: asked whether the open-toolbox concept was worth continuing to
fight, given three iterations still hadn't produced something crisp at 21px. Rendered a side-by-side
comparison (wrench alone, the current toolbox, the old gear) at both 21px and 120px to make the
trade-off concrete instead of describing it in the abstract — recommended the wrench (as legible as
the gear, still reads as "tools" rather than "settings"). Landed on the wrench (Feather's `tool` glyph)
replacing the toolbox entirely. Confirmed on the real hub card.

### Follow-up: the SVG-overflow fix wasn't actually the fix (2026-07-30)

The `overflow: visible` fix above turned out incomplete — a hard-refreshed, freshly-regenerated
screenshot from a real browser (Chrome/Windows) still showed the same label cropped, which never
reproduced in this sandbox's headless Linux Chromium no matter how the check was run. Walked the full
ancestor chain's *computed* `overflow` from the label text up to the `<svg>` (not just the two ends)
and found the real second clipping box: Mermaid wraps each edge label's HTML content in its own
`<foreignObject width="200" height="132">`, which carries the same UA-default `overflow: hidden`
*independently* of the outer `<svg>` — a completely separate box the first fix never touched. Whether
a given label actually overflows that fixed 200px depends on real glyph metrics (`ui-sans-serif,
system-ui, "Segoe UI", ...` resolves to a different actual font, with different character widths, on
Linux vs. Windows), which is exactly why the bug was invisible in this sandbox and real in the user's
own browser. Added `.diagram-modal-scroll svg foreignObject { overflow: visible; }` alongside the
existing svg-level rule. Deployed; awaiting the user's own re-check since this sandbox still can't
reproduce the underlying font-metrics condition that triggers it.

Two more rounds followed once the user actually re-checked, each caught from a real screenshot:

1. Text fully rendered, but the label's green **background** stayed cut off mid-sentence — because
   `overflow: visible` lets *content* paint outside a box, it doesn't grow the box's own
   `background-color` fill. Mermaid's `.labelBkg` div/p were still pinned to the foreignObject's
   original 200px. First attempt: `width: max-content` — grew the background to match, but
   `max-content` sizes an element as if `white-space: nowrap` were set *regardless of the element's
   actual white-space value*, so it fought Mermaid's own wrapping (these already had
   `white-space: break-spaces`, verified live) into one very long unwrapped line, wide enough to
   overlap the neighboring "Submit" label and edge.
2. Fixed by using a bounded `width: 230px` instead and leaving wrapping alone — let Mermaid's own
   multi-line layout do what it already knew how to do, just inside a box sized to actually fit it.

Except that *still* didn't reproduce as fixed on the machine that actually shows the bug — this
sandbox's font metrics never triggered it, so four straight rounds of "looks right in my screenshot"
kept not matching what the user saw. Screenshots alone had stopped being enough to debug this, so the
next step was a real DevTools console dump of the actual computed/inline styles, from the user's own
browser, walking the same ancestor chain. That's what finally found the real root cause: Mermaid bakes
an *inline* `style="white-space: nowrap; ...; max-width: 200px; ..."` directly onto its `.labelBkg`
div. `width: 230px !important` genuinely did win its own property's cascade over that non-important
inline style (confirmed in the dump), but `max-width` is a *different* property nothing was
overriding, so the box model's `used width = min(width, max-width)` step clamped straight back down to
the inline 200px regardless — and `white-space: nowrap` was never contested at all, forcing one long
unwrapped line instead of Mermaid's own multi-line layout. Adding `max-width: 230px !important` and
`white-space: normal !important` alongside the existing `width` override fixed it for real — confirmed
by both a live screenshot (clean 4-line label, background fully covering the text) and a second console
dump from the same real browser showing all three properties resolving as intended.

Lesson for next time a Mermaid-rendered element misbehaves only in a browser this sandbox can't
reproduce: ask for a DevTools computed-style dump (including `getAttribute('style')` for inline
styles) up the whole ancestor chain *before* trying a second or third CSS patch on faith — it would
have found the actual cause on the first pass instead of the fourth.

## Addendum: back to actually using Generate — a real Stage 1→2 bug (2026-07-30)

First real use of the rebuilt Test Generation pipeline since the redesign, on a fresh discovery report
(29 scenarios, up from an earlier 24 — the target app grew), found a genuine bug rather than a UI
nit: after hand-correcting an under-confidence grouping (11/29 scenarios initially ungrouped) and
clicking "Approve grouping," the freshly-approved file saved to disk fine but never appeared in Stage
2's "Approved grouping" dropdown. Cause: `loadGroupingList()` only ever ran once, at page load — Stage
1's approve handler had no reason to know Stage 2's dropdown existed. Fixed by calling
`loadGroupingList()` again right after a successful approve; its existing last-item auto-select
(already used by every other report/grouping dropdown on this page) picks up the new one for free.
Verified live and for free: approved a real grouping, confirmed the new filename appears in Stage 2's
dropdown and is the one auto-selected, no page reload needed.

A second, genuinely useful finding while actually driving the pipeline: the user asked whether setting
Stage 2's "Max scenarios/group" to 15 would likely fail — checked `budget.ts` and `ClaudeProvider.ts`
rather than guessing, and yes: `max_tokens: 8096` is hardcoded per call, `DEFAULT_MAX_SCENARIOS_PER_GROUP
= 6` was chosen empirically against that exact ceiling (the old hand-maintained suite needed to cut a
~19-scenario "orders" domain into 3 files of ≤9 to stay under it), and 15 wouldn't split their
15-scenario "orders" group at all — sending it as one call, over twice the safe precedent. Worse,
`ClaudeProvider.ts` treats `stop_reason === 'max_tokens'` the same as a normal completion, just
returning whatever text was generated so far — a truncated response, which then fails to parse as
valid JSON in Stage 2 rather than surfacing as an obvious "ran out of tokens" error.

That answer surfaced a real naming problem: "group" already means something concrete and specific from
Stage 1 (the group a human just hand-built on screen, e.g. "orders — 15 scenarios") — a field called
"Max scenarios/group" sitting right next to that concept in Stage 2 reads as capping or dropping
scenarios from it, backwards from what `splitByBudget` actually does (never drops anything; splits an
oversized group into multiple Claude calls and recombines the results). Renamed to "Scenarios per
Claude call" — describing the actual mechanism instead of overloading "group" — plus a hover tooltip
spelling out the "nothing capped or dropped" guarantee explicitly. Internal identifiers (`maxScenarios`,
`DEFAULT_MAX_SCENARIOS_PER_GROUP`, the `spec-max-scenarios` element id) deliberately left alone, same
principle as every other display-only rename this session.

## Addendum: "Groups" filter was matching the wrong layer (2026-07-30)

Same overloaded-"group" problem from the rename above turned out to also be a real logic bug, not
just a wording one. Stage 2's "Groups (optional, comma-separated)" field was implemented to filter the
*post-budget-split* render groups — so a Stage 1 group like "orders" (15 scenarios), once
`splitByBudget` had chunked it into `orders-1`/`orders-2`/`orders-3` for the "Scenarios per Claude
call" limit, could only be selected by typing those exact split keys. Typing the plain group name a
user actually sees on screen — "orders" — matched nothing and generated for zero groups.

Corrected the `/api/generate/spec` handler in [server.ts](../agent-service/src/admin/server.ts) to
filter `approvedGrouping.groups`/`.ungrouped` by the requested Stage 1 keys *before* calling
`splitByBudget`, not after. Typing "orders" now means the whole Stage 1 group, however many Claude
calls it internally needs — the chunking happens automatically and invisibly downstream, exactly like
it does when no filter is applied at all. Relabeled the field to "Limit to groups (optional)" in
[generate.html](../agent-service/src/admin/static/generate.html) with a tooltip explaining it matches
Stage 1 group names regardless of internal batching.

Verified for free, without any real Claude calls: a standalone script imported the real
`splitByBudget` from `budget.ts` and ran the same filter-then-split logic against a fake grouping
containing a 15-scenario "orders" group, confirming (a) filtering by plain "orders" alone selects and
fully batches all 15 scenarios into `orders-1/2/3`, (b) unrequested groups are excluded entirely, (c)
"ungrouped" is only included when explicitly named, (d) an empty match still hits the existing 400
error path. `pnpm --dir agent-service typecheck` also passed clean.

## Addendum: Stage 1 wording + "Show last approved grouping" (2026-07-30)

Two more Stage 1 requests before resuming real spec generation, both driven by actually using the
page. First, the threshold field's label — "Give up and show one flat list if more than this % of
scenarios don't fit a group" — was one long run-on sentence competing for space with the rest of the
row. Shortened to "Ungrouped threshold" with the full explanation moved into a hover tooltip, the same
treatment already used for "Scenarios per Claude call" and "Limit to groups" right next to it in Stage
2, so the row reads consistently now.

Second: Stage 1 only ever offered a fresh (mechanical, free) recompute — reselecting a report that
already had an approved grouping from an earlier session gave no way to see that grouping again short
of digging through `reports/*.json` by hand. Added a "Show last approved grouping" button next to
Generate grouping, backed by a new `GET /api/generate/grouping-for-report` route in
[server.ts](../agent-service/src/admin/server.ts) that mirrors the existing
`/api/workflow/for-report` pattern from Visualize: scans `generate-grouping-approved-*.json` files,
picks the most recent one whose `sourceReportPath` matches the selected report, and returns it (or
`null`). The button stays hidden until that check finds something, on both page load and report
reselect (reusing the same "change" + "click" dual-listener trick as Visualize's report dropdowns,
needed because re-picking the already-selected option fires neither event alone).

Verified live against the real running `workbench` container and its actual `reports/` data (no
Claude calls involved — this route only reads already-approved JSON off disk): confirmed via `curl`
that the endpoint returns the latest approved grouping for a report with grouping history and `null`
for one without, then drove the actual page with a headless Playwright session — selecting the report
with history shows the button and clicking it renders all 4 of its approved groups; selecting a report
with no grouping history keeps the button hidden.

## Addendum: Stage 1 button styling + Show/Hide toggle (2026-07-30)

Follow-up polish on the two Stage 1 buttons added above. `recompute-btn` ("Generate grouping") and
`show-approved-grouping-btn` were both still `class="ghost"`, out of step with every other action
button on the page (`primary` — blue background, white text). Switched both to `primary`.

`show-approved-grouping-btn` also gained real Show/Hide toggle behavior, matching the pattern already
used by Visualize's Render buttons: clicking it while collapsed loads the approved grouping and
relabels itself "Hide last approved grouping"; clicking again clears the grouping block and relabels
back to "Show last approved grouping". Clicking "Generate grouping" while the approved snapshot is
showing also resets the label back to "Show ..." — the block on screen is a fresh recompute at that
point, not the approved one the button was previously showing, so leaving it labeled "Hide" would
misdescribe what collapsing it does. The existing rule from the prior addendum — hide the button
entirely when the selected report has no approved grouping at all — was already correct and needed no
change.

Verified live with the same headless-Playwright approach as the prior addendum, against the real
`workbench` container and real `reports/` data: both buttons render with the blue `primary` style;
selecting the report with grouping history, clicking the button once shows "Hide last approved
grouping" with all 4 approved groups rendered, clicking again returns to "Show last approved grouping"
with the block empty; selecting a report with no grouping history keeps the button hidden throughout.

## Addendum: same Show/Hide pattern, one layer down, for Stage 2 (2026-07-30)

Same request applied to Stage 2: a "Show last approved spec" button next to Generate spec, visible
only when the currently-selected grouping already has an approved spec from an earlier session. New
`GET /api/generate/spec-for-grouping` route in
[server.ts](../agent-service/src/admin/server.ts) mirrors `/api/generate/grouping-for-report` one
layer down the pipeline — scans `generate-spec-approved-*.json`, matches on `ApprovedSpec
.sourceGroupingPath` instead of `ApprovedGrouping.sourceReportPath`, returns the latest match or
`null`.

Named "approved" rather than "generated," on purpose — came up while answering a related question
about what Generate spec and Save corrections do and don't touch on disk: the web UI's Generate spec
button (`/api/generate/spec`) never writes anything to disk by itself, only Approve spec does. So
there's no "last generated" artifact sitting on disk to reload for free — only the last *approved* one,
same as Stage 1's button really shows the last *approved* grouping, not the last *computed* one.

Same Show/Hide toggle mechanics as Stage 1 and Visualize's Render buttons. Two places needed to reset
or recheck the toggle so it can't show stale state for a grouping that's no longer selected: Generate
spec's success handler (screen now shows a fresh unapproved generation, not necessarily the approved
one) and Stage 1's Approve-grouping handler, which already calls `loadGroupingList()` to refresh Stage
2's dropdown — setting a `<select>`'s `.value` via JS doesn't fire `change`, so without an explicit
recheck there the button could keep showing/hiding whatever the previously-selected grouping's state
was.

Verified live against the real running container and real `reports/` data, no Claude calls: `curl`
confirmed the endpoint matches the one grouping with an approved spec and returns `null` for one
without; a headless Playwright session then drove the actual page — selecting the grouping with an
approved spec shows the button, clicking it renders its 5 scenarios and flips to "Hide last approved
spec," clicking again collapses back to "Show last approved spec," and selecting a grouping with no
approved spec keeps the button hidden throughout.

## Addendum: auto-derive both "Descriptor" fields instead of typing them (2026-07-30)

Both "Descriptor" text fields — Scenario corrections' and Stage 2's — were free text the user had to
type by hand, with no check that what they typed actually matched the system they were working with. A
mismatch is a quiet correctness bug: it makes `/api/generate/spec` and Load/Save corrections read or
write the wrong descriptor's `*.corrections.json`, silently mixing up two different target systems'
notes.

The fix leans on something already true: [discovery.ts:119-125](../agent-service/src/bootstrap/discovery.ts:119)
names every report `discovery-<isoTimestamp>-<descriptorLabel>.json`, timestamp first (so "find the
latest" sorting keeps working), descriptor label last. That label can be parsed straight back out of
the filename — no reason to make the user retype something already on disk. In
[generate.html](../agent-service/src/admin/static/generate.html), a `descriptorFromReportName()` regex
does that parse, and both Descriptor inputs became `readonly`:

- **Scenario corrections'** Descriptor now tracks whichever report is selected in Stage 1's dropdown —
  that dropdown already means "the system I'm currently working with," so this is a direct reuse.
- **Stage 2's** Descriptor deliberately does *not* track Stage 1's report-select the same way. Stage
  1's report and Stage 2's selected grouping are independently choosable — someone can flip Stage 1 to
  a different report while an older grouping stays selected in Stage 2 — so deriving from the widget
  would silently point corrections lookups at the wrong system whenever those two fall out of sync.
  Instead it derives from *the selected grouping's own* `sourceReportPath`, fetched via a new
  `GET /api/generate/groupings/:name` route in [server.ts](../agent-service/src/admin/server.ts) that
  returns a single grouping's full content by filename.

One more piece, at the user's suggestion: a handful of early reports (from before the descriptor-label
naming convention existed — six `discovery-2026-07-29T*.json` files with no trailing label) have
nothing for that regex to parse. Rather than build a manual-entry fallback for them, Stage 1's report
list simply excludes any report the regex can't parse a label from — they're still valid inputs to the
CLI's `generate-group`, just not selectable from this dropdown. This filtering is scoped to
`generate.html`'s own `loadReportList()`, not the shared `/api/generate/reports` endpoint Visualize's
five report dropdowns also call — those diagrams don't need a descriptor at all, so there was no reason
to narrow what they can see.

Verified live against the real running container and real `reports/` data (no Claude calls): `curl`
confirmed `/api/generate/reports` itself is unchanged (still returns all 8 reports, so Visualize is
unaffected) while a headless Playwright session showed Stage 1's dropdown listing only the 3 reports
with a parseable descriptor label; selecting each one correctly filled in `orderflow` /
`kafka-consumer-demo`; Stage 2's Descriptor correctly showed `orderflow` for a grouping sourced from an
`-orderflow.json` report and came back empty (not an error) for the one existing grouping whose source
report predates the naming convention.

## Addendum: highlight corrections relevant to Stage 2's shown spec (2026-07-30)

Came out of a real question about workflow: after generating a spec for just the "products" group
(5 scenarios), clicking Load in Scenario corrections pulls in every correction saved for the whole
`orderflow` descriptor, all groups mixed together — by design, since corrections are stored per
descriptor rather than per group (see the second addendum above), so they survive regrouping. That's
correct, but it left no visual way to tell which of the loaded rows actually matter for what's on
screen right now versus a different group's leftover notes.

`spec.ts`'s `buildCorrectionsBlock()` already answers "which rows matter": it filters the whole
descriptor's corrections down to just the scenario names present in the current render group before
building the Claude prompt. [generate.html](../agent-service/src/admin/static/generate.html) mirrors
that same filter client-side — a `relevantCorrectionNames()` helper builds the set of scenario names in
Stage 2's *currently shown* spec (freshly generated, or reloaded via "Show last approved spec"), and
`renderCorrections()` adds a `.relevant` class (accent-tinted background, left border) to any row whose
name is in that set. Wired into every place `specState` can change — Generate spec's success handler,
and both branches of the Show/Hide approved-spec toggle — so the highlight tracks whatever Stage 2 is
actually displaying, not just a one-time snapshot at Load time.

Verified live against the real running container and its real `descriptors/orderflow.corrections.json`
(no Claude calls, and the verification script never called Save, so no data was written): loaded the 3
real saved corrections — all for "orders" scenarios — with no Stage 2 spec shown yet, confirmed nothing
highlighted (0 of 3, since `specState` was still null); showed the "products" group's approved spec (5
scenarios), confirmed still 0 highlighted (correct — none of the 3 saved corrections are products
scenarios); added a throwaway new row (never saved) named to exactly match one of the 5 shown
scenarios, confirmed it was the one row that picked up the `.relevant` class.

Separately raised by the user: since corrections only take effect at spec-generation time, should the
whole Scenario corrections section move above Stage 2 in the page? Recommended for a later pass
rather than folded into this one — it fits the page's forward pipeline reading order (an input Stage 2
consumes, same direction as Stage 1's approved grouping), but the common edit loop is "generate, notice
something off, add a correction, regenerate," which reads more naturally with corrections sitting next
to Stage 2 rather than above it. No change made pending the user's call.

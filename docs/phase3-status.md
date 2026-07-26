# Agentic QA Platform — Phase 3: Reporting + CI — Status Summary

**Status: complete.** Companion to `phase2-status.md`. Covers Phase 3 as
scoped by Phase 2's "Immediate next steps" list: `multiple-cucumber-html-reporter`
wiring and GitHub Actions CI — plus three follow-on fixes that came out of
actually looking at the rendered report and using the suite day-to-day
(Before-hook tag scoping, a local report-viewer container, and terminal
reporter output). Conducted in a `.claude/worktrees/phase-3-*` worktree,
fast-forward-merged into `main` after each commit (see "Environment notes").

## Environment notes (read this before continuing in a new chat)

- **This session worked from a worktree, not the main checkout** —
  unlike Phase 2. That's fine as long as the worktree's branch has no
  divergence from `main` (`git log main..HEAD --oneline` empty). If it's
  behind, fast-forward merge before continuing.
- **Worktrees don't share untracked/gitignored files.** `tests/.env`
  (`DATABASE_URL=postgresql://user:pass@localhost:5432/testdb`, gitignored)
  had to be recreated by hand in this worktree — copied from the main
  checkout's copy. Without it, `pnpm run cleanup` / any DB-touching script
  fails with a `SASL: client password must be a string` error that doesn't
  obviously point at a missing env var (same failure mode Phase 2 hit for a
  different reason — see `phase2-status.md` point 10).
- **`docker compose ps` run from a worktree directory shows nothing**, even
  though the stack is up — Compose derives the project name from the
  directory the stack was started in (the main checkout), not from wherever
  you happen to run `docker compose ps`. Check from
  `/home/test/projects/agentic-qa-platform`, or just `curl` the app/frontend
  ports directly, before concluding the stack is down.
- pnpm's ignored-builds gate (see `phase2-status.md`) did not trigger for
  either `pnpm install` in `tests/` or adding `multiple-cucumber-html-reporter`
  — confirmed empirically, no `pnpm approve-builds` needed for this package.
- **No git remote is configured for this repo** (`git remote -v` is empty)
  — confirmed with the user, this is a deliberate local-only workflow for
  now, not an oversight. "Push" in this project currently means
  fast-forwarding the local `main` branch from a worktree branch (`git -C
  <main checkout> merge --ff-only <worktree branch>`), not `git push` to a
  remote. The `.github/workflows/tests.yml` added this phase therefore
  **cannot be verified against a real run** until a remote gets added — see
  "Known loose ends" below.
- The Bash tool's working directory silently resets to this worktree's root
  between some (not all) tool calls — observed after `pnpm install` and
  after backgrounding a process with `&`/`disown`, not after ordinary
  commands. Don't assume a `cd` from a prior call is still in effect;
  prefix commands with an explicit `cd <path> &&` when it matters which
  checkout (worktree vs. main) a command runs against. This bit twice this
  session: once running `pnpm run test`/`report` against the wrong
  checkout, once screenshotting a stale report file.

## What Phase 3 does

### 1. Cucumber-format JSON + HTML report

`tests/playwright.config.ts` previously had a reporter entry
`['json', { outputFile: 'reports/cucumber-report.json' }]` — despite the
filename, this is Playwright's **own** JSON reporter format, not Cucumber's.
`multiple-cucumber-html-reporter` needs actual Cucumber-message JSON, which
Playwright's native JSON reporter doesn't produce. Nothing downstream ever
consumed the old file (grepped for references — none), so this was a latent
bug, not a behavior change for anything relying on it.

Fixed by switching to playwright-bdd's own built-in Cucumber reporter
adapter:

```ts
import { defineBddConfig, cucumberReporter } from 'playwright-bdd';
// ...
reporter: [
  ['list'],
  ['html'],
  cucumberReporter('json', { outputFile: 'reports/cucumber-json/report.json' }),
],
```

The `['list']` entry was added slightly later (see "6. Explicit `list`
reporter" below) — without it, Playwright still shows *some* live progress
in the terminal (a fallback it injects automatically whenever none of the
configured reporters print to stdout), but it's a different, more compact
format than the actual `list` reporter's checkmark-per-test output. Worth
calling out because it's an easy thing to mistake for "the list reporter is
already running" when it isn't.

`tests/support/generate-html-report.mjs` (plain `.mjs`, matching the
`cleanup.mjs` convention — see Phase 2 notes on why, not repeated here) reads
that JSON and renders `reports/cucumber-html/index.html` via
`multiple-cucumber-html-reporter`'s `generate()`. Wired as `pnpm run report`.

Also added to `use` in `playwright.config.ts`: `trace: 'retain-on-failure'`
and `screenshot: 'only-on-failure'` — there was previously no trace capture
configured at all, so CI would have had nothing meaningful to upload on a
failure.

**Verified**: full suite run against the live Docker stack, 35/35 passing,
report generated and screenshotted (not just exit-code-checked) —
6 features, 35 scenarios, 405 steps, 100% pass, real per-feature breakdown
rendering correctly.

### 2. Fixed `tests/package.json`'s `test` script

Was `"playwright test"` — missing the `bddgen &&` prefix that Phase 2's
notes explicitly flagged as required (`.features-gen/` doesn't exist until
`bddgen` runs; `playwright test` alone silently finds 0 tests). This had
apparently never been hit because Phase 2's manual workflow always ran
`npx bddgen` separately before `npx playwright test`. Fixed to
`"bddgen && playwright test"` so `pnpm run test` (and CI) works standalone.

### 3. GitHub Actions CI

New `.github/workflows/tests.yml`, triggered on push to `main` / PRs /
manual dispatch (path-filtered to `app/`, `frontend/`, `tests/`,
`docker-compose.yml`, the workflow file itself):

1. `docker compose up -d --build` — builds and starts `db` + `app` +
   `frontend` from the repo's existing `docker-compose.yml`.
2. `docker compose exec -T app npx prisma migrate deploy`, retried for up to
   30s — the app has no auto-migrate-on-boot and no seed script, so a fresh
   CI Postgres starts with no schema at all. Confirmed no test scenario
   depends on pre-existing seed data (grepped for hardcoded seed names/counts
   — none), so a bare freshly-migrated DB is sufficient; this matches Phase
   2's finding that the full suite passes 35/35 against a freshly-cleaned DB.
3. Waits for `localhost:3000/customers` and `localhost:5173/` to respond
   (up to 60s each) — **must run after** migrations, not before: an earlier
   draft of this workflow checked readiness before migrating, which would
   spin for the full 60s and fail even on a perfectly healthy boot, since
   `/customers` 500s until the schema exists. Caught and fixed before this
   was ever pushed.
4. `pnpm/action-setup` before `actions/setup-node`'s `cache: pnpm` — that
   ordering matters; `setup-node`'s pnpm cache resolution needs `pnpm` on
   `PATH` already, so `pnpm/action-setup` has to come first.
5. Install `tests/` deps, `npx playwright install --with-deps chromium`.
6. `pnpm run cleanup` (pre-sweep) → `pnpm run test` → `pnpm run report`
   (`if: always()`, so a report still gets generated on failed runs) →
   `pnpm run cleanup` (post-sweep, `if: always()`).
7. Uploads three artifacts: Cucumber HTML report, Playwright HTML report
   (both `if: always()`), and traces from `test-results/` (`if: failure()`
   only — nothing to upload on a clean pass since traces are
   `retain-on-failure`).
8. `docker compose logs` dumped on failure; `docker compose down -v` always
   runs last to tear down the ephemeral CI stack.

**Not yet verified**: this workflow has been reviewed and YAML-validated
(`python3 -c "import yaml; yaml.safe_load(...)"`) but **not actually run on
GitHub** — there's no remote configured for this repo (see "Environment
notes"), so it can't be until one is added. First real push should be
watched closely; the readiness-check ordering bug above is exactly the
kind of thing that only shows up on a genuinely fresh environment, and
GitHub-hosted runners are colder than this dev box.

### 4. Before-hook tag scoping

Found by actually opening the rendered HTML report and looking at a
scenario's step list, not by reading code: every scenario showed several
unnamed `Before` entries with no step text. Root cause — every one of the 7
steps files (`customers`, `products`, `security`, `orders-common`,
`orders-items`, `orders-status`, `orders-validation`) registers its own
`Before()` hook, and **Cucumber/playwright-bdd hooks are global by
default** — every registered `Before()` runs before *every* scenario
regardless of which steps file "owns" it, unless scoped by tag. So a
`security` scenario was running 7 Before hooks: its own plus 6 irrelevant
resets from every other domain (mostly `ctx = {}` for a `ctx` variable that
scenario never touches; three of them also called `ensureDbConnected()`).
Harmless — nothing failed, no state leaked — but it cluttered every
scenario's report with no-op steps and did a small amount of wasted work.

Fixed by:
1. Adding a domain tag to every scenario in `customers.feature`,
   `products.feature`, `orders-items.feature`, `orders-status.feature`,
   `orders-validation.feature` (`@customers`, `@products`, `@orders_items`,
   `@orders_status`, `@orders_validation` — `security.feature` already had
   a unique `@security` tag, no change needed there). The existing
   `@happy_path`/`@edge_case` tags were kept alongside, not replaced — they
   weren't domain-specific to begin with (reused across 5 of the 6
   domains), so they couldn't have been used for this.
2. Scoping each domain's own `Before()` via playwright-bdd's `{ tags: '@x'
   }` option, e.g. `Before({ tags: '@customers' }, async () => {...})`.
3. `orders-common.steps.ts`'s shared fixture-reset hook (`resetOrderCtx()`,
   used by all three orders domains) scoped to a tag-expression OR:
   `{ tags: '@orders_items or @orders_status or @orders_validation' }`
   (playwright-bdd's tag expressions come from `@cucumber/tag-expressions`,
   same `and`/`or`/`not`/parens syntax as standard Cucumber).

**Verified**: 35/35 still pass; re-inspected the regenerated report and
confirmed a security scenario now shows exactly 1 `Before` and an orders
scenario shows exactly 2 (shared + own domain) — checked directly in the
Cucumber JSON, not just visually.

### 5. Local report-viewer container

Originally viewed the report via a manually-started `python3 -m http.server
8080` in `tests/reports/cucumber-html/` — works, but has to be restarted by
hand each session and isn't part of the project's normal `docker compose`
lifecycle. Replaced with a `report` service in `docker-compose.yml`:

```yaml
report:
  image: nginx:alpine
  ports: ["8080:80"]
  volumes:
    - ./tests/reports/cucumber-html:/usr/share/nginx/html:ro
```

No Dockerfile needed, no `depends_on` (doesn't touch `app`/`db`). The bind
mount is read-only and points at the same directory `pnpm run report`
writes to, so regenerating the report and refreshing the browser picks up
the new content immediately — no container restart. Mirrors the
architecture doc's existing pattern of an optional viewer container
(it mentions `swaggerapi/swagger-ui` as an example). Local-only — CI
uploads the report as a build artifact instead, since GitHub Actions
runners don't stay up to serve anything afterward.

**Verified**: `docker compose up -d report` from the main checkout,
`curl localhost:8080/` returns 200 with the report's `<title>`, appears in
`docker compose ps` alongside `app`/`frontend`/`db`.

### 6. Explicit `list` reporter

User ran `npx playwright test --reporter=list` directly and got the
familiar checkmark-per-test terminal output — but that CLI flag **replaces**
the config's `reporter` array entirely rather than adding to it, so the
Cucumber JSON silently stopped being written (confirmed via
`npx playwright test --help`: `--reporter` takes over, doesn't merge).
Fixed properly by adding `['list']` as an entry in the config's `reporter`
array instead (see code block in section 1), so plain `pnpm run test` gets
checkmark terminal output, the HTML report, and the Cucumber JSON all
together — no CLI flag needed, and none of the file-writing reporters are
at risk of being silently dropped by someone reaching for `--reporter` on
the command line later.

**Verified**: `pnpm run test` output now matches `--reporter=list`'s
checkmark format exactly, and `reports/cucumber-json/report.json` still
gets a fresh timestamp on every run.

## Known loose ends / risks (not yet addressed)

- **GitHub Actions workflow is unverified against a real run** — no git
  remote is configured (deliberate, local-only workflow for now — see
  "Environment notes"), so `.github/workflows/tests.yml` has only been
  reviewed and YAML-validated, never actually executed by GitHub. The
  readiness-check ordering bug found and fixed during this phase is exactly
  the kind of thing that only surfaces on a genuinely fresh environment —
  treat the first real run (whenever a remote gets added) as the actual
  test of this workflow, not this local review.
- No caching for the `docker compose build` layer — every CI run would
  rebuild `app`/`frontend` images from scratch. Fine for a portfolio
  project's current traffic; worth a registry-cache or
  `docker/build-push-action` swap if run frequency goes up.
- The original architecture doc's recommended development sequence
  (steps 3–10: API Agent, UI Agent via Playwright Test
  Agents/MCP, DB tools, E2E Agent, Orchestrator, Claude/OpenAI provider
  abstraction, metrics) describes a different, more interactive agent
  framework than what `agent-service`'s `recon.ts` → `generate.ts` pipeline
  actually built (a two-phase batch generator, not a live multi-agent
  orchestrator). Whether "Phase 4" continues the batch-pipeline numbering
  or picks up that original roadmap is an open question for the next
  session, not decided here.

## Immediate next steps (recommended order)

1. Whenever a git remote gets added: push and watch the first real
   GitHub Actions run closely, since the workflow is untested against
   actual GitHub infrastructure (see "Known loose ends"). Fix and re-push
   if anything cold-runner-specific breaks.
2. Decide the Phase 4 scope question above before starting more work.

## Addendum (post-completion, same session)

After this phase was marked complete, `agent-service/src/phases/` was
renamed to `agent-service/src/bootstrap/` (commit `2bee4c6`) — out of
scope for this doc (it's an `agent-service` architecture change, not
reporting/CI), noted here only so a future session doesn't find `src/phases/`
in this file and wonder why the tree doesn't match. Rationale and the
corrected understanding of what `recon.ts` actually does (it's a real
MCP-based tool-use agent, not a plain SDK call — an earlier draft of the
architecture doc got this wrong and was corrected) live in the updated
`agentic-qa-platform-summary.md`, not in this repo.

## Addendum 2 (Phase 4 session, 2026-07-24)

Section 4 above ("Before-hook tag scoping") claimed, as a verified fact, that
an orders-domain scenario shows "exactly 2 [`Before` hooks] (shared + own
domain)". **That's no longer true as of commit `aa67823`.** Looking at the
rendered Cucumber HTML report while starting Phase 4 surfaced this as two
blank, indistinguishable "Before" rows per orders-* scenario — functionally
harmless (the two hooks did different work), but noise. Fixed by calling
`resetOrderCtx()` directly from each of orders-items/orders-status/orders-
validation's own `Before()` and deleting the shared cross-domain `Before()`
in `orders-common.steps.ts`, so it's back to exactly 1 `Before` per scenario
— same as customers/products/security always had. Re-verified 35/35 passing
and 1 `Before` per orders-* scenario directly in the Cucumber JSON.

## Addendum 3 (Phase 4 session, 2026-07-24)

Phase 1 ("Recon") was renamed to "System Discovery Agent" for clarity to
readers without AI-agent-jargon context — `recon.ts` → `agent-service/src/bootstrap/discovery.ts`,
`pnpm recon` → `pnpm discovery`, report prefix `recon-*.json` →
`discovery-*.json`. This file's own references to `recon.ts`/`pnpm recon`
above (e.g. the "Environment notes" and the addendum right before this one)
describe the code as it was named at the time — left as-is, not rewritten.
Full rationale and scope of the rename: `phase4-status.md`.

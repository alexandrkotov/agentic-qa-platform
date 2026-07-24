# Agentic QA Platform — Phase 3: Reporting + CI — Status Summary

Companion to `phase2-status.md`. Covers Phase 3 as scoped by Phase 2's
"Immediate next steps" list: `multiple-cucumber-html-reporter` wiring and
GitHub Actions CI. Conducted in a `.claude/worktrees/phase-3-*` worktree,
kept in sync with `main` throughout (see "Environment notes" below).

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
  ['html'],
  cucumberReporter('json', { outputFile: 'reports/cucumber-json/report.json' }),
],
```

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
GitHub** — doing that requires pushing/opening a PR, which wasn't done yet
this session. First real push should be watched closely; the readiness-check
ordering bug above is exactly the kind of thing that only shows up on a
genuinely fresh environment, and GitHub-hosted runners are colder than this
dev box.

## Known loose ends / risks (not yet addressed)

- GitHub Actions workflow is unverified against a real run (see above).
- No caching for the `docker compose build` layer — every CI run rebuilds
  `app`/`frontend` images from scratch. Fine for a portfolio project's
  current traffic; worth a registry-cache or `docker/build-push-action`
  swap if run frequency goes up.
- The original architecture doc's "Рекомендуемая последовательность
  разработки" (steps 3–10: API Agent, UI Agent via Playwright Test
  Agents/MCP, DB tools, E2E Agent, Orchestrator, Claude/OpenAI provider
  abstraction, metrics) describes a different, more interactive agent
  framework than what `agent-service`'s `recon.ts` → `generate.ts` pipeline
  actually built (a two-phase batch generator, not a live multi-agent
  orchestrator). Whether "Phase 4" continues the batch-pipeline numbering
  or picks up that original roadmap is an open question for the next
  session, not decided here.

## Immediate next steps (recommended order)

1. Commit and push this work; watch the first real GitHub Actions run.
2. If it fails on something not caught by local testing (cold-runner
   timing, Docker layer differences, etc.), fix and re-push — treat the
   first CI run as the actual test of this phase, not the local dry-run.
3. Decide the Phase 4 scope question above before starting more work.

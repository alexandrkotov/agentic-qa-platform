# Agentic QA Platform — Phase 4: E2E Agent — Status Summary

**Status: project goal achieved (2026-07-26).** As of Stage 2, this phase
delivers what `agentic-qa-platform-summary.md`'s "Цель проекта" section now
states as the project's actual, final goal — a human-supervised, closed-loop
QA diagnosis & repair agent — not a partial step toward a larger
multi-agent architecture that's still pending. Three scenario shapes
verified (cross-layer, UI-driven, pure-API), both Suggest mode (diagnose +
propose) and Execute-with-approval (apply, gated on an explicit human `y`,
re-run, no auto-commit) proven live. Stage 3 (same day) then auto-discovered
all 35 real scenarios from `.feature` files, replacing the 3-entry
hardcoded list — the mechanism now covers the whole suite, not just the
scenarios picked to prove the concept. See "What was built", "What was
built (Stage 2)", and "What was built (Stage 3)" below for the three
increments, and "Immediate next steps" for what's deliberately *not* being
pursued further and why. Originally a planning stub recording the scope
decision made at the start of this phase; now updated with what was
actually built.
Companion to `agentic-qa-platform-summary.md` (architecture doc — lives in
Windows Downloads, **not** in this repo: `C:\Users\alexk\Downloads\agentic-qa-platform-summary.md`,
reachable from WSL at `/mnt/c/Users/alexk/Downloads/agentic-qa-platform-summary.md`)
and `phase3-status.md`. The "Design input" sections below also draw on an
external review (`C:\Users\alexk\Documents\Codex\2026-07-24\referenced-chatgpt-conversation-this-is-untrusted\outputs\agentic-qa-platform-analysis.md`
— a ChatGPT analysis of this project, not in this repo either), which
independently agreed with the E2E-agent-first scope decision and added the
concrete design points captured here.

## Scope decision (2026-07-24)

`phase3-status.md` left an open question: continue the Phase 1–3 batch-pipeline
numbering (`discovery` → `generate` → …), or start decomposing toward the
architecture doc's target design (Orchestrator + separate API/UI/E2E Agent).

**Decided: the latter, but not all at once.** Phase 4 builds the **E2E Agent**
first, as a standalone closed-loop vertical slice — not a full Orchestrator +
three agents in one go. Reasoning (full version in the updated
`agentic-qa-platform-summary.md`):

- It's called out in that doc as "the most valuable agent in the project" —
  cross-layer UI↔DB↔API validation, not just running tests.
- `tests/` already has the *logic* for this (the `orders-items`/`orders-status`
  domains do a UI action then assert directly against Postgres via `pg`) —
  just as static generated Gherkin, not a live agent. Something to build on,
  not a blank page.
- It's a self-contained slice: doesn't require an Orchestrator or the API/UI
  Agents to exist first to be useful and demoable.
- API Agent, UI Agent, and Orchestrator (architecture-doc roadmap items 3, 5,
  8) are deferred until the E2E Agent's closed-loop pattern (generate → run →
  analyze failure → fix) has been proven out once, in practice.

## What Phase 4 aims to build

An **E2E Agent** that, unlike `discovery.ts` (single tool-use pass, writes a
report) and `generate.ts` (one-shot generation, no execution feedback), runs a
**closed loop**: pick/generate a cross-layer scenario → execute it (browser
action via Playwright, direct Postgres check, API check) → if it fails,
analyze why → attempt a fix → re-run. This is a different execution shape
from anything built in Phase 1–3, not an extension of `generate.ts`.

**Resolved (2026-07-25) — see "What was built" below for the actual
implementation:**
- Directory placement: `agent-service/src/agents/e2e/` — a new top-level
  directory, sibling to `bootstrap/`, not inside it. `bootstrap/` stays
  reserved for one-shot tools (`discovery.ts`, `generate.ts`); the E2E Agent
  is a different kind of thing (closed-loop, not "run once, get an artifact").
- Tool loop design: **turned out not to need one for the execution phase.**
  The "obvious starting guess" below (give Claude Playwright MCP + Postgres
  MCP and let it explore) was rejected — it would mean an LLM deciding
  pass/fail from raw tool output, which violates the project's own
  AI-discovers/code-asserts split. Instead: a deterministic runner spawns the
  *real* `tests/` Playwright suite (`bddgen` then `playwright test --grep
  "<scenario>"`) as a child process and reads its actual exit code + Cucumber
  JSON report. `provider.run()` is only called once, only on failure, purely
  to diagnose — no tools, no MCP, no loop needed since there's nothing for it
  to call.
- MCP servers needed: **none, for this slice.** Evidence comes entirely from
  the real test run's own output (Cucumber JSON + `trace.zip` +
  `test-failed-1.png` + `error-context.md`), not from the LLM re-verifying
  anything live via MCP. This directly answered the "read Playwright's own
  test output" question below — yes, that's the whole mechanism now, not an
  addition on top of MCP browser actions.
- First scenario: **"Submit DRAFT order"** (`tests/features/orders-status.feature`,
  `@happy_path @orders_status`) — hardcoded in `agent-service/src/agents/e2e/scenarios.ts`.
  Later generalized to a small `SCENARIOS` array plus a `--scenario` CLI
  filter (mirrors `generate.ts`'s `--domain`) — see "Scenario-shape check"
  below.

## Design input: agent contract (from external review)

Not yet implemented — captured here so the eventual `AgentRunOptions`-style
interface for the E2E Agent has a target shape instead of being designed from
scratch when coding starts. A structured contract matters more than a free-text
report here because it's what would make future evaluations/provider-comparison
work (architecture doc's roadmap item 10, still not done) possible at all.

**Input:**
- Scenario identifier or structured scenario description (not free text —
  needs to be something the loop can re-run deterministically)
- Allowed base URLs (app/API under test)
- Allowed tools (which MCP servers / custom tools this run may use)
- Data policy (what it may create/mutate/delete — ties into the healing
  guardrails below)
- Max iterations
- Autonomy mode (see rollout section below)

**Output:**
- Final status
- Steps actually executed
- Deterministic assertion results
- UI / API / DB evidence (see Evidence collection below)
- Failure classification (see below), if it failed
- Proposed or applied patch, if any
- Retry results
- Token / time / tool-call metrics (the per-run cost logging added in
  `ClaudeProvider`/`pricing.ts` this phase is a building block for this, not
  the whole thing — that logs a whole `provider.run()` call, this needs it
  scoped per E2E Agent run)

## Design input: failure classification (from external review)

The closed loop's "diagnose" step needs to produce something structured, not
just prose, or there's nothing to build evaluations or dashboards on top of
later. Minimal taxonomy to classify a failed run against:

- `application_bug` — the app under test is actually wrong
- `test_bug` — the generated/existing test scenario itself is wrong
- `environment_issue` — Docker/DB/network/browser-install problem, not a
  real signal about app or test correctness
- `test_data_issue` — stale/conflicting test data, not a code defect
- `tool_error` — an MCP server or tool call itself failed
- `unknown` — classification not confident enough to pick one of the above

The classification must be backed by retained evidence (assertion output,
HTTP status/body, SQL result, browser state, trace) — a label with no
evidence behind it isn't trustworthy enough to act on, let alone automate.

## Design input: healing guardrails and autonomy rollout (from external review)

This wasn't discussed at all when the E2E-agent-first decision was made —
worth flagging as a real gap the scope decision didn't cover. Giving a
closed-loop agent write access to fix its own failures is a meaningfully
different risk profile from `discovery`/`generate`'s one-shot, human-reviewed
output.

Guardrails for the first implementation:
- Allowed: fixing locators, waits, and other test *plumbing*
- Not allowed (without human approval): weakening or removing assertions —
  otherwise a "fix" could just make a real bug stop being caught
- Not allowed in automatic mode at all: changing backend/frontend
  application code — a defect found this way should be reported, not
  silently patched around
- Every change gets a retained diff, not just a final state
- Bounded retry count, not unbounded looping
- Re-run the original scenario (and relevant regression scope) after every
  fix attempt, not just assume the fix worked

Staged autonomy rollout instead of building straight to full autonomy:
1. **Suggest** — agent diagnoses and proposes a patch, applies nothing
2. **Execute with approval** — applies an approved patch, re-runs
3. **Constrained autonomous** — auto-fixes only pre-approved categories of
   *test* defects (never application code), still bounded by the guardrails
   above

Phase 4's first vertical slice should target **Suggest** mode — matches
where `discovery`/`generate` already sit (see `agentic-qa-platform-summary.md`'s
"Suggest mode" framing), and doesn't require the guardrails above to be
airtight on day one.

## Design input: evidence collection (from external review)

Evidence collection (Playwright trace/screenshot, browser snapshot, HTTP
request/response, SQL query/result, runner output, timestamps/correlation
IDs) should be a plain deterministic capability the E2E Agent calls into —
not a separate LLM-driven agent. Collecting artifacts is predictable work;
there's no reason to spend a model call on it. Keeps with the project's
existing AI-does-discovery/decisions, code-does-execution/assertions split
(see `agentic-qa-platform-summary.md`, "Что именно делает AI").

## Naming: "Recon" renamed to "System Discovery Agent" (2026-07-24)

Phase 1 was called "Recon" throughout the code and docs. Renamed because
"recon" reads as AI/security jargon — clear inside this project, but not
self-explanatory to someone reading the README without that context. Went
with **System Discovery Agent** over
the alternative **Application Discovery Agent** because the agent explores
three layers (OpenAPI contract, UI, and Postgres directly), not just "the
application" — "System" better matches what it actually inspects, and reads
consistently alongside the planned API Agent / UI Agent / E2E Agent names.

Renamed thoroughly, not just in prose:
- `agent-service/src/bootstrap/recon.ts` → `discovery.ts`, `runRecon` →
  `runDiscovery`, CLI phase keyword `recon` → `discovery`
  (`pnpm discovery`/`discovery:openai` replace `pnpm recon`/`recon:openai`)
- Report filename prefix: new runs write `discovery-<timestamp>.json`
  instead of `recon-<timestamp>.json`
- Every current-facing doc updated: this file, `README.md`,
  `agent-service/README.md`, `agentic-qa-platform-summary.md`

**Deliberately NOT renamed:**
- The four existing historical report files in `agent-service/reports/`
  (`recon-2026-07-2*...json`, git-ignored) — left as-is as historical
  artifacts of runs that were actually called "recon" at the time. Still
  loadable via `generate.ts`'s explicit `--report <path>` flag; they just
  won't match the new `discovery-*.json` auto-detection glob for "latest
  report" (not a problem — that report is already consumed, `tests/` is
  already generated and committed from it).
- `docs/phase2-status.md` and `docs/phase3-status.md` — frozen, dated status
  summaries describing what was literally true when written (`recon.ts`,
  `pnpm recon`, etc., at the time). Following the same precedent as the
  earlier `phases/` → `bootstrap/` rename (see `phase3-status.md`'s
  addendum): corrections/renames after the fact get a short addendum note
  in those files, not a silent rewrite of the original text.

## What was built (2026-07-25)

`agent-service/src/agents/e2e/`, five files:

- `scenarios.ts` — hardcoded `SCENARIOS` array, one entry (id, title,
  Gherkin feature name, feature/steps file paths). Mirrors `generate.ts`'s
  `DOMAINS` array pattern (data-driven config, not dynamic discovery).
- `contract.ts` — the actual TypeScript types for the input/output contract
  designed above: `FailureClassification`, `StepEvidence`,
  `ScenarioEvidence`/`ScenarioEvidenceNotFound` (discriminated union — a
  missing/unparseable report or a `--grep` miss is a typed case, not a
  crash), `EvidenceBundle`, `Diagnosis`, `E2ERunReport`.
- `runner.ts` — deterministic execution, no LLM. Deletes the previous
  `tests/reports/cucumber-json/report.json` first (its absence afterward
  unambiguously means bddgen/Playwright crashed before the reporter ran,
  not stale data), pre-sweep `cleanup.mjs`, `bddgen`, `playwright test
  --grep "<title>"`, post-sweep `cleanup.mjs` (always, even on failure).
  Invokes `tests/node_modules/.bin/{bddgen,playwright}` directly via
  `node:child_process.spawn` — not through `pnpm run ...` — matching
  `discovery.ts`'s existing precedent of spawning local binaries directly.
  `AbortController`-based timeouts (bddgen 60s, playwright 4min, cleanup
  30s) so a stuck browser or a down Docker stack can't hang the agent
  forever. **Pass/fail is the child process's real exit code — never an
  LLM's opinion.**
- `evidence.ts` — reads the Cucumber JSON report and scans (never
  reconstructs) `tests/test-results/` for the matching run's artifacts.
  Two things learned empirically that the original design guessed wrong
  about: (1) Cucumber JSON nests scenarios under **features**
  (`{name, elements[]}`), not a flat scenario list — confirmed by parsing a
  real report; (2) Playwright SHA1-hash-truncates the per-test output folder
  name once the title exceeds ~60 chars, so the folder name is not
  reconstructable from the scenario title — confirmed live: a run of this
  exact scenario produced `test-results/features-orders-status.fea-ac52b-nagement-Submit-DRAFT-order/`,
  which no naive concatenation would have predicted. `evidence.ts` just
  `readdir`s the directory instead (Playwright wipes `test-results/` at the
  start of every invocation, and `--grep` isolates one scenario, so there's
  normally at most one entry).
- `diagnose.ts` — the only LLM call, and only made when the run failed. No
  MCP servers, no tools, single `provider.run()` call with the Gherkin +
  step source + the evidence bundle, asked to return the classification/
  reasoning/patch JSON per the contract. The `application_bug` → no-patch
  guardrail is stated in the prompt **and** re-enforced in code afterward
  (`diagnose.ts` nulls out `proposedPatch` if the model returns one anyway
  for an `application_bug` classification) — the model isn't trusted to
  have followed the prompt rule perfectly.

Wired up the same way `discovery`/`generate` are: `case 'e2e'` in
`agent-service/src/index.ts`, `pnpm e2e`/`pnpm e2e:openai` scripts in
`agent-service/package.json`. OpenAI provider support came for free (no
extra code) since `runE2EAgent` takes the generic `AgentProvider` interface.

**Verified live**, not just typechecked:
- **Pass-path**: `pnpm e2e` against the (currently-passing) scenario —
  report shows `status: "passed"`, `diagnosis: null`, and the console log
  confirms no `[Claude] Usage: ...` line appeared (proves the diagnosis call
  really was skipped, no cost incurred on a passing run).
- **Fail-path**: temporarily changed `orders-status.steps.ts`'s
  `expect(body.status).toBe('SUBMITTED')` to `.toBe('SUBMITTED_WRONG')`, ran
  `pnpm e2e`, confirmed: `status: "failed"`; the failing step carried a real
  Playwright error message; `tracePath`/`screenshotPath`/`errorContextPath`
  all pointed at real files; `diagnosis` classified it `test_bug` (confidence
  `high`) with a `proposedPatch` that was exactly the one-line fix, scoped
  only to the `.steps.ts` file. Reverted via `git checkout --` immediately
  after — `git status` on `tests/` was clean throughout, confirming the
  Suggest-mode guardrail held in practice (the agent never touched the file
  itself), not just in prompt text.
- **Full-suite regression**: `cd tests && pnpm run test` — all 35 scenarios
  still pass after the above runs.

**Known rough edges, accepted for this slice, not silently ignored:**
- `--grep` runs overwrite `tests/reports/cucumber-json/report.json`, which
  is the same file the full-suite HTML report reads from. Running `pnpm e2e`
  and then `pnpm run report` (without re-running the full suite first) would
  render an HTML report showing only 1 scenario, not 35. Not a problem for
  how it's used today (nothing auto-chains these), but a sharp edge for a
  future session to know about.
- Token/cost metrics aren't in the structured `E2ERunReport` — only visible
  via `ClaudeProvider`'s existing console logging (unchanged from
  `discovery`/`generate`, per the "agent contract" design note above; fixing
  this means extending `AgentProvider.run()`'s return type, deliberately not
  done here).
- Still exactly one hardcoded scenario, Suggest mode only. No retry-after-fix
  loop (that's "Execute with approval," stage 2 of the autonomy rollout,
  deliberately out of scope for this slice).

## Scenario-shape check: is "E2E Agent" the right name? (2026-07-25)

While using the agent, a sharp question came up: it's called the **E2E
Agent**, but the mechanism (`runner.ts` → `evidence.ts` → `diagnose.ts`)
doesn't check what *kind* of scenario it's running — it would work
identically on a pure-UI scenario or a pure-API scenario, not just a
cross-layer one. So does the name overclaim, and should the project drop the
API Agent/UI Agent/E2E Agent specialization from the architecture doc in
favor of one generically-named agent?

**Decision at the time: don't guess, test it.** `scenarios.ts` was
generalized from one hardcoded entry to three, deliberately chosen to be
different *shapes*, not three more cross-layer checks:

| id | scenario | shape |
|---|---|---|
| `submit-draft-order` | Submit DRAFT order | cross-layer: UI action, verified via both a direct API call and a direct Postgres query |
| `create-customer-valid` | Create customer with valid data | UI-driven: action + assertion through the page, plus a DB check, no explicit API assertion |
| `invalid-customer-id` | Invalid customer ID in API | pure API: no UI, no direct DB query at all |

`agent-service/src/agents/e2e/index.ts` was generalized alongside it to loop
over a filterable list of scenarios (`SCENARIOS`, optionally narrowed by a
new `--scenario <id>[,<id>...]` CLI flag, mirroring `generate.ts`'s
`--domain`) instead of always running `SCENARIOS[0]`. Each scenario writes
its own `agent-service/reports/e2e-<scenarioId>-<timestamp>.json`.

**Verified live, all three shapes, both pass and fail:**
- All three passed cleanly with no code changes needed per shape.
- All three were then deliberately broken (a wrong expected value in the
  relevant assertion — API status code, DB value, or the original
  `SUBMITTED` check) and re-run individually via `--scenario <id>`. All three
  produced a correct `test_bug` classification (high confidence) and a
  patch scoped to exactly the broken line — with **zero scenario-specific
  code** in `evidence.ts`/`diagnose.ts` to make that happen.
- The pure-API scenario correctly came back with `screenshotPath: null`
  (there's no `page`/browser context in that test, so Playwright never
  writes one) while `tracePath`/`errorContextPath` were still populated —
  `evidence.ts`'s `fileIfExists` handled the missing file as a normal `null`,
  not a crash. The UI-driven scenario had all three artifact paths
  populated. This is exactly the kind of shape-dependent detail that *would*
  have needed special-casing if the mechanism weren't genuinely generic.
- Full 35/35 regression suite stayed green after every one of these runs;
  `tests/` was reverted via `git checkout --` each time and confirmed clean.

**Conclusion: the current mechanism (run → collect evidence → diagnose) is
empirically scenario-shape-agnostic, not just cross-layer-specific.** This
is now a tested fact, not a guess, and it reopened the naming question the
architecture doc's original API/UI/E2E split was built around.

**Decided (2026-07-25): keep the name "E2E Agent".** It names the *role*
this instance fills in the target architecture (Orchestrator + API Agent +
UI Agent + E2E Agent), not a technical guarantee enforced by the code —
same framing as `agentic-qa-platform-summary.md`'s "Архитектура агентов"
section, which this agent instance partially realizes. Reasoning against
renaming to something scope-neutral right now: specialization may become
real later (e.g. UI-agent-style locator healing would plausibly need live
DOM/accessibility access that this agent doesn't have; an API-agent-style
contract check would plausibly want to diff against the OpenAPI schema) —
renaming now, based on a sample of three scenarios, risks having to rename
back if that turns out to matter. If/when API Agent or UI Agent get built
and turn out to need meaningfully different capabilities than this one, that
will be the real signal to revisit naming — not this experiment alone.
`agentic-qa-platform-summary.md` updated to match (status table, "Архитектура
агентов" section, and a new naming note alongside the existing Recon →
System Discovery Agent one).

## Environment notes carried forward (see `phase3-status.md` for detail)

- No git remote configured — local-only git workflow, deliberate.
- `agent-service/src/phases/` is now `agent-service/src/bootstrap/` (renamed
  in Phase 3, commit `2bee4c6`).
- Worktrees don't share untracked/gitignored files (`tests/.env`,
  `agent-service/.env`) or Docker Compose project identity — run
  `docker compose ps` / bring the stack up from the main checkout
  (`/home/test/projects/agentic-qa-platform`), not from a worktree directory.
- Check `git log main..HEAD --oneline` is empty before assuming a worktree
  branch is caught up with `main`.

## Immediate next steps

1. ~~Resolve the open design questions above (directory placement, tool-loop
   shape, MCP server needs) before writing code.~~ Done — see "What was
   built" above.
2. ~~Implement the E2E Agent against a single existing cross-layer scenario
   first (e.g. the `orders-status` DRAFT→SUBMITTED check), verify the
   closed loop (run → detect failure → fix → re-run) actually works
   end-to-end, before generalizing to more scenarios.~~ Done — pass-path and
   fail-path both verified live (see "What was built" above). Note: the
   "fix → re-run" part of the loop is *diagnose + propose* only for this
   slice (Suggest mode) — nothing auto-applies or auto-retries yet, by
   design.
3. ~~Generalize `scenarios.ts` beyond the one hardcoded entry — pick 1-2 more
   existing cross-layer scenarios ... and confirm the evidence/diagnosis code
   holds up without scenario-specific special-casing.~~ Done — went further
   than planned: tested across three different scenario *shapes*
   (cross-layer, UI-driven, pure-API), not just more cross-layer ones. See
   "Scenario-shape check" above. This surfaced an unresolved naming question
   (next item).
4. ~~Decide the naming question from "Scenario-shape check" above.~~ Done —
   keeping "E2E Agent" as a role name, not renamed. See "Scenario-shape
   check" above for the reasoning; `agentic-qa-platform-summary.md` updated
   to match.
5. ~~Move to autonomy stage 2 ("Execute with approval").~~ Done — see "What
   was built (Stage 2)" below.
6. 🚫 **Deliberately not pursued for now:** building the API Agent, UI
   Agent, and Orchestrator on top. Not a backlog item — `agentic-qa-platform-summary.md`'s
   "Цель проекта" section now states the human-supervised E2E Agent
   (Suggest + Execute-with-approval) *is* the project's actual, final goal,
   not a partial step toward this bigger architecture. Revisit only if a
   concrete, specific need for specialization shows up in practice (e.g.
   UI-healing needing live DOM access, API-agent needing OpenAPI-schema
   diffing) — not as a default next step.
7. 🚫 **Deliberately not pursued for now:** autonomy stage 3 ("Constrained
   autonomous" — auto-apply without the interactive `y` confirmation).
   Same reasoning as #6 — the explicit human-approval gate is a stated part
   of the current goal, not a stepping stone to remove. Would only be
   reconsidered after substantial real-world experience with Stage 2 across
   many scenarios/failure types *and* a deliberate, separate decision to
   accept the higher risk profile — not an automatic progression.
8. Optional, low-priority, not required for the stated goal: more Stage 2
   runs across more scenarios/failure types (useful data, doesn't change
   scope), the still-open CI-on-a-real-GitHub-runner verification from
   Phase 3 (blocked on adding a git remote, a separate decision), and a
   systematic Claude-vs-OpenAI benchmark (currently just one qualitative
   comparison point, see `agentic-qa-platform-summary.md`'s "Что не
   реализовано — осознанно").
9. ~~Auto-discover all 35 scenarios from `.feature` files instead of a
   hardcoded 3-entry list.~~ Done — see "What was built (Stage 3)" below.
   Makes item 8's "more Stage 2 runs across more scenarios" trivially easy
   now (any of the 35 is runnable via `--scenario <id>`, not just the
   original 3) — still optional, still not required for the stated goal.

## What was built (Stage 2 — Execute with approval, 2026-07-26)

**Core design decision: `structuredFix`, a new field separate from
`proposedPatch`.** `proposedPatch` (free text, "diff preferred, prose is
fine") isn't reliably machine-applicable — no diff-parsing library is
installed in `agent-service`, and LLM-generated unified diffs routinely have
slightly-off line numbers/context a strict `git apply` would reject anyway.
Added `Diagnosis.structuredFix: { filePath, oldText, newText } | null` —
an exact-match find/replace, the same shape as how Claude Code itself edits
files. `proposedPatch` is unchanged, kept for human-readable display.

Guardrails enforced in **code**, not just prompted (`diagnose.ts`'s new
`sanitizeStructuredFix()`, called from `diagnoseFailure` after
`JSON.parse`):
- `structuredFix` forced to `null` whenever `classification === 'application_bug'`
  (same rule as `proposedPatch`).
- `oldText` must be non-empty and different from `newText` (rejects empty
  needles and no-op "fixes").
- `filePath` must resolve (via `path.resolve`, not raw string equality) to
  exactly one of the scenario's own `featurePath`/`stepsPaths` — the same
  closed set `diagnose.ts` already reads as source context. Tighter than
  "anywhere under `tests/`" and costs nothing, since the model has no
  evidence-grounded visibility into any other file anyway.
- `oldText` must occur **exactly once** in the file's live contents at
  apply time (checked again in `apply.ts`, independently of the
  diagnose-time check, since the file may have changed since) — zero or
  multiple matches refuses rather than guessing.

**Two-phase CLI, not one combined command.** Approval has to be a real
human action. A new `apply-fix` phase (`agent-service/src/agents/e2e/apply.ts`,
wired into `index.ts`/`package.json` as `pnpm apply-fix -- --report <path>`,
reusing the *existing* `--report` flag) reads back a specific Suggest-mode
report, validates every guardrail above plus `status === 'failed'` and a
non-null `diagnosis`, prints a before/after view, and requires an
**explicit interactive `y`/`yes`** via `node:readline/promises` before
writing anything — anything else (including a piped/non-TTY stream
reaching EOF, which readline resolves as `''`) defaults to abort. Every
outcome (`refused_not_applicable`, `aborted_by_user`,
`applied_but_typecheck_failed`, `applied_and_passed`/`applied_but_still_failed`)
writes an `ApplyFixReport` (`e2e-<id>-applied-<timestamp>.json`) carrying
the original diagnosis, the exact fix applied (or not), a `tsc --noEmit`
gate result, and the re-run result — a self-contained audit trail, not
just "it worked." Nothing in `apply.ts` calls `diagnoseFailure` — a second
failure after applying is reported, never auto-re-diagnosed or looped.
**Never commits anything** — the modified file is left for a human to
review via `git diff`, same as every other change this project makes.

`runner.ts`'s internal `runProcess` was exported (one-line change) so
`apply.ts` could reuse it for the `tsc --noEmit` gate without duplicating
child-process/timeout logic. `index.ts` also moved `createProvider()` from
one call before the `switch` to being called individually inside each case
that needs it, since `apply-fix` needs **no LLM call at all** (diagnosis
already happened in a prior `e2e` run) and shouldn't require an Anthropic
API key just to exist; the `Provider: ...` log line is now gated the same
way so it isn't printed for `apply-fix`.

**Verified live**, not just typechecked — all against the `invalid-customer-id`
scenario (pure API, no `page`/browser context):
- Deliberately broke it (`expect(lastStatus).toBe(404)` → `.toBe(499)`),
  ran `pnpm e2e -- --scenario invalid-customer-id`: failed as expected,
  `diagnosis.structuredFix` came back non-null, correctly scoped to
  `steps/customers.steps.ts`, with `oldText` verbatim-present.
- **Abort path, both ways**: `printf 'n\n' | pnpm apply-fix ...` and
  `printf '' | pnpm apply-fix ...` (simulating piped EOF) both correctly
  aborted with `aborted_by_user`, writing an apply-report but leaving
  `git diff` on the source file unchanged both times.
- **Approval path**: `printf 'y\n' | pnpm apply-fix ...` — file modified,
  `tsc --noEmit` ran and passed, scenario re-ran via the real Playwright
  process (no `[Claude] Usage: ...` line — confirms no LLM call happened
  during apply), scenario passed, `applied_and_passed` report written. The
  model's fix happened to exactly reverse the deliberate break —
  `git diff` on the file was empty afterward (byte-identical restore), not
  just semantically correct — though byte-identical restoration was never
  the pass criterion, only the re-run passing was.
- **Negative-path spot checks**, all correctly refused with no write and no
  prompt/exit code 1: (a) a `status: "passed"` report; (b) a hand-edited
  report with `classification: "application_bug"` and a non-null
  `structuredFix` anyway — proves the *code* guardrail stops it, not just
  the prompt; (c) a hand-edited report where `oldText` was chosen to occur
  7 times in the target file — refused with "found 7, expected exactly 1."
- **Full 35/35 regression** stayed green throughout; `tests/` confirmed
  clean via `git status`/`git diff` after every step.

**Known rough edges, accepted for this stage:**
- `structuredFix` is a single find/replace block, not an array — can't
  express a multi-location fix in one shot. Not needed yet; every fix seen
  so far has been single-location.
- No automatic retry-with-re-diagnosis if the applied fix doesn't work —
  by design (bounded to exactly one apply-and-retry attempt per the
  documented guardrails), but means a human has to re-run Suggest mode
  by hand to get a second diagnosis if the first fix doesn't land.
- The `tsc --noEmit` gate only catches compile-time breakage, not runtime
  logic errors that would still pass typecheck but fail differently than
  expected — the scenario re-run is still the real check for those.

## What was built (Stage 3 — auto-discover all 35 scenarios, 2026-07-26)

`scenarios.ts`'s hardcoded 3-entry `SCENARIOS` array (hand-picked to span
different scenario shapes — see "Scenario-shape check" above) is replaced
by `discoverScenarios(testsRoot): Promise<E2EScenarioConfig[]>`, which
parses the real `.feature` files under `tests/features/` directly. No more
hand-typed scenario list to keep in sync as the suite grows — all 35
scenarios across all 6 domains are now runnable via `--scenario <id>`, not
just the original 3.

**How it works:** a minimal line-scanner (only matches `Feature:` and
`Scenario:` lines — this suite has no `Scenario Outline:`/`Examples:`
anywhere, confirmed by counting) extracts feature name + scenario titles
per `.feature` file. `id` is derived via `slugify(title)` (verified
empirically against all 35 real titles: zero collisions; also re-checked
at runtime, throws loudly on any collision rather than silently dropping
one). The one thing that *is* still a small, hand-maintained map:
`DOMAIN_STEPS_FILES` (6 entries, one per `.feature` file's domain →
its `.steps.ts` file(s)) — not derivable from the `.feature` file alone,
since `orders-items`/`orders-status`/`orders-validation` all share
`orders-common.steps.ts` and there's no `orders-common.feature` to infer
that from. A domain missing from this map only drops that domain's
scenarios (`console.warn`, not a crash); zero scenarios discovered overall
is a thrown error, not a silent empty list.

**Known, accepted backward-compatibility break:** `slugify(title)` only
matches 1 of the 3 original hand-picked ids. `create-customer-valid` →
`create-customer-with-valid-data`; `invalid-customer-id` →
`invalid-customer-id-in-api` (`submit-draft-order` happens to stay the
same). The two historical report files under the old ids
(`e2e-create-customer-valid-*.json`, `e2e-invalid-customer-id-*.json`) no
longer resolve via `apply-fix` — confirmed live: refuses cleanly with
"Report references unknown scenario id," not a crash. Decided deliberately,
not fixed with an id-override map: the old ids were arbitrary human
shorthand from the 3-scenario proof-of-concept, not a stable API: adding an
override map would just relocate the "hand-maintained list forever"
problem this stage exists to eliminate. The "Scenario-shape check" section
above and Stage 2's "Verified live" section both still reference the old
ids — left as-is (historical record of what was literally run at the time
those sections were written), not rewritten.

**A real operational tradeoff, made visible rather than silently
absorbed:** `runner.ts` spawns a *separate* `bddgen` + `playwright test
--grep` + pre/post cleanup cycle per scenario (~3-4s each). Running the
E2E Agent with no `--scenario` filter now means ~35 such cycles
sequentially — much slower than `cd tests && pnpm run test`, which runs
all 35 in one parallel Playwright invocation in ~5s. Not fixed (batching
multiple `--grep` titles into one invocation is a separate, bigger
feature) — instead, `runE2EAgent` now prints an explicit warning whenever
no `--scenario` filter is given at all, naming the slowdown and suggesting
`--scenario` to target a subset.

**Verified live:**
- `discoverScenarios()` in isolation: exactly 35 scenarios, 35 unique ids,
  per-feature counts matching the known suite shape exactly
  (`Customer Management`: 6, `Products`: 6, `Security - ...`: 4, `Order
  Items Management`: 5, `Order status management`: 5, `Orders validation`:
  9), zero missing `featurePath`/`stepsPaths` files on disk.
- One scenario per domain (6 total, deliberately including both
  `Background:`-bearing domains and all three `orders-common.steps.ts`-sharing
  domains) run via `pnpm e2e -- --scenario <id>`: all 6 passed correctly.
- The no-filter warning: confirmed it prints (with the correct count, 35)
  before the first scenario starts.
- The accepted backward-compat break: `pnpm apply-fix -- --report
  <old-id-report>` refuses cleanly with the expected message, not a crash.
- `pnpm run typecheck` clean; full 35/35 regression suite still green
  afterward.

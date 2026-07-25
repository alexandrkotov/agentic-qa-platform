# Agentic QA Platform — Phase 4: E2E Agent — Status Summary

**Status: not started.** Planning stub only — records the scope decision made
at the start of this phase so a new chat doesn't have to re-derive it.
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
numbering (`recon` → `generate` → …), or start decomposing toward the
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

An **E2E Agent** that, unlike `recon.ts` (single tool-use pass, writes a
report) and `generate.ts` (one-shot generation, no execution feedback), runs a
**closed loop**: pick/generate a cross-layer scenario → execute it (browser
action via Playwright, direct Postgres check, API check) → if it fails,
analyze why → attempt a fix → re-run. This is a different execution shape
from anything built in Phase 1–3, not an extension of `generate.ts`.

Not yet designed (target input/output shape now drafted in "Design input:
agent contract" below, but not implemented — the items here are the
remaining open questions on top of that):
- Whether this lives under `agent-service/src/bootstrap/` alongside
  `recon.ts`/`generate.ts`, or a new top-level directory (arguably it isn't a
  one-shot bootstrap tool the way those two are — open question).
- Tool loop design: reuse `ClaudeProvider`'s existing manual agentic loop, or
  does the closed-loop generate→run→analyze→fix shape need something
  different from `AgentProvider.run()`'s current one-shot-conversation
  contract.
- Which MCP servers it needs at runtime (Playwright MCP + Postgres MCP,
  matching `recon.ts`'s tool config, is the obvious starting guess) and
  whether it also needs a way to run/read Playwright's own test output
  (not just MCP browser actions) to close the loop on real test failures.
- Scope of the first scenario(s) to target — likely one existing
  `orders-items`/`orders-status`-style cross-layer check, reimplemented as a
  live agent loop, before generalizing to new scenarios.

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
different risk profile from `recon`/`generate`'s one-shot, human-reviewed
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
where `recon`/`generate` already sit (see `agentic-qa-platform-summary.md`'s
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

1. Resolve the open design questions above (directory placement, tool-loop
   shape, MCP server needs) before writing code.
2. Implement the E2E Agent against a single existing cross-layer scenario
   first (e.g. the `orders-status` DRAFT→SUBMITTED check), verify the
   closed loop (run → detect failure → fix → re-run) actually works
   end-to-end, before generalizing to more scenarios.
3. Once proven, revisit whether/how to build the API Agent, UI Agent, and
   Orchestrator on top.

# Agentic QA Platform — Phase 4: E2E Agent — Status Summary

**Status: not started.** Planning stub only — records the scope decision made
at the start of this phase so a new chat doesn't have to re-derive it.
Companion to `agentic-qa-platform-summary.md` (architecture doc — lives in
Windows Downloads, **not** in this repo: `C:\Users\alexk\Downloads\agentic-qa-platform-summary.md`,
reachable from WSL at `/mnt/c/Users/alexk/Downloads/agentic-qa-platform-summary.md`)
and `phase3-status.md`.

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

Not yet designed:
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

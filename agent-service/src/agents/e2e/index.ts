import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import { config } from '../../config.ts';
import { discoverScenarios, resolveScenarioSelectors, type E2EScenarioConfig } from './scenarios.ts';
import { runScenario } from './runner.ts';
import { collectEvidence } from './evidence.ts';
import { diagnoseFailure } from './diagnose.ts';
import type { E2ERunReport } from './contract.ts';

const TESTS_ROOT = resolve(config.reportsDir, '..', '..', 'tests');

export interface RunOneScenarioOpts {
  /** Overrides the child processes' environment (e.g. container-network
   *  service hosts) — undefined inherits the caller's own process.env,
   *  matching runScenario()/runProcess()'s own default. */
  env?: NodeJS.ProcessEnv;
  /** Fired at the same points this function already console.logs, so a
   *  caller (e.g. the admin server, streaming NDJSON to a browser) can
   *  mirror that feedback live instead of only seeing it after the fact. */
  onProgress?: (message: string) => void;
  /** Passed straight through to diagnoseFailure() for usage-log attribution — see its own comment for why this defaults to 'orderflow' rather than being required. */
  descriptor?: string;
}

/**
 * Runs Suggest mode for exactly one scenario: real Playwright/Cucumber run,
 * then (only on failure) one Claude diagnosis call. Writes the report to
 * disk and returns it. Parameterized by `testsRoot` (and optionally `env`)
 * rather than a module-level constant so callers outside this CLI's own
 * layout — the admin server runs inside a container with a different
 * tests/ path and needs container-network env overrides — can reuse it
 * without duplicating this logic.
 */
export async function runOneScenario(
  provider: AgentProvider,
  providerName: string,
  scenario: E2EScenarioConfig,
  testsRoot: string,
  opts: RunOneScenarioOpts = {},
): Promise<{ report: E2ERunReport; reportPath: string }> {
  const { env, onProgress, descriptor } = opts;
  const progress = (message: string) => {
    console.log(message);
    onProgress?.(message);
  };

  progress(`--- Scenario: ${scenario.title} (${scenario.id}) ---`);

  const startedAt = new Date();
  const { passed, result } = await runScenario(testsRoot, scenario.title, { env });
  const finishedAt = new Date();

  const evidence = await collectEvidence(testsRoot, scenario, result);

  let diagnosis = null;
  if (!passed) {
    progress('Scenario failed — running diagnosis (1 model call)');
    diagnosis = await diagnoseFailure(provider, testsRoot, scenario, evidence, descriptor);
  } else {
    progress('Scenario passed — skipping diagnosis (no model call, no cost)');
  }

  const report: E2ERunReport = {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    provider: providerName,
    status: passed ? 'passed' : 'failed',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    evidence,
    diagnosis,
  };

  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const reportPath = join(config.reportsDir, `e2e-${scenario.id}-${timestamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  progress(`=== [${scenario.id}] ${report.status.toUpperCase()} — report saved: ${reportPath} ===`);
  if (diagnosis) {
    console.log(`Classification: ${diagnosis.classification} (confidence: ${diagnosis.confidence})`);
    console.log(`Reasoning: ${diagnosis.reasoning}`);
    console.log(diagnosis.proposedPatch ? `\nProposed patch:\n${diagnosis.proposedPatch}` : 'No patch proposed.');
  }

  return { report, reportPath };
}

/**
 * @param scenarioIds Optional list of scenario selectors to (re-)run — each may be an
 *   exact scenario id, an exact scenario title, or a tag (e.g. ['invalid-customer-id-in-api'],
 *   ['View order status history'], ['security'], ['WIP']). Resolved via
 *   resolveScenarioSelectors(). Omit to run every discovered scenario.
 * @param descriptor Which descriptor's tests/ tree this run is actually against, for
 *   usage-log.jsonl attribution only (see diagnoseFailure()'s own comment) — defaults
 *   to 'orderflow' when omitted, same as every pre-existing caller already got.
 */
export async function runE2EAgent(
  provider: AgentProvider,
  providerName: string,
  scenarioIds?: string[],
  descriptor?: string,
): Promise<void> {
  console.log('\n=== Phase 4: E2E Agent (Suggest mode) ===\n');

  const SCENARIOS = await discoverScenarios(TESTS_ROOT);

  const scenariosToRun = scenarioIds?.length
    ? resolveScenarioSelectors(SCENARIOS, scenarioIds)
    : SCENARIOS;

  if (!scenarioIds?.length) {
    console.warn(
      [
        '',
        `WARNING: running all ${scenariosToRun.length} scenarios with no --scenario filter.`,
        'Each scenario spawns its own bddgen + playwright + cleanup cycle (roughly 3-4s',
        'each), unlike `cd tests && pnpm run test`, which runs everything in ONE parallel',
        'Playwright invocation (roughly 5s total). This run may take several minutes.',
        'Pass --scenario <id>[,<id>...] to run a subset instead.',
        '',
      ].join('\n'),
    );
  }

  const reports: E2ERunReport[] = [];
  for (const scenario of scenariosToRun) {
    const { report } = await runOneScenario(provider, providerName, scenario, TESTS_ROOT, { descriptor });
    reports.push(report);
  }

  const passedCount = reports.filter((r) => r.status === 'passed').length;
  console.log(
    `\n=== E2E Agent summary: ${passedCount}/${reports.length} passed ===`,
  );
  for (const r of reports) {
    console.log(` - ${r.scenarioId}: ${r.status}${r.diagnosis ? ` (${r.diagnosis.classification})` : ''}`);
  }
}

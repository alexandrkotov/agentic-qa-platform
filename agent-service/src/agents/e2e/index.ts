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

async function runOne(
  provider: AgentProvider,
  providerName: string,
  scenario: E2EScenarioConfig,
): Promise<E2ERunReport> {
  console.log(`\n--- Scenario: ${scenario.title} (${scenario.id}) ---\n`);

  const startedAt = new Date();
  const { passed, result } = await runScenario(TESTS_ROOT, scenario.title);
  const finishedAt = new Date();

  const evidence = await collectEvidence(TESTS_ROOT, scenario, result);

  let diagnosis = null;
  if (!passed) {
    console.log('\nScenario failed — running diagnosis (1 model call)\n');
    diagnosis = await diagnoseFailure(provider, TESTS_ROOT, scenario, evidence);
  } else {
    console.log('\nScenario passed — skipping diagnosis (no model call, no cost)\n');
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

  console.log(`=== [${scenario.id}] ${report.status.toUpperCase()} — report saved: ${reportPath} ===`);
  if (diagnosis) {
    console.log(`Classification: ${diagnosis.classification} (confidence: ${diagnosis.confidence})`);
    console.log(`Reasoning: ${diagnosis.reasoning}`);
    console.log(diagnosis.proposedPatch ? `\nProposed patch:\n${diagnosis.proposedPatch}` : 'No patch proposed.');
  }

  return report;
}

/**
 * @param scenarioIds Optional list of scenario selectors to (re-)run — each may be an
 *   exact scenario id, an exact scenario title, or a tag (e.g. ['invalid-customer-id-in-api'],
 *   ['View order status history'], ['security'], ['WIP']). Resolved via
 *   resolveScenarioSelectors(). Omit to run every discovered scenario.
 */
export async function runE2EAgent(
  provider: AgentProvider,
  providerName: string,
  scenarioIds?: string[],
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
    reports.push(await runOne(provider, providerName, scenario));
  }

  const passedCount = reports.filter((r) => r.status === 'passed').length;
  console.log(
    `\n=== E2E Agent summary: ${passedCount}/${reports.length} passed ===`,
  );
  for (const r of reports) {
    console.log(` - ${r.scenarioId}: ${r.status}${r.diagnosis ? ` (${r.diagnosis.classification})` : ''}`);
  }
}

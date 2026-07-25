import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import { config } from '../../config.ts';
import { SCENARIOS } from './scenarios.ts';
import { runScenario } from './runner.ts';
import { collectEvidence } from './evidence.ts';
import { diagnoseFailure } from './diagnose.ts';
import type { E2ERunReport } from './contract.ts';

const TESTS_ROOT = resolve(config.reportsDir, '..', '..', 'tests');

export async function runE2EAgent(provider: AgentProvider, providerName: string): Promise<void> {
  console.log('\n=== Phase 4: E2E Agent (Suggest mode) ===\n');

  const scenario = SCENARIOS[0]; // v1: exactly one hardcoded scenario
  console.log(`Scenario: ${scenario.title}`);

  const startedAt = new Date();
  const { passed, result } = await runScenario(TESTS_ROOT, scenario.title);
  const finishedAt = new Date();

  const evidence = await collectEvidence(TESTS_ROOT, scenario, result);

  let diagnosis = null;
  if (!passed) {
    console.log('\n--- Scenario failed — running diagnosis (1 model call) ---\n');
    diagnosis = await diagnoseFailure(provider, TESTS_ROOT, scenario, evidence);
  } else {
    console.log('\n--- Scenario passed — skipping diagnosis (no model call, no cost) ---\n');
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
  const reportPath = join(config.reportsDir, `e2e-${timestamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n=== E2E run ${report.status.toUpperCase()} — report saved: ${reportPath} ===\n`);
  if (diagnosis) {
    console.log(`Classification: ${diagnosis.classification} (confidence: ${diagnosis.confidence})`);
    console.log(`Reasoning: ${diagnosis.reasoning}`);
    console.log(diagnosis.proposedPatch ? `\nProposed patch:\n${diagnosis.proposedPatch}` : '\nNo patch proposed.');
  }
}

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runProcess, runScenario, type RunnerResult } from './runner.ts';
import { collectEvidence } from './evidence.ts';
import { config } from '../../config.ts';
import { SCENARIOS } from './scenarios.ts';
import type { E2ERunReport, ApplyFixReport, ApplyFixOutcome } from './contract.ts';

async function confirm(promptText: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(promptText);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

const nowIso = () => new Date().toISOString();

async function writeApplyReport(report: ApplyFixReport): Promise<string> {
  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = report.startedAt.replace(/[:.]/g, '-');
  const reportPath = join(config.reportsDir, `e2e-${report.scenarioId}-applied-${timestamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  return reportPath;
}

export async function applyFix(sourceReportPath: string, testsRoot: string): Promise<void> {
  const startedAt = nowIso();
  const raw = await readFile(sourceReportPath, 'utf-8');
  const sourceReport = JSON.parse(raw) as E2ERunReport;

  const scenario = SCENARIOS.find((s) => s.id === sourceReport.scenarioId);
  if (!scenario) {
    console.error(`Report references unknown scenario id "${sourceReport.scenarioId}" (not in current SCENARIOS list).`);
    process.exit(1);
  }

  const abort = async (outcome: ApplyFixOutcome, note: string): Promise<never> => {
    console.error(note);
    const report: ApplyFixReport = {
      scenarioId: sourceReport.scenarioId,
      scenarioTitle: sourceReport.scenarioTitle,
      sourceReportPath,
      outcome,
      originalClassification: sourceReport.diagnosis?.classification ?? 'unknown',
      originalReasoning: sourceReport.diagnosis?.reasoning ?? '',
      appliedFix: null,
      typecheck: null,
      rerun: null,
      startedAt,
      finishedAt: nowIso(),
    };
    const path = await writeApplyReport(report);
    console.error(`Wrote ${path}`);
    process.exit(outcome === 'aborted_by_user' ? 0 : 1);
  };

  if (sourceReport.status !== 'failed') {
    await abort('refused_not_applicable', `Report ${sourceReportPath} is not a failed run (status: ${sourceReport.status}) — nothing to apply.`);
    return;
  }
  const diagnosis = sourceReport.diagnosis;
  if (!diagnosis) {
    await abort('refused_not_applicable', 'Report has no diagnosis.');
    return;
  }
  if (diagnosis.classification === 'application_bug') {
    await abort(
      'refused_not_applicable',
      'Diagnosis classified this as an application_bug — not eligible for automated apply. See recommendedAction and act as a human.',
    );
    return;
  }
  const fix = diagnosis.structuredFix;
  if (!fix) {
    await abort(
      'refused_not_applicable',
      'Diagnosis has no structuredFix — nothing machine-applicable. See proposedPatch for a human-readable suggestion.',
    );
    return;
  }

  const allowedPaths = [scenario.featurePath, ...scenario.stepsPaths];
  const resolvedTarget = resolve(testsRoot, fix.filePath);
  if (!allowedPaths.some((p) => resolve(testsRoot, p) === resolvedTarget)) {
    await abort(
      'refused_not_applicable',
      `structuredFix.filePath "${fix.filePath}" is not one of this scenario's known files: ${allowedPaths.join(', ')}`,
    );
    return;
  }

  const currentContents = await readFile(resolvedTarget, 'utf-8');
  const occurrences = currentContents.split(fix.oldText).length - 1;
  if (occurrences !== 1) {
    await abort(
      'refused_not_applicable',
      `oldText found ${occurrences} time(s) in ${fix.filePath}, expected exactly 1 — refusing to guess.`,
    );
    return;
  }

  console.log(`\n--- Proposed fix for scenario "${scenario.title}" (${scenario.id}) ---`);
  console.log(`File: ${fix.filePath}\n`);
  console.log(`before:\n${fix.oldText}\n`);
  console.log(`after:\n${fix.newText}\n`);
  console.log(`Diagnosis: ${diagnosis.classification} (confidence: ${diagnosis.confidence})`);
  console.log(`Reasoning: ${diagnosis.reasoning}\n`);

  const approved = await confirm('Apply this fix and re-run the scenario? [y/N] ');
  if (!approved) {
    await abort('aborted_by_user', 'Aborted — no changes made.');
    return;
  }

  const newContents = currentContents.replace(fix.oldText, fix.newText);
  await writeFile(resolvedTarget, newContents, 'utf-8');
  console.log(`Wrote ${fix.filePath}.`);

  console.log('\nRunning tsc --noEmit as a fast gate before re-running the scenario...');
  const typecheckResult: RunnerResult = await runProcess(
    join(testsRoot, 'node_modules', '.bin', 'tsc'),
    ['--noEmit'],
    testsRoot,
    60_000,
  );
  const typecheckPassed = typecheckResult.exitCode === 0 && !typecheckResult.timedOut;
  const typecheck = {
    ranAt: nowIso(),
    passed: typecheckPassed,
    stdoutTail: typecheckResult.stdout,
    stderrTail: typecheckResult.stderr,
  };

  if (!typecheckPassed) {
    console.error(
      '\ntypecheck FAILED after applying the fix. The file has been left modified — review manually (git diff) before deciding whether to revert.',
    );
    const report: ApplyFixReport = {
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      sourceReportPath,
      outcome: 'applied_but_typecheck_failed',
      originalClassification: diagnosis.classification,
      originalReasoning: diagnosis.reasoning,
      appliedFix: fix,
      typecheck,
      rerun: null,
      startedAt,
      finishedAt: nowIso(),
    };
    const path = await writeApplyReport(report);
    console.error(`Wrote ${path}`);
    process.exit(1);
  }
  console.log('typecheck passed.');

  console.log('\nRe-running the scenario...');
  const { passed, result } = await runScenario(testsRoot, scenario.title);
  const evidence = await collectEvidence(testsRoot, scenario, result);

  const outcome: ApplyFixOutcome = passed ? 'applied_and_passed' : 'applied_but_still_failed';
  const report: ApplyFixReport = {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    sourceReportPath,
    outcome,
    originalClassification: diagnosis.classification,
    originalReasoning: diagnosis.reasoning,
    appliedFix: fix,
    typecheck,
    rerun: { passed, evidence },
    startedAt,
    finishedAt: nowIso(),
  };
  const path = await writeApplyReport(report);

  console.log(`\n${passed ? 'PASSED' : 'STILL FAILING'} after applying the fix.`);
  console.log(`Wrote ${path}`);
  console.log('No commit was made — review the change with `git diff` and commit yourself if satisfied.');
  if (!passed) process.exit(1);
}

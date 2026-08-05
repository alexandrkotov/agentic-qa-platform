import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess, runScenario, type RunnerResult } from './runner.ts';
import { collectEvidence } from './evidence.ts';
import { config } from '../../config.ts';
import { discoverScenarios, type E2EScenarioConfig } from './scenarios.ts';
import type {
  E2ERunReport,
  ApplyFixReport,
  ApplyFixOutcome,
  StructuredFix,
  Diagnosis,
  FailureClassification,
} from './contract.ts';

export const nowIso = () => new Date().toISOString();

export async function writeApplyReport(report: ApplyFixReport): Promise<string> {
  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = report.startedAt.replace(/[:.]/g, '-');
  const reportPath = join(config.reportsDir, `e2e-${report.scenarioId}-applied-${timestamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  return reportPath;
}

export interface ApplyPreview {
  scenario: E2EScenarioConfig;
  diagnosis: Diagnosis;
  fix: StructuredFix;
  currentContents: string;
}

export interface ApplyRefusal {
  ok: false;
  outcome: ApplyFixOutcome;
  reason: string;
  /** false only for the "report references an unknown scenario id" case —
   *  mirrors the CLI's original behavior of exiting without writing an
   *  ApplyFixReport for that one case; every other refusal persists one. */
  persistReport: boolean;
  scenarioId: string;
  scenarioTitle: string;
  originalClassification: FailureClassification;
  originalReasoning: string;
}

export type ApplyPreviewResult = { ok: true; preview: ApplyPreview } | ApplyRefusal;

/** Builds the same "nothing was applied" ApplyFixReport shape apply.ts's own
 *  abort() used to build inline, for either a refusal from loadApplyPreview
 *  or a human declining the confirm prompt after a successful preview. */
export function buildAbortedReport(
  params: {
    scenarioId: string;
    scenarioTitle: string;
    outcome: ApplyFixOutcome;
    originalClassification: FailureClassification;
    originalReasoning: string;
  },
  sourceReportPath: string,
  startedAt: string,
): ApplyFixReport {
  return {
    scenarioId: params.scenarioId,
    scenarioTitle: params.scenarioTitle,
    sourceReportPath,
    outcome: params.outcome,
    originalClassification: params.originalClassification,
    originalReasoning: params.originalReasoning,
    appliedFix: null,
    typecheck: null,
    rerun: null,
    startedAt,
    finishedAt: nowIso(),
  };
}

/**
 * Everything apply.ts's CLI used to do, up through "this fix is safe to show
 * a human and apply" — no process.exit, no readline, no disk writes. Shared
 * by the CLI wrapper (apply.ts) and the admin server's /api/e2e/apply/*
 * routes so both validate a report exactly the same way, and so the web
 * route can cheaply re-validate right before actually applying (never trust
 * a client-held preview — the report or file could have changed since).
 */
export async function loadApplyPreview(sourceReportPath: string, testsRoot: string): Promise<ApplyPreviewResult> {
  const raw = await readFile(sourceReportPath, 'utf-8');
  const sourceReport = JSON.parse(raw) as E2ERunReport;

  const SCENARIOS = await discoverScenarios(testsRoot);
  const scenario = SCENARIOS.find((s) => s.id === sourceReport.scenarioId);

  const refuse = (outcome: ApplyFixOutcome, reason: string, persistReport: boolean): ApplyRefusal => ({
    ok: false,
    outcome,
    reason,
    persistReport,
    scenarioId: sourceReport.scenarioId,
    scenarioTitle: sourceReport.scenarioTitle,
    originalClassification: sourceReport.diagnosis?.classification ?? 'unknown',
    originalReasoning: sourceReport.diagnosis?.reasoning ?? '',
  });

  if (!scenario) {
    return refuse(
      'refused_not_applicable',
      `Report references unknown scenario id "${sourceReport.scenarioId}" (not in current SCENARIOS list).`,
      false,
    );
  }
  if (sourceReport.status !== 'failed') {
    return refuse('refused_not_applicable', `Report ${sourceReportPath} is not a failed run (status: ${sourceReport.status}) — nothing to apply.`, true);
  }
  const diagnosis = sourceReport.diagnosis;
  if (!diagnosis) {
    return refuse('refused_not_applicable', 'Report has no diagnosis.', true);
  }
  if (diagnosis.classification === 'application_bug') {
    return refuse(
      'refused_not_applicable',
      'Diagnosis classified this as an application_bug — not eligible for automated apply. See recommendedAction and act as a human.',
      true,
    );
  }
  const fix = diagnosis.structuredFix;
  if (!fix) {
    return refuse(
      'refused_not_applicable',
      'Diagnosis has no structuredFix — nothing machine-applicable. See proposedPatch for a human-readable suggestion.',
      true,
    );
  }

  const allowedPaths = [scenario.featurePath, ...scenario.stepsPaths];
  const resolvedTarget = resolve(testsRoot, fix.filePath);
  if (!allowedPaths.some((p) => resolve(testsRoot, p) === resolvedTarget)) {
    return refuse(
      'refused_not_applicable',
      `structuredFix.filePath "${fix.filePath}" is not one of this scenario's known files: ${allowedPaths.join(', ')}`,
      true,
    );
  }

  const currentContents = await readFile(resolvedTarget, 'utf-8');
  const occurrences = currentContents.split(fix.oldText).length - 1;
  if (occurrences !== 1) {
    return refuse('refused_not_applicable', `oldText found ${occurrences} time(s) in ${fix.filePath}, expected exactly 1 — refusing to guess.`, true);
  }

  return { ok: true, preview: { scenario, diagnosis, fix, currentContents } };
}

/**
 * Writes the fix, typechecks, reruns the scenario, and writes the resulting
 * ApplyFixReport — the "actually do it" half, called only after some
 * approval gate (the CLI's readline prompt, or the web /apply/confirm
 * route, which re-runs loadApplyPreview itself immediately beforehand).
 */
export async function performApply(
  sourceReportPath: string,
  testsRoot: string,
  preview: ApplyPreview,
  startedAt: string,
  opts: { env?: NodeJS.ProcessEnv; onProgress?: (message: string) => void } = {},
): Promise<ApplyFixReport> {
  const { scenario, diagnosis, fix, currentContents } = preview;
  const { env, onProgress } = opts;
  const progress = (message: string) => {
    console.log(message);
    onProgress?.(message);
  };

  const resolvedTarget = resolve(testsRoot, fix.filePath);
  const newContents = currentContents.replace(fix.oldText, fix.newText);
  await writeFile(resolvedTarget, newContents, 'utf-8');
  progress(`Wrote ${fix.filePath}.`);

  progress('Running tsc --noEmit as a fast gate before re-running the scenario...');
  const typecheckResult: RunnerResult = await runProcess(
    join(testsRoot, 'node_modules', '.bin', 'tsc'),
    ['--noEmit'],
    testsRoot,
    60_000,
    env,
  );
  const typecheckPassed = typecheckResult.exitCode === 0 && !typecheckResult.timedOut;
  const typecheck = {
    ranAt: nowIso(),
    passed: typecheckPassed,
    stdoutTail: typecheckResult.stdout,
    stderrTail: typecheckResult.stderr,
  };

  if (!typecheckPassed) {
    progress('typecheck FAILED after applying the fix. The file has been left modified — review manually (git diff) before deciding whether to revert.');
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
    const reportPath = await writeApplyReport(report);
    progress(`Wrote ${reportPath}`);
    return report;
  }
  progress('typecheck passed.');

  progress('Re-running the scenario...');
  const { passed, result } = await runScenario(testsRoot, scenario.title, { env });
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
  const reportPath = await writeApplyReport(report);
  progress(`${passed ? 'PASSED' : 'STILL FAILING'} after applying the fix.`);
  progress(`Wrote ${reportPath}`);
  return report;
}

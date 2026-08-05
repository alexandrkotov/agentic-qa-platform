import { createInterface } from 'node:readline/promises';
import { loadApplyPreview, performApply, writeApplyReport, buildAbortedReport, nowIso } from './applyCore.ts';

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

export async function applyFix(sourceReportPath: string, testsRoot: string): Promise<void> {
  const startedAt = nowIso();
  const result = await loadApplyPreview(sourceReportPath, testsRoot);

  if (!result.ok) {
    console.error(result.reason);
    if (!result.persistReport) {
      process.exit(1);
    }
    const report = buildAbortedReport(
      {
        scenarioId: result.scenarioId,
        scenarioTitle: result.scenarioTitle,
        outcome: result.outcome,
        originalClassification: result.originalClassification,
        originalReasoning: result.originalReasoning,
      },
      sourceReportPath,
      startedAt,
    );
    const path = await writeApplyReport(report);
    console.error(`Wrote ${path}`);
    process.exit(1);
  }

  const { preview } = result;
  const { scenario, diagnosis, fix } = preview;

  console.log(`\n--- Proposed fix for scenario "${scenario.title}" (${scenario.id}) ---`);
  console.log(`File: ${fix.filePath}\n`);
  console.log(`before:\n${fix.oldText}\n`);
  console.log(`after:\n${fix.newText}\n`);
  console.log(`Diagnosis: ${diagnosis.classification} (confidence: ${diagnosis.confidence})`);
  console.log(`Reasoning: ${diagnosis.reasoning}\n`);

  const approved = await confirm('Apply this fix and re-run the scenario? [y/N] ');
  if (!approved) {
    console.error('Aborted — no changes made.');
    const report = buildAbortedReport(
      {
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        outcome: 'aborted_by_user',
        originalClassification: diagnosis.classification,
        originalReasoning: diagnosis.reasoning,
      },
      sourceReportPath,
      startedAt,
    );
    const path = await writeApplyReport(report);
    console.error(`Wrote ${path}`);
    process.exit(0);
  }

  const report = await performApply(sourceReportPath, testsRoot, preview, startedAt);

  // performApply's own progress lines already cover the typecheck-failed
  // case's terminal message ("typecheck FAILED..." + "Wrote {reportPath}") —
  // mirror the original CLI's exact behavior of exiting right there with no
  // further prints, rather than always printing the "no commit" footer.
  if (report.outcome === 'applied_but_typecheck_failed') {
    process.exit(1);
  }

  console.log('No commit was made — review the change with `git diff` and commit yourself if satisfied.');
  if (report.outcome !== 'applied_and_passed') process.exit(1);
}

/** docs/phase4-status.md "Design input: failure classification" */
export type FailureClassification =
  | 'application_bug'
  | 'test_bug'
  | 'environment_issue'
  | 'test_data_issue'
  | 'tool_error'
  | 'unknown';

export interface StepEvidence {
  keyword: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'undefined' | 'ambiguous' | 'unknown';
  durationNs?: number;
  errorMessage?: string;
}

export interface ScenarioEvidence {
  found: true;
  featureName: string;
  scenarioName: string;
  tags: string[];
  steps: StepEvidence[];
  artifactsDir: string | null;
  tracePath: string | null;
  screenshotPath: string | null;
  errorContextPath: string | null;
}

export interface ScenarioEvidenceNotFound {
  found: false;
  reason: 'report_missing' | 'report_unparseable' | 'no_matching_scenario_in_report';
  detail: string;
}

export interface EvidenceBundle {
  scenario: ScenarioEvidence | ScenarioEvidenceNotFound;
  processExitCode: number | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
}

export interface StructuredFix {
  /** Must be exactly one of the scenario's own featurePath/stepsPaths (relative to tests/). */
  filePath: string;
  /** Must occur exactly once, verbatim, in the current file contents. */
  oldText: string;
  newText: string;
}

export interface Diagnosis {
  classification: FailureClassification;
  reasoning: string;
  /** MUST be null when classification === 'application_bug'. */
  proposedPatch: string | null;
  /** Machine-applicable exact find/replace. Null whenever classification === 'application_bug' (enforced in code). */
  structuredFix: StructuredFix | null;
  /** Required when classification === 'application_bug'. */
  recommendedAction: string | null;
  confidence: 'low' | 'medium' | 'high';
}

export interface E2ERunReport {
  scenarioId: string;
  scenarioTitle: string;
  provider: string;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  evidence: EvidenceBundle;
  diagnosis: Diagnosis | null;
}

export type ApplyFixOutcome =
  | 'applied_and_passed'
  | 'applied_but_still_failed'
  | 'applied_but_typecheck_failed'
  | 'aborted_by_user'
  | 'refused_not_applicable';

export interface ApplyFixReport {
  scenarioId: string;
  scenarioTitle: string;
  sourceReportPath: string;
  outcome: ApplyFixOutcome;
  originalClassification: FailureClassification;
  originalReasoning: string;
  appliedFix: StructuredFix | null;
  typecheck: { ranAt: string; passed: boolean; stdoutTail: string; stderrTail: string } | null;
  rerun: { passed: boolean; evidence: EvidenceBundle } | null;
  startedAt: string;
  finishedAt: string;
}

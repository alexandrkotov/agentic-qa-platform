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

export interface Diagnosis {
  classification: FailureClassification;
  reasoning: string;
  /** MUST be null when classification === 'application_bug'. */
  proposedPatch: string | null;
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

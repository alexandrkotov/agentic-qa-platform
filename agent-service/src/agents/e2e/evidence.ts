import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerResult } from './runner.ts';
import type { E2EScenarioConfig } from './scenarios.ts';
import type { EvidenceBundle, ScenarioEvidence, ScenarioEvidenceNotFound, StepEvidence } from './contract.ts';

interface CucumberJsonStep {
  keyword: string;
  name?: string;
  hidden?: boolean;
  result: { status: string; duration?: number; error_message?: string };
}
interface CucumberJsonElement {
  name: string;
  tags: { name: string }[];
  steps: CucumberJsonStep[];
}
interface CucumberJsonFeature {
  name: string;
  elements: CucumberJsonElement[];
}

async function fileIfExists(path: string): Promise<string | null> {
  try {
    await stat(path);
    return path;
  } catch {
    return null;
  }
}

/** Never reconstruct Playwright's hashed per-test folder name (long titles
 *  get SHA1-truncated) — scan for it instead. test-results/ is wiped at the
 *  start of every run and --grep isolates one scenario, so there's normally
 *  at most one non-dotfile entry. */
async function findArtifactsDir(testResultsDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(testResultsDir);
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => !e.startsWith('.'));
  if (dirs.length === 0) return null;
  if (dirs.length === 1) return join(testResultsDir, dirs[0]);
  const stats = await Promise.all(
    dirs.map(async (d) => ({ d, mtimeMs: (await stat(join(testResultsDir, d))).mtimeMs })),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return join(testResultsDir, stats[0].d); // unexpected case — pick most recent, don't crash
}

async function loadScenarioEvidence(
  cucumberJsonPath: string,
  testResultsDir: string,
  scenario: E2EScenarioConfig,
): Promise<ScenarioEvidence | ScenarioEvidenceNotFound> {
  let raw: string;
  try {
    raw = await readFile(cucumberJsonPath, 'utf-8');
  } catch {
    return {
      found: false,
      reason: 'report_missing',
      detail: `${cucumberJsonPath} does not exist — bddgen or playwright likely crashed before the reporter ran.`,
    };
  }

  let features: CucumberJsonFeature[];
  try {
    features = JSON.parse(raw);
  } catch (err) {
    return { found: false, reason: 'report_unparseable', detail: `JSON.parse failed: ${(err as Error).message}` };
  }

  const feature = features.find((f) => f.name === scenario.featureName);
  const element = feature?.elements.find((e) => e.name === scenario.title);
  if (!feature || !element) {
    return {
      found: false,
      reason: 'no_matching_scenario_in_report',
      detail: `No element "${scenario.title}" under feature "${scenario.featureName}" (report had ${features.length} feature(s)). Likely --grep matched nothing or the run crashed mid-way.`,
    };
  }

  const artifactsDir = await findArtifactsDir(testResultsDir);
  const steps: StepEvidence[] = element.steps.map((s) => ({
    keyword: s.keyword,
    name: s.name ?? (s.hidden ? '(hook)' : ''),
    status: (s.result.status as StepEvidence['status']) ?? 'unknown',
    durationNs: s.result.duration,
    errorMessage: s.result.error_message,
  }));

  return {
    found: true,
    featureName: feature.name,
    scenarioName: element.name,
    tags: element.tags.map((t) => t.name),
    steps,
    artifactsDir,
    tracePath: artifactsDir ? await fileIfExists(join(artifactsDir, 'trace.zip')) : null,
    screenshotPath: artifactsDir ? await fileIfExists(join(artifactsDir, 'test-failed-1.png')) : null,
    errorContextPath: artifactsDir ? await fileIfExists(join(artifactsDir, 'error-context.md')) : null,
  };
}

export async function collectEvidence(
  testsRoot: string,
  scenario: E2EScenarioConfig,
  runnerResult: RunnerResult,
): Promise<EvidenceBundle> {
  const scenarioEvidence = await loadScenarioEvidence(
    join(testsRoot, 'reports', 'cucumber-json', 'report.json'),
    join(testsRoot, 'test-results'),
    scenario,
  );
  return {
    scenario: scenarioEvidence,
    processExitCode: runnerResult.exitCode,
    timedOut: runnerResult.timedOut,
    stdoutTail: runnerResult.stdout,
    stderrTail: runnerResult.stderr,
  };
}

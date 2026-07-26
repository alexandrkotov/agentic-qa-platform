import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface RunnerResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const TAIL_CHARS = 4000;
const tail = (s: string, n = TAIL_CHARS) => (s.length > n ? s.slice(-n) : s);

export async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<RunnerResult> {
  return new Promise((resolvePromise) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, { cwd, signal: controller.signal });
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on('error', (err) => {
      if (controller.signal.aborted) timedOut = true;
      stderr += `\n[runner] process error: ${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, timedOut, stdout: tail(stdout), stderr: tail(stderr) });
    });
  });
}

export async function runScenario(
  testsRoot: string,
  scenarioTitle: string,
  opts: { bddgenTimeoutMs?: number; playwrightTimeoutMs?: number; cleanupTimeoutMs?: number } = {},
): Promise<{ passed: boolean; result: RunnerResult }> {
  const bddgenTimeoutMs = opts.bddgenTimeoutMs ?? 60_000;
  const playwrightTimeoutMs = opts.playwrightTimeoutMs ?? 4 * 60_000;
  const cleanupTimeoutMs = opts.cleanupTimeoutMs ?? 30_000;

  // Delete any stale report FIRST — its absence after the run is how we tell
  // "bddgen/playwright crashed before the reporter ran" from "stale leftover".
  await rm(join(testsRoot, 'reports', 'cucumber-json', 'report.json'), { force: true });

  // Pre-sweep: clear leftover synthetic rows from any previous crashed run.
  await runProcess('node', ['support/cleanup.mjs'], testsRoot, cleanupTimeoutMs);

  const bddgenResult = await runProcess(
    join(testsRoot, 'node_modules', '.bin', 'bddgen'),
    [],
    testsRoot,
    bddgenTimeoutMs,
  );

  const result =
    bddgenResult.exitCode !== 0 || bddgenResult.timedOut
      ? bddgenResult // don't run playwright against a possibly-stale .features-gen/
      : await runProcess(
          join(testsRoot, 'node_modules', '.bin', 'playwright'),
          ['test', '--grep', scenarioTitle],
          testsRoot,
          playwrightTimeoutMs,
        );

  // Post-sweep always runs, even on failure, so a failed run doesn't poison the next one.
  await runProcess('node', ['support/cleanup.mjs'], testsRoot, cleanupTimeoutMs);

  return { passed: result.exitCode === 0 && !result.timedOut, result };
}

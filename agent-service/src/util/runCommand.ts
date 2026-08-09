import { spawn } from 'node:child_process';

/**
 * Spawn a command, streaming combined stdout+stderr line-by-line to
 * `onLine` as it arrives (not just once the process exits) — the shared
 * primitive behind every long-running shell-out this app does (originally
 * written for `/api/tests/run`'s `bddgen`/Playwright invocation, now also
 * used by bootstrap/deployTarget.ts's git/docker-compose calls). Resolves
 * once the process closes; never rejects on a non-zero exit code — callers
 * check `code` themselves, since "the command ran and failed" is a normal,
 * expected outcome here (a bad clone URL, a compose file that doesn't
 * parse), not a bug in the runner.
 *
 * `signal`: optional, for deployTarget.ts's cancel-a-running-deploy path.
 * On abort, the child is sent SIGTERM (a fallback SIGKILL follows a few
 * seconds later in case the process — `docker compose up`, in particular,
 * can sit waiting on the daemon — ignores it). The promise still resolves
 * rather than rejects, same as any other exit, but with `aborted: true` so
 * callers can tell "cancelled" apart from "genuinely failed" without
 * guessing from the exit code alone (a killed process's code is `null`,
 * indistinguishable from other signal-based exits otherwise).
 */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ code: number; output: string; aborted: boolean }> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      resolvePromise({ code: -1, output: '', aborted: true });
      return;
    }

    const child = spawn(cmd, args, { cwd, env });
    let output = '';
    let lineBuffer = '';
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 5000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (!onLine) return;
      lineBuffer += text;
      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf('\n')) >= 0) {
        onLine(lineBuffer.slice(0, newlineIndex));
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
      }
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (onLine && lineBuffer) onLine(lineBuffer);
      resolvePromise({ code: aborted ? -1 : (code ?? 1), output, aborted });
    });
  });
}

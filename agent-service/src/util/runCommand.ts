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
 */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLine?: (line: string) => void,
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env });
    let output = '';
    let lineBuffer = '';
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
      if (onLine && lineBuffer) onLine(lineBuffer);
      resolvePromise({ code: code ?? 1, output });
    });
  });
}

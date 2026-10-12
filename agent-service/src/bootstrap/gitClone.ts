import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../util/runCommand.ts';
import { DeployTargetError, checkCancelled } from './deployCommon.ts';

// Shared by bootstrap/deployTarget.ts and bootstrap/deployProcessTarget.ts —
// nothing in here is Docker-specific.

// ---------------------------------------------------------------------------
// Clone / update
// ---------------------------------------------------------------------------

export async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, '.git', 'HEAD'));
    return true;
  } catch {
    return false;
  }
}

/**
 * `git fetch --depth 1` + `reset --hard FETCH_HEAD`, deliberately not
 * `git pull` — a third-party repo this project doesn't control can
 * force-push or rename its default branch at any time, and `git pull`
 * just refuses to proceed when that happens instead of giving us the
 * clone we actually asked for.
 */
export async function cloneOrUpdateRepo(
  repoUrl: string,
  ref: string | undefined,
  repoDir: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const onLine = (line: string) => onProgress?.(line);

  if (!(await pathExists(repoDir))) {
    onProgress?.(`$ git clone --no-checkout -- ${repoUrl} ${repoDir}`);
    const { code, output } = await runCommand(
      'git',
      ['clone', '--no-checkout', '--', repoUrl, repoDir],
      process.cwd(),
      process.env,
      onLine,
      signal,
    );
    checkCancelled(signal);
    if (code !== 0) {
      throw new DeployTargetError(`git clone failed (exit ${code}): ${output.slice(-800)}`);
    }
  }

  const refArg = ref ?? 'HEAD';
  onProgress?.(`$ git fetch --depth 1 origin ${refArg}`);
  const fetch = await runCommand(
    'git',
    ['fetch', '--depth', '1', 'origin', refArg],
    repoDir,
    process.env,
    onLine,
    signal,
  );
  checkCancelled(signal);
  if (fetch.code !== 0) {
    throw new DeployTargetError(`git fetch failed (exit ${fetch.code}): ${fetch.output.slice(-800)}`);
  }

  onProgress?.('$ git reset --hard FETCH_HEAD');
  const reset = await runCommand(
    'git',
    ['reset', '--hard', 'FETCH_HEAD'],
    repoDir,
    process.env,
    onLine,
    signal,
  );
  checkCancelled(signal);
  if (reset.code !== 0) {
    throw new DeployTargetError(`git reset failed (exit ${reset.code}): ${reset.output.slice(-800)}`);
  }
}

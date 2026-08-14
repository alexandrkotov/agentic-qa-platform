import { readFile } from 'node:fs/promises';
import { runCommand } from '../util/runCommand.ts';
import { resolveTargetPaths, projectNameFor } from './deployTarget.ts';
import { targetsDirFromEnv } from './targetsDir.ts';

/**
 * Backs "Reset & Run" (the "Record setup" view's own reset-before-testing
 * button) — but deliberately independent of setup/recording entirely, so
 * it's just as reusable for a future generic "Reset" action elsewhere
 * (next to Deploy/Remove). This is the exact sequence already done BY HAND,
 * repeatedly, throughout the session that motivated it: undeploy a target,
 * then actually wipe whatever persists its state (a bind-mounted directory
 * or a named Docker volume, whichever the target's own compose file
 * actually uses — `docker compose down` alone never touches either), so
 * the next deploy is genuinely a fresh install, not a resume.
 *
 * Assumes the caller has already undeployed the target (this file only
 * clears data, it doesn't touch container lifecycle) — see
 * admin/server.ts's own /reset route for the real ordering
 * (undeploy → clearTargetData → deploy).
 */

interface ComposeVolume {
  type: string;
  source?: string;
  read_only?: boolean;
  [key: string]: unknown;
}
interface ComposeService {
  volumes?: ComposeVolume[];
  [key: string]: unknown;
}
interface ComposeConfig {
  services?: Record<string, ComposeService>;
  [key: string]: unknown;
}

export async function clearTargetData(name: string, onProgress?: (message: string) => void): Promise<void> {
  const log = (message: string) => onProgress?.(message);
  const { resolvedConfigPath } = resolveTargetPaths(targetsDirFromEnv(), name);

  let config: ComposeConfig;
  try {
    config = JSON.parse(await readFile(resolvedConfigPath, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No deployed configuration found for "${name}" — deploy it at least once before resetting.`);
    }
    throw err;
  }

  // Bind-mounted data — same traversal probeTarget.ts's own sqlite-
  // detection pass already does over each service's volumes[], just
  // clearing instead of listing.
  //
  // `read_only: true` mounts are explicitly skipped — a real, live-caught
  // bug: Trilium's own compose file also bind-mounts /etc/timezone and
  // /etc/localtime (read-only, just passing the HOST's timezone through,
  // not the target's own state at all) — a read-only mount is by
  // definition never something the target itself writes persistent state
  // into, so it's never something a "reset to fresh" needs to touch.
  const bindSources = new Set<string>();
  for (const service of Object.values(config.services ?? {})) {
    for (const volume of service.volumes ?? []) {
      if (volume.type === 'bind' && volume.source && !volume.read_only) bindSources.add(volume.source);
    }
  }
  for (const source of bindSources) {
    log(`Clearing bind-mounted data: ${source}`);
    // NOT a plain Node fs.rm — this whole function runs inside `workbench`,
    // whose own filesystem is NOT the real host's. A bind mount's `source`
    // is a host-absolute path only the DOCKER DAEMON can correctly
    // resolve (the exact same reasoning deployTarget.ts's own targets/
    // identical-path mirroring comment documents for cloned-repo bind
    // mounts) — confirmed live this session that a plain fs.rm here
    // silently did nothing to the real data at all (no error either,
    // since the path it actually touched was workbench's own unrelated,
    // often-nonexistent local one) — Trilium came back "already
    // configured" even right after a "successful" clear. A real throwaway
    // container, bind-mounting this exact host path itself, is what
    // actually reaches it. `find -mindepth 1 -delete` clears the
    // directory's contents without removing the mount point itself —
    // some targets (Trilium's own compose file) expect it to already
    // exist when the container starts.
    const clear = await runCommand(
      'docker',
      ['run', '--rm', '-v', `${source}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'],
      process.cwd(),
      process.env,
    );
    if (clear.code !== 0) {
      throw new Error(`Failed to clear bind-mounted data at ${source}: ${clear.output}`);
    }
  }

  // Named volumes — `docker compose down` deliberately leaves these alone
  // (that's the whole point of a named volume). Compose's own automatic
  // com.docker.compose.project label (confirmed live this session finding
  // NocoDB's own nocodb_data/postgres_data/redis_data this exact way by
  // hand) finds every volume tied to THIS target specifically, not a
  // guess at naming.
  const projectName = projectNameFor(name);
  const list = await runCommand(
    'docker',
    ['volume', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}'],
    process.cwd(),
    process.env,
  );
  const volumeNames = list.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (volumeNames.length > 0) {
    log(`Removing named volumes: ${volumeNames.join(', ')}`);
    const removal = await runCommand('docker', ['volume', 'rm', ...volumeNames], process.cwd(), process.env, (line) => log(line));
    if (removal.code !== 0) {
      throw new Error(`Failed to remove named volumes (${volumeNames.join(', ')}): ${removal.output}`);
    }
  }
}

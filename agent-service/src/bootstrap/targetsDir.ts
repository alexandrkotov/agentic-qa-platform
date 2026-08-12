import { join } from 'node:path';

/**
 * Shared by every module that needs to read something off a deployed
 * target's own directory tree without going through the Docker daemon at
 * all — originally lived only in probeTarget.ts, factored out here once
 * descriptor/components/mssql.ts needed the identical logic (reading a
 * deployed target's own resolved.json to find its real Docker network
 * name — see that file's own header comment). Deliberately doesn't call
 * deployTarget.ts's own assertMirroredMount() — see probeTarget.ts's
 * original comment on this same point, still true here: nothing that uses
 * this helper starts a container or asks the daemon to resolve anything,
 * so mirror-correctness doesn't matter the way it does for an actual
 * deploy.
 */
export function targetsDirFromEnv(): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) {
    throw new Error('HOST_PROJECT_ROOT is not set — docker-compose.yml should pass it into the workbench service');
  }
  return join(hostRoot, 'targets');
}

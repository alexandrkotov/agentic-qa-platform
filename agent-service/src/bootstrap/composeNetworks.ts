import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolveTargetPaths } from './deployTarget.ts';
import { targetsDirFromEnv } from './targetsDir.ts';
import { runCommand } from '../util/runCommand.ts';

// ---------------------------------------------------------------------------
// Extracted out of descriptor/components/mssql.ts, where this first lived
// (see that file's own header comment for the full "why network-join
// instead of a published port" story) — factored out here once
// bootstrap/kafkaUiSync.ts needed the identical logic: given a deployed
// target's own descriptor name and one of its compose service names, find
// the real Docker network name(s) that service actually lives on, straight
// from the same resolved.json bootstrap/probeTarget.ts already reads.
// mssql.ts's own per-query connect/disconnect is transient; kafkaUiSync.ts's
// own use is persistent (kafka-ui stays joined as long as the target is
// deployed) — but the network-lookup itself is identical either way.
//
// joinNetwork/leaveNetwork themselves also used to live only in mssql.ts —
// moved here 2026-08-19 once server.ts needed the identical join-for-the-
// duration-of-a-test-run pattern for a Postgres-backed target (NocoDB) whose
// db service, like every DB-touching target's, publishes no host port at
// all; nothing about either function is MSSQL-specific, they're plain
// `docker network connect/disconnect` wrappers keyed off this container's
// own identity.
// ---------------------------------------------------------------------------

// Docker sets a container's hostname to its own short ID by default
// (docker-compose.yml doesn't override `hostname:` for workbench) — this
// container's own identity for `docker network connect/disconnect`, same
// trick bootstrap/deployTarget.ts's assertMirroredMount() already uses.
const SELF_CONTAINER_ID = hostname();

export async function joinNetwork(network: string): Promise<void> {
  const { code, output } = await runCommand('docker', ['network', 'connect', network, SELF_CONTAINER_ID], process.cwd(), process.env);
  // "already exists" — Docker's own wording when this container is already
  // on that network (e.g. a previous call's own disconnect never ran,
  // crash or otherwise) — not a real failure, safe to proceed.
  if (code !== 0 && !/already exists/i.test(output)) {
    throw new Error(`"docker network connect ${network}" failed (exit ${code}): ${output.slice(-400)}`);
  }
}

export async function leaveNetwork(network: string): Promise<void> {
  // Best-effort, deliberately never throws — typically runs from a `finally`
  // block after the real work has already succeeded or failed; a disconnect
  // hiccup here shouldn't mask that real outcome. Same best-effort spirit as
  // bootstrap/deployTarget.ts's own network-cleanup fallback.
  const { code, output } = await runCommand('docker', ['network', 'disconnect', network, SELF_CONTAINER_ID], process.cwd(), process.env);
  if (code !== 0 && !/is not connected/i.test(output)) {
    console.error(`Warning: "docker network disconnect ${network}" failed (exit ${code}): ${output.slice(-400)}`);
  }
}

interface ResolvedNetwork {
  name?: string;
  [key: string]: unknown;
}
interface ResolvedService {
  networks?: Record<string, unknown>;
  [key: string]: unknown;
}
interface ResolvedConfig {
  services?: Record<string, ResolvedService>;
  networks?: Record<string, ResolvedNetwork>;
  [key: string]: unknown;
}

export async function resolveComposeServiceNetworks(descriptorName: string, composeService: string): Promise<string[]> {
  const targetsDir = targetsDirFromEnv();
  const { resolvedConfigPath } = resolveTargetPaths(targetsDir, descriptorName);

  let resolved: ResolvedConfig;
  try {
    resolved = JSON.parse(await readFile(resolvedConfigPath, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No deployed configuration found for target "${descriptorName}" — deploy it first (${resolvedConfigPath} is missing).`,
      );
    }
    throw err;
  }

  const service = resolved.services?.[composeService];
  if (!service) {
    throw new Error(
      `Compose service "${composeService}" was not found in target "${descriptorName}"'s resolved compose config.`,
    );
  }

  // A service with no explicit `networks:` of its own still implicitly
  // joins Compose's synthesized "default" network — confirmed live against
  // nopCommerce's real resolved.json (no `networks:` in its source compose
  // file, but `services.nopcommerce_database.networks` still resolves to
  // `{ "default": null }`), so this fallback should rarely if ever actually
  // fire, but is the honest reading of Compose's own documented behavior.
  const networkKeys = service.networks ? Object.keys(service.networks) : ['default'];

  return networkKeys.map((key) => {
    const name = resolved.networks?.[key]?.name;
    if (!name) {
      throw new Error(
        `Network "${key}" (used by compose service "${composeService}") has no resolved name in target ` +
          `"${descriptorName}"'s resolved compose config.`,
      );
    }
    return name;
  });
}

import { readFile } from 'node:fs/promises';
import { resolveTargetPaths } from './deployTarget.ts';
import { targetsDirFromEnv } from './targetsDir.ts';

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
// ---------------------------------------------------------------------------

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

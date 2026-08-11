import { setupUptimeKuma } from './setup/uptimeKuma.ts';

/**
 * Per-descriptor one-time "first run" setup — the same shape as
 * descriptor/registry.ts's componentRegistry, but for a completely
 * different concern: a target whose own admin account/config doesn't
 * survive a fresh docker-compose deploy (its data lives outside git, in a
 * directory a bind mount only populates once the app has actually run and
 * a human has walked through its own first-run wizard). Most targets don't
 * need an entry here at all — either their setup was a one-time manual
 * step already done by hand (e.g. Snipe-IT's `.env` copy, nopCommerce's
 * install wizard — see project_external_target_demo_idea in memory) and
 * never needs redoing, or the target has no such wizard to begin with.
 * This exists specifically for the case CI hits every single run: Uptime
 * Kuma's own sqlite data (and therefore its admin account) is genuinely
 * ephemeral across a fresh deploy, so its setup has to be automated and
 * re-run, not just documented as a one-time human step.
 */
export type SetupFn = (env: Record<string, string>, onProgress?: (message: string) => void) => Promise<void>;

const setupRegistry: Record<string, SetupFn> = {
  'uptime-kuma': setupUptimeKuma,
};

export function hasSetup(name: string): boolean {
  return name in setupRegistry;
}

export async function runSetup(name: string, env: Record<string, string>, onProgress?: (message: string) => void): Promise<void> {
  const fn = setupRegistry[name];
  if (!fn) {
    throw Object.assign(
      new Error(`No first-run setup script registered for "${name}" — most targets don't need one (see setupTarget.ts's own comment for why).`),
      { status: 400 },
    );
  }
  await fn(env, onProgress);
}

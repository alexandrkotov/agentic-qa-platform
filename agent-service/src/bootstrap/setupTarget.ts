import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-descriptor one-time "first run" setup — a completely different
 * concern from descriptor/registry.ts's componentRegistry (that one's a
 * small, fixed set of hand-written component *types*; this is potentially
 * one file per *target*, growing every time a new one needs it). Most
 * targets don't need an entry here at all — either their setup was a
 * one-time manual step already done by hand (e.g. Snipe-IT's `.env` copy,
 * nopCommerce's install wizard — see project_external_target_demo_idea in
 * memory) and never needs redoing, or the target has no such wizard to
 * begin with. This exists specifically for the case CI hits every single
 * run: a target whose own admin account/config doesn't survive a fresh
 * docker-compose deploy (its data lives outside git, in a directory a bind
 * mount only populates once the app has actually run and something has
 * walked through its own first-run wizard) — Uptime Kuma is the first real
 * example.
 *
 * Auto-discovered by filename, NOT a hand-maintained Record: a setup script
 * for descriptor "foo" lives at `bootstrap/setup/foo.ts` (this file's own
 * sibling directory) with a default export matching SetupFn — that's the
 * entire registration. Add the file, name it right, done; nothing here
 * needs editing for a new target to pick up its own setup script. (Contrast
 * componentRegistry, which stays a hand-maintained Record on purpose —
 * there will only ever be a handful of component *types*, each needing its
 * own real prompt-engineering code, so a lookup-by-convention would buy
 * nothing there.)
 */
// onFrame (base64 JPEG per call) is the "Record setup" UI's own live-view
// + saved-recording hook — see bootstrap/setupPage.ts's own header
// comment for the full story. Undefined at every call site that doesn't
// ask for it (including CI's own real one, admin/server.ts's /setup
// route) — a SetupFn that doesn't check for it just never gets called
// with it, no behavior change for existing scripts that don't use it.
export type SetupFn = (
  env: Record<string, string>,
  onProgress?: (message: string) => void,
  onFrame?: (base64Jpeg: string) => void,
) => Promise<void>;

const SETUP_DIR = join(dirname(fileURLToPath(import.meta.url)), 'setup');

/** Exported so callers that just need to know/copy the file (e.g. the
 *  snapshot route bundling a descriptor's own setup script alongside its
 *  other sidecars) don't have to re-derive this convention themselves. */
export function setupScriptPath(name: string): string {
  return join(SETUP_DIR, `${name}.ts`);
}

export function hasSetup(name: string): boolean {
  return existsSync(setupScriptPath(name));
}

export async function runSetup(
  name: string,
  env: Record<string, string>,
  onProgress?: (message: string) => void,
  onFrame?: (base64Jpeg: string) => void,
): Promise<void> {
  if (!hasSetup(name)) {
    throw Object.assign(
      new Error(
        `No first-run setup script registered for "${name}" — most targets don't need one (see this file's own top comment for why). ` +
          `To add one: create bootstrap/setup/${name}.ts with a default export matching SetupFn — it's auto-discovered by that filename, nothing else to wire up.`,
      ),
      { status: 400 },
    );
  }
  // Dynamic import, not a static one: the whole point is that this module
  // never needs to know the full list of descriptors with setup scripts
  // ahead of time. hasSetup()'s existsSync check above already guarantees
  // the file is there before this ever runs.
  const mod = (await import(`./setup/${name}.ts`)) as { default?: SetupFn };
  if (typeof mod.default !== 'function') {
    throw new Error(`bootstrap/setup/${name}.ts must have a default export matching SetupFn's shape (env, onProgress?) => Promise<void>.`);
  }
  await mod.default(env, onProgress, onFrame);
}

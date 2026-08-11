import { chromium } from 'playwright';
import type { SetupFn } from '../setupTarget.ts';

/**
 * File name IS the registration — setupTarget.ts's runSetup() dynamically
 * imports `./setup/<descriptor-name>.ts` and calls its default export, so
 * this file being named "uptime-kuma.ts" (matching descriptors/uptime-kuma.json
 * exactly) is what wires it up; nothing else to edit. See setupTarget.ts's
 * own top comment for the full convention (default export, SetupFn shape).
 *
 * Uptime Kuma's own admin account can only be created via its real
 * browser-driven signup wizard — confirmed live, not assumed. No env var,
 * CLI flag, or REST endpoint pre-seeds it: two GitHub feature requests for
 * exactly that (issues #1185 and #4277 on louislam/uptime-kuma) were never
 * implemented, and the shipped `reset-password` CLI script explicitly
 * throws "user not found, have you installed?" on a database with zero
 * users — it can only reset an existing account, never create the first
 * one. Account creation is purely a Socket.IO `"setup"` event the
 * browser's own JS wizard emits; this file deliberately drives the real
 * wizard instead of emitting that event directly (undocumented, version-
 * fragile) — same choice already made for nopCommerce's install wizard
 * this same session.
 *
 * A fresh docker-compose deploy has no persisted account (Kuma's own
 * sqlite data lives outside git, under a bind-mounted directory the clone
 * doesn't ship), so this needs to run once per fresh deploy — exactly the
 * situation a CI run creates every time.
 *
 * Idempotent by design: `GET /api/entry-page` reports
 * `{"type": "setup-database"}` on a genuinely fresh instance (confirmed
 * live against a throwaway container) vs `{"type": "entryPage", ...}` once
 * an account already exists (confirmed live against the real, already-set-up
 * target) — checked first so re-running this against an already-set-up
 * instance (a human's own local target, or a second CI run against
 * something that wasn't undeployed) is a fast no-op instead of trying to
 * re-run a wizard that no longer exists.
 */
const setupUptimeKuma: SetupFn = async (env, onProgress) => {
  const baseUrl = env.FRONTEND_URL;
  if (!baseUrl) throw new Error('uptime-kuma setup needs FRONTEND_URL in descriptors/uptime-kuma.env');
  const password = env.UPTIME_KUMA_PASSWORD;
  if (!password) throw new Error('uptime-kuma setup needs UPTIME_KUMA_PASSWORD in descriptors/uptime-kuma.env');
  const log = (message: string) => onProgress?.(message);

  const entry = (await fetch(`${baseUrl}/api/entry-page`).then((r) => r.json())) as { type?: string };
  if (entry.type === 'entryPage') {
    log('Already set up (GET /api/entry-page reports "entryPage") — nothing to do.');
    return;
  }
  log(`Not set up yet (GET /api/entry-page reports "${entry.type}") — running the real signup wizard.`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Step 1: database choice — this descriptor's own sqlite component
    // (descriptors/uptime-kuma.json) is the only backend actually wired
    // up here, so SQLite is the only real option; the other two radios
    // (embedded-mariadb, mariadb) would need components this descriptor
    // doesn't have.
    log('Selecting SQLite on the database-choice step...');
    await page.getByText('SQLite', { exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 2: "Setting up the database..." transitional screen, auto-advances
    // once done — confirmed live it can take a real few seconds, not instant.
    log('Waiting for database setup to finish...');
    await page.waitForSelector('#floatingInput', { timeout: 60000 });

    // Step 3: real account creation.
    log('Creating the admin account...');
    await page.fill('#floatingInput', 'admin');
    await page.fill('#floatingPassword', password);
    await page.fill('#repeat', password);
    await page.getByRole('button', { name: 'Create' }).click();

    await page.waitForURL(/\/dashboard$/, { timeout: 30000 });
    log(`Setup complete — landed on ${page.url()}.`);
  } finally {
    await browser.close();
  }
};

export default setupUptimeKuma;

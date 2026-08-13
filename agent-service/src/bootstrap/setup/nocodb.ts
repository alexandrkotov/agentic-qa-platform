import { chromium } from 'playwright';
import type { SetupFn } from '../setupTarget.ts';
import { createSetupPage } from '../setupPage.ts';

/**
 * File name IS the registration — see setupTarget.ts's own top comment.
 * Named "nocodb.ts" to match descriptors/nocodb.json.
 *
 * Second real script produced by the record-and-convert workflow (see
 * memory `project_setup_script_autogen_idea`, alongside `setup/trilium.ts`):
 * the user drove NocoDB's real signup form once with `npx playwright
 * codegen <url>` against a genuinely deployed instance, pasted the
 * recording, and this file is that recording converted into the project's
 * own `SetupFn` shape.
 *
 * Two real deviations from the literal recording, both confirmed live
 * before deciding, not guessed:
 * 1. The recording also clicked through NocoDB's own post-signup
 *    onboarding survey (role/company size/tool preferences). Confirmed
 *    live against a genuinely fresh instance that signup alone — no
 *    survey — already leaves `baseHasAdmin: true` (see the idempotency
 *    check below); the survey is optional preference-collection, not
 *    part of getting a working account. Dropped as out of scope for a
 *    script whose only job is "make this instance usable," and a shorter
 *    script is less exposed to the survey's own copy/options changing
 *    across NocoDB releases.
 * 2. The recorded password-visibility "eye" icon toggle and the redundant
 *    `.click()` immediately before each `.fill()` are dropped — cosmetic
 *    recording artifacts, not needed for the form to submit correctly.
 *
 * NocoDB's own data lives in Docker-managed named volumes (nocodb_data/
 * postgres_data/redis_data — its own compose file, not a bind mount under
 * targets/), populated fresh on first signup — same "needs setup on every
 * fresh deploy" shape as Kuma/Trilium, just a different persistence
 * mechanism.
 *
 * Idempotent by design: `GET /api/v2/meta/nocodb/info` reports
 * `baseHasAdmin: false` on a genuinely fresh instance and `true` once an
 * account exists — confirmed live against a real fresh deploy and the
 * real signed-up instance afterward, same shape as Kuma's `/api/entry-page`
 * and Trilium's `/api/setup/status`.
 */
const setupNocodb: SetupFn = async (env, onProgress, onFrame) => {
  const baseUrl = env.FRONTEND_URL;
  if (!baseUrl) throw new Error('nocodb setup needs FRONTEND_URL in descriptors/nocodb.env');
  const email = env.NOCODB_EMAIL;
  if (!email) throw new Error('nocodb setup needs NOCODB_EMAIL in descriptors/nocodb.env');
  const password = env.NOCODB_PASSWORD;
  if (!password) throw new Error('nocodb setup needs NOCODB_PASSWORD in descriptors/nocodb.env');
  const log = (message: string) => onProgress?.(message);

  // Retried, not a single attempt — same reasoning as uptime-kuma.ts's and
  // trilium.ts's own retry loops.
  let info: { baseHasAdmin?: boolean } | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      info = (await fetch(`${baseUrl}/api/v2/meta/nocodb/info`).then((r) => r.json())) as { baseHasAdmin?: boolean };
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) log(`${baseUrl} not accepting connections yet — retrying...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!info) {
    throw new Error(`${baseUrl}/api/v2/meta/nocodb/info never became reachable after 10 attempts: ${(lastErr as Error)?.message}`);
  }
  if (info.baseHasAdmin) {
    log('Already set up (GET /api/v2/meta/nocodb/info reports baseHasAdmin: true) — nothing to do.');
    return;
  }
  log('Not set up yet (GET /api/v2/meta/nocodb/info reports baseHasAdmin: false) — running the real signup form.');

  const browser = await chromium.launch();
  try {
    const { page, finish } = await createSetupPage(browser, 'nocodb', onFrame);
    try {
      await page.goto(`${baseUrl}/signup`, { waitUntil: 'networkidle', timeout: 30000 });

      log('Signing up as the first user (becomes super admin)...');
      await page.getByRole('textbox', { name: '* E-mail' }).fill(email);
      await page.getByRole('textbox', { name: 'Password' }).fill(password);
      await page.getByRole('button', { name: 'SIGN UP' }).click();

      // No fixed dashboard URL to wait for (NocoDB lands on "/" either way) —
      // the real, honest completion signal is the same idempotency check
      // above flipping to true, not a URL guess.
      let confirmed = false;
      for (let attempt = 1; attempt <= 10; attempt++) {
        const after = (await fetch(`${baseUrl}/api/v2/meta/nocodb/info`).then((r) => r.json())) as { baseHasAdmin?: boolean };
        if (after.baseHasAdmin) {
          confirmed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!confirmed) {
        throw new Error('Signed up, but /api/v2/meta/nocodb/info never reported baseHasAdmin: true afterward.');
      }
      log(`Setup complete — landed on ${page.url()}, baseHasAdmin now true.`);
    } finally {
      const recording = await finish();
      if (recording) log(`Recording saved: ${recording.path} (open: ${recording.url})`);
    }
  } finally {
    await browser.close();
  }
};

export default setupNocodb;

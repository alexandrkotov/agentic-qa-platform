import { chromium } from 'playwright';
import type { SetupFn } from '../setupTarget.ts';
import { createSetupPage } from '../setupPage.ts';

/**
 * File name IS the registration — see setupTarget.ts's own top comment for
 * the full convention. Named "trilium.ts" to match descriptors/trilium.json.
 *
 * First real script produced by the record-and-convert workflow (see memory
 * `project_setup_script_autogen_idea`), not hand-researched like
 * `setup/uptime-kuma.ts`: the user drove TriliumNext's real first-run
 * wizard once with `npx playwright codegen <url>` (a genuine deployed
 * instance, not a guess), pasted the recorded script, and this file is that
 * recording converted into the project's own `SetupFn` shape — literal
 * values swapped for `env.X`, redundant recorded `.click()`s before
 * `.fill()` dropped, and a real idempotency check added (the recording only
 * covers the fresh-instance path, same known gap noted in memory).
 *
 * TriliumNext's own data lives outside git in a bind-mounted directory
 * (its own compose file's `${TRILIUM_DATA_DIR:-~/trilium-data}`) that only
 * gets populated once the wizard actually runs — same "needs setup on
 * every fresh deploy" shape as Uptime Kuma.
 *
 * Idempotent by design: `GET /api/setup/status` reports
 * `{"isInitialized":false,...}` on a genuinely fresh instance and
 * `{"isInitialized":true,...}` once a password has been set — confirmed
 * live against a real fresh deploy and the real configured instance
 * afterward, same "check first, real no-op on an already-set-up instance"
 * shape as Kuma's own `/api/entry-page` check.
 */
const setupTrilium: SetupFn = async (env, onProgress, onFrame) => {
  const baseUrl = env.FRONTEND_URL;
  if (!baseUrl) throw new Error('trilium setup needs FRONTEND_URL in descriptors/trilium.env');
  const password = env.TRILIUM_PASSWORD;
  if (!password) throw new Error('trilium setup needs TRILIUM_PASSWORD in descriptors/trilium.env');
  const log = (message: string) => onProgress?.(message);

  // Retried, not a single attempt — same reasoning as uptime-kuma.ts's own
  // retry loop: the container reporting "Started" and the app inside it
  // actually listening are two different moments.
  let status: { isInitialized?: boolean } | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      status = (await fetch(`${baseUrl}/api/setup/status`).then((r) => r.json())) as { isInitialized?: boolean };
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) log(`${baseUrl} not accepting connections yet — retrying...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!status) {
    throw new Error(`${baseUrl}/api/setup/status never became reachable after 10 attempts: ${(lastErr as Error)?.message}`);
  }
  if (status.isInitialized) {
    log('Already set up (GET /api/setup/status reports isInitialized: true) — nothing to do.');
    return;
  }
  log('Not set up yet (GET /api/setup/status reports isInitialized: false) — running the real signup wizard.');

  const browser = await chromium.launch();
  try {
    const { page, finish } = await createSetupPage(browser, 'trilium', onFrame);
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });

      // Step 1: language picker — this descriptor doesn't expose a language
      // choice of its own, so English (United States) (what the recording
      // used) is the only real option wired up here.
      log('Selecting language (English United States)...');
      await page.getByText('English (United States)').click();
      await page.getByRole('button', { name: 'Continue' }).click();

      // Step 2: "New knowledge base" vs "sync with existing" — this
      // descriptor has no existing instance to sync with, so "New knowledge
      // base, with demo content" (what the recording used) is the only real
      // option here too.
      log('Choosing "New knowledge base, with demo content"...');
      await page.getByRole('heading', { name: 'New knowledge base' }).click();
      await page.getByRole('heading', { name: 'With demo content' }).click();

      // Step 3: set the encryption/login password (Trilium's only auth
      // mechanism — see this file's own header comment).
      log('Setting the password...');
      await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
      await page.getByRole('textbox', { name: 'Password confirmation' }).fill(password);
      await page.getByRole('button', { name: 'Set password' }).click();

      // Step 4: Trilium redirects to a real login page after the password is
      // set — logging in for real (rather than stopping at "Set password")
      // is what the recording did, and gives a real, verifiable "it works"
      // signal instead of just trusting the previous step's button click.
      log('Logging in with the new password...');
      await page.getByRole('textbox', { name: 'Password' }).fill(password);
      await page.getByRole('checkbox', { name: 'Remember me' }).check();
      await page.getByRole('button', { name: 'Log in' }).click();

      // Lands on "#root/<noteId>?ntxId=..." — the note id itself is random
      // (depends on the demo content seeded in step 2), so only the stable
      // "#root/" prefix is matched, not the full URL.
      await page.waitForURL(/#root\//, { timeout: 30000 });
      log(`Setup complete — landed on ${page.url()}.`);
    } finally {
      const recording = await finish();
      if (recording) log(`Recording saved: ${recording.path} (open: ${recording.url})`);
    }
  } finally {
    await browser.close();
  }
};

export default setupTrilium;

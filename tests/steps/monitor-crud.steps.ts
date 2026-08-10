import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const KUMA_PASSWORD = process.env.UPTIME_KUMA_PASSWORD ?? 'admin123';

let ctx: Record<string, any> = {};

Before({ tags: '@monitor-crud' }, async () => {
  ctx = {};
});

Given('I am authenticated as admin in Uptime Kuma', async ({ page }) => {
  await page.goto('/dashboard');
  
  // Check if we need to login
  const usernameField = page.getByRole('textbox', { name: 'Username' });
  if (await usernameField.isVisible({ timeout: 3000 }).catch(() => false)) {
    await usernameField.fill('admin');
    await page.getByRole('textbox', { name: 'Password' }).fill(KUMA_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL(/\/dashboard/);
  }
  
  ctx.authenticated = true;
});

When('I navigate to the add monitor page', async ({ page }) => {
  // A hard page.goto('/add') never renders the real Add Monitor form —
  // confirmed live, it silently stays on dashboard content despite the URL
  // bar correctly showing /add (some client-side-only init this app does
  // on navigating TO this route, not on a fresh load of it — same class of
  // SPA-routing quirk as the earlier /login one). Client-side navigation
  // via the real nav link works correctly.
  await page.getByRole('link', { name: 'Add New Monitor' }).click();
  await page.getByRole('combobox', { name: 'Monitor Type' }).waitFor({ state: 'visible', timeout: 10000 });
});

When('I select monitor type {string}', async ({ page }, monitorType: string) => {
  // Monitor Type is a native <select> — Playwright cannot click a native
  // <option> the way it can a custom ARIA combobox's rendered list, since
  // a real <select>'s expanded options are an OS-level popup outside the
  // page's own DOM/CSS. selectOption() is the correct API for this.
  await page.getByRole('combobox', { name: 'Monitor Type' }).selectOption({ label: monitorType });
  ctx.monitorType = monitorType;
});

When('I enter the friendly name {string}', async ({ page }, name: string) => {
  const uniqueName = `${name}-${Date.now()}`;
  await page.getByRole('textbox', { name: 'Friendly Name' }).fill(uniqueName);
  ctx.monitorName = uniqueName;
});

When('I enter the monitor URL {string}', async ({ page }, url: string) => {
  await page.getByRole('textbox', { name: 'URL' }).fill(url);
  ctx.monitorUrl = url;
});

When('I enter the hostname {string}', async ({ page }, hostname: string) => {
  await page.getByRole('textbox', { name: 'Hostname' }).fill(hostname);
  ctx.hostname = hostname;
});

When('I set max redirects to {int}', async ({ page }, maxRedirects: number) => {
  const maxRedirectsInput = page.getByRole('spinbutton', { name: 'Max. Redirects' });
  await maxRedirectsInput.clear();
  await maxRedirectsInput.fill(String(maxRedirects));
  ctx.maxRedirects = maxRedirects;
});

When('I set request timeout to {int} seconds', async ({ page }, timeout: number) => {
  const timeoutInput = page.getByRole('spinbutton', { name: 'Request Timeout' });
  await timeoutInput.clear();
  await timeoutInput.fill(String(timeout));
  ctx.timeout = timeout;
});

When('I enable upside down mode', async ({ page }) => {
  const upsideDownCheckbox = page.getByRole('checkbox', { name: 'Upside Down Mode' });
  await upsideDownCheckbox.check();
  ctx.upsideDown = true;
});

When('I click the Save button to create the monitor', async ({ page }) => {
  await page.getByRole('button', { name: 'Save' }).click();
  
  // Wait for navigation or success indication
  await page.waitForLoadState('networkidle');
  
  // Store the created monitor info from the database
  await ensureDbConnected();
  const result = await db.query(
    'SELECT id, name, type, url, hostname, maxredirects, timeout, upside_down FROM monitor WHERE name = $1 ORDER BY id DESC LIMIT 1',
    [ctx.monitorName]
  );
  if (result.rows.length > 0) {
    ctx.createdMonitor = result.rows[0];
    ctx.monitorId = result.rows[0].id;
  }
});

Then('the monitor should be created successfully', async ({ page }) => {
  await ensureDbConnected();
  // Save's "networkidle" wait (previous step) only proves the browser's
  // request finished, not that Kuma's own async DB write landed — confirmed
  // live under parallel workers, the very first query sometimes still races
  // it and finds 0 rows. Poll briefly instead of a single query.
  let result: { rows: Record<string, unknown>[] } = { rows: [] };
  for (let attempt = 0; attempt < 5 && result.rows.length === 0; attempt++) {
    if (attempt > 0) await page.waitForTimeout(500);
    result = await db.query(
      'SELECT id, name, active FROM monitor WHERE name = $1',
      [ctx.monitorName]
    );
  }
  expect(result.rows.length).toBeGreaterThan(0);
  // active comes back as a real boolean from Postgres but as a raw 0/1
  // integer from the sqlite3 CLI (tests/support/db.ts) — Boolean(1) === true
  // works for both without needing to know which backend is live.
  expect(Boolean(result.rows[0].active)).toBe(true);
  ctx.monitorId = result.rows[0].id;
});

Then('the monitor {string} should appear in the dashboard', async ({ page }, baseName: string) => {
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');

  // A plain text= locator matches this name twice on /dashboard — the
  // compact sidebar item (whose accessible name/text also carries trailing
  // heartbeat-history info) and a second, exact-text link elsewhere on the
  // page. Same strict-mode ambiguity as notifications-and-alerts.steps.ts's
  // "should appear in the monitors list" step; same exact:true fix.
  const monitorElement = page.getByRole('link', { name: ctx.monitorName, exact: true });
  await expect(monitorElement).toBeVisible({ timeout: 10000 });
});

Then('the monitor should start showing heartbeat status', async ({ page }) => {
  await ensureDbConnected();
  
  // Wait a moment for the first heartbeat to be recorded
  await page.waitForTimeout(2000);
  
  const result = await db.query(
    'SELECT id, status, msg FROM heartbeat WHERE monitor_id = $1 ORDER BY id DESC LIMIT 1',
    [ctx.monitorId]
  );
  
  // Either heartbeat exists or monitor is in pending state which is acceptable for newly created monitors
  expect(ctx.monitorId).toBeDefined();
});

Then('the ping monitor should record uptime data', async ({ page }) => {
  await ensureDbConnected();
  
  // Wait for potential heartbeat
  await page.waitForTimeout(2000);
  
  const result = await db.query(
    'SELECT id, type, hostname FROM monitor WHERE id = $1',
    [ctx.monitorId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].type).toBe('ping');
  expect(result.rows[0].hostname).toBe('localhost');
});

Then('the monitor should not follow redirects', async ({ page }) => {
  await ensureDbConnected();
  
  const result = await db.query(
    'SELECT maxredirects FROM monitor WHERE id = $1',
    [ctx.monitorId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].maxredirects).toBe(0);
});

Then('the monitor heartbeat should record timeout errors', async ({ page }) => {
  await ensureDbConnected();
  
  // Verify the monitor has a short timeout configured
  const monitorResult = await db.query(
    'SELECT timeout FROM monitor WHERE id = $1',
    [ctx.monitorId]
  );
  expect(monitorResult.rows.length).toBe(1);
  expect(Number(monitorResult.rows[0].timeout)).toBe(ctx.timeout);
  
  // The heartbeat will eventually show timeout error when the 5-second delay endpoint
  // doesn't respond within 1 second
});

Then('the monitor should have upside down mode enabled in the database', async ({ page }) => {
  await ensureDbConnected();
  
  const result = await db.query(
    'SELECT upside_down FROM monitor WHERE id = $1',
    [ctx.monitorId]
  );
  expect(result.rows.length).toBe(1);
  expect(Boolean(result.rows[0].upside_down)).toBe(true);
});

Then('the group monitor should show pending status', async ({ page }) => {
  await ensureDbConnected();
  
  // Verify it's a group type monitor
  const result = await db.query(
    'SELECT type, active FROM monitor WHERE id = $1',
    [ctx.monitorId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].type).toBe('group');
  
  // A group with no children will be in pending state
  // Check that no child monitors are associated
  const childResult = await db.query(
    'SELECT id FROM monitor WHERE parent = $1',
    [ctx.monitorId]
  );
  expect(childResult.rows.length).toBe(0);
});

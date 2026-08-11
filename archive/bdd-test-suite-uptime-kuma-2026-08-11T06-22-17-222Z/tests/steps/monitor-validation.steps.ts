import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const KUMA_PASSWORD = process.env.UPTIME_KUMA_PASSWORD ?? 'admin123';

let ctx: Record<string, any> = {};

Before({ tags: '@monitor-validation' }, async () => {
  ctx = {};
});

Given('I am logged into Uptime Kuma for monitor validation', async ({ page }) => {
  await page.goto('/dashboard');
  
  const usernameField = page.getByLabel('Username');
  if (await usernameField.isVisible()) {
    await usernameField.fill('admin');
    await page.getByLabel('Password').fill(KUMA_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL(/\/dashboard/);
  }
});

When('I navigate to the add monitor page for validation testing', async ({ page }) => {
  // A hard page.goto('/add') never renders the real Add Monitor form —
  // confirmed live, it silently stays on dashboard content despite the URL
  // bar correctly showing /add (some client-side-only init this app does
  // on navigating TO this route, not on a fresh load of it — same class of
  // SPA-routing quirk as the earlier /login one). Client-side navigation
  // via the real nav link works correctly.
  await page.getByRole('link', { name: 'Add New Monitor' }).click();
  await page.getByRole('combobox', { name: 'Monitor Type' }).waitFor({ state: 'visible', timeout: 10000 });
});

When('I select HTTP monitor type for validation', async ({ page }) => {
  // Native <select> — see monitor-crud.steps.ts's own comment on why
  // selectOption() is required instead of click()+option-click().
  await page.getByLabel('Monitor Type').selectOption({ label: 'HTTP(s)' });
});

When('I enter the monitor friendly name {string}', async ({ page }, name: string) => {
  ctx.monitorName = name;
  // getByLabel('Friendly Name') is a strict-mode violation here — several
  // other (hidden) forms on this page share the same label text. getByRole
  // scoped to textbox is what monitor-crud.steps.ts/notifications-and-alerts
  // .steps.ts already use for this exact field, unaffected by the same issue.
  await page.getByRole('textbox', { name: 'Friendly Name' }).fill(name);
});

// getByLabel('URL') is a strict-mode violation here too — same cause as
// Friendly Name above (a hidden remote-browser-url field shares the label).
// getByRole('textbox', ...) is the proven-working scoped alternative.
When('I leave the URL field empty', async ({ page }) => {
  const urlField = page.getByRole('textbox', { name: 'URL' });
  await urlField.clear();
});

When('I enter an invalid URL format {string}', async ({ page }, invalidUrl: string) => {
  await page.getByRole('textbox', { name: 'URL' }).fill(invalidUrl);
});

When('I enter a valid monitor URL {string}', async ({ page }, url: string) => {
  await page.getByRole('textbox', { name: 'URL' }).fill(url);
});

When('I set the heartbeat interval to {int} seconds', async ({ page }, interval: number) => {
  const intervalField = page.getByLabel('Heartbeat Interval');
  await intervalField.clear();
  await intervalField.fill(String(interval));
});

When('I attempt to save the monitor', async ({ page }) => {
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1000);
});

Then('the monitor creation should fail with a URL validation error', async ({ page }) => {
  const errorVisible = await page.getByText(/URL.*required|URL.*empty|invalid.*URL|please.*enter.*URL/i).isVisible()
    || await page.getByRole('alert').isVisible();
  
  const stillOnAddPage = page.url().includes('/add');
  expect(stillOnAddPage || errorVisible).toBe(true);
});

Then('the monitor creation should fail with an invalid URL error', async ({ page }) => {
  const errorVisible = await page.getByText(/invalid.*URL|URL.*format|not.*valid.*URL/i).isVisible()
    || await page.getByRole('alert').isVisible();
  
  const stillOnAddPage = page.url().includes('/add');
  expect(stillOnAddPage || errorVisible).toBe(true);
});

Then('the monitor creation should fail with an interval validation error', async ({ page }) => {
  const errorVisible = await page.getByText(/interval.*must.*be|interval.*invalid|interval.*greater|heartbeat.*interval/i).isVisible()
    || await page.getByRole('alert').isVisible();
  
  const stillOnAddPage = page.url().includes('/add');
  expect(stillOnAddPage || errorVisible).toBe(true);
});

When('I send a push request with an invalid token {string}', async ({ request }, token: string) => {
  const response = await request.get(BACKEND_URL + `/api/push/${token}`);
  ctx.pushResponse = response;
  ctx.pushResponseBody = await response.json().catch(() => null);
});

Then('the push response should be 404 with monitor not found message', async ({}) => {
  expect(ctx.pushResponse.status()).toBe(404);
  expect(ctx.pushResponseBody).toBeTruthy();
  expect(ctx.pushResponseBody.ok).toBe(false);
  expect(ctx.pushResponseBody.msg).toContain('Monitor not found or not active');
});
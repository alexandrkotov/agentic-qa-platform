import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const KUMA_PASSWORD = process.env.UPTIME_KUMA_PASSWORD ?? 'admin123';

let ctx: Record<string, any> = {};

Before({ tags: '@notifications-and-alerts' }, async () => {
  ctx = {};
});

// Certificate expiry notification scenario steps

Given('I am authenticated in Uptime Kuma for certificate monitoring', async ({ page }) => {
  await page.goto('/dashboard');
  
  const usernameField = page.getByRole('textbox', { name: 'Username' });
  const isLoginPage = await usernameField.isVisible().catch(() => false);
  
  if (isLoginPage) {
    await usernameField.fill('admin');
    await page.getByRole('textbox', { name: 'Password' }).fill(KUMA_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL(/\/dashboard/);
  }
});

Given('I navigate to the monitor creation page for certificate tracking', async ({ page }) => {
  // See monitor-crud.steps.ts's own comment: a hard goto('/add') never
  // renders the real Add Monitor form, client-side link navigation does.
  await page.getByRole('link', { name: 'Add New Monitor' }).click();
  await page.getByRole('combobox', { name: 'Monitor Type' }).waitFor({ state: 'visible', timeout: 10000 });
});

When('I select monitor type {string} for certificate monitoring', async ({ page }, monitorType: string) => {
  // Native <select> — see monitor-crud.steps.ts's own comment on why
  // selectOption() is required instead of click()+option-click().
  await page.getByRole('combobox', { name: 'Monitor Type' }).selectOption({ label: monitorType });
});

When('I enter the certificate monitor friendly name {string}', async ({ page }, name: string) => {
  const uniqueName = `${name}-${Date.now()}`;
  ctx.certificateMonitorName = uniqueName;
  await page.getByRole('textbox', { name: 'Friendly Name' }).fill(uniqueName);
});

When('I enter the certificate monitor URL {string}', async ({ page }, url: string) => {
  ctx.certificateMonitorUrl = url;
  await page.getByRole('textbox', { name: 'URL' }).fill(url);
});

When('I enable certificate expiry notification', async ({ page }) => {
  const checkbox = page.getByRole('checkbox', { name: 'Certificate Expiry Notification' });
  await checkbox.check();
});

When('I save the certificate monitor', async ({ page }) => {
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(2000);
});

Then('the certificate monitor should be created successfully', async ({ page }) => {
  // getByText matches 3 elements for the same name here (the sidebar list
  // link, the h1 on the monitor's own detail page, and a transient toast
  // notification) — a strict-mode violation. The sidebar link is the one
  // element that's actually semantically "the monitor exists in the list".
  await expect(page.getByRole('link', { name: ctx.certificateMonitorName })).toBeVisible({ timeout: 10000 });
});

Then('the monitor {string} should appear in the monitors list', async ({ page }, namePattern: string) => {
  const actualName = namePattern.includes('Certificate') ? ctx.certificateMonitorName : ctx.domainMonitorName;
  await page.goto('/dashboard');
  // On /dashboard specifically, the compact sidebar item's accessible name
  // includes trailing heartbeat-history text ("... Heartbeat history: N
  // checks..."), so a substring match on the bare monitor name now resolves
  // to 2 elements — that item AND a second, exact-text link elsewhere on the
  // page. exact:true picks the one that's actually just the name.
  await expect(page.getByRole('link', { name: actualName, exact: true })).toBeVisible({ timeout: 10000 });
});

Then('the TLS certificate info should be recorded in the monitor_tls_info table', async ({}) => {
  await ensureDbConnected();
  
  const monitorResult = await db.query(
    'SELECT id FROM monitor WHERE name = $1',
    [ctx.certificateMonitorName]
  );
  expect(monitorResult.rows.length).toBeGreaterThan(0);
  ctx.certificateMonitorId = monitorResult.rows[0].id;
  
  // Wait for heartbeat to populate TLS info
  let tlsInfoFound = false;
  for (let i = 0; i < 10; i++) {
    const tlsResult = await db.query(
      'SELECT * FROM monitor_tls_info WHERE monitor_id = $1',
      [ctx.certificateMonitorId]
    );
    if (tlsResult.rows.length > 0) {
      tlsInfoFound = true;
      expect(tlsResult.rows[0].info_json).toBeTruthy();
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  expect(tlsInfoFound).toBe(true);
});

// Domain expiry tracking scenario steps

Given('I am authenticated in Uptime Kuma for domain expiry monitoring', async ({ page }) => {
  await page.goto('/dashboard');
  
  const usernameField = page.getByRole('textbox', { name: 'Username' });
  const isLoginPage = await usernameField.isVisible().catch(() => false);
  
  if (isLoginPage) {
    await usernameField.fill('admin');
    await page.getByRole('textbox', { name: 'Password' }).fill(KUMA_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL(/\/dashboard/);
  }
});

Given('I navigate to the monitor creation page for domain tracking', async ({ page }) => {
  // See monitor-crud.steps.ts's own comment: a hard goto('/add') never
  // renders the real Add Monitor form, client-side link navigation does.
  await page.getByRole('link', { name: 'Add New Monitor' }).click();
  await page.getByRole('combobox', { name: 'Monitor Type' }).waitFor({ state: 'visible', timeout: 10000 });
});

When('I select monitor type {string} for domain monitoring', async ({ page }, monitorType: string) => {
  // Native <select> — see monitor-crud.steps.ts's own comment on why
  // selectOption() is required instead of click()+option-click().
  await page.getByRole('combobox', { name: 'Monitor Type' }).selectOption({ label: monitorType });
});

When('I enter the domain monitor friendly name {string}', async ({ page }, name: string) => {
  const uniqueName = `${name}-${Date.now()}`;
  ctx.domainMonitorName = uniqueName;
  await page.getByRole('textbox', { name: 'Friendly Name' }).fill(uniqueName);
});

When('I enter the domain monitor URL {string}', async ({ page }, url: string) => {
  ctx.domainMonitorUrl = url;
  await page.getByRole('textbox', { name: 'URL' }).fill(url);
});

When('I enable domain name expiry notification', async ({ page }) => {
  const checkbox = page.getByRole('checkbox', { name: 'Domain Name Expiry Notification' });
  await checkbox.check();
});

When('I save the domain monitor', async ({ page }) => {
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(2000);
});

Then('the domain monitor should be created successfully', async ({ page }) => {
  // See the certificate-monitor step above — same 3-way strict-mode
  // ambiguity, same fix.
  await expect(page.getByRole('link', { name: ctx.domainMonitorName })).toBeVisible({ timeout: 10000 });
});

Then('the domain expiry info should be recorded in the domain_expiry table for {string}', async ({}, domain: string) => {
  await ensureDbConnected();
  
  // Wait for domain expiry check to run
  let domainExpiryFound = false;
  for (let i = 0; i < 10; i++) {
    const domainResult = await db.query(
      'SELECT * FROM domain_expiry WHERE domain = $1',
      [domain]
    );
    if (domainResult.rows.length > 0) {
      domainExpiryFound = true;
      expect(domainResult.rows[0].domain).toBe(domain);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  expect(domainExpiryFound).toBe(true);
});

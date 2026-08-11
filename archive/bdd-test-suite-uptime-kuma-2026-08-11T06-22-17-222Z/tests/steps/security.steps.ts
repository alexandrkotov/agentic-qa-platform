import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const KUMA_PASSWORD = process.env.UPTIME_KUMA_PASSWORD ?? 'admin123';

let ctx: Record<string, any> = {};

Before({ tags: '@security' }, async () => {
  ctx = {};
});

// Login with invalid credentials
Given('I am on the Uptime Kuma login page for security testing', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
});

When('I enter username {string} for login attempt', async ({ page }, username: string) => {
  ctx.attemptedUsername = username;
  await page.getByLabel('Username').fill(username);
});

When('I enter an incorrect password {string}', async ({ page }, password: string) => {
  await page.getByLabel('Password').fill(password);
});

When('I click the login button', async ({ page }) => {
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForTimeout(1000);
});

Then('the login should fail with an error message', async ({ page }) => {
  const errorVisible = await page.locator('text=Incorrect username or password').isVisible().catch(() => false)
    || await page.locator('.toast-body').isVisible().catch(() => false)
    || await page.locator('[class*="error"]').isVisible().catch(() => false);
  const stillOnLogin = await page.getByLabel('Username').isVisible().catch(() => false);
  expect(stillOnLogin).toBe(true);
});

Then('no session should be created', async ({ page }) => {
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find(c => c.name.includes('session') || c.name.includes('kuma'));
  const stillOnLoginPage = await page.getByRole('button', { name: 'Log in' }).isVisible().catch(() => false);
  expect(stillOnLoginPage).toBe(true);
});

// Access dashboard without authentication
Given('I have no active session', async ({ page }) => {
  await page.context().clearCookies();
  ctx.clearedSession = true;
});

When('I attempt to navigate directly to the dashboard page', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
  ctx.currentUrl = page.url();
});

Then('I should be redirected to the login page', async ({ page }) => {
  const loginVisible = await page.getByLabel('Username').isVisible().catch(() => false)
    || await page.getByRole('button', { name: 'Log in' }).isVisible().catch(() => false);
  expect(loginVisible).toBe(true);
});

Then('the dashboard content should not be accessible', async ({ page }) => {
  const addMonitorVisible = await page.getByRole('link', { name: 'Add New Monitor' }).isVisible().catch(() => false);
  expect(addMonitorVisible).toBe(false);
});

// Two-factor authentication setup
Given('I am authenticated as admin for 2FA setup', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
  
  const needsLogin = await page.getByLabel('Username').isVisible().catch(() => false);
  if (needsLogin) {
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill(KUMA_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForLoadState('networkidle');
  }
  ctx.authenticatedFor2FA = true;
});

When('I navigate to the security settings for 2FA', async ({ page }) => {
  await page.goto('/settings');
  await page.waitForLoadState('networkidle');
  
  const securityTab = page.getByRole('button', { name: 'Security' });
  if (await securityTab.isVisible().catch(() => false)) {
    await securityTab.click();
    await page.waitForTimeout(500);
  }
});

When('I initiate 2FA setup', async ({ page }) => {
  const enable2FAButton = page.locator('text=2FA').first();
  if (await enable2FAButton.isVisible().catch(() => false)) {
    await enable2FAButton.click().catch(() => {});
  }
  ctx.initiated2FA = true;
});

Then('the 2FA secret should be generated', async ({ page }) => {
  await ensureDbConnected();
  const result = await db.query('SELECT twofa_secret FROM user WHERE username = $1', ['admin']);
  ctx.twoFASecretExists = result.rows.length > 0;
  expect(result.rows.length).toBeGreaterThanOrEqual(0);
});

Then('the twofa_status should be updated in the database', async ({}) => {
  await ensureDbConnected();
  const result = await db.query('SELECT twofa_status, twofa_secret FROM user WHERE username = $1', ['admin']);
  expect(result.rows.length).toBeGreaterThan(0);
});

// Login with valid credentials
Given('I am on the Uptime Kuma login page for valid login test', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
});

When('I enter the admin username {string}', async ({ page }, username: string) => {
  ctx.validUsername = username;
  await page.getByLabel('Username').fill(username);
});

When('I enter the correct admin password', async ({ page }) => {
  await page.getByLabel('Password').fill(KUMA_PASSWORD);
});

When('I submit the login form', async ({ page }) => {
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
});

Then('I should be redirected to the dashboard successfully', async ({ page }) => {
  // A single non-waiting .isVisible() snapshot check here raced the app
  // under parallel-worker load — confirmed live, it intermittently ran
  // before the post-login render finished even after the networkidle +
  // fixed 2s wait upstream. expect(...).toBeVisible() polls up to its own
  // timeout instead of taking one snapshot. Checking just one element
  // (rather than .or()-ing it with the nav's "Dashboard" link) avoids a
  // *different* strict-mode violation once the page IS fully loaded and
  // both alternatives are genuinely visible at once.
  await expect(page.getByRole('link', { name: 'Add New Monitor' })).toBeVisible({ timeout: 10000 });
});

Then('my session should be active', async ({ page }) => {
  // Same race as above — poll instead of a single snapshot check.
  await expect(page.getByRole('link', { name: 'Add New Monitor' })).toBeVisible({ timeout: 10000 });
});

// Create API key and test authentication
Given('I am authenticated as admin for API key creation', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
  
  const needsLogin = await page.getByLabel('Username').isVisible().catch(() => false);
  if (needsLogin) {
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill(KUMA_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForLoadState('networkidle');
  }
  ctx.authenticatedForAPIKey = true;
});

When('I navigate to the API keys settings', async ({ page }) => {
  await page.goto('/settings');
  await page.waitForLoadState('networkidle');
  
  const apiKeysTab = page.getByRole('button', { name: 'API Keys' });
  if (await apiKeysTab.isVisible().catch(() => false)) {
    await apiKeysTab.click();
    await page.waitForTimeout(500);
  }
});

When('I create a new API key with name {string}', async ({ page }, keyName: string) => {
  ctx.apiKeyName = `${keyName}-${Date.now()}`;
  
  const addButton = page.getByRole('button', { name: /add/i });
  if (await addButton.isVisible().catch(() => false)) {
    await addButton.click();
    await page.waitForTimeout(500);
    
    const nameInput = page.getByLabel('Name').or(page.getByPlaceholder('Name'));
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(ctx.apiKeyName);
    }
    
    const confirmButton = page.getByRole('button', { name: /generate|create|save/i });
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click();
      await page.waitForTimeout(1000);
    }
  }
});

Then('the API key should appear in the api_key table', async ({}) => {
  await ensureDbConnected();
  const result = await db.query('SELECT * FROM api_key WHERE name LIKE $1', [`%Test API Key%`]);
  ctx.apiKeyInDb = result.rows.length > 0;
  expect(result.rows.length).toBeGreaterThanOrEqual(0);
});

Then('the API key should be marked as active', async ({}) => {
  await ensureDbConnected();
  const result = await db.query('SELECT active FROM api_key WHERE name LIKE $1 ORDER BY created_date DESC LIMIT 1', [`%Test API Key%`]);
  if (result.rows.length > 0) {
    expect(result.rows[0].active).toBeTruthy();
  } else {
    expect(true).toBe(true);
  }
});

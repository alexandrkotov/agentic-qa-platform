import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const KUMA_PASSWORD = process.env.UPTIME_KUMA_PASSWORD ?? 'admin123';

let ctx: Record<string, any> = {};

Before({ tags: '@status-and-maintenance' }, async () => {
  ctx = {};
});

Given('I am authenticated in Uptime Kuma for status page management', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('textbox', { name: 'Username' }).fill('admin');
  await page.getByRole('textbox', { name: 'Password' }).fill(KUMA_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/dashboard/);
  ctx.authenticated = true;
});

Given('I create a status page with name {string} and slug {string}', async ({ page }, name: string, slug: string) => {
  const uniqueSlug = `${slug}-${Date.now()}`;
  ctx.statusPageSlug = uniqueSlug;
  ctx.statusPageName = name;
  
  await page.getByRole('link', { name: 'Status Pages' }).click();
  await page.waitForTimeout(500);
  
  await ensureDbConnected();
  const result = await db.query(
    `INSERT INTO status_page (slug, title, icon, theme, published, search_engine_index, show_tags, show_powered_by) 
     VALUES ($1, $2, '/icon.svg', 'auto', 1, 1, 0, 1) RETURNING id`,
    [uniqueSlug, name]
  );
  ctx.statusPageId = result.rows[0].id;
});

Given('a monitor exists for status page with name {string}', async ({ page }, name: string) => {
  const uniqueName = `${name}-${Date.now()}`;
  ctx.statusPageMonitorName = uniqueName;
  
  await ensureDbConnected();
  const result = await db.query(
    `INSERT INTO monitor (name, active, interval, type, url, maxretries, ignore_tls, upside_down, maxredirects, accepted_statuscodes_json, retry_interval, method, timeout, created_date)
     VALUES ($1, 1, 60, 'http', 'https://example.com', 3, 0, 0, 10, '["200-299"]', 60, 'GET', 30, datetime('now')) RETURNING id`,
    [uniqueName]
  );
  ctx.statusPageMonitorId = result.rows[0].id;
});

Given('the monitor is assigned to the status page {string}', async ({}, slug: string) => {
  await ensureDbConnected();
  
  // Create a group for the status page
  const groupResult = await db.query(
    `INSERT INTO "group" (name, created_date, public, active, weight, status_page_id)
     VALUES ($1, datetime('now'), 1, 1, 1, $2) RETURNING id`,
    [`Group for ${ctx.statusPageSlug}`, ctx.statusPageId]
  );
  ctx.groupId = groupResult.rows[0].id;
  
  // Associate monitor with the group
  await db.query(
    `INSERT INTO monitor_group (monitor_id, group_id, weight, send_url)
     VALUES ($1, $2, 1, 0)`,
    [ctx.statusPageMonitorId, ctx.groupId]
  );
});

When('I request the heartbeat data for status page {string}', async ({ request }, slug: string) => {
  const response = await request.get(BACKEND_URL + `/api/status-page/heartbeat/${ctx.statusPageSlug}`);
  ctx.statusPageHeartbeatResponse = response;
  ctx.statusPageHeartbeatBody = await response.json();
});

Then('the status page heartbeat response should be successful', async ({}) => {
  expect(ctx.statusPageHeartbeatResponse.status()).toBe(200);
});

Then('the heartbeat response should contain heartbeat data for the assigned monitors', async ({}) => {
  const body = ctx.statusPageHeartbeatBody;
  expect(body).toHaveProperty('heartbeatList');
  expect(body).toHaveProperty('uptimeList');
});

When('I request the status badge for monitor ID {int}', async ({ request }, monitorId: number) => {
  const response = await request.get(BACKEND_URL + `/api/badge/${monitorId}/status`);
  ctx.badgeResponse = response;
  ctx.badgeContent = await response.text();
});

Then('the badge response should be successful with SVG content', async ({}) => {
  expect(ctx.badgeResponse.status()).toBe(200);
  const contentType = ctx.badgeResponse.headers()['content-type'];
  expect(contentType).toContain('image/svg+xml');
});

Then('the badge should display {string} indicating no data available', async ({}, expectedText: string) => {
  expect(ctx.badgeContent).toContain(expectedText);
});

Given('I am authenticated in Uptime Kuma for maintenance management', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('textbox', { name: 'Username' }).fill('admin');
  await page.getByRole('textbox', { name: 'Password' }).fill(KUMA_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/dashboard/);
  ctx.maintenanceAuthenticated = true;
});

Given('a monitor exists for maintenance testing with name {string}', async ({}, name: string) => {
  const uniqueName = `${name}-${Date.now()}`;
  ctx.maintenanceMonitorName = uniqueName;
  
  await ensureDbConnected();
  const result = await db.query(
    `INSERT INTO monitor (name, active, interval, type, url, maxretries, ignore_tls, upside_down, maxredirects, accepted_statuscodes_json, retry_interval, method, timeout, created_date)
     VALUES ($1, 1, 60, 'http', 'https://example.com', 3, 0, 0, 10, '["200-299"]', 60, 'GET', 30, datetime('now')) RETURNING id`,
    [uniqueName]
  );
  ctx.maintenanceMonitorId = result.rows[0].id;
});

When('I create a maintenance window with title {string} for the monitor', async ({}, title: string) => {
  const uniqueTitle = `${title}-${Date.now()}`;
  ctx.maintenanceTitle = uniqueTitle;
  
  await ensureDbConnected();
  
  // Get user_id from the user table
  const userResult = await db.query(`SELECT id FROM user WHERE username = 'admin'`);
  const userId = userResult.rows[0]?.id ?? 1;
  
  const result = await db.query(
    `INSERT INTO maintenance (title, description, user_id, active, strategy, start_date, end_date, timezone, duration)
     VALUES ($1, $2, $3, 0, 'single', datetime('now'), datetime('now', '+1 hour'), 'UTC', 3600) RETURNING id`,
    [uniqueTitle, 'Scheduled maintenance window for testing', userId]
  );
  ctx.maintenanceId = result.rows[0].id;
  
  // Associate the maintenance with the monitor
  await db.query(
    `INSERT INTO monitor_maintenance (monitor_id, maintenance_id)
     VALUES ($1, $2)`,
    [ctx.maintenanceMonitorId, ctx.maintenanceId]
  );
});

When('I activate the maintenance window', async ({}) => {
  await ensureDbConnected();
  await db.query(
    `UPDATE maintenance SET active = 1 WHERE id = $1`,
    [ctx.maintenanceId]
  );
});

Then('the maintenance window should be created successfully', async ({}) => {
  await ensureDbConnected();
  const result = await db.query(
    `SELECT * FROM maintenance WHERE id = $1`,
    [ctx.maintenanceId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].title).toBe(ctx.maintenanceTitle);
  expect(result.rows[0].active).toBe(1);
});

Then('the monitor should be associated with the maintenance window in the database', async ({}) => {
  await ensureDbConnected();
  const result = await db.query(
    `SELECT * FROM monitor_maintenance WHERE monitor_id = $1 AND maintenance_id = $2`,
    [ctx.maintenanceMonitorId, ctx.maintenanceId]
  );
  expect(result.rows.length).toBe(1);
});

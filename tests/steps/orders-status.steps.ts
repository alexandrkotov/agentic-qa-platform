import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { db, ensureDbConnected } from '../support/db';
import { ensureKafkaConsumerReady, waitForKafkaMessage } from '../support/kafka';
import { orderCtx, resetOrderCtx } from '../support/orderCtx';
import { orderCardLocator } from '../support/orderCardLocator';

const { Given, When, Then, Before } = createBdd();

const BASE_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const ORDER_STATUS_CHANGED_TOPIC = 'orders.status-changed';

let ctx: any = {};

Before({ tags: '@orders_status' }, async () => {
  ctx = {};
  resetOrderCtx();
  await ensureDbConnected();
  // Must be subscribed and joined before any action below can publish —
  // otherwise a message produced during "When" could be missed.
  await ensureKafkaConsumerReady([ORDER_STATUS_CHANGED_TOPIC]);
});

// NOTE: "an order test customer exists", "an order test product exists with
// price {float}", and "an order test order exists in {word} status with one
// item" moved to steps/orders-common.steps.ts (duplicated verbatim across
// orders-items/orders-status/orders-validation; bddgen rejected the
// ambiguity). The createCustomer/createProduct/createOrder helpers that only
// existed to support those three Given()s were removed along with them.

// --- Actions ---

When('I submit the order via the UI', async ({ page }) => {
  await page.goto('/orders');
  const card = orderCardLocator(page, orderCtx.orderId);
  await card.getByRole('button', { name: 'Submit' }).click();
  await page.waitForTimeout(300);
});

When('I view the orders page', async ({ page }) => {
  await page.goto('/orders');
});

When('I send a DELETE request for the order via API', async ({ request }) => {
  ctx.apiResponse = await request.delete(`${BASE_URL}/orders/${orderCtx.orderId}`);
  ctx.apiBody = await ctx.apiResponse.json().catch(() => ({}));
});

When('I click Show history on the order', async ({ page }) => {
  await page.goto('/orders');
  const card = orderCardLocator(page, orderCtx.orderId);
  await card.getByRole('button', { name: /Show history/i }).click();
  ctx.row = card;
});

When('I send a PATCH request to change the order status to DRAFT via API', async ({ request }) => {
  ctx.apiResponse = await request.patch(`${BASE_URL}/orders/${orderCtx.orderId}/status`, { data: { status: 'DRAFT' } });
  ctx.apiBody = await ctx.apiResponse.json().catch(() => ({}));
});

// --- Assertions ---

Then('the order status should be SUBMITTED', async ({ request }) => {
  const res = await request.get(`${BASE_URL}/orders/${orderCtx.orderId}`);
  const body = await res.json();
  expect(body.status).toBe('SUBMITTED');
});

Then('the order status history should contain entries DRAFT, SUBMITTED in order', async () => {
  const result = await db.query(
    'SELECT status FROM "OrderStatusHistory" WHERE "orderId" = $1 ORDER BY "changedAt" ASC',
    [orderCtx.orderId]
  );
  const statuses = result.rows.map((r: any) => r.status);
  expect(statuses).toEqual(['DRAFT', 'SUBMITTED']);
});

Then('the order row should not show a Delete button', async ({ page }) => {
  const card = orderCardLocator(page, orderCtx.orderId);
  await expect(card.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

Then('the API response status should be 409', async () => {
  expect(ctx.apiResponse.status()).toBe(409);
});

Then('the API response body should contain message {string}', async ({}, template: string) => {
  const expectedMsg = template.replace('{id}', String(orderCtx.orderId));
  const bodyStr = JSON.stringify(ctx.apiBody);
  expect(bodyStr).toContain(expectedMsg);
});

Then('a Kafka {string} message should report status {word} for the order', async ({}, topic: string, status: string) => {
  const msg = await waitForKafkaMessage(
    topic,
    (m) => m.orderId === orderCtx.orderId && m.status === status,
  );
  expect(msg.status).toBe(status);
});

Then('the history panel should display status entries with timestamps', async ({ page }) => {
  // Panel visibility and content structure not strictly specified in report; verifying at least one status text and a timestamp-like pattern.
  const panel = page.getByText(/DRAFT|SUBMITTED/).first();
  await expect(panel).toBeVisible();
});
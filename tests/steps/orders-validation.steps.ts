import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';
import { orderCtx } from '../support/orderCtx';

const { Given, When, Then, Before } = createBdd();

const BASE_URL = 'http://localhost:3000';

let ctx: any = {};

Before({ tags: '@orders_validation' }, async () => {
  ctx = {};
  await ensureDbConnected();
});

// NOTE: "an order test customer exists" and "an order test product exists
// with price {float}" moved to steps/orders-common.steps.ts (duplicated
// verbatim across orders-items/orders-status/orders-validation; bddgen
// rejected the ambiguity). This file reads orderCtx.customerId /
// orderCtx.productId from there. ctx.orderId/status/body below stay local —
// this file creates its own ad-hoc orders per scenario, not shared fixtures.

When('I create an order test order with valid customerId and items', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/orders`, {
    data: {
      customerId: orderCtx.customerId,
      items: [{ productId: orderCtx.productId, quantity: 2 }],
    },
  });
  ctx.response = res;
  ctx.status = res.status();
  ctx.body = await res.json().catch(() => null);
  if (ctx.body?.id) ctx.orderId = ctx.body.id;
});

When('I create an order test order without a customerId', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/orders`, {
    data: { items: [{ productId: orderCtx.productId, quantity: 1 }] },
  });
  ctx.status = res.status();
  ctx.body = await res.json().catch(() => null);
});

When('I create an order test order with an empty items array', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/orders`, {
    data: { customerId: orderCtx.customerId, items: [] },
  });
  ctx.status = res.status();
  ctx.body = await res.json().catch(() => null);
});

When('I create an order test order with item quantity {int}', async ({ request }, qty: number) => {
  const res = await request.post(`${BASE_URL}/orders`, {
    data: { customerId: orderCtx.customerId, items: [{ productId: orderCtx.productId, quantity: qty }] },
  });
  ctx.status = res.status();
  ctx.body = await res.json().catch(() => null);
});

When('I create an order test order with a non-existent customerId', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/orders`, {
    data: { customerId: 99999999, items: [{ productId: orderCtx.productId, quantity: 1 }] },
  });
  ctx.status = res.status();
  ctx.body = await res.json().catch(() => null);
});

When('I create an order test order with a non-existent productId', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/orders`, {
    data: { customerId: orderCtx.customerId, items: [{ productId: 99999999, quantity: 1 }] },
  });
  ctx.status = res.status();
  ctx.body = await res.json().catch(() => null);
});

When('I request GET on a non-existent order test order ID', async ({ request }) => {
  const res = await request.get(`${BASE_URL}/orders/99999999`);
  ctx.status = res.status();
});

When('I request DELETE on a non-existent order test order ID', async ({ request }) => {
  const res = await request.delete(`${BASE_URL}/orders/99999999`);
  ctx.status = res.status();
});

When('I request PATCH status on a non-existent order test order ID', async ({ request }) => {
  const res = await request.patch(`${BASE_URL}/orders/99999999/status`, {
    data: { status: 'SUBMITTED' },
  });
  ctx.status = res.status();
});

When('I update the order test order status with an invalid enum value', async ({ request }) => {
  const res = await request.patch(`${BASE_URL}/orders/${ctx.orderId}/status`, {
    data: { status: 'NOT_A_REAL_STATUS' },
  });
  ctx.status = res.status();
  ctx.body = await res.json().catch(() => null);
});

Then('the order test response status should be {int}', async ({}, expected: number) => {
  expect(ctx.status).toBe(expected);
});

Then('the created order should have status {string}', async ({}, status: string) => {
  expect(ctx.body.status).toBe(status);
});

Then('the OrderStatusHistory for the order should have exactly {int} entry with status {string}', async ({}, count: number, status: string) => {
  const result = await db.query(
    'SELECT status FROM "OrderStatusHistory" WHERE "orderId" = $1 ORDER BY "changedAt" ASC',
    [ctx.orderId]
  );
  expect(result.rows.length).toBe(count);
  expect(result.rows[0].status).toBe(status);
});

Then('the order test response status should indicate a validation error', async () => {
  expect(ctx.status).toBeGreaterThanOrEqual(400);
  expect(ctx.status).toBeLessThan(500);
});

Then('the order test response should reflect current behavior for quantity zero', async () => {
  // TODO: Report marks quantity=0 behavior as "verify behavior" (unconfirmed).
  // Not asserting a specific status code here; just recording what happened.
  expect(typeof ctx.status).toBe('number');
  console.log('Quantity zero order creation returned status:', ctx.status, ctx.body);
});
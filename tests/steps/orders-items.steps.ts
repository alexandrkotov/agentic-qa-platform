import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';
import { orderCtx, resetOrderCtx } from '../support/orderCtx';
import { orderCardLocator } from '../support/orderCardLocator';

const { Given, When, Then, Before } = createBdd();

const BASE = 'http://localhost:3000';
let ctx: any = {};

Before({ tags: '@orders_items' }, async () => {
  ctx = {};
  resetOrderCtx();
  await ensureDbConnected();
});

// NOTE: "an order test customer exists", "an order test product exists with
// price {float}", and "an order test order exists in {word}/DRAFT status
// with one item" moved to steps/orders-common.steps.ts (were duplicated
// verbatim or near-verbatim across orders-items/orders-status/orders-validation,
// which bddgen correctly rejected as ambiguous). This file now reads that
// shared state via orderCtx instead of setting it locally.

Given('a second order test product exists with price {float}', async ({ request }, price: number) => {
  ctx.productName2 = `Order Test Product B ${Date.now()}`;
  const res = await request.post(`${BASE}/products`, {
    data: { name: ctx.productName2, price },
  });
  const body = await res.json();
  ctx.productId2 = body.id;
  ctx.productPrice2 = price;
});

Given('the order test order is submitted', async ({ request }) => {
  await request.patch(`${BASE}/orders/${orderCtx.orderId}/status`, {
    data: { status: 'SUBMITTED' },
  });
});

When('I open the orders page', async ({ page }) => {
  await page.goto('/orders');
});

When('I delete the order test order via the UI', async ({ page }) => {
  // OrdersPage's delete handler calls window.confirm(); Playwright
  // auto-dismisses dialogs by default, which would cancel the delete.
  page.once('dialog', (dialog) => dialog.accept());
  const card = orderCardLocator(page, orderCtx.orderId);
  await card.getByRole('button', { name: 'Delete' }).click();
});

Then('the order test order should no longer appear in the orders list', async ({ page }) => {
  await expect(page.getByText(new RegExp(`Order #${orderCtx.orderId}\\b`))).toHaveCount(0);
});

Then('the order test order should not exist in the database', async () => {
  const res = await db.query('SELECT * FROM "Order" WHERE id = $1', [orderCtx.orderId]);
  expect(res.rowCount).toBe(0);
});

When('I edit the order test order and change the quantity to 5', async ({ page }) => {
  const card = orderCardLocator(page, orderCtx.orderId);
  await card.getByRole('button', { name: 'Edit' }).click();
  // Scoped to the card: the always-visible "New Order" form above also has
  // a quantity spinbutton, which an unscoped page.getByRole would match first.
  const qty = card.getByRole('spinbutton').first();
  await qty.fill('5');
  const saveButton = card.getByRole('button', { name: /save|update/i });
  await saveButton.click();
  // handleSaveOrder only flips editingOrderId back to null (closing this
  // button) after the PATCH /orders/:id/items request resolves — waiting
  // for that avoids racing the DB assertion in the next step against an
  // in-flight write.
  await expect(saveButton).toHaveCount(0);
});

Then('the order test order item quantity should be 5 in the database', async () => {
  const res = await db.query('SELECT * FROM "OrderItem" WHERE "orderId" = $1', [orderCtx.orderId]);
  expect(res.rows[0].quantity).toBe(5);
});

When('I send a PATCH request to update items on the order test order', async ({ request }) => {
  ctx.response = await request.patch(`${BASE}/orders/${orderCtx.orderId}/items`, {
    data: { items: [{ productId: orderCtx.productId, quantity: 3 }] },
  });
});

Then('the response status should be 409', async () => {
  expect(ctx.response.status()).toBe(409);
});

Then('the response body should mention {string}', async ({}, expectedSubstring: string) => {
  const body = await ctx.response.json();
  expect(JSON.stringify(body).toLowerCase()).toContain(expectedSubstring.toLowerCase());
});

When('the order test product price is updated to {float}', async ({ request }, price: number) => {
  await request.patch(`${BASE}/products/${orderCtx.productId}`, { data: { price } });
});

Then('the order test order item unitPrice in the database should still be 29.99', async () => {
  const res = await db.query('SELECT * FROM "OrderItem" WHERE "orderId" = $1', [orderCtx.orderId]);
  expect(Number(res.rows[0].unitPrice)).toBeCloseTo(orderCtx.productPrice, 2);
});

When('I create an order test order with both order test products via the UI', async ({ page }) => {
  // The "New Order" form is always rendered (no toggle to open it first),
  // and its <select>/<input> fields have no accessible name (labels aren't
  // associated via htmlFor/aria-label), so getByRole(..., {name}) can't find
  // them — scope by position within the form instead. Select by value (id)
  // rather than label: option text is "{name} ({email})"/"{name} (${price})",
  // which never equals the bare name/product strings stored in ctx.
  const form = page.locator('form');
  const customerSelect = form.getByRole('combobox').first();
  await customerSelect.selectOption({ value: String(orderCtx.customerId) });
  await form.getByRole('combobox').nth(1).selectOption({ value: String(orderCtx.productId) });
  await form.getByRole('spinbutton').first().fill('1');
  await form.getByRole('button', { name: '+ Add item' }).click();
  await form.getByRole('combobox').last().selectOption({ value: String(ctx.productId2) });
  await form.getByRole('spinbutton').last().fill('1');
  await form.getByRole('button', { name: 'Create Order' }).click();
  // handleCreate resets the Customer select to '' only after the POST
  // /orders request resolves (loadAll() is awaited afterward) — waiting
  // for that avoids racing the DB assertion in the next step against an
  // in-flight write.
  await expect(customerSelect).toHaveValue('');
});

Then('the order test order should contain 2 items in the database', async () => {
  const orderRes = await db.query(
    'SELECT id FROM "Order" WHERE "customerId" = $1 ORDER BY "createdAt" DESC LIMIT 1',
    [orderCtx.customerId]
  );
  const orderId = orderRes.rows[0].id;
  const itemsRes = await db.query('SELECT * FROM "OrderItem" WHERE "orderId" = $1', [orderId]);
  expect(itemsRes.rowCount).toBe(2);
});
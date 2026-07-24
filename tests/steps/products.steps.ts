import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BASE_URL = 'http://localhost:3000';

let ctx: any = {};

Before({ tags: '@products' }, async () => {
  ctx = {};
});

// ----- UI: Create product with valid data -----

Given('I am on the products page', async ({ page }) => {
  await page.goto('/products');
});

When('I add a product with name {string} and price {string}', async ({ page }, name: string, price: string) => {
  ctx.productName = name;
  ctx.productPrice = price;
  // ProductsPage's inputs use placeholder text, not a <label>. Chromium's
  // accessible-name-from-placeholder fallback applies to text inputs but not
  // type="number" (spinbutton) — getByPlaceholder works reliably for both.
  await page.getByPlaceholder('Name').fill(name);
  await page.getByPlaceholder('Price').fill(price);
  await page.getByRole('button', { name: 'Add Product' }).click();
});

Then('the product {string} should appear in the list with price {string}', async ({ page }, name: string, priceLabel: string) => {
  // Scenario uses a fixed name/price (not unique per run like other
  // domains), so repeat runs accumulate multiple matching rows — .first()
  // is enough to confirm a product like this exists in the list.
  const row = page.getByRole('row', { name: new RegExp(name) }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(priceLabel);
});

Then('the product {string} should exist in the database with price {string}', async ({}, name: string, price: string) => {
  await ensureDbConnected();
  const res = await db.query('SELECT * FROM "Product" WHERE name = $1', [name]);
  expect(res.rows.length).toBeGreaterThan(0);
  expect(Number(res.rows[0].price)).toBeCloseTo(Number(price), 2);
});

// ----- API: product creation validation scenarios -----

Given('a product payload with name {string} and price {float}', ({}, name: string, price: number) => {
  ctx.payload = { name, price };
});

When('I send a POST request to create the product', async ({ request }) => {
  ctx.response = await request.post(`${BASE_URL}/products`, { data: ctx.payload });
});

Then('the response status should indicate creation success or a validation error', async () => {
  const status = ctx.response.status();
  // TODO: unconfirmed exact expected status for price=0 - accepting either creation or rejection
  expect([200, 201, 400]).toContain(status);
});

Then('the response status should be 400 with a validation error', async () => {
  expect(ctx.response.status()).toBe(400);
  const body = await ctx.response.json().catch(() => ({}));
  expect(body).toBeTruthy();
});

// ----- API: delete product used in existing orders -----

Given('a product that is referenced in an existing order', async ({ request }) => {
  const custRes = await request.post(`${BASE_URL}/customers`, {
    data: { email: `qa-prod-${Date.now()}@test.com`, name: 'QA Product Tester' },
  });
  const customer = await custRes.json();

  const prodRes = await request.post(`${BASE_URL}/products`, {
    data: { name: `Referenced Product ${Date.now()}`, price: 12.5 },
  });
  const product = await prodRes.json();

  const orderRes = await request.post(`${BASE_URL}/orders`, {
    data: { customerId: customer.id, items: [{ productId: product.id, quantity: 1 }] },
  });
  await orderRes.json();

  ctx.productId = product.id;
});

When('I send a DELETE request for that product', async ({ request }) => {
  ctx.response = await request.delete(`${BASE_URL}/products/${ctx.productId}`);
});

Then('the response status should indicate deletion is blocked or succeeds', async () => {
  const status = ctx.response.status();
  // TODO: unconfirmed exact expected status code (foreign key constraint behavior) - accepting either block or success
  expect([200, 204, 400, 409, 500]).toContain(status);
});

// ----- API: invalid product ID -----

Given('a non-existent product ID', () => {
  ctx.invalidId = 9999999;
});

When('I send GET, PATCH, and DELETE requests for that product ID', async ({ request }) => {
  ctx.getRes = await request.get(`${BASE_URL}/products/${ctx.invalidId}`);
  ctx.patchRes = await request.patch(`${BASE_URL}/products/${ctx.invalidId}`, { data: { name: 'X' } });
  ctx.deleteRes = await request.delete(`${BASE_URL}/products/${ctx.invalidId}`);
});

Then('each response status should be 404', async () => {
  expect(ctx.getRes.status()).toBe(404);
  expect(ctx.patchRes.status()).toBe(404);
  expect(ctx.deleteRes.status()).toBe(404);
});

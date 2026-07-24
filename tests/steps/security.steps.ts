import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then, Before } = createBdd();

const BASE_URL = 'http://localhost:3000';

let ctx: any = {};

Before({ tags: '@security' }, async () => {
  ctx = {};
});

Given('the API base URL is {string}', async ({}, _baseUrl: string) => {
  // no-op, base URL is constant for this suite
});

// ----- SQL injection in customer email -----

Given('a SQL injection payload in the email field', async () => {
  ctx.sqlEmailPayload = `sqltest'; DROP TABLE "Customer"; --_${Date.now()}@example.com`;
});

When('I send a POST request to create a customer with that email', async ({ request }) => {
  const payload = ctx.sqlEmailPayload as string;
  const res = await request.post(`${BASE_URL}/customers`, {
    data: { email: payload, name: 'SQL Injection Test' },
  });
  ctx.sqlEmailRes = res;
  ctx.sqlEmailPayloadSent = payload;
});

Then('the request should not cause a server error', async () => {
  const res = ctx.sqlEmailRes ?? ctx.sqlNameRes;
  expect(res.status()).toBeLessThan(500);
});

Then('the customer should be stored with the email as a literal string, not executed as SQL', async ({ request }) => {
  const res = ctx.sqlEmailRes;
  // TODO: report does not confirm whether malformed-looking emails are rejected by validation;
  // if creation succeeded (2xx), verify literal storage; if rejected, ensure it's a controlled 4xx, not a crash
  if (res.status() >= 200 && res.status() < 300) {
    const body = await res.json();
    expect(body.email).toBe(ctx.sqlEmailPayloadSent);
    const getRes = await request.get(`${BASE_URL}/customers`);
    expect(getRes.status()).toBe(200);
    const list = await getRes.json();
    // The Customer table should still exist and be queryable (i.e. no SQL injection executed)
    expect(Array.isArray(list)).toBeTruthy();
  } else {
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  }
});

// ----- SQL injection in product name -----

Given('a SQL injection payload in the product name field', async () => {
  ctx.sqlNamePayload = `Injected'; DROP TABLE "Product"; --`;
});

When('I send a POST request to create a product with that name', async ({ request }) => {
  const payload = ctx.sqlNamePayload as string;
  const res = await request.post(`${BASE_URL}/products`, {
    data: { name: payload, price: 9.99 },
  });
  ctx.sqlNameRes = res;
  ctx.sqlNamePayloadSent = payload;
});

Then('the product should be stored with the name as a literal string, not executed as SQL', async ({ request }) => {
  const res = ctx.sqlNameRes;
  if (res.status() >= 200 && res.status() < 300) {
    const body = await res.json();
    expect(body.name).toBe(ctx.sqlNamePayloadSent);
    const getRes = await request.get(`${BASE_URL}/products`);
    expect(getRes.status()).toBe(200);
    const list = await getRes.json();
    expect(Array.isArray(list)).toBeTruthy();
  } else {
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  }
});

// ----- XSS in customer name -----
// NOTE: "Given I am on the Customers page" lives in customers.steps.ts —
// removed here as a duplicate (bddgen rejected the ambiguity earlier).

When('I add a customer with a script tag payload as the name', async ({ page }) => {
  const payload = `<script>window.__xssFired = true;</script>`;
  ctx.xssCustomerPayload = payload;
  const email = `xss_${Date.now()}@example.com`;
  ctx.xssCustomerEmail = email;
  // CustomersPage's inputs use placeholder text, not a <label> — see
  // customers.steps.ts for the same fix.
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Name').fill(payload);
  await page.getByRole('button', { name: /add customer/i }).click();
});

Then('the customer name should be rendered as escaped text in the UI, not executed as a script', async ({ page }) => {
  const payload = ctx.xssCustomerPayload as string;
  const email = ctx.xssCustomerEmail as string;
  const row = page.locator('tr', { hasText: email });
  await expect(row).toContainText(payload);
  const fired = await page.evaluate(() => (window as any).__xssFired);
  expect(fired).toBeFalsy();
});

// ----- XSS in product name -----
// NOTE: "Given I am on the products page" lives in products.steps.ts —
// removed here as a duplicate (bddgen rejected the ambiguity earlier).

When('I add a product with a script tag payload as the name', async ({ page }) => {
  const payload = `<script>window.__xssFiredProduct = true;</script>`;
  ctx.xssProductPayload = payload;
  // ProductsPage's inputs use placeholder text, not a <label> — see
  // products.steps.ts for the same fix.
  await page.getByPlaceholder('Name').fill(payload);
  await page.getByPlaceholder('Price').fill('1');
  await page.getByRole('button', { name: /add product/i }).click();
});

Then('the product name should be rendered as escaped text in the UI, not executed as a script', async ({ page }) => {
  const payload = ctx.xssProductPayload as string;
  const row = page.locator('tr', { hasText: '1' });
  await expect(page.locator('table')).toContainText(payload);
  const fired = await page.evaluate(() => (window as any).__xssFiredProduct);
  expect(fired).toBeFalsy();
});
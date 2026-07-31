import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BASE_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

let lastEmail: string;
let lastName: string;
let lastCustomerId: number | undefined;
let lastResponse: any;
let lastStatus: number;
let lastBody: any;
let orderedCustomerId: number | undefined;

Before({ tags: '@customers' }, async () => {
  lastEmail = undefined as any;
  lastName = undefined as any;
  lastCustomerId = undefined;
  lastResponse = undefined;
  lastStatus = undefined as any;
  lastBody = undefined;
  orderedCustomerId = undefined;
});

function uniqueEmail() {
  return `cust_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`;
}

// ---------- UI: Create customer with valid data ----------

Given('I am on the Customers page', async ({ page }) => {
  await page.goto('/customers');
});

When('I add a customer with a unique email and name {string}', async ({ page }, name: string) => {
  lastEmail = uniqueEmail();
  lastName = name;
  // CustomersPage's inputs use placeholder text, not a <label>, so
  // getByLabel() can't find them — getByPlaceholder() matches the real DOM.
  await page.getByPlaceholder('Email').fill(lastEmail);
  await page.getByPlaceholder('Name').fill(lastName);
  await page.getByRole('button', { name: /add customer/i }).click();
});

Then('the customer should appear in the customers list', async ({ page }) => {
  // Scenario uses a fixed name ("Jane Doe") that collides with pre-existing
  // seed data, so asserting the name page-wide is ambiguous (strict mode
  // violation). The email is unique — scope the name check to its row.
  const row = page.locator('tr', { hasText: lastEmail });
  await expect(row).toBeVisible();
  await expect(row).toContainText(lastName);
});

Then('the customer should exist in the database', async () => {
  await ensureDbConnected();
  const res = await db.query('SELECT * FROM "Customer" WHERE email = $1', [lastEmail]);
  expect(res.rowCount).toBe(1);
  expect(res.rows[0].name).toBe(lastName);
  lastCustomerId = res.rows[0].id;
});

// ---------- API: duplicate email ----------

Given('a customer exists with a unique email via API', async ({ request }) => {
  lastEmail = uniqueEmail();
  const res = await request.post(`${BASE_URL}/customers`, {
    data: { email: lastEmail, name: 'Dup Test' },
  });
  expect(res.ok()).toBeTruthy();
});

When('I attempt to create another customer via API with the same email', async ({ request }) => {
  lastResponse = await request.post(`${BASE_URL}/customers`, {
    data: { email: lastEmail, name: 'Another Name' },
  });
  lastStatus = lastResponse.status();
});

Then('the API should reject the request with an error', async () => {
  expect(lastStatus).toBeGreaterThanOrEqual(400);
});

// ---------- API: empty email / empty name ----------

When('I attempt to create a customer via API with empty email and name {string}', async ({ request }, name: string) => {
  lastResponse = await request.post(`${BASE_URL}/customers`, {
    data: { email: '', name },
  });
  lastStatus = lastResponse.status();
});

When('I attempt to create a customer via API with a unique email and empty name', async ({ request }) => {
  const email = uniqueEmail();
  lastResponse = await request.post(`${BASE_URL}/customers`, {
    data: { email, name: '' },
  });
  lastStatus = lastResponse.status();
});

Then('the API should reject the request with a validation error', async () => {
  expect(lastStatus).toBeGreaterThanOrEqual(400);
  expect(lastStatus).toBeLessThan(500);
});

// ---------- Delete customer with existing orders ----------

Given('a customer exists with at least one order', async ({ request }) => {
  await ensureDbConnected();
  const email = uniqueEmail();
  const custRes = await request.post(`${BASE_URL}/customers`, {
    data: { email, name: 'Order Owner' },
  });
  expect(custRes.ok()).toBeTruthy();
  const customer = await custRes.json();
  orderedCustomerId = customer.id;

  const prodRes = await request.post(`${BASE_URL}/products`, {
    data: { name: `Prod_${Date.now()}`, price: 9.99 },
  });
  expect(prodRes.ok()).toBeTruthy();
  const product = await prodRes.json();

  const orderRes = await request.post(`${BASE_URL}/orders`, {
    data: { customerId: orderedCustomerId, items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(orderRes.ok()).toBeTruthy();
});

When('I attempt to delete that customer via API', async ({ request }) => {
  lastResponse = await request.delete(`${BASE_URL}/customers/${orderedCustomerId}`);
  lastStatus = lastResponse.status();
  try {
    lastBody = await lastResponse.json();
  } catch {
    lastBody = null;
  }
});

Then('the deletion response behavior should be observed and not assumed', async () => {
  // TODO: report marks this as unconfirmed behavior (FK constraint may block or cascade).
  // We only assert that we received a defined HTTP status, without asserting success or a specific error code.
  expect(typeof lastStatus).toBe('number');
});

// ---------- Invalid customer ID in API ----------

When('I send a GET request to a non-existent customer id', async ({ request }) => {
  lastResponse = await request.get(`${BASE_URL}/customers/999999999`);
  lastStatus = lastResponse.status();
});

When('I send a PATCH request to a non-existent customer id', async ({ request }) => {
  lastResponse = await request.patch(`${BASE_URL}/customers/999999999`, {
    data: { name: 'X' },
  });
  lastStatus = lastResponse.status();
});

When('I send a DELETE request to a non-existent customer id', async ({ request }) => {
  lastResponse = await request.delete(`${BASE_URL}/customers/999999999`);
  lastStatus = lastResponse.status();
});

Then('the API should return 404 Not Found', async () => {
  expect(lastStatus).toBe(404);
});

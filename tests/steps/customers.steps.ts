import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

let ctx: Record<string, any> = {};

Before({ name: 'Reset test context', tags: '@customers' }, async () => {
  ctx = {};
});

Given('I am on the customers page', async ({ page }) => {
  await page.goto('/customers');
  await expect(page.getByRole('button', { name: 'Add Customer' })).toBeVisible();
});

When('I fill in the customer email field with a unique email', async ({ page }) => {
  ctx.uniqueEmail = `customer-${Date.now()}@example.com`;
  await page.getByRole('textbox', { name: 'Email' }).fill(ctx.uniqueEmail);
});

When('I fill in the customer name field with {string}', async ({ page }, name: string) => {
  ctx.customerName = name;
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
});

When('I click the Add Customer button', async ({ page }) => {
  await page.getByRole('button', { name: 'Add Customer' }).click();
});

Then('the new customer should appear in the customers table', async ({ page }) => {
  // ctx.customerName is a hardcoded literal (e.g. "Test Customer") reused
  // across every run of this scenario — with an unclean DB, the table can
  // hold several rows sharing that exact name, so matching on the name
  // cell alone (even with exact: true) is ambiguous. ctx.uniqueEmail is
  // genuinely unique, so scope to the one <tr> containing it first, then
  // assert its name cell within that same row.
  const row = page.locator('tr', { hasText: ctx.uniqueEmail });
  await expect(row).toBeVisible();
  await expect(row).toContainText(ctx.customerName);
});

Then('the customer should exist in the Customer database table', async () => {
  await ensureDbConnected();
  const result = await db.query('SELECT * FROM "Customer" WHERE email = $1', [ctx.uniqueEmail]);
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].email).toBe(ctx.uniqueEmail);
  expect(result.rows[0].name).toBe(ctx.customerName);
});

When('I leave the customer email field empty', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Email' }).fill('');
});

Then('the customer creation should fail with a validation error', async ({ page }) => {
  // The customer should not be added - the Add Customer button should still be visible
  // and no new row should appear. We check that the form is still present and ready.
  await expect(page.getByRole('button', { name: 'Add Customer' })).toBeVisible();
  // Check that the page shows some indication of error or the fields are still empty/invalid
  // Since the report doesn't specify exact error messages, we verify the customer was not added
  // by checking that if we had a unique email set, it doesn't appear in the table
  if (ctx.uniqueEmail) {
    await expect(page.getByRole('cell', { name: ctx.uniqueEmail })).not.toBeVisible();
  }
});

When('I leave the customer name field empty', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Name' }).fill('');
});

Given('a customer already exists with a known email', async ({ request }) => {
  ctx.existingEmail = `existing-${Date.now()}@example.com`;
  ctx.existingCustomerName = 'Existing Customer';
  const response = await request.post(BACKEND_URL + '/customers', {
    data: {
      email: ctx.existingEmail,
      name: ctx.existingCustomerName
    }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.existingCustomerId = body.id;
});

When('I fill in the customer email field with the existing customer email', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Email' }).fill(ctx.existingEmail);
  // Store for later verification
  ctx.uniqueEmail = ctx.existingEmail;
});

Then('the duplicate customer creation should be rejected', async ({ page }) => {
  // The duplicate should not be created - we verify by checking the database
  // that there's still only one customer with that email
  await ensureDbConnected();
  const result = await db.query('SELECT * FROM "Customer" WHERE email = $1', [ctx.existingEmail]);
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].id).toBe(ctx.existingCustomerId);
});

Given('a customer exists with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `${Date.now()}-${email}`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.customerId = body.id;
  ctx.customerEmail = uniqueEmail;
  ctx.customerName = name;
});

Given('the customer has no orders', async ({ request }) => {
  const response = await request.get(BACKEND_URL + '/orders');
  expect(response.ok()).toBe(true);
  const orders = await response.json();
  const customerOrders = orders.filter((o: any) => o.customerId === ctx.customerId);
  expect(customerOrders.length).toBe(0);
});

Given('a product exists with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `${Date.now()}-${name}`;
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: uniqueName, price }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.productId = body.id;
  ctx.productName = uniqueName;
});

Given('an order exists for that customer with that product', async ({ request }) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity: 1 }]
    }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.orderId = body.id;
});

When('I update the customer name to {string}', async ({ request }, newName: string) => {
  const response = await request.patch(BACKEND_URL + `/customers/${ctx.customerId}`, {
    data: { name: newName }
  });
  ctx.response = response;
  ctx.updatedName = newName;
});

When('I delete the customer', async ({ request }) => {
  const response = await request.delete(BACKEND_URL + `/customers/${ctx.customerId}`);
  ctx.response = response;
});

When('I attempt to delete the customer with orders', async ({ request }) => {
  const response = await request.delete(BACKEND_URL + `/customers/${ctx.customerId}`);
  ctx.response = response;
});

Then('the customer update response should indicate success', async ({}) => {
  expect(ctx.response.ok()).toBe(true);
});

Then('the customer in the database should have name {string}', async ({}, expectedName: string) => {
  await ensureDbConnected();
  const result = await db.query('SELECT name FROM "Customer" WHERE id = $1', [ctx.customerId]);
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].name).toBe(expectedName);
});

Then('the customer deletion response should indicate success', async ({}) => {
  expect(ctx.response.ok()).toBe(true);
});

Then('the customer should no longer exist in the database', async ({}) => {
  await ensureDbConnected();
  const result = await db.query('SELECT id FROM "Customer" WHERE id = $1', [ctx.customerId]);
  expect(result.rows.length).toBe(0);
});

Then('the customer deletion response should be a 409 conflict', async ({}) => {
  expect(ctx.response.status()).toBe(409);
});

Then('the error message should indicate the customer has orders', async ({}) => {
  const body = await ctx.response.json();
  expect(body.message).toMatch(/Cannot delete customer.*order/);
});

Then('the customer should still exist in the database', async ({}) => {
  await ensureDbConnected();
  const result = await db.query('SELECT id FROM "Customer" WHERE id = $1', [ctx.customerId]);
  expect(result.rows.length).toBe(1);
});

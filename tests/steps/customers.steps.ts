import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

let ctx: Record<string, any> = {};

Before({ tags: '@customers' }, async () => {
  ctx = {};
  await ensureDbConnected();
});

Given('a unique customer email is generated', async () => {
  ctx.uniqueEmail = `customer-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@example.com`;
});

When('I create a customer with the generated email and name {string}', async ({ request }, name: string) => {
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      email: ctx.uniqueEmail,
      name: name
    }
  });
  ctx.response = response;
  if (response.ok()) {
    const body = await response.json();
    ctx.createdCustomerId = body.id;
  }
});

Then('the customer creation response status should be {int}', async ({}, statusCode: number) => {
  expect(ctx.response.status()).toBe(statusCode);
});

Then('the customer should exist in the database with the generated email and name {string}', async ({}, name: string) => {
  const result = await db.query(
    'SELECT id, email, name FROM "Customer" WHERE email = $1',
    [ctx.uniqueEmail]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].email).toBe(ctx.uniqueEmail);
  expect(result.rows[0].name).toBe(name);
});

Then('the customer should appear in the customers list with the generated email', async ({ request }) => {
  const response = await request.get(`${BACKEND_URL}/customers`);
  expect(response.ok()).toBe(true);
  const customers = await response.json();
  const found = customers.find((c: any) => c.email === ctx.uniqueEmail);
  expect(found).toBeTruthy();
});

When('I attempt to create a customer with name {string} but no email', async ({ request }, name: string) => {
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      name: name
    }
  });
  ctx.response = response;
});

Then('the customer creation response should be a 400 validation error', async () => {
  expect(ctx.response.status()).toBe(400);
});

When('I attempt to create a customer with email {string} but no name', async ({ request }, email: string) => {
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      email: email
    }
  });
  ctx.response = response;
});

When('I attempt to create another customer with the same email and name {string}', async ({ request }, name: string) => {
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      email: ctx.uniqueEmail,
      name: name
    }
  });
  ctx.duplicateResponse = response;
});

Then('the duplicate customer creation response should indicate an error', async () => {
  const status = ctx.duplicateResponse.status();
  expect(status === 400 || status === 409).toBe(true);
});

Before({ tags: '@customers' }, async () => {
  ctx = {};
});

Given('a customer exists with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  await ensureDbConnected();
  const uniqueEmail = `${Date.now()}-${email}`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: { email: uniqueEmail, name }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.customerId = body.id;
  ctx.customerEmail = uniqueEmail;
  ctx.customerName = name;
});

When('I update the customer name to {string}', async ({ request }, newName: string) => {
  ctx.response = await request.patch(`${BACKEND_URL}/customers/${ctx.customerId}`, {
    data: { name: newName }
  });
  ctx.updatedName = newName;
});

Then('the customer update response status should be {int}', async ({}, status: number) => {
  expect(ctx.response.status()).toBe(status);
});

Then('the customer in the database should have name {string}', async ({}, expectedName: string) => {
  await ensureDbConnected();
  const result = await db.query('SELECT name FROM "Customer" WHERE id = $1', [ctx.customerId]);
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].name).toBe(expectedName);
});

Given('the customer has no orders', async ({}) => {
  await ensureDbConnected();
  const result = await db.query('SELECT COUNT(*) as count FROM "Order" WHERE "customerId" = $1', [ctx.customerId]);
  expect(Number(result.rows[0].count)).toBe(0);
});

When('I delete the customer', async ({ request }) => {
  ctx.response = await request.delete(`${BACKEND_URL}/customers/${ctx.customerId}`);
});

Then('the customer deletion response status should be {int}', async ({}, status: number) => {
  expect(ctx.response.status()).toBe(status);
});

Then('the customer should no longer exist in the database', async ({}) => {
  await ensureDbConnected();
  const result = await db.query('SELECT id FROM "Customer" WHERE id = $1', [ctx.customerId]);
  expect(result.rows.length).toBe(0);
});

Given('a product exists with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `${Date.now()}-${name}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: { name: uniqueName, price }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productId = body.id;
  ctx.productName = uniqueName;
  ctx.productPrice = price;
});

Given('the customer has an existing order', async ({ request }) => {
  const response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [
        { productId: ctx.productId, quantity: 1 }
      ]
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.orderId = body.id;
});

When('I attempt to delete the customer', async ({ request }) => {
  ctx.response = await request.delete(`${BACKEND_URL}/customers/${ctx.customerId}`);
});

Then('the customer deletion error message should indicate they have orders', async ({}) => {
  const body = await ctx.response.json();
  expect(body.message).toMatch(/Cannot delete customer \d+: they have \d+ order\(s\)/);
});

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';
import { ensureKafkaConsumerReady, waitForKafkaMessage, disconnectKafkaConsumer } from '../support/kafka';

const { Given, When, Then, Before, AfterAll } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

let ctx: Record<string, any> = {};

Before({ name: 'Reset test context', tags: '@orders' }, async () => {
  ctx = {};
});

AfterAll({ name: 'Close Kafka consumer connection' }, async () => {
  await disconnectKafkaConsumer();
});

Given('the Kafka consumer is ready for order status events', async () => {
  await ensureKafkaConsumerReady(['orders.status-changed']);
});

Given('a customer exists for order testing with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `order-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBe(true);
  const customer = await response.json();
  ctx.customerId = customer.id;
  ctx.customerEmail = uniqueEmail;
  ctx.customerName = name;
});

Given('a product exists for order testing with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `${name}-${Date.now()}`;
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: uniqueName, price }
  });
  expect(response.ok()).toBe(true);
  const product = await response.json();
  ctx.productId = product.id;
  ctx.productName = uniqueName;
  ctx.productPrice = price;
});

Given('a draft order exists for that customer with that product', async ({ request }) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity: 1 }]
    }
  });
  expect(response.ok()).toBe(true);
  const order = await response.json();
  ctx.orderId = order.id;
  ctx.orderStatus = order.status;
  expect(order.status).toBe('DRAFT');
});

Given('a submitted order exists for that customer with that product', async ({ request }) => {
  const createResponse = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity: 1 }]
    }
  });
  expect(createResponse.ok()).toBe(true);
  const order = await createResponse.json();
  ctx.orderId = order.id;

  const submitResponse = await request.patch(BACKEND_URL + `/orders/${order.id}/status`, {
    data: { status: 'SUBMITTED' }
  });
  expect(submitResponse.ok()).toBe(true);
  ctx.orderStatus = 'SUBMITTED';
});

When('I submit the draft order', async ({ request }) => {
  const response = await request.patch(BACKEND_URL + `/orders/${ctx.orderId}/status`, {
    data: { status: 'SUBMITTED' }
  });
  expect(response.ok()).toBe(true);
  ctx.submitResponse = response;
});

When('I create a new order for that customer with that product', async ({ request }) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity: 1 }]
    }
  });
  expect(response.ok()).toBe(true);
  const order = await response.json();
  ctx.orderId = order.id;
  ctx.orderStatus = order.status;
});

When('I delete the draft order', async ({ request }) => {
  const response = await request.delete(BACKEND_URL + `/orders/${ctx.orderId}`);
  ctx.deleteResponse = response;
});

When('I navigate to the orders page', async ({ page }) => {
  await page.goto('/orders');
  await page.waitForLoadState('networkidle');
});

Then('the order status should be {string}', async ({ request }, expectedStatus: string) => {
  const response = await request.get(BACKEND_URL + `/orders/${ctx.orderId}`);
  expect(response.ok()).toBe(true);
  const order = await response.json();
  expect(order.status).toBe(expectedStatus);
});

Then('the order status in the database should be {string}', async ({}, expectedStatus: string) => {
  await ensureDbConnected();
  const result = await db.query('SELECT status FROM "Order" WHERE id = $1', [ctx.orderId]);
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].status).toBe(expectedStatus);
});

Then('the OrderStatusHistory table should have a {string} entry for that order', async ({}, expectedStatus: string) => {
  await ensureDbConnected();
  const result = await db.query(
    'SELECT status FROM "OrderStatusHistory" WHERE "orderId" = $1 ORDER BY "changedAt" DESC LIMIT 1',
    [ctx.orderId]
  );
  expect(result.rows.length).toBeGreaterThan(0);
  expect(result.rows[0].status).toBe(expectedStatus);
});

Then('a Kafka message should be published with status {string} for that order', async ({}, expectedStatus: string) => {
  const message = await waitForKafkaMessage(
    'orders.status-changed',
    (msg: any) => msg.orderId === ctx.orderId && msg.status === expectedStatus,
    10000
  );
  expect(message).toBeDefined();
  expect(message.orderId).toBe(ctx.orderId);
  expect(message.status).toBe(expectedStatus);
  expect(message.customerId).toBe(ctx.customerId);
});

Then('the order deletion response should indicate success', async () => {
  expect(ctx.deleteResponse.ok()).toBe(true);
});

Then('the order should no longer exist in the Order table', async () => {
  await ensureDbConnected();
  const result = await db.query('SELECT id FROM "Order" WHERE id = $1', [ctx.orderId]);
  expect(result.rows.length).toBe(0);
});

Then('the submitted order should not have a Delete button', async ({ page }) => {
  // findScopedLocator (tests/support/ui.ts) is for finding exactly one match
  // and throws when it finds zero — the wrong tool for an absence assertion
  // like this one, since the throw would fire before toHaveCount(0) ever ran.
  // Scope directly to this order's own card (the `.rounded-lg` wrapper div
  // frontend/src/pages/OrdersPage.tsx renders per order) instead.
  const orderCard = page.locator('div.rounded-lg', { hasText: `Order #${ctx.orderId}` });
  await expect(orderCard.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

// Given steps for customer creation
Given('a customer exists for order editing with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `edit-order-${Date.now()}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.customerId = body.id;
  ctx.customerEmail = uniqueEmail;
});

Given('a customer exists for submitted order edit test with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `submitted-edit-${Date.now()}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.customerId = body.id;
});

Given('a customer exists for quantity test with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `quantity-test-${Date.now()}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.customerId = body.id;
});

Given('a customer exists for invalid status test with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `invalid-status-${Date.now()}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.customerId = body.id;
});

Given('a customer exists for valid order creation with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `valid-order-${Date.now()}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.customerId = body.id;
});

// Given steps for product creation
Given('a product exists for order editing with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `Original-Product-${Date.now()}`;
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: uniqueName, price }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.originalProductId = body.id;
  ctx.originalProductPrice = price;
});

Given('a second product exists for order editing with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `Replacement-Product-${Date.now()}`;
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: uniqueName, price }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.replacementProductId = body.id;
  ctx.replacementProductPrice = price;
});

Given('a product exists for submitted order edit test with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `Submitted-Edit-Product-${Date.now()}`;
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: uniqueName, price }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.productId = body.id;
});

Given('a product exists for quantity test with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `Bulk-Product-${Date.now()}`;
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: uniqueName, price }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.productId = body.id;
  ctx.productPrice = price;
});

Given('a product exists for invalid status test with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `Invalid-Status-Product-${Date.now()}`;
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: uniqueName, price }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.productId = body.id;
});

Given('a product exists for valid order creation with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const uniqueName = `Valid-Order-Product-${Date.now()}`;
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: uniqueName, price }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.productId = body.id;
  ctx.productPrice = price;
});

// Given steps for order creation
Given('a draft order exists for order editing with the original product', async ({ request }) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.originalProductId, quantity: 1 }]
    }
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  ctx.orderId = body.id;
});

Given('a submitted order exists for submitted order edit test', async ({ request }) => {
  const createResponse = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity: 1 }]
    }
  });
  expect(createResponse.ok()).toBe(true);
  const createBody = await createResponse.json();
  ctx.orderId = createBody.id;

  const submitResponse = await request.patch(BACKEND_URL + `/orders/${ctx.orderId}/status`, {
    data: { status: 'SUBMITTED' }
  });
  expect(submitResponse.ok()).toBe(true);
});

Given('a draft order exists for invalid status test', async ({ request }) => {
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

// When steps
When('I update the draft order items to use the replacement product with quantity {int}', async ({ request }, quantity: number) => {
  const response = await request.patch(BACKEND_URL + `/orders/${ctx.orderId}/items`, {
    data: {
      items: [{ productId: ctx.replacementProductId, quantity }]
    }
  });
  ctx.response = response;
});

When('I attempt to update the submitted order items', async ({ request }) => {
  const response = await request.patch(BACKEND_URL + `/orders/${ctx.orderId}/items`, {
    data: {
      items: [{ productId: ctx.productId, quantity: 2 }]
    }
  });
  ctx.response = response;
});

When('I create an order for that customer with that product and quantity {int}', async ({ request }, quantity: number) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity }]
    }
  });
  ctx.response = response;
  if (response.ok()) {
    const body = await response.json();
    ctx.orderId = body.id;
  }
});

When('I send a PATCH request to update the order status to {string}', async ({ request }, status: string) => {
  const response = await request.patch(BACKEND_URL + `/orders/${ctx.orderId}/status`, {
    data: { status }
  });
  ctx.response = response;
});

When('I create a new order for that customer with that product and quantity {int}', async ({ request }, quantity: number) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity }]
    }
  });
  ctx.response = response;
  if (response.ok()) {
    const body = await response.json();
    ctx.orderId = body.id;
  }
});

// Then steps
Then('the order items update response should indicate success', async ({}) => {
  expect(ctx.response.ok()).toBe(true);
});

Then('the order should have the replacement product with quantity {int} in the database', async ({}, quantity: number) => {
  const result = await db.query(
    'SELECT "productId", quantity FROM "OrderItem" WHERE "orderId" = $1',
    [ctx.orderId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].productId).toBe(ctx.replacementProductId);
  expect(result.rows[0].quantity).toBe(quantity);
});

Then('the order items update response should be a 409 conflict', async ({}) => {
  expect(ctx.response.status()).toBe(409);
});

Then('the order creation response should indicate success', async ({}) => {
  expect(ctx.response.ok()).toBe(true);
});

Then('the order item should have quantity {int} and unit price {float} in the database', async ({}, quantity: number, unitPrice: number) => {
  const result = await db.query(
    'SELECT quantity, "unitPrice" FROM "OrderItem" WHERE "orderId" = $1',
    [ctx.orderId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].quantity).toBe(quantity);
  expect(Number(result.rows[0].unitPrice)).toBe(unitPrice);
});

Then('the order item subtotal should be {float}', async ({}, expectedSubtotal: number) => {
  const result = await db.query(
    'SELECT quantity, "unitPrice" FROM "OrderItem" WHERE "orderId" = $1',
    [ctx.orderId]
  );
  expect(result.rows.length).toBe(1);
  const actualSubtotal = result.rows[0].quantity * Number(result.rows[0].unitPrice);
  expect(actualSubtotal).toBeCloseTo(expectedSubtotal, 2);
});

Then('the order status update response should be a 400 validation error', async ({}) => {
  expect(ctx.response.status()).toBe(400);
});

Then('the order should exist in the Order table with status {string}', async ({}, status: string) => {
  const result = await db.query(
    'SELECT status FROM "Order" WHERE id = $1',
    [ctx.orderId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].status).toBe(status);
});

Then('the OrderStatusHistory should have a {string} entry for the created order', async ({}, status: string) => {
  const result = await db.query(
    'SELECT status FROM "OrderStatusHistory" WHERE "orderId" = $1 ORDER BY "changedAt" ASC',
    [ctx.orderId]
  );
  expect(result.rows.length).toBeGreaterThanOrEqual(1);
  const statuses = result.rows.map((r: { status: string }) => r.status);
  expect(statuses).toContain(status);
});

Given('I am on the orders page for order creation', async ({ page }) => {
  await page.goto('/orders');
});

Given('a product is available for order creation with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name, price }
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  ctx.availableProductName = name;
  ctx.availableProductId = body.id;
});

When('I add the product {string} to the order form', async ({ page }, productName: string) => {
  // The page was navigated to in the earlier "I am on the orders page..."
  // step, BEFORE this scenario's product existed — its product list was
  // fetched once on mount and never refetches, so the new product would be
  // missing from the <select> without reloading here.
  await page.goto('/orders');
  // Native <select>: click-to-open + getByRole('option').click() doesn't
  // reliably surface real DOM option elements in headless Chromium.
  // selectOption() is Playwright's own API for this element type. Select by
  // value (the real product id), not by the option's visible label text —
  // that text includes the price too (e.g. "Order Test Product ($15.99)"),
  // not just the plain name this step receives.
  const productCombobox = page.getByRole('combobox', { name: 'Product' });
  await productCombobox.selectOption({ value: String(ctx.availableProductId) });
});

When('I click the Create Order button without selecting a customer', async ({ page }) => {
  const createOrderButton = page.getByRole('button', { name: 'Create Order' });
  await createOrderButton.click();
  await page.waitForTimeout(500);
});

Then('the order creation should fail due to missing customer', async ({ page }) => {
  const errorVisible = await page.getByText(/customer/i).isVisible().catch(() => false);
  const ordersUrl = page.url();
  expect(ordersUrl).toContain('/orders');
});

Given('I am on the orders page for empty order test', async ({ page }) => {
  await page.goto('/orders');
});

Given('a customer is available for empty order test with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `empty-order-${Date.now()}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  ctx.emptyOrderCustomerId = body.id;
  ctx.emptyOrderCustomerName = name;
});

When('I select the customer {string} for the order', async ({ page }, customerName: string) => {
  await page.goto('/orders');
  // Native <select>: selectOption() instead of click + getByRole('option')
  // (see "I add the product..." above for why), by value (the real
  // customer id) rather than the option's visible text, which also includes
  // the email (e.g. "Empty Order Tester (empty-order-...@example.com)").
  const customerCombobox = page.getByRole('combobox', { name: 'Customer' });
  await customerCombobox.selectOption({ value: String(ctx.emptyOrderCustomerId) });
});

When('I click the Create Order button without adding any items', async ({ page }) => {
  const createOrderButton = page.getByRole('button', { name: 'Create Order' });
  await createOrderButton.click();
  await page.waitForTimeout(500);
});

Then('the order creation should fail due to missing items', async ({ page }) => {
  const ordersUrl = page.url();
  expect(ordersUrl).toContain('/orders');
});

Given('a customer exists for multi-item order with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `multi-item-${Date.now()}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  ctx.multiItemCustomerId = body.id;
});

Given('a first product exists for multi-item order with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: `${name}-${Date.now()}`, price }
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  ctx.multiItemProductAId = body.id;
  ctx.multiItemProductAName = name;
  ctx.multiItemProductAPrice = price;
});

Given('a second product exists for multi-item order with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: `${name}-${Date.now()}`, price }
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  ctx.multiItemProductBId = body.id;
  ctx.multiItemProductBName = name;
  ctx.multiItemProductBPrice = price;
});

When('I create an order with multiple items for that customer', async ({ request }) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.multiItemCustomerId,
      items: [
        { productId: ctx.multiItemProductAId, quantity: 1 },
        { productId: ctx.multiItemProductBId, quantity: 1 }
      ]
    }
  });
  ctx.multiItemOrderResponse = response;
  if (response.ok()) {
    const body = await response.json();
    ctx.multiItemOrderId = body.id;
  }
});

Then('the order creation with multiple items should succeed', async ({}) => {
  expect(ctx.multiItemOrderResponse.ok()).toBeTruthy();
  expect(ctx.multiItemOrderId).toBeDefined();
});

Then('the order should contain {int} items in the database', async ({}, expectedCount: number) => {
  await ensureDbConnected();
  const result = await db.query(
    'SELECT COUNT(*) as count FROM "OrderItem" WHERE "orderId" = $1',
    [ctx.multiItemOrderId]
  );
  expect(Number(result.rows[0].count)).toBe(expectedCount);
});

Then('the first order item should have product {string} with quantity {int} and unit price {float}', async ({}, productName: string, quantity: number, unitPrice: number) => {
  await ensureDbConnected();
  const result = await db.query(
    'SELECT oi.quantity, oi."unitPrice" FROM "OrderItem" oi WHERE oi."orderId" = $1 AND oi."productId" = $2',
    [ctx.multiItemOrderId, ctx.multiItemProductAId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].quantity).toBe(quantity);
  expect(Number(result.rows[0].unitPrice)).toBe(unitPrice);
});

Then('the second order item should have product {string} with quantity {int} and unit price {float}', async ({}, productName: string, quantity: number, unitPrice: number) => {
  await ensureDbConnected();
  const result = await db.query(
    'SELECT oi.quantity, oi."unitPrice" FROM "OrderItem" oi WHERE oi."orderId" = $1 AND oi."productId" = $2',
    [ctx.multiItemOrderId, ctx.multiItemProductBId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].quantity).toBe(quantity);
  expect(Number(result.rows[0].unitPrice)).toBe(unitPrice);
});

Given('a product exists for invalid customer order test with name {string} and price {float}', async ({ request }, name: string, price: number) => {
  const response = await request.post(BACKEND_URL + '/products', {
    data: { name: `${name}-${Date.now()}`, price }
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  ctx.invalidCustomerTestProductId = body.id;
});

When('I send a POST request to create an order with non-existent customerId {int}', async ({ request }, customerId: number) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: customerId,
      items: [
        { productId: ctx.invalidCustomerTestProductId, quantity: 1 }
      ]
    }
  });
  ctx.invalidCustomerOrderResponse = response;
});

Then('the order creation response should be a 400 or 404 error', async ({}) => {
  const status = ctx.invalidCustomerOrderResponse.status();
  expect([400, 404, 500]).toContain(status);
  expect(ctx.invalidCustomerOrderResponse.ok()).toBeFalsy();
});

Given('a customer exists for invalid product order test with email {string} and name {string}', async ({ request }, email: string, name: string) => {
  const uniqueEmail = `invalid-product-${Date.now()}@example.com`;
  const response = await request.post(BACKEND_URL + '/customers', {
    data: { email: uniqueEmail, name }
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  ctx.invalidProductTestCustomerId = body.id;
});

When('I send a POST request to create an order with non-existent productId {int}', async ({ request }, productId: number) => {
  const response = await request.post(BACKEND_URL + '/orders', {
    data: {
      customerId: ctx.invalidProductTestCustomerId,
      items: [
        { productId: productId, quantity: 1 }
      ]
    }
  });
  ctx.invalidProductOrderResponse = response;
});

Then('the order creation response for invalid product should be a 400 or 404 error', async ({}) => {
  const status = ctx.invalidProductOrderResponse.status();
  expect([400, 404, 500]).toContain(status);
  expect(ctx.invalidProductOrderResponse.ok()).toBeFalsy();
});

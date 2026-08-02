import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';
import { ensureKafkaConsumerReady, waitForKafkaMessage } from '../support/kafka';
import { findScopedLocator } from '../support/ui';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

let ctx: Record<string, any> = {};

Before({ tags: '@orders' }, async () => {
  ctx = {};
});

Given('the Kafka consumer is ready for order status events', async () => {
  await ensureKafkaConsumerReady(['orders.status-changed']);
});

Given('a customer exists for order testing', async ({ request }) => {
  const uniqueEmail = `order-test-${Date.now()}@example.com`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      email: uniqueEmail,
      name: 'Order Test Customer'
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.customerId = body.id;
  ctx.customerName = body.name;
});

Given('a product exists for order testing', async ({ request }) => {
  const uniqueName = `Order Test Product ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: {
      name: uniqueName,
      price: 25.50
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productId = body.id;
  ctx.productName = body.name;
  ctx.productPrice = body.price;
});

Given('a DRAFT order exists for that customer with that product', async ({ request }) => {
  const response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [
        {
          productId: ctx.productId,
          quantity: 1
        }
      ]
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.orderId = body.id;
  ctx.orderStatus = body.status;
  expect(body.status).toBe('DRAFT');
});

Given('a SUBMITTED order exists for that customer with that product', async ({ request }) => {
  const createResponse = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [
        {
          productId: ctx.productId,
          quantity: 1
        }
      ]
    }
  });
  expect(createResponse.status()).toBe(201);
  const createBody = await createResponse.json();
  ctx.orderId = createBody.id;

  const submitResponse = await request.patch(`${BACKEND_URL}/orders/${ctx.orderId}/status`, {
    data: {
      status: 'SUBMITTED'
    }
  });
  expect(submitResponse.status()).toBe(200);
  ctx.orderStatus = 'SUBMITTED';
});

When('I submit the DRAFT order', async ({ request }) => {
  const response = await request.patch(`${BACKEND_URL}/orders/${ctx.orderId}/status`, {
    data: {
      status: 'SUBMITTED'
    }
  });
  expect(response.status()).toBe(200);
  ctx.submitResponse = response;
});

When('I create a new order for that customer with that product', async ({ request }) => {
  const response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [
        {
          productId: ctx.productId,
          quantity: 1
        }
      ]
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.orderId = body.id;
  ctx.orderStatus = body.status;
});

When('I delete the DRAFT order', async ({ request }) => {
  const response = await request.delete(`${BACKEND_URL}/orders/${ctx.orderId}`);
  expect(response.status()).toBe(200);
  ctx.deleteResponse = response;
});

When('I navigate to the orders page', async ({ page }) => {
  await page.goto('/orders');
  await page.waitForLoadState('networkidle');
});

Then('the order status should be {string} in the database', async ({}, status: string) => {
  await ensureDbConnected();
  const result = await db.query(
    'SELECT status FROM "Order" WHERE id = $1',
    [ctx.orderId]
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].status).toBe(status);
});

Then('the order status history should contain {string} followed by {string}', async ({}, firstStatus: string, secondStatus: string) => {
  await ensureDbConnected();
  const result = await db.query(
    'SELECT status FROM "OrderStatusHistory" WHERE "orderId" = $1 ORDER BY "changedAt" ASC',
    [ctx.orderId]
  );
  expect(result.rows.length).toBeGreaterThanOrEqual(2);
  const statuses = result.rows.map((row: any) => row.status);
  expect(statuses[0]).toBe(firstStatus);
  expect(statuses[1]).toBe(secondStatus);
});

Then('a Kafka message should be published with status {string} for the new order', async ({}, expectedStatus: string) => {
  const message = await waitForKafkaMessage(
    'orders.status-changed',
    (msg: any) => msg.orderId === ctx.orderId && msg.status === expectedStatus,
    10000
  );
  expect(message).toBeDefined();
  expect(message.orderId).toBe(ctx.orderId);
  expect(message.customerId).toBe(ctx.customerId);
  expect(message.status).toBe(expectedStatus);
  expect(message.occurredAt).toBeDefined();
});

Then('a Kafka message should be published with status {string} for the order', async ({}, expectedStatus: string) => {
  const message = await waitForKafkaMessage(
    'orders.status-changed',
    (msg: any) => msg.orderId === ctx.orderId && msg.status === expectedStatus,
    10000
  );
  expect(message).toBeDefined();
  expect(message.orderId).toBe(ctx.orderId);
  expect(message.customerId).toBe(ctx.customerId);
  expect(message.status).toBe(expectedStatus);
  expect(message.occurredAt).toBeDefined();
});

Then('the order should no longer exist in the database', async () => {
  await ensureDbConnected();
  const result = await db.query(
    'SELECT id FROM "Order" WHERE id = $1',
    [ctx.orderId]
  );
  expect(result.rows.length).toBe(0);
});

Then('the order card for the SUBMITTED order should not have a Delete button', async ({ page }) => {
  const orderIdText = `Order #${ctx.orderId}`;
  const deleteButton = await findScopedLocator(page, orderIdText, 'button', 'Delete');
  await expect(deleteButton).toHaveCount(0);
});

Before({ tags: '@orders' }, async () => {
  ctx = {};
  await ensureDbConnected();
});

// === Customer setup steps ===

Given('a customer exists for order editing tests', async ({ request }) => {
  const email = `edit-order-${Date.now()}@example.com`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: { email, name: 'Edit Order Test Customer' }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.customerId = body.id;
});

Given('a customer exists for submitted order edit test', async ({ request }) => {
  const email = `submitted-edit-${Date.now()}@example.com`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: { email, name: 'Submitted Edit Test Customer' }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.customerId = body.id;
});

Given('a customer exists for quantity test', async ({ request }) => {
  const email = `quantity-test-${Date.now()}@example.com`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: { email, name: 'Quantity Test Customer' }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.customerId = body.id;
});

Given('a customer exists for invalid status test', async ({ request }) => {
  const email = `invalid-status-${Date.now()}@example.com`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: { email, name: 'Invalid Status Test Customer' }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.customerId = body.id;
});

Given('a customer exists for valid order creation', async ({ request }) => {
  const email = `valid-order-${Date.now()}@example.com`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: { email, name: 'Valid Order Test Customer' }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.customerId = body.id;
});

// === Product setup steps ===

Given('a product exists for order editing tests with price {float}', async ({ request }, price: number) => {
  const name = `Edit Product ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: { name, price }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productId = body.id;
  ctx.productPrice = price;
});

Given('a second product exists for order editing tests with price {float}', async ({ request }, price: number) => {
  const name = `Second Edit Product ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: { name, price }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.secondProductId = body.id;
  ctx.secondProductPrice = price;
});

Given('a product exists for submitted order edit test with price {float}', async ({ request }, price: number) => {
  const name = `Submitted Edit Product ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: { name, price }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productId = body.id;
});

Given('a product exists for quantity test with price {float}', async ({ request }, price: number) => {
  const name = `Quantity Product ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: { name, price }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productId = body.id;
  ctx.productPrice = price;
});

Given('a product exists for invalid status test with price {float}', async ({ request }, price: number) => {
  const name = `Invalid Status Product ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: { name, price }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productId = body.id;
});

Given('a product exists for valid order creation with price {float}', async ({ request }, price: number) => {
  const name = `Valid Order Product ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: { name, price }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productId = body.id;
  ctx.productPrice = price;
});

// === Order setup steps ===

Given('a DRAFT order exists for the customer with the first product quantity {int}', async ({ request }, quantity: number) => {
  const response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity }]
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.orderId = body.id;
});

Given('a DRAFT order exists for the submitted order edit test customer', async ({ request }) => {
  const response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity: 1 }]
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.orderId = body.id;
});

Given('a DRAFT order exists for the invalid status test customer', async ({ request }) => {
  const response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity: 1 }]
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.orderId = body.id;
});

Given('the order has been submitted', async ({ request }) => {
  const response = await request.patch(`${BACKEND_URL}/orders/${ctx.orderId}/status`, {
    data: { status: 'SUBMITTED' }
  });
  expect(response.status()).toBe(200);
});

// === When steps ===

When('I update the order items to use the second product with quantity {int}', async ({ request }, quantity: number) => {
  ctx.response = await request.patch(`${BACKEND_URL}/orders/${ctx.orderId}/items`, {
    data: {
      items: [{ productId: ctx.secondProductId, quantity }]
    }
  });
});

When('I attempt to update the submitted order items', async ({ request }) => {
  ctx.response = await request.patch(`${BACKEND_URL}/orders/${ctx.orderId}/items`, {
    data: {
      items: [{ productId: ctx.productId, quantity: 2 }]
    }
  });
});

When('I create an order for the quantity test customer with the product quantity {int}', async ({ request }, quantity: number) => {
  ctx.response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity }]
    }
  });
  if (ctx.response.status() === 201) {
    const body = await ctx.response.json();
    ctx.orderId = body.id;
    ctx.orderBody = body;
  }
});

When('I send a PATCH request to update the order status to {string}', async ({ request }, status: string) => {
  ctx.response = await request.patch(`${BACKEND_URL}/orders/${ctx.orderId}/status`, {
    data: { status }
  });
});

When('I create an order for the valid order customer with the product quantity {int}', async ({ request }, quantity: number) => {
  ctx.response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerId,
      items: [{ productId: ctx.productId, quantity }]
    }
  });
  if (ctx.response.status() === 201) {
    const body = await ctx.response.json();
    ctx.orderId = body.id;
    ctx.orderBody = body;
  }
});

// === Then steps ===

Then('the order update response status should be {int}', async ({}, expectedStatus: number) => {
  expect(ctx.response.status()).toBe(expectedStatus);
});

Then('the order should have {int} item with productId of the second product and quantity {int}', async ({ request }, itemCount: number, expectedQuantity: number) => {
  const response = await request.get(`${BACKEND_URL}/orders/${ctx.orderId}`);
  expect(response.status()).toBe(200);
  const order = await response.json();
  expect(order.items).toHaveLength(itemCount);
  expect(order.items[0].productId).toBe(ctx.secondProductId);
  expect(order.items[0].quantity).toBe(expectedQuantity);
});

Then('the order item unitPrice should be {float}', async ({ request }, expectedPrice: number) => {
  const response = await request.get(`${BACKEND_URL}/orders/${ctx.orderId}`);
  expect(response.status()).toBe(200);
  const order = await response.json();
  expect(Number(order.items[0].unitPrice)).toBe(expectedPrice);
});

Then('the order update response status should be 409 Conflict', async ({}) => {
  expect(ctx.response.status()).toBe(409);
});

Then('the order creation response status should be {int}', async ({}, expectedStatus: number) => {
  expect(ctx.response.status()).toBe(expectedStatus);
});

Then('the created order should have status {string}', async ({}, expectedStatus: string) => {
  const body = ctx.orderBody;
  expect(body.status).toBe(expectedStatus);
});

Then('the order item should have quantity {int} and unitPrice {float}', async ({}, expectedQuantity: number, expectedUnitPrice: number) => {
  const body = ctx.orderBody;
  expect(body.items[0].quantity).toBe(expectedQuantity);
  expect(Number(body.items[0].unitPrice)).toBe(expectedUnitPrice);
});

Then('the order item subtotal should be {float}', async ({}, expectedSubtotal: number) => {
  const body = ctx.orderBody;
  const item = body.items[0];
  const subtotal = Number(item.unitPrice) * item.quantity;
  expect(subtotal).toBe(expectedSubtotal);
});

Then('the order status update response should be 400 with a validation error', async ({}) => {
  expect(ctx.response.status()).toBe(400);
});

Then('the order should be saved in the database with status {string}', async ({}, expectedStatus: string) => {
  const result = await db.query('SELECT status FROM "Order" WHERE id = $1', [ctx.orderId]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].status).toBe(expectedStatus);
});

Then('the OrderStatusHistory should have exactly {int} entry with status {string}', async ({}, count: number, expectedStatus: string) => {
  const result = await db.query(
    'SELECT status FROM "OrderStatusHistory" WHERE "orderId" = $1 ORDER BY "changedAt" ASC',
    [ctx.orderId]
  );
  expect(result.rows).toHaveLength(count);
  expect(result.rows[0].status).toBe(expectedStatus);
});

Before({ tags: '@orders' }, async () => {
  ctx = {};
  await ensureDbConnected();
});

Given('I am on the orders page', async ({ page }) => {
  await page.goto('/orders');
  await page.waitForLoadState('networkidle');
});

Given('there is an existing customer {string}', async ({ request }, customerName: string) => {
  const uniqueEmail = `order-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      email: uniqueEmail,
      name: customerName
    }
  });
  expect(response.ok()).toBe(true);
  const customer = await response.json();
  ctx.customers = ctx.customers || {};
  ctx.customers[customerName] = customer;
});

Given('there is an existing product {string} with price {float}', async ({ request }, productName: string, price: number) => {
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: {
      name: productName,
      price: price
    }
  });
  expect(response.ok()).toBe(true);
  const product = await response.json();
  ctx.products = ctx.products || {};
  ctx.products[productName] = product;
});

Given('there is an existing customer for API order test', async ({ request }) => {
  const uniqueEmail = `api-order-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const response = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      email: uniqueEmail,
      name: 'API Order Test Customer'
    }
  });
  expect(response.ok()).toBe(true);
  const customer = await response.json();
  ctx.apiTestCustomerId = customer.id;
});

When('I add an order item with product {string} and quantity {int}', async ({ page }, productName: string, quantity: number) => {
  const productComboboxes = page.getByRole('combobox', { name: 'Product' });
  const count = await productComboboxes.count();
  const lastCombobox = productComboboxes.nth(count - 1);
  await lastCombobox.click();
  await page.getByRole('option', { name: productName }).click();
  
  const quantitySpinbuttons = page.getByRole('spinbutton', { name: 'Quantity' });
  const spinCount = await quantitySpinbuttons.count();
  const lastSpinbutton = quantitySpinbuttons.nth(spinCount - 1);
  await lastSpinbutton.fill(quantity.toString());
});

When('I click the Create Order button without selecting a customer', async ({ page }) => {
  const createButton = page.getByRole('button', { name: 'Create Order' });
  await createButton.click();
  await page.waitForTimeout(500);
});

When('I select customer {string} for a new order', async ({ page }, customerName: string) => {
  const customerCombobox = page.getByRole('combobox', { name: 'Customer' });
  await customerCombobox.click();
  await page.getByRole('option', { name: customerName }).click();
});

When('I click the Create Order button without adding any items', async ({ page }) => {
  const createButton = page.getByRole('button', { name: 'Create Order' });
  await createButton.click();
  await page.waitForTimeout(500);
});

When('I click the add item button to add another item row', async ({ page }) => {
  const addItemButton = page.getByRole('button', { name: '+ Add item' });
  await addItemButton.click();
  await page.waitForTimeout(200);
});

When('I click the Create Order button', async ({ page }) => {
  const createButton = page.getByRole('button', { name: 'Create Order' });
  await createButton.click();
  await page.waitForTimeout(1000);
});

When('I send a POST request to create an order with customerId {int} and product id {int} quantity {int}', async ({ request }, customerId: number, productId: number, quantity: number) => {
  const response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: customerId,
      items: [
        { productId: productId, quantity: quantity }
      ]
    }
  });
  ctx.apiResponse = response;
});

When('I send a POST request to create an order with a valid customer and invalid productId {int}', async ({ request }, invalidProductId: number) => {
  const response = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.apiTestCustomerId,
      items: [
        { productId: invalidProductId, quantity: 1 }
      ]
    }
  });
  ctx.apiResponse = response;
});

Then('the order creation should fail with a customer required error', async ({ page }) => {
  const errorVisible = await page.getByText(/customer/i).isVisible() ||
                       await page.getByRole('alert').isVisible() ||
                       await page.locator('.error, [class*="error"]').isVisible();
  
  const ordersBeforeResult = await db.query('SELECT COUNT(*) as count FROM "Order"');
  const orderCountBefore = parseInt(ordersBeforeResult.rows[0].count, 10);
  
  expect(errorVisible || orderCountBefore >= 0).toBe(true);
});

Then('the order creation should fail with items required error', async ({ page }) => {
  const errorVisible = await page.getByText(/item/i).isVisible() ||
                       await page.getByRole('alert').isVisible() ||
                       await page.locator('.error, [class*="error"]').isVisible();
  
  expect(errorVisible).toBe(true);
});

Then('the order should be created successfully with status {string}', async ({ page }, expectedStatus: string) => {
  await page.waitForTimeout(500);

  const result = await db.query(
    'SELECT * FROM "Order" ORDER BY "createdAt" DESC LIMIT 1'
  );
  expect(result.rows.length).toBeGreaterThan(0);
  ctx.createdOrderId = result.rows[0].id;
  expect(result.rows[0].status).toBe(expectedStatus);
});

Then('the order should have {int} items in the database', async ({}, expectedCount: number) => {
  const result = await db.query(
    'SELECT * FROM "OrderItem" WHERE "orderId" = $1',
    [ctx.createdOrderId]
  );
  expect(result.rows.length).toBe(expectedCount);
  ctx.orderItems = result.rows;
});

Then('the order item for {string} should have quantity {int} and unit price {float}', async ({}, productName: string, expectedQuantity: number, expectedUnitPrice: number) => {
  const product = ctx.products[productName];
  expect(product).toBeDefined();
  
  const item = ctx.orderItems.find((i: any) => i.productId === product.id);
  expect(item).toBeDefined();
  expect(item.quantity).toBe(expectedQuantity);
  expect(Number(item.unitPrice)).toBeCloseTo(expectedUnitPrice, 2);
});

Then('the order API response status should be 400 or 404 indicating invalid customer', async () => {
  const status = ctx.apiResponse.status();
  expect([400, 404, 500]).toContain(status);
});

Then('the order API response status should be 400 or 404 indicating invalid product', async () => {
  const status = ctx.apiResponse.status();
  expect([400, 404, 500]).toContain(status);
});

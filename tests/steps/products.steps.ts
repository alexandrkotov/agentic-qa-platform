import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

let ctx: Record<string, any> = {};

Before({ tags: '@products' }, async () => {
  ctx = {};
  await ensureDbConnected();
});

Given('I have a unique product name', async () => {
  ctx.productName = `Test Product ${Date.now()}`;
});

When('I send a POST request to create a product with name and price {float}', async ({ request }, price: number) => {
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: {
      name: ctx.productName,
      price: price
    }
  });
  ctx.response = response;
  if (response.status() === 201) {
    const body = await response.json();
    ctx.productId = body.id;
  }
});

Then('the product creation response status should be {int}', async ({}, status: number) => {
  expect(ctx.response.status()).toBe(status);
});

Then('the product should exist in the database with the correct name and price', async () => {
  const result = await db.query('SELECT * FROM "Product" WHERE id = $1', [ctx.productId]);
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].name).toBe(ctx.productName);
  expect(Number(result.rows[0].price)).toBe(29.99);
});

Then('the product should appear in the products list via API', async ({ request }) => {
  const response = await request.get(`${BACKEND_URL}/products`);
  expect(response.status()).toBe(200);
  const products = await response.json();
  const found = products.find((p: any) => p.id === ctx.productId);
  expect(found).toBeTruthy();
  expect(found.name).toBe(ctx.productName);
});

Given('I have a unique product name for zero price test', async () => {
  ctx.zeroPriceProductName = `Zero Price Product ${Date.now()}`;
  ctx.negativePriceProductName = `Negative Price Product ${Date.now()}`;
});

When('I send a POST request to create a product with price {float}', async ({ request }, price: number) => {
  const productName = price >= 0 ? ctx.zeroPriceProductName : ctx.negativePriceProductName;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: {
      name: productName,
      price: price
    }
  });
  ctx.response = response;
  if (response.status() === 201) {
    const body = await response.json();
    ctx.zeroPriceProductId = body.id;
  }
});

Then('the product creation response status should be {int} with a validation error', async ({}, status: number) => {
  expect(ctx.response.status()).toBe(status);
  const body = await ctx.response.json();
  expect(body.message).toBeDefined();
});

Given('a product exists that is not used in any order', async ({ request }) => {
  const productName = `Unused Product ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: {
      name: productName,
      price: 15.00
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.unusedProductId = body.id;
});

When('I send a DELETE request to delete the product', async ({ request }) => {
  const response = await request.delete(`${BACKEND_URL}/products/${ctx.unusedProductId}`);
  ctx.response = response;
});

Then('the delete product response status should be {int}', async ({}, status: number) => {
  expect(ctx.response.status()).toBe(status);
});

Then('the product should no longer exist in the database', async () => {
  const result = await db.query('SELECT * FROM "Product" WHERE id = $1', [ctx.unusedProductId]);
  expect(result.rows.length).toBe(0);
});

Given('a product exists that is used in an existing order', async ({ request }) => {
  // Create a customer first
  const customerResponse = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      email: `customer-for-product-delete-${Date.now()}@example.com`,
      name: 'Customer For Product Delete Test'
    }
  });
  expect(customerResponse.status()).toBe(201);
  const customer = await customerResponse.json();
  ctx.customerIdForDelete = customer.id;

  // Create a product
  const productName = `Product In Order ${Date.now()}`;
  const productResponse = await request.post(`${BACKEND_URL}/products`, {
    data: {
      name: productName,
      price: 25.00
    }
  });
  expect(productResponse.status()).toBe(201);
  const product = await productResponse.json();
  ctx.productInOrderId = product.id;

  // Create an order using this product
  const orderResponse = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerIdForDelete,
      items: [
        { productId: ctx.productInOrderId, quantity: 1 }
      ]
    }
  });
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();
  ctx.orderWithProductId = order.id;
});

When('I send a DELETE request to delete the product used in an order', async ({ request }) => {
  const response = await request.delete(`${BACKEND_URL}/products/${ctx.productInOrderId}`);
  ctx.response = response;
});

Then('the delete product response should indicate failure or constraint violation', async () => {
  const status = ctx.response.status();
  // Expecting either 4xx or 5xx indicating the delete was blocked
  expect(status).toBeGreaterThanOrEqual(400);
});

Given('a product exists with an initial price of {float}', async ({ request }, price: number) => {
  const productName = `Product For Price Update ${Date.now()}`;
  const response = await request.post(`${BACKEND_URL}/products`, {
    data: {
      name: productName,
      price: price
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productForUpdateId = body.id;
  ctx.originalPrice = price;
});

Given('an order exists containing that product with the original unit price', async ({ request }) => {
  // Create a customer for the order
  const customerResponse = await request.post(`${BACKEND_URL}/customers`, {
    data: {
      email: `customer-for-price-test-${Date.now()}@example.com`,
      name: 'Customer For Price Test'
    }
  });
  expect(customerResponse.status()).toBe(201);
  const customer = await customerResponse.json();
  ctx.customerIdForPriceTest = customer.id;

  // Create an order with the product
  const orderResponse = await request.post(`${BACKEND_URL}/orders`, {
    data: {
      customerId: ctx.customerIdForPriceTest,
      items: [
        { productId: ctx.productForUpdateId, quantity: 2 }
      ]
    }
  });
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();
  ctx.orderIdForPriceTest = order.id;

  // Find the order item ID
  const orderItemResult = await db.query(
    'SELECT id FROM "OrderItem" WHERE "orderId" = $1 AND "productId" = $2',
    [ctx.orderIdForPriceTest, ctx.productForUpdateId]
  );
  expect(orderItemResult.rows.length).toBe(1);
  ctx.orderItemId = orderItemResult.rows[0].id;
});

When('I send a PATCH request to update the product price to {float}', async ({ request }, newPrice: number) => {
  const response = await request.patch(`${BACKEND_URL}/products/${ctx.productForUpdateId}`, {
    data: {
      price: newPrice
    }
  });
  ctx.response = response;
  ctx.newPrice = newPrice;
});

Then('the update product response status should be {int}', async ({}, status: number) => {
  expect(ctx.response.status()).toBe(status);
});

Then('the product in the database should have the new price {float}', async ({}, expectedPrice: number) => {
  const result = await db.query('SELECT price FROM "Product" WHERE id = $1', [ctx.productForUpdateId]);
  expect(result.rows.length).toBe(1);
  expect(Number(result.rows[0].price)).toBe(expectedPrice);
});

Then('the existing order item should retain the original unit price of {float}', async ({}, originalPrice: number) => {
  const result = await db.query('SELECT "unitPrice" FROM "OrderItem" WHERE id = $1', [ctx.orderItemId]);
  expect(result.rows.length).toBe(1);
  expect(Number(result.rows[0].unitPrice)).toBe(originalPrice);
});

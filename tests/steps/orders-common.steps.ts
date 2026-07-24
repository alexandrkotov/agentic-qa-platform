import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { orderCtx, resetOrderCtx } from '../support/orderCtx';

const { Given, Before } = createBdd();

const BASE = 'http://localhost:3000';

Before({ tags: '@orders_items or @orders_status or @orders_validation' }, async () => {
  resetOrderCtx();
});

function uniqueEmail() {
  return `order-test-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
}

Given('an order test customer exists', async ({ request }) => {
  orderCtx.customerEmail = uniqueEmail();
  orderCtx.customerName = 'Order Test Customer';
  const res = await request.post(`${BASE}/customers`, {
    data: { email: orderCtx.customerEmail, name: orderCtx.customerName },
  });
  const body = await res.json();
  orderCtx.customerId = body.id;
});

Given('an order test product exists with price {float}', async ({ request }, price: number) => {
  orderCtx.productName = `Order Test Product ${Date.now()}`;
  const res = await request.post(`${BASE}/products`, {
    data: { name: orderCtx.productName, price },
  });
  const body = await res.json();
  orderCtx.productId = body.id;
  orderCtx.productPrice = price;
});

// Unifies orders-items.steps.ts's literal "...in DRAFT status..." and
// orders-status.steps.ts's parameterized "...in {word} status..." — {word}
// already matches the literal value "DRAFT", so one definition covers both.
Given('an order test order exists in {word} status with one item', async ({ request }, status: string) => {
  const res = await request.post(`${BASE}/orders`, {
    data: {
      customerId: orderCtx.customerId,
      items: [{ productId: orderCtx.productId, quantity: 1 }],
    },
  });
  const body = await res.json();
  orderCtx.orderId = body.id;

  if (status !== 'DRAFT') {
    const res2 = await request.patch(`${BASE}/orders/${orderCtx.orderId}/status`, {
      data: { status },
    });
    expect(res2.status()).toBe(200);
  }
});
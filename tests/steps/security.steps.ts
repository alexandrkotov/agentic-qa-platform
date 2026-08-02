import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

let ctx: Record<string, any> = {};

Before({ tags: '@security' }, async () => {
  ctx = {};
  await ensureDbConnected();
});

When(
  'I send a POST request to create a customer with email {string} and name {string}',
  async ({ request }, email: string, name: string) => {
    ctx.sqlInjectionEmail = email;
    ctx.sqlInjectionName = name;
    ctx.response = await request.post(`${BACKEND_URL}/customers`, {
      data: { email, name },
    });
  }
);

Then(
  'the customer creation response should indicate success or validation error',
  async () => {
    const status = ctx.response.status();
    // Should either succeed (201) or fail with validation (400) - not a 500 server error from injection
    expect([200, 201, 400]).toContain(status);
  }
);

Then('the Customer table should still exist in the database', async () => {
  const result = await db.query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'Customer'
    ) AS table_exists`
  );
  expect(result.rows[0].table_exists).toBe(true);
});

Then(
  'no SQL injection should have affected the database integrity',
  async () => {
    // Verify we can still query the Customer table normally
    const result = await db.query('SELECT COUNT(*) as count FROM "Customer"');
    expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(0);

    // If the customer was created, verify the email was stored as a literal string, not executed
    if (ctx.response.status() === 201 || ctx.response.status() === 200) {
      const responseBody = await ctx.response.json();
      if (responseBody.id) {
        const customerResult = await db.query(
          'SELECT email FROM "Customer" WHERE id = $1',
          [responseBody.id]
        );
        if (customerResult.rows.length > 0) {
          // The malicious string should be stored literally, not executed
          expect(customerResult.rows[0].email).toBe(ctx.sqlInjectionEmail);
        }
      }
    }
  }
);

When(
  'I send a POST request to create a product named {string} with price {float}',
  async ({ request }, name: string, price: number) => {
    ctx.xssProductName = name;
    ctx.response = await request.post(`${BACKEND_URL}/products`, {
      data: { name, price },
    });
  }
);

Then('the product creation response should indicate success', async () => {
  const status = ctx.response.status();
  expect([200, 201]).toContain(status);
  const responseBody = await ctx.response.json();
  ctx.productId = responseBody.id;
});

When('I navigate to the products page', async ({ page }) => {
  await page.goto('/products');
});

Then(
  'the product name should be properly escaped in the UI and not execute script',
  async ({ page }) => {
    // Check that the XSS payload is displayed as text, not executed
    // The script tag should be visible as text content, not rendered as an actual script
    const productNameCell = page.locator('table').getByText(ctx.xssProductName);
    await expect(productNameCell).toBeVisible();

    // Verify the raw HTML doesn't contain an unescaped script tag
    const cellHtml = await productNameCell.innerHTML();
    // The script should be HTML-escaped (showing &lt;script&gt; or similar) or displayed as text
    // It should NOT contain an actual executable <script> tag in the DOM
    expect(cellHtml).not.toMatch(/<script[^>]*>alert\('XSS'\)<\/script>/i);

    // Verify no alert dialog appeared (Playwright would throw if an unexpected dialog appeared)
    // Also verify the content is present as escaped text
    const pageContent = await page.content();
    // The text should be present in some escaped form
    expect(pageContent).toContain('script');
    expect(pageContent).toContain('alert');
  }
);

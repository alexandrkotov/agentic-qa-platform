import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { db, ensureDbConnected } from '../support/db';

const { Given, When, Then, Before } = createBdd();

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

let ctx: Record<string, any> = {};

Before({ name: 'Reset test context', tags: '@security' }, async () => {
  ctx = {};
});

// SQL Injection in customer email

Given('I attempt to create a customer with SQL injection in the email field', async ({ request }) => {
  await ensureDbConnected();
  
  // Store initial customer count to verify no unintended data manipulation
  const initialCountResult = await db.query('SELECT COUNT(*) as count FROM "Customer"');
  ctx.initialCustomerCount = parseInt(initialCountResult.rows[0].count, 10);
  
  // Classic SQL injection payload attempting to drop table or manipulate data
  ctx.sqlInjectionEmail = `test${Date.now()}@example.com'; DROP TABLE "Customer"; --`;
  ctx.customerName = `SQLi Test ${Date.now()}`;
  
  ctx.requestPayload = {
    email: ctx.sqlInjectionEmail,
    name: ctx.customerName
  };
});

When('I submit the customer creation request', async ({ request }) => {
  ctx.response = await request.post(BACKEND_URL + '/customers', {
    data: ctx.requestPayload
  });
  ctx.responseStatus = ctx.response.status();
  try {
    ctx.responseBody = await ctx.response.json();
  } catch {
    ctx.responseBody = null;
  }
});

Then('the customer creation should not execute arbitrary SQL', async () => {
  await ensureDbConnected();
  
  // Verify the Customer table still exists and wasn't dropped
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'Customer'
    ) as exists
  `);
  expect(tableCheck.rows[0].exists).toBe(true);
  
  // Verify no unexpected data manipulation occurred
  const currentCountResult = await db.query('SELECT COUNT(*) as count FROM "Customer"');
  const currentCount = parseInt(currentCountResult.rows[0].count, 10);
  
  // Count should either be the same (if rejected) or increased by exactly 1 (if sanitized and inserted)
  const countDiff = currentCount - ctx.initialCustomerCount;
  expect(countDiff).toBeGreaterThanOrEqual(0);
  expect(countDiff).toBeLessThanOrEqual(1);
});

Then('the request should either fail validation or create a customer with the literal injection string', async () => {
  await ensureDbConnected();
  
  if (ctx.responseStatus >= 200 && ctx.responseStatus < 300) {
    // If the request succeeded, verify the injection string was stored literally (sanitized)
    const result = await db.query(
      'SELECT email FROM "Customer" WHERE name = $1',
      [ctx.customerName]
    );
    expect(result.rows.length).toBe(1);
    // The email should contain the literal injection characters, stored as data not executed as SQL
    expect(result.rows[0].email).toContain("'");
    expect(result.rows[0].email).toContain('DROP');
  } else {
    // If rejected, that's also acceptable security behavior
    expect(ctx.responseStatus).toBeGreaterThanOrEqual(400);
  }
});

// XSS in product name

Given('I create a product with XSS payload in the name field', async ({ request }) => {
  ctx.xssPayload = `<script>window.xssExecuted=true;</script>Product${Date.now()}`;
  ctx.productPrice = 19.99;
  
  const response = await request.post(BACKEND_URL + '/products', {
    data: {
      name: ctx.xssPayload,
      price: ctx.productPrice
    }
  });
  
  expect(response.status()).toBe(201);
  const body = await response.json();
  ctx.productId = body.id;
});

When('I view the products page in the browser', async ({ page }) => {
  // Set up a flag to detect if any script executes
  await page.addInitScript(() => {
    (window as any).xssExecuted = false;
  });
  
  await page.goto('/products');
  
  // Wait for the product table to load
  await page.waitForSelector('table');
  
  // Store page content for assertion
  ctx.pageContent = await page.content();
});

Then('the XSS payload should be escaped and displayed as text', async ({ page }) => {
  // The XSS payload should be visible as text, not interpreted as HTML
  const productNameCell = page.locator('table').getByText(ctx.xssPayload.replace(/<[^>]*>/g, ''));
  
  // Check that the script tags are escaped/displayed as text or stripped
  // The actual product name text should be visible
  const pageText = await page.textContent('body');
  
  // Either the script tags are escaped (shown as text) or stripped out
  // In either case, the non-script part of the name should be visible
  const productIdentifier = `Product${ctx.xssPayload.match(/Product(\d+)/)?.[1] || ''}`;
  expect(pageText).toContain('Product');
  
  // Verify that <script> is not present as actual HTML tags in the DOM
  // by checking if the raw HTML contains escaped versions or the text is stripped
  const hasUnescapedScript = ctx.pageContent.includes('<script>window.xssExecuted');
  const hasEscapedScript = ctx.pageContent.includes('&lt;script&gt;') || ctx.pageContent.includes('&lt;script');
  const hasStrippedContent = !ctx.pageContent.includes('<script>window.xssExecuted');
  
  // Either the script is escaped or stripped - both are valid XSS protections
  expect(hasEscapedScript || hasStrippedContent).toBe(true);
});

Then('no script should execute on the page', async ({ page }) => {
  // Check that our XSS payload did not execute
  const xssExecuted = await page.evaluate(() => (window as any).xssExecuted);
  expect(xssExecuted).toBe(false);
  
  // Additional check: try to find if there are any script execution side effects
  const alertTriggered = await page.evaluate(() => {
    return (window as any).alertTriggered === true;
  });
  expect(alertTriggered).toBe(false);
});

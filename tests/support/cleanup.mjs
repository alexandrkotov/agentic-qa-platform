import 'dotenv/config';
import { Client } from 'pg';

// Deletes only rows created by this test suite, identified by the naming
// patterns each domain's steps files use for synthetic data (see
// docs/phase2-status.md "Test data cleanup" for the full list and why a
// blind TRUNCATE isn't safe — seed/demo data like "Alec"/"Jane Doe" lives in
// the same tables). Extend these lists whenever a new domain/scenario
// introduces a new naming scheme.
const CUSTOMER_EMAIL_PATTERNS = [
  'order-test-%', // orders-common.steps.ts
  'cust_%', // customers.steps.ts (also used for its "Order Owner"/"Dup Test" scenarios)
  'qa-prod-%', // products.steps.ts ("a product that is referenced in an existing order")
  'xss_%', // security.steps.ts
  'sqltest%', // security.steps.ts SQL injection payload
  'debug-%', // ad-hoc debug scripts during development
];

const PRODUCT_NAME_PATTERNS = [
  'Order Test Product%', // orders-common.steps.ts + orders-items.steps.ts's second product
  'Prod\\_%', // customers.steps.ts
  'Referenced Product%', // products.steps.ts
  'Wireless Mouse QA%', // products.steps.ts (fixed literal happy-path product; distinct from real seed "Wireless Mouse")
  'Debug Product%', // ad-hoc debug scripts during development
  'Injected%', // security.steps.ts SQL injection payload
  '<script>%', // security.steps.ts XSS payload
];

const PRODUCT_NAME_EXACT = ['Zero Price Item', 'Negative Price Item'];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const custRes = await client.query(
      'SELECT id FROM "Customer" WHERE email LIKE ANY($1::text[])',
      [CUSTOMER_EMAIL_PATTERNS]
    );
    const prodRes = await client.query(
      'SELECT id FROM "Product" WHERE name LIKE ANY($1::text[]) OR name = ANY($2::text[])',
      [PRODUCT_NAME_PATTERNS, PRODUCT_NAME_EXACT]
    );

    const customerIds = custRes.rows.map((r) => r.id);
    const productIds = prodRes.rows.map((r) => r.id);

    // Orders aren't matched by their own naming scheme — they're pulled in
    // transitively via the test customer/product that created them.
    // OrderItem/OrderStatusHistory have onDelete: Cascade on Order in the
    // Prisma schema, so deleting the Order is enough; Order->Customer and
    // OrderItem->Product have no cascade (Prisma default Restrict), so
    // Orders must be deleted before Customers/Products.
    const orderRes = await client.query(
      `SELECT id FROM "Order"
       WHERE "customerId" = ANY($1::int[])
          OR id IN (SELECT "orderId" FROM "OrderItem" WHERE "productId" = ANY($2::int[]))`,
      [customerIds, productIds]
    );
    const orderIds = orderRes.rows.map((r) => r.id);

    console.log(
      `Found ${customerIds.length} test customers, ${productIds.length} test products, ` +
        `${orderIds.length} test orders (their OrderItem/OrderStatusHistory rows cascade automatically).`
    );

    if (orderIds.length > 0) {
      await client.query('DELETE FROM "Order" WHERE id = ANY($1::int[])', [orderIds]);
    }
    if (customerIds.length > 0) {
      await client.query('DELETE FROM "Customer" WHERE id = ANY($1::int[])', [customerIds]);
    }
    if (productIds.length > 0) {
      await client.query('DELETE FROM "Product" WHERE id = ANY($1::int[])', [productIds]);
    }

    console.log('Cleanup complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

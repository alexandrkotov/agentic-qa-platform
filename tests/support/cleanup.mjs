import 'dotenv/config';
import { Client } from 'pg';

// Deletes rows created by test runs, two complementary ways — neither alone
// covers everything, and a blind TRUNCATE isn't safe (seed/demo data like
// "Jane Doe"/"Wireless Mouse" lives in the same tables, see docs/phase2-
// status.md "Test data cleanup"):
//
// 1. Naming patterns each hand-written domain's steps files use for
//    synthetic data (below). Extend these whenever a new domain/scenario
//    introduces a new naming scheme.
// 2. `--since <ISO8601>` (default: just after the last real seed row —
//    see DEFAULT_SINCE below). The Generate Agent pipeline's runtime
//    (tests/support/generateRuntime.ts) fills unique-value placeholders with
//    a model-chosen literal prefix + a random suffix — there is no fixed
//    naming scheme to pattern-match against, so anything created at or after
//    the cutoff is swept up regardless of what it's named. This is also what
//    actually catches stray rows attached to a *real* seed customer/product
//    (e.g. test orders placed against "Jane Doe") that pattern-matching can
//    never reach, since the customer/product itself isn't test data.
//
// Verified against the real DB (2026-07-30): the last genuine seed row is
// Product "Mouse Pad", createdAt 2026-07-22T17:39:03Z; the next row of any
// kind is 2026-07-27. DEFAULT_SINCE sits in that gap.
const DEFAULT_SINCE = '2026-07-23T00:00:00Z';

function parseSinceArg() {
  const idx = process.argv.indexOf('--since');
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : DEFAULT_SINCE;
}

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

// Re-syncs each table's identity/serial sequence to MAX(id) after cleanup
// deletes rows, so repeated test runs don't leave the sequence drifting
// arbitrarily far ahead of the actual row count. Must run after the deletes
// below, not before — otherwise MAX(id) would still include the rows about
// to be removed.
const RESET_ID_SEQUENCES_SQL = `
DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'Product',
        'Customer',
        'Order',
        'OrderItem',
        'OrderStatusHistory'
    ]
    LOOP
        EXECUTE format(
            'SELECT setval(
                pg_get_serial_sequence(''public."%1$s"'', ''id''),
                COALESCE(MAX(id), 1),
                MAX(id) IS NOT NULL
            )
            FROM public."%1$s";',
            table_name
        );
    END LOOP;
END $$;
`;

async function main() {
  const since = parseSinceArg();
  console.log(`Cutoff: rows created at or after ${since} are swept up regardless of naming (plus the fixed patterns below).`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const custRes = await client.query(
      'SELECT id FROM "Customer" WHERE email LIKE ANY($1::text[]) OR "createdAt" >= $2',
      [CUSTOMER_EMAIL_PATTERNS, since]
    );
    const prodRes = await client.query(
      'SELECT id FROM "Product" WHERE name LIKE ANY($1::text[]) OR name = ANY($2::text[]) OR "createdAt" >= $3',
      [PRODUCT_NAME_PATTERNS, PRODUCT_NAME_EXACT, since]
    );

    const customerIds = custRes.rows.map((r) => r.id);
    const productIds = prodRes.rows.map((r) => r.id);

    // Orders are pulled in three ways: transitively via a matched test
    // customer/product, OR by the order's own createdAt — the last one is
    // what catches, e.g., a test order placed against a *real* seed customer
    // (the customer itself isn't test data, so it never matches the other
    // two conditions). OrderItem/OrderStatusHistory have onDelete: Cascade on
    // Order in the Prisma schema, so deleting the Order is enough;
    // Order->Customer and OrderItem->Product have no cascade (Prisma default
    // Restrict), so Orders must be deleted before Customers/Products.
    const orderRes = await client.query(
      `SELECT id FROM "Order"
       WHERE "customerId" = ANY($1::int[])
          OR id IN (SELECT "orderId" FROM "OrderItem" WHERE "productId" = ANY($2::int[]))
          OR "createdAt" >= $3`,
      [customerIds, productIds, since]
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

    await client.query(RESET_ID_SEQUENCES_SQL);

    console.log('Cleanup complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

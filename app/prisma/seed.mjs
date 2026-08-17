// Real baseline demo data — 1 customer + 3 products — so a freshly
// deployed instance's Frontend shows something on first load, and so
// there's a stable, non-test-data anchor tests/support/cleanup.mjs's own
// date-cutoff mode can distinguish from whatever the BDD suite/k6 load
// test create afterward. Plain `pg` + raw SQL, not the generated Prisma
// client — same lightweight approach tests/support/cleanup.mjs already
// uses, and it sidesteps a real incompatibility hit going the Prisma-
// client route: running `ts-node --transpile-only` against Prisma 7's own
// generated client.ts failed with "Cannot find module './internal/class.js'"
// (confirmed live, 2026-08-17) — the generated client's module resolution
// only works cleanly through NestJS's own build pipeline (nest start),
// not a bare ts-node invocation. No such issue with plain pg.
//
// Idempotent (ON CONFLICT DO NOTHING, keyed on the customer's unique email
// / the product name) — safe to run again against a DB that already has
// this data, though in practice a fresh `down -v` redeploy always starts
// from an empty DB anyway. docker-compose.demo-orderflow.yml's own
// command runs this directly (`node prisma/seed.mjs`), right after
// `migrate deploy` and before the app starts listening.
import { Client } from 'pg';

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(
      'INSERT INTO "Customer" (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
      ['jane@example.com', 'Jane Doe'],
    );

    const products = [
      ['Wireless Mouse', 29.99],
      ['Mouse Pad', 9.99],
      ['USB-C Hub', 39.99],
    ];
    for (const [name, price] of products) {
      await client.query(
        'INSERT INTO "Product" (name, price) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM "Product" WHERE name = $1)',
        [name, price],
      );
    }

    console.log('Seed complete: 1 customer, 3 products (idempotent).');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

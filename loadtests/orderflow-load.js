// Backend/API load test — hits the REST API directly over HTTP, no browser
// involved. Measures request rate, latency (p95/p99), and error rate for
// OrderFlow's own write-flow (create customer -> create product -> create
// order -> submit order), the same sequence already documented in
// descriptors/orderflow.json's own extraInstructions. Does not touch the
// UI/frontend at all — see the E2E tab for real-browser functional testing.
import http from 'k6/http';
import { check, sleep } from 'k6';

// Always passed explicitly by /api/load/:descriptor/run (resolved per
// descriptor via server.ts's rewriteForContainerNetwork()/restApiOrigin());
// the fallback here only matters for a local `k6 run` outside Docker.
const BASE_URL = __ENV.K6_BASE_URL || 'http://app:3000';

// Modest demo scale, not a real stress test.
export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const uniqueSuffix = `${__VU}-${__ITER}-${Date.now()}`;

  const customerRes = http.post(
    `${BASE_URL}/customers`,
    JSON.stringify({ email: `k6-${uniqueSuffix}@example.com`, name: 'K6 Load Customer' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(customerRes, { 'create customer: status 201': (r) => r.status === 201 });
  const customerId = customerRes.json('id');

  const productRes = http.post(
    `${BASE_URL}/products`,
    JSON.stringify({ name: 'K6 Load Product', price: 19.99 }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(productRes, { 'create product: status 201': (r) => r.status === 201 });
  const productId = productRes.json('id');

  if (customerId && productId) {
    const orderRes = http.post(
      `${BASE_URL}/orders`,
      JSON.stringify({ customerId, items: [{ productId, quantity: 1 }] }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    check(orderRes, { 'create order: status 201': (r) => r.status === 201 });
    const orderId = orderRes.json('id');

    if (orderId) {
      const submitRes = http.patch(
        `${BASE_URL}/orders/${orderId}/status`,
        JSON.stringify({ status: 'SUBMITTED' }),
        { headers: { 'Content-Type': 'application/json' } },
      );
      check(submitRes, { 'submit order: status 200': (r) => r.status === 200 });
    }
  }

  sleep(1);
}

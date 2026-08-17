// Backend/API load test — hits the REST API directly over HTTP, no browser involved.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000'; // fallback only matters for a local `k6 run` outside Docker; the real run always passes K6_BASE_URL explicitly

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
  // Step 1: Fetch entry page configuration
  // Business rule: Entry page type is configurable (Dashboard by default)
  const entryPageRes = http.get(`${BASE_URL}/api/entry-page`);
  check(entryPageRes, {
    'entry-page returns 200': (r) => r.status === 200,
    'entry-page has type field': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.type !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  // Step 2: Fetch status page heartbeat data for default status page
  // Business rule: Status pages aggregate monitor heartbeats; returns empty lists if no status page configured
  const statusPageHeartbeatRes = http.get(`${BASE_URL}/api/status-page/heartbeat/default`);
  check(statusPageHeartbeatRes, {
    'status-page heartbeat returns 200': (r) => r.status === 200,
    'status-page heartbeat has heartbeatList': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.heartbeatList !== undefined || body.uptimeList !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  // Step 3: Fetch status badge for monitor 1
  // Business rule: Monitors have badges showing status; shows N/A when no heartbeat data
  const statusBadgeRes = http.get(`${BASE_URL}/api/badge/1/status`);
  check(statusBadgeRes, {
    'status badge returns 200': (r) => r.status === 200,
    'status badge is SVG': (r) => r.headers['Content-Type'] && r.headers['Content-Type'].includes('image/svg+xml'),
  });

  // Step 4: Fetch uptime percentage badge for monitor 1
  // Business rule: Uptime is tracked per monitor and shown as percentage
  const uptimeBadgeRes = http.get(`${BASE_URL}/api/badge/1/uptime`);
  check(uptimeBadgeRes, {
    'uptime badge returns 200': (r) => r.status === 200,
    'uptime badge is SVG': (r) => r.headers['Content-Type'] && r.headers['Content-Type'].includes('image/svg+xml'),
  });

  // Step 5: Fetch ping time badge for monitor 1
  // Business rule: Ping/response time is recorded in heartbeats and can be displayed via badge
  const pingBadgeRes = http.get(`${BASE_URL}/api/badge/1/ping`);
  check(pingBadgeRes, {
    'ping badge returns 200': (r) => r.status === 200,
    'ping badge is SVG': (r) => r.headers['Content-Type'] && r.headers['Content-Type'].includes('image/svg+xml'),
  });

  // Step 6: Test push monitor endpoint with invalid token
  // Business rule: Push monitors require a valid push_token to record heartbeats
  // Expected: 404 with {ok: false, msg: 'Monitor not found or not active.'}
  const uniqueInvalidToken = `invalidtoken-${__VU}-${__ITER}-${Date.now()}`;
  const pushInvalidRes = http.get(`${BASE_URL}/api/push/${uniqueInvalidToken}`, {
    responseCallback: http.expectedStatuses(404),
  });
  check(pushInvalidRes, {
    'push with invalid token returns 404': (r) => r.status === 404,
    'push invalid token has error message': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.ok === false && body.msg && body.msg.includes('Monitor not found');
      } catch (e) {
        return false;
      }
    },
  });

  sleep(1);
}

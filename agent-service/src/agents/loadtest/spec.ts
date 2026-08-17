import { z } from 'zod';
import type { AgentProvider } from '../../providers/AgentProvider.ts';

// ---------------------------------------------------------------------------
// Load stage — one LLM call, one k6 script, from a target's real discovery
// report. Deliberately much smaller than generate/spec.ts, which this is
// modeled on: no grouping/budget/merge machinery (one file, not many),
// no step-pattern collision verification (a k6 script has no cross-file
// step-definition namespace the way generated Gherkin does). What carries
// over: dumping the whole report JSON into the prompt and letting the model
// find what it needs itself (same as generate/spec.ts — no server-side
// extraction of "the rest-api component" by a specific key, which would
// have to guess at a naming convention the report schema itself deliberately
// doesn't fix, see reportSchema.ts's own comment on that), the fenced-JSON-
// tolerant output parse, and the propose-then-human-approves shape (the
// caller, server.ts, never writes this straight to disk).
// ---------------------------------------------------------------------------

const ModelLoadTestSchema = z.object({ scriptContent: z.string() });
export type ModelLoadTest = z.infer<typeof ModelLoadTestSchema>;

function buildSystemPrompt(reportJson: string, descriptor: string): string {
  return `You are a QA performance-testing agent. You convert a system discovery report (JSON) into a REAL,
working k6 backend/API load-test script — HTTP-only, no browser module, hitting the target's REST API
directly. This is deliberately NOT a stress test: modest scale, meant to demonstrate the target holds up
under light concurrent load, not to find its breaking point.

## System discovery report for "${descriptor}" (source of truth for endpoints, request/response shapes, and business rules)
${reportJson}

## What to build
Find this report's REST API component (an entry under \`components\` with an \`endpoints\` array) and its
\`businessRules\`/\`testScenarios\` — use them to write ONE realistic, multi-step k6 scenario exercising a
genuine business flow this system actually supports (e.g. create some resource, then a dependent resource,
then transition its status) — not a single isolated endpoint hit repeated in a loop. Prefer a flow the
report's own testScenarios/businessRules describe or imply over inventing one from the endpoint list alone.

## Required script shape — match this exactly
\`\`\`js
// Backend/API load test — hits the REST API directly over HTTP, no browser involved.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000'; // fallback only matters for a local \`k6 run\` outside Docker; the real run always passes K6_BASE_URL explicitly

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
  // ... your flow's real HTTP calls against BASE_URL + <real endpoint path from the report>,
  // a check() after each one, using a per-VU/per-iteration-unique value (e.g. \`\${__VU}-\${__ITER}-\${Date.now()}\`)
  // for anything the report suggests must be unique (an email, a slug, etc.) ...
  sleep(1);
}
\`\`\`
Rules:
- Keep the header comment line, the imports, \`BASE_URL\`, the \`options\` block (stages/thresholds), and the
  \`sleep(1)\` at the end of the iteration EXACTLY as shown — only the body of the default-exported function
  (the actual HTTP calls) is yours to write, based on the report.
- Every request URL is \`BASE_URL + '<path>'\` using a real path from the report's own endpoints — never an
  invented or guessed path.
- \`check()\` after every request, asserting the status code the report/business rules imply for that call.
- Never invent a field name, status code, or business rule the report doesn't support.
- No k6 browser module, no custom metrics beyond the built-in ones, no \`Trend\`/\`Counter\`/\`Rate\` imports.
- **Any request whose report/business-rule-implied status is NOT 2xx/3xx** (e.g. a deliberate "invalid input
  returns 400", "unknown id returns 404" scenario) MUST pass
  \`{ responseCallback: http.expectedStatuses(<that exact code>) }\` as that call's params (the last argument
  to \`http.get\`/\`http.post\`/etc — an object literal, merge in headers there too if the call needs any).
  Without this, k6's own built-in \`http_req_failed\` metric always classifies a non-2xx/3xx response as a
  failure regardless of \`check()\`, which would make the \`http_req_failed\` threshold above fail on a
  request that is behaving exactly as the report says it should — a false alarm, not a real problem. Ordinary
  2xx/3xx requests need no \`responseCallback\` at all.

## Output contract — read carefully
Output ONLY a single valid JSON object with exactly one string key, no markdown fences, no prose before or
after:
{
  "scriptContent": "<the full, complete .js file content, starting with the header comment line>"
}
The value is the LITERAL file content as a JSON string (newlines as \\n, quotes escaped normally) — not a
summary, not truncated, not wrapped in markdown code fences inside the JSON string.`;
}

const USER_MESSAGE = (descriptor: string) =>
  `Write the k6 backend/API load-test script for "${descriptor}" per your instructions. Return the JSON object with exactly the "scriptContent" key.`;

function parseModelLoadTestResponse(raw: string): ModelLoadTest {
  const fenceMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  const jsonText = fenceMatch ? fenceMatch[1] : raw;
  const parsed = JSON.parse(jsonText);
  return ModelLoadTestSchema.parse(parsed);
}

export async function generateLoadTestScript(
  provider: AgentProvider,
  reportJson: string,
  descriptor: string,
): Promise<{ scriptContent: string }> {
  const raw = await provider.run({
    systemPrompt: buildSystemPrompt(reportJson, descriptor),
    userMessage: USER_MESSAGE(descriptor),
    mcpServers: [],
    tools: [],
    maxIterations: 5,
    operation: `loadtest:${descriptor}`,
    descriptor,
  });

  return parseModelLoadTestResponse(raw);
}

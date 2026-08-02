import os from 'node:os';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'multiple-cucumber-html-reporter';

const RAW_JSON_DIR = 'reports/cucumber-json';
const SANITIZED_JSON_DIR = 'reports/cucumber-json-sanitized';

// multiple-cucumber-html-reporter embeds step-argument content straight into an
// inline `<script>` data blob without escaping it. It does have its own
// _escapeHtml() helper, but that only fires for a `step.doc_string` field —
// playwright-bdd's JSON formatter emits `step.arguments` instead, so that path
// never runs for our reports. Confirmed live: the security suite's own XSS
// payload (`<script>alert('XSS-{{unique}}')</script>`, there to prove the app
// escapes it) broke out of the reporter's own data <script> tag instead — the
// browser's HTML parser treats the first `</script>` it finds, even mid
// string, as the real closing tag, so everything before it executes as JS
// (the alert box) and everything after renders as raw visible text (the
// "empty" report full of garbage JSON). Since the escaping bug lives in the
// vendored package, not in our code, sanitize a *copy* of the JSON at this
// boundary instead of patching node_modules — the original report.json (the
// actual test-run record) is left untouched.
function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitize(value) {
  if (typeof value === 'string') return escapeHtml(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

await rm(SANITIZED_JSON_DIR, { recursive: true, force: true });
await mkdir(SANITIZED_JSON_DIR, { recursive: true });
for (const file of await readdir(RAW_JSON_DIR)) {
  if (!file.endsWith('.json')) continue;
  const raw = JSON.parse(await readFile(join(RAW_JSON_DIR, file), 'utf-8'));
  await writeFile(join(SANITIZED_JSON_DIR, file), JSON.stringify(sanitize(raw)));
}

// Reads the Cucumber-format JSON written by playwright-bdd's cucumberReporter('json', ...)
// (see playwright.config.ts) and renders the interactive HTML report.
generate({
  jsonDir: SANITIZED_JSON_DIR,
  reportPath: 'reports/cucumber-html',
  reportName: 'Agentic QA Platform — BDD Test Report',
  metadata: {
    platform: { name: os.platform(), version: os.release() },
    executionPlatform: 'local',
  },
  customData: {
    projectName: 'Agentic QA Platform',
    ciPipeline: process.env.CI ? 'GitHub Actions' : 'local',
    buildNumber: process.env.GITHUB_RUN_NUMBER ?? 'local',
  },
});

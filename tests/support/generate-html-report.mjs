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

// playwright-bdd's JSON formatter marks every Before/After hook step
// `hidden: true` and never sets its own `name` field at all (the hook's
// registered `name:` option, if any, only reaches a *different* Cucumber
// Messages type this JSON formatter doesn't emit) — the HTML report always
// rendered a bare, unlabeled "Before"/"After" regardless of what the hook
// actually does. The report template does render `step.name` right next to
// `step.keyword` for every step generically, so injecting one here works;
// there's just nothing upstream to inject automatically. Hardcoded because
// today there's exactly one hook per keyword across the whole suite (every
// `Before` resets `ctx`; the only `After` is orders.steps.ts's Kafka
// consumer disconnect) — extend this map if that ever stops being true.
const HIDDEN_HOOK_NAMES = { Before: 'Reset test context', After: 'Close Kafka consumer connection' };

function labelHiddenHooks(report) {
  for (const feature of report) {
    for (const element of feature.elements ?? []) {
      for (const step of element.steps ?? []) {
        if (step.hidden && HIDDEN_HOOK_NAMES[step.keyword]) {
          step.name = HIDDEN_HOOK_NAMES[step.keyword];
        }
      }
    }
  }
  return report;
}

await rm(SANITIZED_JSON_DIR, { recursive: true, force: true });
await mkdir(SANITIZED_JSON_DIR, { recursive: true });
for (const file of await readdir(RAW_JSON_DIR)) {
  if (!file.endsWith('.json')) continue;
  const raw = JSON.parse(await readFile(join(RAW_JSON_DIR, file), 'utf-8'));
  const labeled = labelHiddenHooks(raw);
  await writeFile(join(SANITIZED_JSON_DIR, file), JSON.stringify(sanitize(labeled)));
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

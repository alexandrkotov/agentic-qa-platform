import { defineConfig } from '@playwright/test';
import { defineBddConfig, cucumberReporter } from 'playwright-bdd';

const testDir = defineBddConfig({
  features: 'features/*.feature',
  steps: 'steps/*.steps.ts',
});

export default defineConfig({
  testDir,
  // Undefined (Playwright's own CPU-core default) unless a descriptor's own
  // test-run env overrides it — added because Uptime Kuma's real login
  // route rate-limits ("Too frequently, try again later") once several
  // workers log in near-simultaneously, confirmed live under the default
  // 5-worker parallelism. Set PLAYWRIGHT_WORKERS in descriptors/<name>.env
  // for any target with the same constraint; orderflow's own suite is
  // unaffected since it has no such override.
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : undefined,
  use: {
    baseURL: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['list'],
    ['html'],
    cucumberReporter('json', { outputFile: 'reports/cucumber-json/report.json' }),
  ],
});
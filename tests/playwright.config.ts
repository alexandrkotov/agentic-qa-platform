import { defineConfig } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

const testDir = defineBddConfig({
  features: 'features/*.feature',
  steps: 'steps/*.steps.ts',
});

export default defineConfig({
  testDir,
  use: {
    baseURL: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  },
  reporter: [['html'], ['json', { outputFile: 'reports/cucumber-report.json' }]],
});
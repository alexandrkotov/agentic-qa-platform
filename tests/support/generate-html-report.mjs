import os from 'node:os';
import { generate } from 'multiple-cucumber-html-reporter';

// Reads the Cucumber-format JSON written by playwright-bdd's cucumberReporter('json', ...)
// (see playwright.config.ts) and renders the interactive HTML report.
generate({
  jsonDir: 'reports/cucumber-json',
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

import { resolve } from 'node:path';
import { runDiscovery } from './bootstrap/discovery.ts';
import { runGenerate } from './bootstrap/generate.ts';
import { runE2EAgent } from './agents/e2e/index.ts';
import { applyFix } from './agents/e2e/apply.ts';
import { ClaudeProvider } from './providers/ClaudeProvider.ts';
import { OpenAIProvider } from './providers/OpenAIProvider.ts';
import type { AgentProvider } from './providers/AgentProvider.ts';
import { config } from './config.ts';

const args = process.argv.slice(2);

function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const phase = args.find((a) => !a.startsWith('-')) ?? 'discovery';
const providerName = getArg('--provider', 'claude');
const reportPathArg = getArg('--report', '');
const domainArg = getArg('--domain', '');
const scenarioArg = getArg('--scenario', '');

// Same derivation agent-service/src/agents/e2e/index.ts uses to find the
// sibling tests/ directory from agent-service/reports/.
const TESTS_ROOT = resolve(config.reportsDir, '..', '..', 'tests');

function createProvider(): AgentProvider {
  switch (providerName) {
    case 'openai':
      return new OpenAIProvider();
    case 'claude':
    default:
      return new ClaudeProvider();
  }
}

async function main() {
  // apply-fix needs no LLM call at all (diagnosis already happened in a
  // prior `e2e` run) — don't construct a provider (which requires an API
  // key) or print a misleading "Provider: ..." line for it.
  if (phase !== 'apply-fix') console.log(`Provider: ${providerName}`);

  switch (phase) {
    case 'discovery':
      await runDiscovery(createProvider());
      break;
    case 'generate':
      await runGenerate(
        createProvider(),
        reportPathArg || undefined,
        domainArg ? domainArg.split(',') : undefined,
      );
      break;
    case 'e2e':
      await runE2EAgent(createProvider(), providerName, scenarioArg ? scenarioArg.split(',') : undefined);
      break;
    case 'apply-fix':
      if (!reportPathArg) {
        console.error('apply-fix requires --report <path>');
        process.exit(1);
      }
      await applyFix(reportPathArg, TESTS_ROOT);
      break;
    default:
      console.error(`Unknown phase: ${phase}`);
      console.error('Usage: tsx src/index.ts discovery|generate|e2e|apply-fix [--provider claude|openai] [--report <path>]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { resolve } from 'node:path';
import { runDiscovery } from './bootstrap/discovery.ts';
import { runGenerate } from './bootstrap/generate.ts';
import { runGenerateGroup } from './bootstrap/generateGroup.ts';
import { runGenerateSpec } from './bootstrap/generateSpec.ts';
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
const descriptorArg = getArg('--descriptor', '');
const thresholdArg = getArg('--threshold', '');
const groupingArg = getArg('--grouping', '');
const maxScenariosArg = getArg('--max-scenarios', '');
const groupArg = getArg('--group', '');

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
  // apply-fix and generate-group need no LLM call at all (diagnosis/grouping
  // already happened deterministically) — don't construct a provider (which
  // requires an API key) or print a misleading "Provider: ..." line for them.
  if (phase !== 'apply-fix' && phase !== 'generate-group') console.log(`Provider: ${providerName}`);

  switch (phase) {
    case 'discovery':
      await runDiscovery(createProvider(), descriptorArg || undefined);
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
    case 'generate-group':
      // Temporary phase for the Generate Agent redesign (milestone 2): Stage
      // 1 grouping only, CLI-only, no LLM call. Superseded once bootstrap/
      // generate.ts is rewritten to orchestrate group/spec/render together.
      await runGenerateGroup(reportPathArg || undefined, thresholdArg ? Number(thresholdArg) : undefined);
      break;
    case 'generate-spec':
      // Temporary phase for the Generate Agent redesign (milestone 5): Stage
      // 2 structured spec only, one LLM call per render group. Superseded
      // once bootstrap/generate.ts is rewritten to orchestrate all stages.
      await runGenerateSpec(
        createProvider(),
        groupingArg || undefined,
        descriptorArg || undefined,
        maxScenariosArg ? Number(maxScenariosArg) : undefined,
        groupArg ? groupArg.split(',') : undefined,
      );
      break;
    default:
      console.error(`Unknown phase: ${phase}`);
      console.error(
        'Usage: tsx src/index.ts discovery|generate|generate-group|generate-spec|e2e|apply-fix [--provider claude|openai] [--report <path>] [--descriptor <path>] [--threshold <n>] [--grouping <path>] [--max-scenarios <n>] [--group <keys>]',
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

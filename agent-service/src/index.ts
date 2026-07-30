import { resolve } from 'node:path';
import { runDiscovery } from './bootstrap/discovery.ts';
import { runGenerateGroup } from './bootstrap/generateGroup.ts';
import { runGenerateSpec } from './bootstrap/generateSpec.ts';
import { runGenerateRender } from './bootstrap/generateRender.ts';
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
const scenarioArg = getArg('--scenario', '');
const descriptorArg = getArg('--descriptor', '');
const thresholdArg = getArg('--threshold', '');
const groupingArg = getArg('--grouping', '');
const maxScenariosArg = getArg('--max-scenarios', '');
const groupArg = getArg('--group', '');
const specArg = getArg('--spec', '');

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
  // apply-fix, generate-group, and generate-render need no LLM call at all
  // (diagnosis/grouping/rendering already happened deterministically) —
  // don't construct a provider (which requires an API key) or print a
  // misleading "Provider: ..." line for them.
  const NO_PROVIDER_PHASES = ['apply-fix', 'generate-group', 'generate-render'];
  if (!NO_PROVIDER_PHASES.includes(phase)) console.log(`Provider: ${providerName}`);

  switch (phase) {
    case 'discovery':
      await runDiscovery(createProvider(), descriptorArg || undefined);
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
      // Stage 1 of the Generate pipeline: deterministic grouping proposal,
      // no LLM call. Review/approve via the admin UI (or hand-edit the
      // written generate-grouping-proposed-*.json) before running
      // generate-spec against the approved-grouping file it produces.
      await runGenerateGroup(reportPathArg || undefined, thresholdArg ? Number(thresholdArg) : undefined);
      break;
    case 'generate-spec':
      // Stage 2: one structured Given/When/Then LLM call per render group,
      // reading an approved grouping (see generate-group) and this
      // descriptor's corrections. Review/approve the result (admin UI, or
      // hand-edit the written generate-spec-proposed-*.json) before
      // generate-render.
      await runGenerateSpec(
        createProvider(),
        groupingArg || undefined,
        descriptorArg || undefined,
        maxScenariosArg ? Number(maxScenariosArg) : undefined,
        groupArg ? groupArg.split(',') : undefined,
      );
      break;
    case 'generate-render':
      // Stage 3: mechanical, no LLM — turns an approved spec (see
      // generate-spec) into tests/features/*.feature + tests/steps/*.steps.ts.
      await runGenerateRender(specArg || undefined);
      break;
    default:
      console.error(`Unknown phase: ${phase}`);
      console.error(
        'Usage: tsx src/index.ts discovery|generate-group|generate-spec|generate-render|e2e|apply-fix [--provider claude|openai] [--report <path>] [--descriptor <path>] [--threshold <n>] [--grouping <path>] [--max-scenarios <n>] [--group <keys>] [--spec <path>]',
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

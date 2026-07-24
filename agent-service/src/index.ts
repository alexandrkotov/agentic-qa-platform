import { runRecon } from './phases/recon.ts';
import { runGenerate } from './phases/generate.ts';
import { ClaudeProvider } from './providers/ClaudeProvider.ts';
import { OpenAIProvider } from './providers/OpenAIProvider.ts';
import type { AgentProvider } from './providers/AgentProvider.ts';

const args = process.argv.slice(2);

function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const phase = args.find((a) => !a.startsWith('-')) ?? 'recon';
const providerName = getArg('--provider', 'claude');
const reportPathArg = getArg('--report', '');
const domainArg = getArg('--domain', '');

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
  console.log(`Provider: ${providerName}`);

  const provider = createProvider();

  switch (phase) {
    case 'recon':
      await runRecon(provider);
      break;
    case 'generate':
      await runGenerate(
        provider,
        reportPathArg || undefined,
        domainArg ? domainArg.split(',') : undefined,
      );
      break;
    default:
      console.error(`Unknown phase: ${phase}`);
      console.error('Usage: tsx src/index.ts recon [--provider claude|openai]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

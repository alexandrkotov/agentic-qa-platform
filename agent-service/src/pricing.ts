/**
 * Anthropic API pricing, $ per million tokens. Source: platform.claude.com/docs/en/pricing,
 * cached 2026-06-24. Only lists models this codebase actually references
 * (config.ts default, generate.ts override) — check platform.claude.com before
 * trusting this for a model not listed here.
 *
 * claude-sonnet-5 is at its introductory rate (in effect through 2026-08-31);
 * reverts to $3.00/$15.00 after that.
 */
const CLAUDE_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-opus-4-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Returns null if `model` isn't in the pricing table above, rather than guessing. */
export function estimateClaudeCostUsd(model: string, usage: ClaudeUsage): number | null {
  const rates = CLAUDE_PRICING_PER_MILLION[model];
  if (!rates) return null;

  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  return (
    (usage.input_tokens * rates.input) / 1_000_000 +
    (usage.output_tokens * rates.output) / 1_000_000 +
    (cacheWrite * rates.input * 1.25) / 1_000_000 +
    (cacheRead * rates.input * 0.1) / 1_000_000
  );
}

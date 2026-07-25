import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import type { E2EScenarioConfig } from './scenarios.ts';
import type { EvidenceBundle, Diagnosis } from './contract.ts';

const SYSTEM_PROMPT = `You are an E2E QA Diagnosis Agent. A Playwright/Cucumber BDD scenario just
failed. You get the Gherkin feature source, the step-definition source files,
and deterministic evidence from the actual run (per-step pass/fail, error
messages, stdout/stderr tail, and paths to a trace/screenshot/error-context
file if captured — you cannot open those files yourself, reason only from the
text evidence given).

## Classify into EXACTLY ONE:
- application_bug — the app under test is actually wrong
- test_bug — the scenario/step code itself is wrong (bad locator, bad wait, wrong assertion, race condition)
- environment_issue — Docker/DB/network/browser-install problem, not a real app/test signal
- test_data_issue — stale/conflicting test data, not a code defect
- tool_error — bddgen or the Playwright runner crashed before any assertion ran
- unknown — not enough evidence to pick confidently

## Rules for the fix
- If classification is application_bug: proposedPatch MUST be null. Do not
  propose changes to app/ or frontend/ even if the fix is obvious — put your
  analysis in recommendedAction for a human to act on. Defects found this way
  are reported, not silently patched around.
- Otherwise, proposedPatch may target ONLY files under tests/ (the .feature
  file or the given .steps.ts files) — locators, waits, step logic, test data
  setup. Unified diff preferred; a clearly described before/after is fine.
- Never propose weakening/removing/loosening an assertion as a "fix" — if an
  assertion looks wrong, say so in reasoning and let a human decide.
- If no safe fix is proposable, proposedPatch: null and explain why in recommendedAction.
- confidence reflects how directly the evidence supports the classification.

## Output — ONLY this JSON object, no markdown fences, no prose:
{
  "classification": "application_bug|test_bug|environment_issue|test_data_issue|tool_error|unknown",
  "reasoning": "...",
  "proposedPatch": "diff or description, or null",
  "recommendedAction": "required when classification is application_bug, else null unless useful",
  "confidence": "low|medium|high"
}`;

function buildUserMessage(
  scenario: E2EScenarioConfig,
  sources: Record<string, string>,
  evidence: EvidenceBundle,
): string {
  const sourcesBlock = Object.entries(sources)
    .map(([p, c]) => `### ${p}\n\`\`\`\n${c}\n\`\`\``)
    .join('\n\n');
  return `## Scenario\n${scenario.title} (feature: ${scenario.featureName})\n\n## Source files\n${sourcesBlock}\n\n## Evidence from the actual run\n${JSON.stringify(evidence, null, 2)}\n\nDiagnose this failure and return the JSON object per your instructions.`;
}

export async function diagnoseFailure(
  provider: AgentProvider,
  testsRoot: string,
  scenario: E2EScenarioConfig,
  evidence: EvidenceBundle,
): Promise<Diagnosis> {
  const sources: Record<string, string> = {};
  for (const relPath of [scenario.featurePath, ...scenario.stepsPaths]) {
    try {
      sources[relPath] = await readFile(join(testsRoot, relPath), 'utf-8');
    } catch (err) {
      sources[relPath] = `<could not read: ${(err as Error).message}>`;
    }
  }

  const raw = await provider.run({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: buildUserMessage(scenario, sources, evidence),
    mcpServers: [],
    tools: [],
    maxIterations: 5,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const fallback = (reason: string): Diagnosis => ({
    classification: 'unknown',
    reasoning: reason,
    proposedPatch: null,
    recommendedAction: null,
    confidence: 'low',
  });
  if (!jsonMatch) return fallback(`No JSON in diagnosis response. Raw: ${raw.slice(0, 500)}`);

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Diagnosis;
    // Enforce the guardrail in code — don't trust the model to have followed it.
    if (parsed.classification === 'application_bug' && parsed.proposedPatch) parsed.proposedPatch = null;
    return parsed;
  } catch (err) {
    return fallback(`JSON.parse failed: ${(err as Error).message}. Raw: ${raw.slice(0, 500)}`);
  }
}

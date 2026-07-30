import type { ApprovedGrouping, RenderGroup } from './contract.ts';

// ---------------------------------------------------------------------------
// Mechanical token-budget split — runs after grouping approval, no LLM call
// and no human review (this is packaging, not a semantic decision). Splits
// any group whose scenario count exceeds a configurable ceiling into
// `<key>-1`, `<key>-2`, ... in original order, evenly sized rather than
// floor-sized-chunks-plus-a-remainder.
//
// Default reflects the ceiling ClaudeProvider.ts hardcodes (`max_tokens:
// 8096`): the old hand-maintained domain list this pipeline replaced had
// manually cut its one large domain (orders, ~19 scenarios) into 3 files of
// <=9 scenarios each to stay under it. 6 is a safe, slightly tighter default
// given that precedent; callers can pass a different value interactively
// (see admin UI).
//
// This is a scenario-COUNT proxy for a token budget, not an actual token
// count — a verbose scenario (many given/then entries) costs more output
// tokens than a terse one, but both count as "1" here. Nothing keeps this
// number in sync with ClaudeProvider.ts's max_tokens automatically; if that
// value changes, re-check whether 6 is still safe.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_SCENARIOS_PER_GROUP = 6;

function chunk(scenarioNames: string[], maxPerChunk: number): string[][] {
  if (scenarioNames.length <= maxPerChunk) return [scenarioNames];
  const chunkCount = Math.ceil(scenarioNames.length / maxPerChunk);
  const chunkSize = Math.ceil(scenarioNames.length / chunkCount);
  const chunks: string[][] = [];
  for (let i = 0; i < chunkCount; i++) {
    const slice = scenarioNames.slice(i * chunkSize, (i + 1) * chunkSize);
    if (slice.length > 0) chunks.push(slice);
  }
  return chunks;
}

export function splitByBudget(
  grouping: ApprovedGrouping,
  maxScenariosPerGroup: number = DEFAULT_MAX_SCENARIOS_PER_GROUP,
): RenderGroup[] {
  const renderGroups: RenderGroup[] = [];

  for (const group of grouping.groups) {
    const chunks = chunk(group.scenarioNames, maxScenariosPerGroup);
    if (chunks.length === 1) {
      renderGroups.push({ key: group.key, scenarioNames: chunks[0] });
    } else {
      chunks.forEach((scenarioNames, i) => {
        renderGroups.push({ key: `${group.key}-${i + 1}`, scenarioNames });
      });
    }
  }

  // A human can approve a grouping that still has leftover ungrouped
  // scenarios (e.g. a flatFallback they chose not to fully untangle) —
  // those still need to end up in *some* render group rather than silently
  // vanishing from the generated suite.
  if (grouping.ungrouped.length > 0) {
    const chunks = chunk(grouping.ungrouped, maxScenariosPerGroup);
    chunks.forEach((scenarioNames, i) => {
      const key = chunks.length === 1 ? 'ungrouped' : `ungrouped-${i + 1}`;
      renderGroups.push({ key, scenarioNames });
    });
  }

  return renderGroups;
}

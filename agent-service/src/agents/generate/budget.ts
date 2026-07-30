import type { ApprovedGrouping, RenderGroup } from './contract.ts';

// ---------------------------------------------------------------------------
// Mechanical token-budget split — runs after grouping approval, no LLM call
// and no human review (this is packaging, not a semantic decision). Splits
// any group whose scenario count exceeds a configurable ceiling into
// `<key>-1`, `<key>-2`, ... in original order, evenly sized rather than
// floor-sized-chunks-plus-a-remainder.
//
// Default reflects today's implicit ceiling: ClaudeProvider.ts hardcodes
// `max_tokens: 8096`, and the one domain that has needed splitting so far
// (orders, ~19 scenarios) was manually cut into 3 files of <=9 scenarios each
// in bootstrap/generate.ts's DOMAINS array. 6 is a safe, slightly tighter
// default given that precedent; callers can pass a different value
// interactively (see admin UI).
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

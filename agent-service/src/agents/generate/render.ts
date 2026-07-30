import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ApprovedSpec, ScenarioSpec } from './contract.ts';
import { renderFeature } from './templates/gherkin.ts';
import { renderStepsFile } from './templates/steps.ts';

// ---------------------------------------------------------------------------
// Stage 3 orchestrator — no LLM call. Groups an approved spec's scenarios by
// their own `group` field (already set mechanically in Stage 2, from the
// render-group that produced them) and writes exactly one .feature +
// .steps.ts pair per group, with paths derived from the group's key by
// convention — no separate "key -> path" map to fall out of sync, unlike
// agents/e2e/scenarios.ts's DOMAIN_STEPS_FILES.
// ---------------------------------------------------------------------------

export interface RenderedFile {
  path: string;
  content: string;
}

export function renderSpec(spec: ApprovedSpec): RenderedFile[] {
  const byGroup = new Map<string, ScenarioSpec[]>();
  for (const scenario of spec.scenarios) {
    const list = byGroup.get(scenario.group) ?? [];
    list.push(scenario);
    byGroup.set(scenario.group, list);
  }

  const files: RenderedFile[] = [];
  for (const [key, scenarios] of byGroup) {
    const kafkaTopics = [
      ...new Set(
        scenarios.flatMap((s) => s.then).filter((a) => a.kind === 'kafka_message').map((a) => a.topic),
      ),
    ];
    files.push({ path: `tests/features/${key}.feature`, content: renderFeature(key, scenarios) });
    files.push({ path: `tests/steps/${key}.steps.ts`, content: renderStepsFile(key, kafkaTopics) });
  }
  return files;
}

export async function writeRenderedFiles(files: RenderedFile[], repoRoot: string): Promise<string[]> {
  const written: string[] = [];
  for (const file of files) {
    const absolutePath = join(repoRoot, file.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, 'utf-8');
    written.push(absolutePath);
  }
  return written;
}

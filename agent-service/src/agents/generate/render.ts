import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ApprovedGeneration } from './contract.ts';
import { mergeGroups } from './merge.ts';

// ---------------------------------------------------------------------------
// Stage 3 — no LLM call, no templating. Stage 2 (spec.ts's generateGeneration)
// already merges any render-groups budget.ts split off the same Stage 1
// group back into one real .feature/.steps.ts pair and re-verifies the
// merged result before a human ever reviews it, so generation.groups here is
// normally already one entry per final file. The mergeGroups() call below is
// just a defensive no-op for that common case (every group is its own
// singleton cluster) — real protection for a hand-assembled ApprovedGeneration
// that skipped Stage 2's own merge (e.g. built by hand or by an older tool).
// Writes each group's content to disk unchanged, with paths derived from its
// key (= its sourceKey) by convention.
// ---------------------------------------------------------------------------

export interface RenderedFile {
  path: string;
  content: string;
}

export function renderGeneration(generation: ApprovedGeneration): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const group of mergeGroups(generation.groups)) {
    files.push({ path: `tests/features/${group.key}.feature`, content: group.featureContent });
    files.push({ path: `tests/steps/${group.key}.steps.ts`, content: group.stepsContent });
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

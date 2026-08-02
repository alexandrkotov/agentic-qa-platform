import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ApprovedGeneration } from './contract.ts';
import { mergeGroups } from './merge.ts';

// ---------------------------------------------------------------------------
// Stage 3 — no LLM call, no templating. Stage 2 already produced the real
// .feature and .steps.ts content per render-group (verified by verify.ts
// before it was ever accepted); this merges any render-groups budget.ts
// split off the same Stage 1 group back into one pair (see merge.ts) and
// writes the result to disk, with paths derived from each merged group's
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

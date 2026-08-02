import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApprovedGenerationSchema } from '../agents/generate/contract.ts';
import { renderGeneration, writeRenderedFiles } from '../agents/generate/render.ts';
import { config } from '../config.ts';

// ---------------------------------------------------------------------------
// CLI entry point for Stage 3 (render) of the Generate pipeline — same role
// generateGroup.ts/generateSpec.ts play for Stages 1/2. No LLM call:
// render.ts is purely mechanical.
//
// Assumes repo layout: <repo>/agent-service/reports/ <- config.reportsDir,
// <repo>/tests/ <- output target (same assumption discovery.ts's report
// writing and e2e/index.ts's TESTS_ROOT derivation already make).
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(config.reportsDir, '..', '..');

async function findLatestApprovedSpec(): Promise<string> {
  const files = await readdir(config.reportsDir);
  const matches = files.filter((f) => f.startsWith('generate-spec-approved-') && f.endsWith('.json'));
  if (matches.length === 0) {
    throw new Error(
      `No generate-spec-approved-*.json found in ${config.reportsDir}. Approve a spec first (admin UI, or POST /api/generate/spec/approve).`,
    );
  }
  matches.sort();
  return join(config.reportsDir, matches[matches.length - 1]);
}

export async function runGenerateRender(specPath?: string): Promise<void> {
  console.log('\n=== Generate Stage 3: Render ===\n');

  const resolvedSpecPath = specPath ?? (await findLatestApprovedSpec());
  console.log(`Using approved spec: ${resolvedSpecPath}`);
  const generation = ApprovedGenerationSchema.parse(JSON.parse(await readFile(resolvedSpecPath, 'utf-8')));

  const files = renderGeneration(generation);
  const written = await writeRenderedFiles(files, REPO_ROOT);

  console.log(`\n=== Wrote ${written.length} file(s) ===`);
  for (const f of written) console.log(` - ${f}`);
}

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDiscoveryReport } from '../agents/generate/reportSchema.ts';
import { proposeGrouping, DEFAULT_UNGROUPED_FALLBACK_RATIO } from '../agents/generate/group.ts';
import { config } from '../config.ts';

// ---------------------------------------------------------------------------
// CLI entry point for Stage 1 (grouping) of the Generate pipeline. Prints and
// saves a ProposedGrouping (generate-grouping-proposed-*.json) — approve it
// via the admin UI (or hand-edit the file and write an
// generate-grouping-approved-*.json yourself) before running generate-spec.
// ---------------------------------------------------------------------------

async function findLatestReport(): Promise<string> {
  const files = await readdir(config.reportsDir);
  const discoveryFiles = files.filter((f) => f.startsWith('discovery-') && f.endsWith('.json'));
  if (discoveryFiles.length === 0) {
    throw new Error(`No discovery-*.json reports found in ${config.reportsDir}. Run 'pnpm discovery' first.`);
  }
  discoveryFiles.sort();
  return join(config.reportsDir, discoveryFiles[discoveryFiles.length - 1]);
}

export async function runGenerateGroup(reportPath?: string, threshold?: number): Promise<void> {
  console.log('\n=== Generate Stage 1: Grouping proposal ===\n');

  const resolvedReportPath = reportPath ?? (await findLatestReport());
  console.log(`Using report: ${resolvedReportPath}`);
  const raw = JSON.parse(await readFile(resolvedReportPath, 'utf-8'));
  const report = parseDiscoveryReport(raw);

  const proposed = proposeGrouping(report, resolvedReportPath, {
    ungroupedFallbackRatio: threshold ?? DEFAULT_UNGROUPED_FALLBACK_RATIO,
  });

  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = proposed.generatedAt.replace(/[:.]/g, '-');
  const outPath = join(config.reportsDir, `generate-grouping-proposed-${timestamp}.json`);
  await writeFile(outPath, JSON.stringify(proposed, null, 2), 'utf-8');

  if (proposed.flatFallback) {
    console.log(`flatFallback: TRUE — too many ungrouped scenarios to trust entity grouping.`);
  }
  for (const group of proposed.groups) {
    console.log(`\n[${group.key}] (${group.scenarioNames.length} scenario(s)) — ${group.rationale ?? ''}`);
    for (const name of group.scenarioNames) console.log(`  - ${name}`);
  }
  if (proposed.ungrouped.length > 0) {
    console.log(`\n[ungrouped] (${proposed.ungrouped.length} scenario(s))`);
    for (const name of proposed.ungrouped) console.log(`  - ${name}`);
  }

  console.log(`\nWrote ${outPath}`);
}

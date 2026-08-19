import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentProvider } from '../providers/AgentProvider.ts';
import { parseDiscoveryReport } from '../agents/generate/reportSchema.ts';
import { ApprovedGroupingSchema } from '../agents/generate/contract.ts';
import { splitByBudget, DEFAULT_MAX_SCENARIOS_PER_GROUP } from '../agents/generate/budget.ts';
import { generateGeneration } from '../agents/generate/spec.ts';
import { loadCorrections } from '../agents/generate/corrections.ts';
import { loadUatContext } from '../agents/generate/uat.ts';
import { config } from '../config.ts';

// ---------------------------------------------------------------------------
// CLI entry point for Stage 2 (generate real .feature/.steps.ts content) of
// the Generate pipeline — same role generateGroup.ts plays for Stage 1.
// Reads an approved grouping, makes one LLM call per render group, and
// writes a generate-spec-proposed-*.json for review (admin UI, or hand-edit
// + write a generate-spec-approved-*.json yourself) before running
// generate-render.
//
// Same repo-layout assumption generateRender.ts already makes:
// <repo>/agent-service/reports/ <- config.reportsDir, <repo>/tests/steps/
// <- where already-generated step definitions live, seeded into the
// cross-group step-pattern-collision check (see verify.ts).
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(config.reportsDir, '..', '..');
const TESTS_STEPS_DIR = join(REPO_ROOT, 'tests', 'steps');

async function findLatestApprovedGrouping(): Promise<string> {
  const files = await readdir(config.reportsDir);
  const matches = files.filter((f) => f.startsWith('generate-grouping-approved-') && f.endsWith('.json'));
  if (matches.length === 0) {
    throw new Error(
      `No generate-grouping-approved-*.json found in ${config.reportsDir}. Approve a grouping first (admin UI, or POST /api/generate/group/approve).`,
    );
  }
  matches.sort();
  return join(config.reportsDir, matches[matches.length - 1]);
}

export async function runGenerateSpec(
  provider: AgentProvider,
  groupingPath?: string,
  descriptorPath?: string,
  maxScenariosPerGroup?: number,
  groupFilter?: string[],
): Promise<void> {
  console.log('\n=== Generate Stage 2: Generate feature & steps ===\n');

  const resolvedGroupingPath = groupingPath ?? (await findLatestApprovedGrouping());
  console.log(`Using approved grouping: ${resolvedGroupingPath}`);
  const grouping = ApprovedGroupingSchema.parse(JSON.parse(await readFile(resolvedGroupingPath, 'utf-8')));

  const reportRaw = JSON.parse(await readFile(grouping.sourceReportPath, 'utf-8'));
  parseDiscoveryReport(reportRaw); // validate shape before spending money on a Claude call
  const reportJson = JSON.stringify(reportRaw, null, 2);

  const corrections = descriptorPath ? await loadCorrections(descriptorPath) : {};
  const uatContext = descriptorPath ? await loadUatContext(descriptorPath) : '';

  let renderGroups = splitByBudget(grouping, maxScenariosPerGroup ?? DEFAULT_MAX_SCENARIOS_PER_GROUP);
  if (groupFilter?.length) {
    renderGroups = renderGroups.filter((g) => groupFilter.includes(g.key));
    if (renderGroups.length === 0) {
      throw new Error(`--group matched no render groups (requested: ${groupFilter.join(', ')})`);
    }
  }
  console.log(`Render groups: ${renderGroups.map((g) => `${g.key}(${g.scenarioNames.length})`).join(', ')}`);

  const { generation, failures } = await generateGeneration(
    provider,
    renderGroups,
    reportJson,
    corrections,
    resolvedGroupingPath,
    TESTS_STEPS_DIR,
    config.reportsDir,
    uatContext,
  );

  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = generation.generatedAt.replace(/[:.]/g, '-');
  const outPath = join(config.reportsDir, `generate-spec-proposed-${timestamp}.json`);
  await writeFile(outPath, JSON.stringify(generation, null, 2), 'utf-8');

  // generation.groups is now already merged (one entry per final .feature/
  // .steps.ts file, budget.ts-split pieces collapsed back to their sourceKey
  // — see spec.ts's generateGeneration), so compare against the number of
  // distinct source groups, not the (possibly larger) render-group count.
  const totalSourceKeys = new Set(renderGroups.map((g) => g.sourceKey)).size;
  console.log(`\n=== Generated ${generation.groups.length}/${totalSourceKeys} file(s) ===`);
  for (const g of generation.groups) {
    console.log(`  - ${g.key} (${g.scenarioNames.length} scenario(s)): ${g.scenarioNames.join(', ')}`);
  }
  if (failures.length > 0) {
    console.log(`\nFailed render group(s) (retry with --group ${failures.join(',')}): ${failures.join(', ')}`);
    process.exitCode = 1;
  }
  console.log(`\nWrote ${outPath}`);
}

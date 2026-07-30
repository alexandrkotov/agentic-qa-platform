import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProvider } from '../providers/AgentProvider.ts';
import { parseDiscoveryReport } from '../agents/generate/reportSchema.ts';
import { ApprovedGroupingSchema } from '../agents/generate/contract.ts';
import { splitByBudget, DEFAULT_MAX_SCENARIOS_PER_GROUP } from '../agents/generate/budget.ts';
import { generateSpec } from '../agents/generate/spec.ts';
import { loadCorrections } from '../agents/generate/corrections.ts';
import { config } from '../config.ts';

// ---------------------------------------------------------------------------
// Temporary CLI-only entry point for Stage 2 (milestone 5 of the Generate
// Agent redesign) — same role generateGroup.ts plays for Stage 1: lets the
// spec heuristic/LLM call be validated against real reports before the
// admin-UI review page exists. Superseded once bootstrap/generate.ts is
// rewritten to orchestrate all three stages (milestone 7).
// ---------------------------------------------------------------------------

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
  console.log('\n=== Generate Stage 2: Spec proposal ===\n');

  const resolvedGroupingPath = groupingPath ?? (await findLatestApprovedGrouping());
  console.log(`Using approved grouping: ${resolvedGroupingPath}`);
  const grouping = ApprovedGroupingSchema.parse(JSON.parse(await readFile(resolvedGroupingPath, 'utf-8')));

  const reportRaw = JSON.parse(await readFile(grouping.sourceReportPath, 'utf-8'));
  const report = parseDiscoveryReport(reportRaw);
  const reportJson = JSON.stringify(reportRaw, null, 2);

  const corrections = descriptorPath ? await loadCorrections(descriptorPath) : {};

  let renderGroups = splitByBudget(grouping, maxScenariosPerGroup ?? DEFAULT_MAX_SCENARIOS_PER_GROUP);
  if (groupFilter?.length) {
    renderGroups = renderGroups.filter((g) => groupFilter.includes(g.key));
    if (renderGroups.length === 0) {
      throw new Error(`--group matched no render groups (requested: ${groupFilter.join(', ')})`);
    }
  }
  console.log(`Render groups: ${renderGroups.map((g) => `${g.key}(${g.scenarioNames.length})`).join(', ')}`);

  const { spec, failures } = await generateSpec(provider, renderGroups, report, reportJson, corrections, resolvedGroupingPath);

  await mkdir(config.reportsDir, { recursive: true });
  const timestamp = spec.generatedAt.replace(/[:.]/g, '-');
  const outPath = join(config.reportsDir, `generate-spec-proposed-${timestamp}.json`);
  await writeFile(outPath, JSON.stringify(spec, null, 2), 'utf-8');

  console.log(
    `\n=== Generated specs for ${spec.scenarios.length} scenario(s) across ${renderGroups.length - failures.length}/${renderGroups.length} render group(s) ===`,
  );
  for (const s of spec.scenarios) {
    console.log(`  - [${s.group}] "${s.scenarioName}" (${s.type})${s.unconfirmed ? ' [UNCONFIRMED]' : ''}`);
  }
  if (failures.length > 0) {
    console.log(`\nFailed render group(s) (retry with --group ${failures.join(',')}): ${failures.join(', ')}`);
    process.exitCode = 1;
  }
  console.log(`\nWrote ${outPath}`);
}

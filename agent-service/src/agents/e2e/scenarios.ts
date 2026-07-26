import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface E2EScenarioConfig {
  id: string;
  title: string; // exact Cucumber scenario name
  featureName: string; // exact Gherkin "Feature:" name (cucumber-json nests scenarios under features)
  featurePath: string; // relative to tests/
  stepsPaths: string[]; // relative to tests/ — read as source context for diagnosis
  tags: string[]; // e.g. ['@happy_path', '@customers'] — used by resolveScenarioSelectors()
}

/** Maps a `.feature` file's basename (no extension) to the step-definition
 *  file(s) that implement its steps. NOT derivable from the .feature file
 *  alone: orders-items/orders-status/orders-validation all rely on shared
 *  `Given` steps extracted into orders-common.steps.ts, and there is no
 *  orders-common.feature to infer that relationship from. Keep this map in
 *  sync by hand whenever a domain or a shared steps file is added/removed —
 *  a missing entry only drops that domain's scenarios (see discoverScenarios
 *  below), it does not fail the whole run. */
const DOMAIN_STEPS_FILES: Record<string, string[]> = {
  customers: ['steps/customers.steps.ts'],
  products: ['steps/products.steps.ts'],
  security: ['steps/security.steps.ts'],
  'orders-items': ['steps/orders-items.steps.ts', 'steps/orders-common.steps.ts'],
  'orders-status': ['steps/orders-status.steps.ts', 'steps/orders-common.steps.ts'],
  'orders-validation': ['steps/orders-validation.steps.ts', 'steps/orders-common.steps.ts'],
};

/** Verified empirically against all 35 real scenario titles: zero collisions.
 *  Used as-is to derive `id` from `title` — do not change without re-checking
 *  uniqueness (discoverScenarios also re-checks this at runtime). */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface ParsedScenario {
  title: string;
  tags: string[];
}

interface ParsedFeature {
  featureName: string;
  scenarios: ParsedScenario[];
}

/** Deliberately minimal: this suite has no `Scenario Outline:`/`Examples:`
 *  (verified — every scenario across all 6 .feature files is a plain
 *  `Scenario:`, confirmed by counting). Tags are collected from `@`-prefixed
 *  lines immediately preceding a `Scenario:` line; any other real content
 *  (including `Background:`, which two of the six files have) resets the
 *  pending-tags buffer, so tags never leak across scenarios. If a
 *  `Scenario Outline:` is ever added, it's explicitly detected and skipped
 *  with a warning rather than silently mis-parsed or silently dropped. */
function parseFeatureContent(content: string, featurePath: string): ParsedFeature | null {
  const lines = content.split('\n');
  let featureName: string | null = null;
  const scenarios: ParsedScenario[] = [];
  let pendingTags: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (featureName === null) {
      const featureMatch = /^Feature:\s*(.+?)\s*$/.exec(line);
      if (featureMatch) {
        featureName = featureMatch[1];
        continue;
      }
    }

    if (/^@\S/.test(trimmed)) {
      pendingTags.push(...trimmed.split(/\s+/).filter((t) => t.startsWith('@')));
      continue;
    }

    if (/^\s*Scenario Outline:/.test(line)) {
      console.warn(
        `[discoverScenarios] ${featurePath}: found "${trimmed}" — Scenario Outline (parameterized) is not supported by this parser, skipping it.`,
      );
      pendingTags = [];
      continue;
    }

    const scenarioMatch = /^\s*Scenario:\s*(.+?)\s*$/.exec(line);
    if (scenarioMatch) {
      scenarios.push({ title: scenarioMatch[1], tags: pendingTags });
      pendingTags = [];
      continue;
    }

    if (trimmed !== '') pendingTags = []; // any other real content (Background:, step lines, comments) resets pending tags
  }

  if (featureName === null) {
    console.warn(`[discoverScenarios] ${featurePath}: no "Feature:" line found — skipping this file entirely.`);
    return null;
  }
  return { featureName, scenarios };
}

/**
 * Discovers every scenario by parsing the .feature files under
 * `<testsRoot>/features/` directly — no hand-maintained list. Called fresh
 * on every invocation (cheap: 6 small text files), so it can never go stale
 * relative to the actual suite.
 */
export async function discoverScenarios(testsRoot: string): Promise<E2EScenarioConfig[]> {
  const featuresDir = join(testsRoot, 'features');
  const entries = await readdir(featuresDir);
  const featureFiles = entries.filter((f) => f.endsWith('.feature')).sort();

  const scenarios: E2EScenarioConfig[] = [];
  const idToTitle = new Map<string, string>();

  for (const file of featureFiles) {
    const domain = file.slice(0, -'.feature'.length);
    const featurePath = `features/${file}`;
    const content = await readFile(join(featuresDir, file), 'utf-8');
    const parsed = parseFeatureContent(content, featurePath);
    if (!parsed) continue;

    const stepsPaths = DOMAIN_STEPS_FILES[domain];
    if (!stepsPaths) {
      console.warn(
        `[discoverScenarios] ${featurePath}: no entry in DOMAIN_STEPS_FILES for domain "${domain}" — skipping its ${parsed.scenarios.length} scenario(s). Add an entry to DOMAIN_STEPS_FILES to include them.`,
      );
      continue;
    }

    for (const { title, tags } of parsed.scenarios) {
      const id = slugify(title);
      if (idToTitle.has(id)) {
        throw new Error(
          `[discoverScenarios] id collision: "${id}" is produced by both "${idToTitle.get(id)}" and "${title}" — rename one of the scenarios or extend slugify().`,
        );
      }
      idToTitle.set(id, title);
      scenarios.push({ id, title, featureName: parsed.featureName, featurePath, stepsPaths, tags });
    }
  }

  if (scenarios.length === 0) {
    throw new Error(
      `[discoverScenarios] discovered 0 scenarios under ${featuresDir} — check testsRoot is correct and DOMAIN_STEPS_FILES isn't missing every domain.`,
    );
  }

  return scenarios;
}

/**
 * Resolves each --scenario selector (comma-split by the caller) against, in
 * order: an exact scenario id, an exact scenario title, or a tag (matched
 * with a leading '@' stripped from both sides, so 'WIP' and '@WIP' are
 * equivalent). A tag can select multiple scenarios at once. Throws
 * immediately naming any selector that matches none of the three — never
 * silently drops one.
 */
export function resolveScenarioSelectors(
  scenarios: E2EScenarioConfig[],
  selectors: string[],
): E2EScenarioConfig[] {
  const matchedIds = new Set<string>();
  const unmatched: string[] = [];

  for (const raw of selectors) {
    const selector = raw.trim();
    const bareTag = selector.startsWith('@') ? selector.slice(1) : selector;
    const byId = scenarios.find((s) => s.id === selector);
    const byTitle = scenarios.find((s) => s.title === selector);
    const byTag = scenarios.filter((s) => s.tags.some((t) => (t.startsWith('@') ? t.slice(1) : t) === bareTag));

    if (byId) matchedIds.add(byId.id);
    else if (byTitle) matchedIds.add(byTitle.id);
    else if (byTag.length > 0) for (const s of byTag) matchedIds.add(s.id);
    else unmatched.push(raw);
  }

  if (unmatched.length > 0) {
    const availableTags = [...new Set(scenarios.flatMap((s) => s.tags.map((t) => t.replace(/^@/, ''))))].sort();
    throw new Error(
      `Unknown --scenario selector(s): ${unmatched.join(', ')}. Each must be an exact scenario id, an exact scenario title, or a tag. ` +
        `Available tags: ${availableTags.join(', ')}.`,
    );
  }

  return scenarios.filter((s) => matchedIds.has(s.id));
}

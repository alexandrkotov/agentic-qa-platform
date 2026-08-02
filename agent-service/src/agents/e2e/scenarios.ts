import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface E2EScenarioConfig {
  id: string;
  title: string; // exact Cucumber scenario name
  featureName: string; // exact Gherkin "Feature:" name (cucumber-json nests scenarios under features)
  featurePath: string; // relative to tests/
  stepsPaths: string[]; // relative to tests/ — read as source context for diagnosis
  tags: string[]; // e.g. ['@happy_path', '@customers'] — used by resolveScenarioSelectors()
}

/** Overrides for domains where a `.feature` file's steps DON'T live in the
 *  single matching `steps/<domain>.steps.ts` — not derivable from the
 *  .feature file alone, so this has to be hand-maintained for exactly the
 *  domains where it's true. Empty today: the current suite is always the
 *  simple 1:1 case (one .feature, one matching .steps.ts) — but earlier
 *  suite layouts split large domains across several .feature files sharing
 *  one common steps file (e.g. orders-items/orders-status/orders-validation
 *  all reading from orders-common.steps.ts, before the Generate Agent
 *  redesign merged everything back into single per-domain files), and the
 *  Generate Agent's own budget-splitting could in principle produce that
 *  shape again. Add an entry here if/when it does — discoverScenarios below
 *  falls back to the 1:1 default otherwise. */
const DOMAIN_STEPS_FILES_OVERRIDES: Record<string, string[]> = {};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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
 * `<testsRoot>/features/` directly, and defaults each one's steps file to
 * the matching `steps/<domain>.steps.ts` — no hand-maintained list for the
 * common case. Called fresh on every invocation (cheap: a handful of small
 * text files), so it can never go stale relative to the actual suite.
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

    const defaultStepsPath = `steps/${domain}.steps.ts`;
    const override = DOMAIN_STEPS_FILES_OVERRIDES[domain];
    const stepsPaths = override ?? [defaultStepsPath];
    if (!override && !(await fileExists(join(testsRoot, defaultStepsPath)))) {
      console.warn(
        `[discoverScenarios] ${featurePath}: no "${defaultStepsPath}" and no entry in DOMAIN_STEPS_FILES_OVERRIDES for domain "${domain}" — skipping its ${parsed.scenarios.length} scenario(s). Add an override if this domain's steps live somewhere else.`,
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
      `[discoverScenarios] discovered 0 scenarios under ${featuresDir} — check testsRoot is correct and every domain's steps.ts file actually exists.`,
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

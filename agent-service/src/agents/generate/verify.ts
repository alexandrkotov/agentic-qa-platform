import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { CucumberExpression, ParameterTypeRegistry, RegularExpression, type Argument } from '@cucumber/cucumber-expressions';

// ---------------------------------------------------------------------------
// Deterministic, no-LLM safety net for Stage 2 (spec.ts). Once Stage 2 emits
// real, freeform .feature/.steps.ts text instead of a fixed generic-phrase
// DSL, nothing guarantees by construction that a Gherkin step's text still
// matches a step definition the model wrote in the same call — this file
// checks that for real (via the same @cucumber/cucumber-expressions library
// Cucumber/playwright-bdd use internally, not a regex heuristic) before
// anything is written to disk. A group that fails any check here throws;
// callers add it to the existing `failures: string[]` list and move on —
// same failure-handling pattern this pipeline already used pre-rewrite.
// ---------------------------------------------------------------------------

const SCENARIO_LINE = /^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/;

export function extractScenarioNames(featureContent: string): string[] {
  const names: string[] = [];
  for (const line of featureContent.split('\n')) {
    const m = SCENARIO_LINE.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

export interface GherkinStep {
  text: string;
  line: number;
}

const STEP_LINE = /^\s*(?:Given|When|Then|And|But)\s+(.+?)\s*$/;

/**
 * Line-scan, not a real Gherkin parser — good enough for this pipeline's own
 * output. Skips tag lines (`@...`), comment lines (`#...`), and everything
 * between a pair of `"""` docstring markers (data-table rows never match
 * STEP_LINE's leading keyword anyway, so they need no special handling).
 */
export function extractGherkinSteps(featureContent: string): GherkinStep[] {
  const steps: GherkinStep[] = [];
  let inDocstring = false;
  featureContent.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('"""')) {
      inDocstring = !inDocstring;
      return;
    }
    if (inDocstring || trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('@')) return;
    const m = STEP_LINE.exec(line);
    if (m) steps.push({ text: m[1], line: i + 1 });
  });
  return steps;
}

export interface StepPattern {
  pattern: string;
  isRegex: boolean;
  line: number;
  /** The handler function's own captured-argument count (its total parameter count minus the leading fixtures-destructure parameter) — compared against how many arguments Cucumber actually passes for a specific matching step text, the same "Function has N arguments, but expected M" class of error playwright-bdd's own bddgen throws at generation time. */
  declaredParamCount: number;
}

/**
 * Walks the generated .steps.ts with the real TypeScript compiler API rather
 * than a hand-rolled regex — generated step definitions routinely contain
 * template literals and nested quotes a regex extracts unreliably, and this
 * file is the sole safety net against a silent step-mismatch regression.
 */
export function extractStepDefinitionPatterns(stepsContent: string): StepPattern[] {
  const sourceFile = ts.createSourceFile('generated.steps.ts', stepsContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const patterns: StepPattern[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'Given' || node.expression.text === 'When' || node.expression.text === 'Then')
    ) {
      const arg = node.arguments[0];
      const handler = node.arguments[1];
      const declaredParamCount =
        handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) ? Math.max(0, handler.parameters.length - 1) : 0;
      if (arg) {
        const line = sourceFile.getLineAndCharacterOfPosition(arg.getStart(sourceFile)).line + 1;
        if (ts.isStringLiteralLike(arg)) {
          patterns.push({ pattern: arg.text, isRegex: false, line, declaredParamCount });
        } else if (ts.isRegularExpressionLiteral(arg)) {
          const m = /^\/(.*)\/([a-z]*)$/.exec(arg.text);
          if (m) patterns.push({ pattern: `${m[1]} ${m[2]}`, isRegex: true, line, declaredParamCount });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return patterns;
}

// A regex StepPattern's own `pattern` field is stored as "<source> <flags>"
// (see extractStepDefinitionPatterns) — flags are always the last
// whitespace-free token, but the source itself routinely contains spaces
// (e.g. "I send a request"), so splitting on the FIRST space rather than the
// LAST one silently truncated the source to its first word and mangled the
// flags. Affects both actually compiling the regex and describing it in an
// error message, so both go through this one correct split.
function splitRegexPattern(pattern: string): { source: string; flags: string } {
  const idx = pattern.lastIndexOf(' ');
  return idx === -1 ? { source: pattern, flags: '' } : { source: pattern.slice(0, idx), flags: pattern.slice(idx + 1) };
}

/** Full, readable text of a step pattern for error messages — never truncate to just its first word (a prior version's `.split(' ')[0]` made every message show "I"/"a"/"the" instead of the actual pattern, useless for diagnosing a real failure). */
function describePattern(p: StepPattern): string {
  if (!p.isRegex) return p.pattern;
  const { source, flags } = splitRegexPattern(p.pattern);
  return `/${source}/${flags}`;
}

function compilePattern(p: StepPattern, registry: ParameterTypeRegistry, groupKey: string) {
  try {
    if (p.isRegex) {
      const { source, flags } = splitRegexPattern(p.pattern);
      return new RegularExpression(new RegExp(source, flags), registry);
    }
    return new CucumberExpression(p.pattern, registry);
  } catch (err) {
    throw new Error(`[${groupKey}] Invalid step pattern at steps.ts:${p.line} ("${p.pattern}"): ${(err as Error).message}`);
  }
}

export interface GroupToVerify {
  key: string;
  scenarioNames: string[];
  featureContent: string;
  stepsContent: string;
}

/**
 * Verifies one freshly-generated group: scenario-name coverage; every
 * Gherkin step matching EXACTLY ONE step definition in the same file (zero
 * matches is an "Undefined step", more than one is the "Multiple definitions
 * matched" ambiguity playwright-bdd's own bddgen rejects — most commonly two
 * patterns differing only in parameter type, e.g. {int} vs {float} both
 * matching "0"); that matched definition's handler function declares exactly
 * as many captured parameters as Cucumber will actually pass for that step
 * text; and no step-pattern text colliding with a pattern already owned by a
 * different group (playwright-bdd step text is global across every loaded
 * .steps.ts file, not scoped per group/tag, so identical wording in two
 * groups would shadow/collide at runtime). Returns this group's own patterns
 * (pattern -> this group's key) on success, so the caller can merge them
 * into the registry before verifying the next group.
 */
export function compileAndVerify(group: GroupToVerify, priorPatterns: Map<string, string>): Map<string, string> {
  const actualNames = extractScenarioNames(group.featureContent);
  const actualSet = new Set(actualNames);
  const expectedSet = new Set(group.scenarioNames);
  const missing = group.scenarioNames.filter((n) => !actualSet.has(n));
  const extra = actualNames.filter((n) => !expectedSet.has(n));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`[${group.key}] Scenario name mismatch — missing: [${missing.join(', ')}], unexpected: [${extra.join(', ')}]`);
  }

  const defPatterns = extractStepDefinitionPatterns(group.stepsContent);
  if (defPatterns.length === 0) {
    throw new Error(`[${group.key}] No Given/When/Then step definitions found in the generated .steps.ts`);
  }

  const registry = new ParameterTypeRegistry();
  const compiled = defPatterns.map((p) => ({ p, expr: compilePattern(p, registry, group.key) }));

  const ownPatterns = new Map<string, string>();
  for (const p of defPatterns) {
    const owner = priorPatterns.get(p.pattern);
    if (owner && owner !== group.key) {
      throw new Error(
        `[${group.key}] Step pattern at steps.ts:${p.line} ("${describePattern(p)}") collides with an identical ` +
          `step already defined in group "${owner}" — step text is global across every .steps.ts file, not scoped per ` +
          `group, so identical wording in two groups would shadow/collide at runtime. Rephrase using this group's own ` +
          `entity vocabulary.`,
      );
    }
    ownPatterns.set(p.pattern, group.key);
  }

  const steps = extractGherkinSteps(group.featureContent);
  for (const step of steps) {
    const matches = compiled
      .map(({ p, expr }) => ({ p, args: expr.match(step.text) }))
      .filter((m): m is { p: StepPattern; args: readonly Argument[] } => m.args !== null);

    if (matches.length === 0) {
      const registered = defPatterns.map((p) => `"${describePattern(p)}"`).join(', ');
      throw new Error(
        `[${group.key}] Gherkin step at feature.feature:${step.line} ("${step.text}") does not match any step ` +
          `definition in the generated .steps.ts. Registered patterns: ${registered}`,
      );
    }
    if (matches.length > 1) {
      const culprits = matches.map((m) => `"${describePattern(m.p)}" (steps.ts:${m.p.line})`).join(' AND ');
      throw new Error(
        `[${group.key}] Gherkin step at feature.feature:${step.line} ("${step.text}") matches MULTIPLE step ` +
          `definitions — ${culprits}. This is usually two step definitions with the same wording but different ` +
          `parameter types (e.g. {int} vs {float}) both matching the same value. Remove the redundant definition.`,
      );
    }

    const [{ p, args }] = matches;
    if (args.length !== p.declaredParamCount) {
      throw new Error(
        `[${group.key}] Step definition at steps.ts:${p.line} ("${describePattern(p)}") declares ` +
          `${p.declaredParamCount} captured parameter(s) in its handler function, but the pattern actually captures ` +
          `${args.length} for step "${step.text}" (feature.feature:${step.line}). Fix the handler's parameter list to match.`,
      );
    }
  }

  return ownPatterns;
}

/**
 * Seeds a pattern registry from every `*.steps.ts` already on disk except
 * the groups currently being regenerated, so a partial re-run (e.g. one
 * failed render-group retried alone) is still checked for collisions against
 * the full existing suite, not just whatever's in the current batch.
 */
export async function collectExistingStepPatterns(stepsDir: string, excludeKeys: string[]): Promise<Map<string, string>> {
  const registry = new Map<string, string>();
  let files: string[];
  try {
    files = await readdir(stepsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return registry;
    throw err;
  }
  for (const file of files) {
    if (!file.endsWith('.steps.ts')) continue;
    const key = file.slice(0, -'.steps.ts'.length);
    if (excludeKeys.includes(key)) continue;
    const content = await readFile(join(stepsDir, file), 'utf-8');
    for (const p of extractStepDefinitionPatterns(content)) {
      registry.set(p.pattern, key);
    }
  }
  return registry;
}

/**
 * Seeds additional pattern-registry entries from every OTHER
 * `generate-spec-approved-*.json` for the SAME grouping, except the groups
 * currently being (re)generated/(re)approved — closes a real gap
 * collectExistingStepPatterns leaves: when a large grouping is generated as
 * several independent Claude calls/approval rounds (e.g. one call per
 * cross-functional group, done on purpose to avoid a different collision
 * that a single oversized call risked), a group approved in an earlier round
 * isn't written to tests/steps/ yet — "Write files" is a separate, later,
 * human-triggered step — so collectExistingStepPatterns's on-disk scan can't
 * see it. Two independently-approved groups can then both claim the exact
 * same step wording and nothing catches it until bddgen itself refuses to
 * build, well after both were already approved. Newest approval per group
 * key wins, same "latest state" semantics as
 * server.ts's /api/generate/spec-for-grouping merge. Malformed/partial JSON
 * (e.g. a file mid-write) is skipped rather than thrown — this is a safety
 * net, it must never itself be the reason generation/approval fails.
 */
export async function collectApprovedSpecPatterns(
  reportsDir: string,
  sourceGroupingPath: string,
  excludeKeys: string[],
): Promise<Map<string, string>> {
  const registry = new Map<string, string>();
  let files: string[];
  try {
    files = await readdir(reportsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return registry;
    throw err;
  }
  const candidates = files.filter((f) => f.startsWith('generate-spec-approved-') && f.endsWith('.json')).sort().reverse(); // newest first
  const seenKeys = new Set<string>(excludeKeys);
  for (const file of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(reportsDir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || (raw as { sourceGroupingPath?: unknown }).sourceGroupingPath !== sourceGroupingPath) continue;
    const groups = (raw as { groups?: { key?: unknown; stepsContent?: unknown }[] }).groups ?? [];
    for (const group of groups) {
      if (typeof group.key !== 'string' || typeof group.stepsContent !== 'string' || seenKeys.has(group.key)) continue;
      seenKeys.add(group.key);
      for (const p of extractStepDefinitionPatterns(group.stepsContent)) {
        registry.set(p.pattern, group.key);
      }
    }
  }
  return registry;
}

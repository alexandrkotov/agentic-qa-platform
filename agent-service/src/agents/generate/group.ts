import type { DiscoveryReport, TestScenario } from './reportSchema.ts';
import type { Group, ProposedGrouping } from './contract.ts';

// ---------------------------------------------------------------------------
// Stage 1 — deterministic grouping heuristic. No LLM call: this only reads a
// discovery report and produces a *proposal* for a human to approve or edit
// (see contract.ts's ProposedGrouping / ApprovedGrouping).
// ---------------------------------------------------------------------------

/** Scenario types that always form their own group regardless of which entity they touch. */
export const DEFAULT_CROSS_FUNCTIONAL_TYPES = ['security'];

/** Above this fraction of ungrouped scenarios, stop pretending there's structure — see flatFallback. */
export const DEFAULT_UNGROUPED_FALLBACK_RATIO = 0.3;

export interface GroupingOptions {
  crossFunctionalTypes?: string[];
  ungroupedFallbackRatio?: number;
}

interface Entity {
  /** Canonical group key, e.g. "orders" — becomes the group's `key` and, later, its file name. */
  key: string;
  /** Normalized words that identify this entity in scenario text (singular + plural forms, related table/path words). */
  words: Set<string>;
}

function splitWords(raw: string): string[] {
  // Splits "OrderItem" -> ["order", "item"] and "orders-status" / "orders_status" -> ["orders", "status"] alike.
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Deliberately naive (strip a trailing non-double 's'): good enough for this domain's plain English nouns. */
function singularize(word: string): string {
  if (word.endsWith('ss') || word.length <= 3) return word;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function pathSegments(path: string): string[] {
  return path
    .split('/')
    .filter((seg) => seg.length > 0 && !/^\{.*\}$/.test(seg))
    .map((seg) => seg.toLowerCase());
}

function tokenize(text: string): Set<string> {
  return new Set(splitWords(text).map(singularize));
}

/**
 * Builds entity candidates from whichever components have `.endpoints[]`
 * and/or `.tables[]` — never from a hardcoded component key like "postgres"
 * or "rest-api", since the real key in a report is sanitized
 * (componentKey() in descriptor/schema.ts) and can be a custom `name`.
 *
 * REST top-level path segments become the canonical entities first (they're
 * already plural, human-facing resource names, e.g. "customers"/"orders").
 * Table names then either merge into an existing entity when their words
 * overlap it (e.g. "OrderItem" -> {order, item} overlaps the "orders"
 * entity's {order}), or become their own fallback entity — for DB-only
 * systems, or tables with no REST surface.
 */
export function extractEntities(report: DiscoveryReport): Entity[] {
  const entities = new Map<string, Entity>();

  for (const component of Object.values(report.components)) {
    for (const endpoint of component.endpoints ?? []) {
      const segments = pathSegments(endpoint.path);
      const top = segments[0];
      if (!top) continue;
      const entity = entities.get(top) ?? { key: top, words: new Set<string>() };
      entity.words.add(top);
      entity.words.add(singularize(top));
      for (const seg of segments.slice(1)) {
        entity.words.add(seg);
        entity.words.add(singularize(seg));
      }
      entities.set(top, entity);
    }
  }

  for (const component of Object.values(report.components)) {
    for (const table of component.tables ?? []) {
      const tableWords = splitWords(table.name).map(singularize);
      const mergeTarget = [...entities.values()].find((entity) => tableWords.some((w) => entity.words.has(w)));
      if (mergeTarget) {
        for (const w of tableWords) mergeTarget.words.add(w);
        continue;
      }
      const fallbackKey = `${tableWords[tableWords.length - 1] ?? table.name.toLowerCase()}s`;
      const entity = entities.get(fallbackKey) ?? { key: fallbackKey, words: new Set<string>() };
      for (const w of tableWords) entity.words.add(w);
      entities.set(fallbackKey, entity);
    }
  }

  return [...entities.values()];
}

function matchSingleEntity(scenario: TestScenario, entities: Entity[]): Entity | null {
  const tokens = tokenize(`${scenario.name} ${scenario.description}`);
  const matches = entities.filter((entity) => [...tokens].some((t) => entity.words.has(t)));
  return matches.length === 1 ? matches[0] : null;
}

export function proposeGrouping(
  report: DiscoveryReport,
  sourceReportPath: string,
  options: GroupingOptions = {},
): ProposedGrouping {
  const crossFunctionalTypes = options.crossFunctionalTypes ?? DEFAULT_CROSS_FUNCTIONAL_TYPES;
  const threshold = options.ungroupedFallbackRatio ?? DEFAULT_UNGROUPED_FALLBACK_RATIO;

  const crossFunctional = new Map<string, string[]>();
  const remainder: TestScenario[] = [];
  for (const scenario of report.testScenarios) {
    if (crossFunctionalTypes.includes(scenario.type)) {
      const list = crossFunctional.get(scenario.type) ?? [];
      list.push(scenario.name);
      crossFunctional.set(scenario.type, list);
    } else {
      remainder.push(scenario);
    }
  }

  const entities = extractEntities(report);
  const byEntity = new Map<string, string[]>();
  const ungrouped: string[] = [];

  for (const scenario of remainder) {
    const entity = matchSingleEntity(scenario, entities);
    if (entity) {
      const list = byEntity.get(entity.key) ?? [];
      list.push(scenario.name);
      byEntity.set(entity.key, list);
    } else {
      ungrouped.push(scenario.name);
    }
  }

  const totalScenarios = report.testScenarios.length;
  const flatFallback = totalScenarios > 0 && ungrouped.length / totalScenarios > threshold;

  if (flatFallback) {
    return {
      generatedAt: new Date().toISOString(),
      sourceReportPath,
      crossFunctionalTypes,
      threshold,
      groups: [
        {
          key: 'all',
          scenarioNames: report.testScenarios.map((s) => s.name),
          rationale: `flatFallback: ${ungrouped.length}/${totalScenarios} scenarios did not match exactly one entity — refusing to pretend the rest has real structure`,
        },
      ],
      ungrouped: [],
      flatFallback: true,
    };
  }

  const groups: Group[] = [
    ...[...crossFunctional.entries()].map(([type, scenarioNames]) => ({
      key: type,
      scenarioNames,
      rationale: `cross-functional: type="${type}"`,
    })),
    ...[...byEntity.entries()].map(([key, scenarioNames]) => ({
      key,
      scenarioNames,
      rationale: `entity: "${key}"`,
    })),
  ];

  return {
    generatedAt: new Date().toISOString(),
    sourceReportPath,
    crossFunctionalTypes,
    threshold,
    groups,
    ungrouped,
    flatFallback: false,
  };
}

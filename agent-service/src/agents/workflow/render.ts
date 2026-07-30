import type { DiscoveryReport } from '../generate/reportSchema.ts';
import type { EntityWorkflow } from './contract.ts';

// ---------------------------------------------------------------------------
// Pure functions, no LLM: structured data -> Mermaid diagram text. Mirrors
// generate/templates/*.ts's role in Stage 3 — mechanical rendering of
// whatever a prior stage already structured and a human already approved.
// ---------------------------------------------------------------------------

function sanitizeId(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_');
  return cleaned || 'n';
}

/** Strips characters that would break out of a Mermaid label/note context. */
function sanitizeLabel(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/["`]/g, "'");
}

export interface RenderedEntityWorkflow {
  name: string;
  mermaid: string;
  guards: string[];
  invariants: string[];
}

/**
 * `forbidden_transition`/`guard`/`invariant` rules aren't graph edges —
 * Mermaid's stateDiagram-v2 has no "crossed-out" edge convention, and a
 * guard/invariant isn't necessarily tied to one state at all. Forbidden
 * transitions render as a note on their origin state (well-defined);
 * guards/invariants come back as plain text lists for the caller to show
 * alongside the diagram rather than forced into ambiguous Mermaid syntax.
 */
export function renderStateDiagram(entity: EntityWorkflow): RenderedEntityWorkflow {
  const idByState = new Map<string, string>();
  const ensureId = (state: string): string => {
    let id = idByState.get(state);
    if (!id) {
      id = `s${idByState.size}_${sanitizeId(state)}`;
      idByState.set(state, id);
    }
    return id;
  };
  entity.states.forEach(ensureId);

  const stateLines: string[] = [];
  for (const state of entity.states) {
    stateLines.push(`    ${ensureId(state)} : ${sanitizeLabel(state)}`);
  }

  const transitionLines: string[] = [];
  const guards: string[] = [];
  const invariants: string[] = [];
  let hasExplicitInitial = false;

  for (const rule of entity.rules) {
    switch (rule.kind) {
      case 'state_transition':
        if (rule.from === null) {
          transitionLines.push(`    [*] --> ${ensureId(rule.to)} : ${sanitizeLabel(rule.trigger)}`);
          hasExplicitInitial = true;
        } else {
          transitionLines.push(`    ${ensureId(rule.from)} --> ${ensureId(rule.to)} : ${sanitizeLabel(rule.trigger)}`);
        }
        break;
      case 'forbidden_transition':
        transitionLines.push(`    note right of ${ensureId(rule.from)}`);
        transitionLines.push(`        Forbidden: -> ${sanitizeLabel(rule.to)} (${sanitizeLabel(rule.reason)})`);
        transitionLines.push(`    end note`);
        break;
      case 'guard':
        guards.push(`${rule.action}: ${rule.condition} — ${rule.description}`);
        break;
      case 'invariant':
        invariants.push(rule.description);
        break;
    }
  }

  // Fallback only if the model never said explicitly which state is the
  // entry point — an explicit "from: null" rule (see spec.ts's prompt) is
  // more reliable than assuming array order is meaningful.
  const initialLines =
    !hasExplicitInitial && entity.states.length > 0 ? [`    [*] --> ${ensureId(entity.states[0])}`] : [];

  const lines = ['stateDiagram-v2', ...stateLines, ...initialLines, ...transitionLines];
  return { name: entity.name, mermaid: lines.join('\n'), guards, invariants };
}

/**
 * Entirely mechanical, no LLM involvement at all: entities/columns come
 * straight from whichever components have `.tables[]` (never a hardcoded
 * component key — same shape-based convention agents/generate/group.ts
 * already uses), and foreign keys are inferred by the `<name>Id` naming
 * convention this system's own schema happens to follow, matched against
 * the other table names actually present in the same report.
 *
 * Returns null when the report has no `.tables[]` anywhere (e.g. a
 * kafka-only descriptor) — there's nothing to draw, and an empty
 * `erDiagram` block would render as a blank canvas with no explanation.
 */
export function renderErDiagram(report: DiscoveryReport): string | null {
  const tables = Object.values(report.components).flatMap((c) => c.tables ?? []);
  if (tables.length === 0) return null;
  const tableNames = new Set(tables.map((t) => t.name));
  const lines = ['erDiagram'];

  for (const table of tables) {
    lines.push(`    ${sanitizeId(table.name)} {`);
    for (const column of table.columns ?? []) {
      const rawType = (column as { type?: unknown }).type;
      const type = typeof rawType === 'string' ? sanitizeId(rawType) : 'string';
      lines.push(`        ${type} ${sanitizeId(column.name)}`);
    }
    lines.push('    }');
  }

  const seenEdges = new Set<string>();
  for (const table of tables) {
    for (const column of table.columns ?? []) {
      const match = /^(.+)Id$/.exec(column.name);
      if (!match) continue;
      const refName = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      if (refName === table.name || !tableNames.has(refName)) continue;
      const edgeKey = `${refName}->${table.name}:${column.name}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      lines.push(`    ${sanitizeId(refName)} ||--o{ ${sanitizeId(table.name)} : "${sanitizeLabel(column.name)}"`);
    }
  }

  return lines.join('\n');
}

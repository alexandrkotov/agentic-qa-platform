import type { DiscoveryReport } from '../generate/reportSchema.ts';
import type { EntityWorkflow, UiPageFlow } from './contract.ts';

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

/** `web_ui` -> "Web ui", `rest-api` -> "Rest api" — a readable node label from a report component key, without hardcoding any specific key name. */
function prettifyKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
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
        // A real edge between the two (already-existing) states, not a
        // floating note — reads as part of the graph instead of a
        // disconnected annotation. stateDiagram-v2 has no per-edge color/
        // dash styling hook, so the "✗ Forbidden" prefix is what carries the
        // distinction instead.
        transitionLines.push(
          `    ${ensureId(rule.from)} --> ${ensureId(rule.to)} : ✗ Forbidden — ${sanitizeLabel(rule.reason)}`,
        );
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

/**
 * Entirely mechanical, no LLM: which components exist and what shape each one
 * has (`.uiPages`/`.endpoints`/`.tables`/`.topic`/`.topics` — same shape-based
 * convention as the ER diagram, never a hardcoded component key) is enough to
 * draw a generic three-layer architecture (UI -> API -> DB, API -> Kafka).
 * These edges are a standard-architecture assumption, not a claim the report
 * verified — the same kind of inference the ER diagram already makes for
 * foreign keys by naming convention.
 *
 * Returns null when fewer than two components were classified — nothing
 * meaningful to connect.
 */
export function renderArchitectureDiagram(report: DiscoveryReport): string | null {
  interface ArchNode {
    id: string;
    label: string;
  }
  const uiNodes: ArchNode[] = [];
  const apiNodes: ArchNode[] = [];
  const dbNodes: ArchNode[] = [];
  const kafkaNodes: ArchNode[] = [];

  for (const [key, component] of Object.entries(report.components)) {
    const id = sanitizeId(key);
    const label = prettifyKey(key);
    const c = component as {
      uiPages?: unknown[];
      endpoints?: unknown[];
      tables?: unknown[];
      topic?: unknown;
      topics?: unknown[];
    };
    if (Array.isArray(c.uiPages)) uiNodes.push({ id, label: `${label}<br/>${c.uiPages.length} pages` });
    if (Array.isArray(c.endpoints)) apiNodes.push({ id, label: `${label}<br/>${c.endpoints.length} endpoints` });
    if (Array.isArray(c.tables)) dbNodes.push({ id, label: `${label}<br/>${c.tables.length} tables` });
    if (typeof c.topic === 'string') kafkaNodes.push({ id, label: `${label}<br/>topic: ${sanitizeLabel(c.topic)}` });
    else if (Array.isArray(c.topics)) kafkaNodes.push({ id, label: `${label}<br/>${c.topics.length} topics` });
  }

  const allNodes = [...uiNodes, ...apiNodes, ...dbNodes, ...kafkaNodes];
  if (allNodes.length < 2) return null;

  const lines = ['flowchart LR'];
  for (const n of allNodes) lines.push(`    ${n.id}["${n.label}"]`);
  for (const ui of uiNodes) for (const api of apiNodes) lines.push(`    ${ui.id} -->|HTTP| ${api.id}`);
  for (const api of apiNodes) for (const db of dbNodes) lines.push(`    ${api.id} -->|SQL| ${db.id}`);
  for (const api of apiNodes) for (const kafka of kafkaNodes) lines.push(`    ${api.id} -->|events| ${kafka.id}`);

  return lines.join('\n');
}

export interface RenderedUiFlow {
  mermaid: string;
  actionsByPage: { route: string; actions: string[] }[];
}

/**
 * A single combined flowchart for the whole page graph, not one diagram per
 * page — unlike entity workflows, navigation is inherently cross-page.
 * `navigation` transitions become edges; `in_place_action` transitions aren't
 * graph edges (they don't leave the page) and come back as a plain list per
 * page instead, the same way guards/invariants do for renderStateDiagram.
 */
export function renderUiFlowDiagram(flow: { pages: UiPageFlow[] }): RenderedUiFlow | null {
  if (flow.pages.length === 0) return null;

  const idByRoute = new Map<string, string>();
  const ensureId = (route: string): string => {
    let id = idByRoute.get(route);
    if (!id) {
      id = `p${idByRoute.size}_${sanitizeId(route)}`;
      idByRoute.set(route, id);
    }
    return id;
  };
  // Two passes: first every page's own route, then every navigation target —
  // a target route the model referenced but didn't separately describe (e.g.
  // a detail page) still gets a proper node with its route path as the label.
  for (const page of flow.pages) ensureId(page.route);
  for (const page of flow.pages) {
    for (const t of page.transitions) {
      if (t.kind === 'navigation') ensureId(t.to);
    }
  }

  const edgeLines: string[] = [];
  const actionsByPage: { route: string; actions: string[] }[] = [];
  for (const page of flow.pages) {
    const inPlace: string[] = [];
    for (const t of page.transitions) {
      if (t.kind === 'navigation') {
        edgeLines.push(`    ${ensureId(page.route)} -->|${sanitizeLabel(t.action)}| ${ensureId(t.to)}`);
      } else {
        inPlace.push(`${t.action}: ${t.description}`);
      }
    }
    if (inPlace.length > 0) actionsByPage.push({ route: page.route, actions: inPlace });
  }

  const nodeLines = [...idByRoute.entries()].map(([route, id]) => `    ${id}["${sanitizeLabel(route)}"]`);
  const lines = ['flowchart LR', ...nodeLines, ...edgeLines];
  return { mermaid: lines.join('\n'), actionsByPage };
}

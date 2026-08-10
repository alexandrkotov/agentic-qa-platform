import type { DiscoveryReport } from '../generate/reportSchema.ts';
import type { EntityWorkflow, UiPageFlow, ScenarioFlow } from './contract.ts';

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

/** Strips separators/casing so "monitor_id"/"monitorId"/"MonitorID" all
 *  collapse to the same key — lets the FK match below work regardless of
 *  which naming convention a given system's schema actually uses. */
function normalizeIdentifier(s: string): string {
  return s.toLowerCase().replace(/_/g, '');
}

/**
 * Entirely mechanical, no LLM involvement at all: entities/columns come
 * straight from whichever components have `.tables[]` (never a hardcoded
 * component key — same shape-based convention agents/generate/group.ts
 * already uses), and foreign keys are inferred by an `<name>Id`/`<name>_id`
 * naming convention, matched (case/separator-insensitively — see
 * normalizeIdentifier) against the other table names actually present in
 * the same report. Confirmed live this needs to cover BOTH conventions:
 * orderflow's own Postgres schema uses camelCase (`customerId`), while a
 * SQLite schema explored via the sqlite component type (e.g. Uptime Kuma's
 * `monitor_id`, `user_id`) uses snake_case — a camelCase-only match against
 * 22 of Kuma's 23 tables' real FK columns produced zero edges at all.
 *
 * Returns null when the report has no `.tables[]` anywhere (e.g. a
 * kafka-only descriptor) — there's nothing to draw, and an empty
 * `erDiagram` block would render as a blank canvas with no explanation.
 */
export function renderErDiagram(report: DiscoveryReport): string | null {
  const tables = Object.values(report.components).flatMap((c) => c.tables ?? []);
  if (tables.length === 0) return null;
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

  const tableByNormalizedName = new Map<string, string>();
  for (const t of tables) tableByNormalizedName.set(normalizeIdentifier(t.name), t.name);

  const seenEdges = new Set<string>();
  for (const table of tables) {
    for (const column of table.columns ?? []) {
      const match = /^(.+?)(?:Id|_id)$/.exec(column.name);
      if (!match) continue;
      const refName = tableByNormalizedName.get(normalizeIdentifier(match[1]));
      if (!refName || refName === table.name) continue;
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

/**
 * Entirely mechanical, no LLM: `.endpoints[]` already arrives fully
 * structured — `{method, path, description, requestBody, responseSchema}` —
 * pulled directly from a real, live OpenAPI/Swagger spec at discovery time
 * (see descriptor/components/restApi.ts's own prompt). Unlike UI Inventory,
 * there's no relationship between endpoints to infer here, just a list to
 * group and format, so this stays free/instant like Architecture and ER
 * rather than needing a Claude call of its own.
 *
 * Grouped by resource — the path's first segment, so `/orders/{id}/status`
 * groups under `/orders` alongside every other `/orders*` endpoint — rather
 * than one node per endpoint. A REST API's own resource shape is usually the
 * more useful way to scan its surface, and it keeps the diagram from turning
 * into dozens of disconnected single-line boxes. No edges between groups:
 * unlike UI Inventory's pages, endpoints don't have a meaningful "leads to"
 * relationship with each other.
 *
 * Returns null when the report has no `.endpoints[]` anywhere.
 */
export function renderApiInventoryDiagram(report: DiscoveryReport): string | null {
  interface Endpoint {
    method: string;
    path: string;
    description: string;
  }
  const endpoints: Endpoint[] = [];
  for (const component of Object.values(report.components)) {
    const list = (component as { endpoints?: unknown[] }).endpoints;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const e = raw as { method?: unknown; path?: unknown; description?: unknown };
      if (typeof e.method !== 'string' || typeof e.path !== 'string') continue;
      endpoints.push({
        method: e.method,
        path: e.path,
        description: typeof e.description === 'string' ? e.description : '',
      });
    }
  }
  if (endpoints.length === 0) return null;

  const resourceOf = (path: string): string => {
    const first = path.split('/').filter(Boolean)[0];
    return first ? `/${first}` : '/';
  };

  const byResource = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    const key = resourceOf(e.path);
    const group = byResource.get(key) ?? [];
    group.push(e);
    byResource.set(key, group);
  }

  const lines = ['flowchart LR'];
  let i = 0;
  for (const [resource, group] of byResource) {
    const id = `r${i++}_${sanitizeId(resource)}`;
    // <b> on just the method+path (not the description) so each entry's own
    // start is visually distinct even once Mermaid line-wraps a long
    // description — a plain <br/>-joined list of same-weight text reads as
    // one continuous paragraph with no way to tell where one endpoint's
    // wrapped description ends and the next one begins. A blank line
    // (double <br/>) between entries reinforces that same separation.
    const rows = group.map((e) => {
      const desc = e.description ? ` — ${sanitizeLabel(e.description)}` : '';
      return `<b>${sanitizeLabel(e.method.toUpperCase())} ${sanitizeLabel(e.path)}</b>${desc}`;
    });
    const label = `<b>${sanitizeLabel(resource)}</b><br/><br/>${rows.join('<br/><br/>')}`;
    lines.push(`    ${id}["${label}"]`);
  }
  return lines.join('\n');
}

export interface RenderedUiFlow {
  mermaid: string;
}

/**
 * A single combined flowchart for the whole page graph, not one diagram per
 * page — unlike entity workflows, navigation is inherently cross-page.
 * `navigation` transitions become edges between two different pages.
 * `in_place_action` transitions don't leave the page, so they aren't edges —
 * tried rendering them as self-loop edges on their own node first, but
 * Mermaid's flowchart layout only keeps the last self-loop when a node has
 * more than one, silently dropping the rest. Listing every in-place action
 * directly inside its page's own node label instead has no such limit and
 * scales to any number of actions.
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

  const actionsByRoute = new Map<string, string[]>();
  const edgeLines: string[] = [];
  for (const page of flow.pages) {
    const pageId = ensureId(page.route);
    for (const t of page.transitions) {
      if (t.kind === 'navigation') {
        edgeLines.push(`    ${pageId} -->|${sanitizeLabel(t.action)}| ${ensureId(t.to)}`);
      } else {
        const list = actionsByRoute.get(page.route) ?? [];
        list.push(t.action);
        actionsByRoute.set(page.route, list);
      }
    }
  }

  const nodeLines = [...idByRoute.entries()].map(([route, id]) => {
    const actions = actionsByRoute.get(route);
    const label = actions
      ? `<b>${sanitizeLabel(route)}</b><br/>${actions.map(sanitizeLabel).join('<br/>')}`
      : sanitizeLabel(route);
    return `    ${id}["${label}"]`;
  });
  const lines = ['flowchart LR', ...nodeLines, ...edgeLines];
  return { mermaid: lines.join('\n') };
}

export interface RenderedSequenceFlow {
  name: string;
  mermaid: string;
}

/**
 * Entirely mechanical, no LLM: one Mermaid `sequenceDiagram` per scenario —
 * unlike UI Inventory's single combined graph, a sequence is inherently about
 * one specific scenario, so combining several into one diagram would just be
 * a tangle. Participants are declared in first-appearance order across the
 * scenario's own steps, aliased through the same `prettifyKey` used for
 * Architecture's node labels (report component keys, never hardcoded) — the
 * reserved "User" actor is left as-is, it already reads fine.
 */
export function renderSequenceDiagram(scenario: ScenarioFlow): RenderedSequenceFlow {
  const idByParticipant = new Map<string, string>();
  const ensureId = (participant: string): string => {
    let id = idByParticipant.get(participant);
    if (!id) {
      id = participant === 'User' ? 'User' : `c${idByParticipant.size}_${sanitizeId(participant)}`;
      idByParticipant.set(participant, id);
    }
    return id;
  };
  for (const step of scenario.steps) {
    ensureId(step.from);
    ensureId(step.to);
  }

  const participantLines = [...idByParticipant.entries()].map(([participant, id]) =>
    participant === 'User' ? '    participant User' : `    participant ${id} as ${sanitizeLabel(prettifyKey(participant))}`,
  );
  const stepLines = scenario.steps.map(
    (step) => `    ${ensureId(step.from)}->>${ensureId(step.to)}: ${sanitizeLabel(step.label)}`,
  );

  const lines = ['sequenceDiagram', ...participantLines, ...stepLines];
  return { name: scenario.name, mermaid: lines.join('\n') };
}

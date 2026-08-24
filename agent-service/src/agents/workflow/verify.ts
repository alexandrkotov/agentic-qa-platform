import type { DiscoveryReport } from '../generate/reportSchema.ts';
import type { EntityWorkflow, ScenarioFlow, UiPageFlow } from './contract.ts';

// ---------------------------------------------------------------------------
// Deterministic, no-LLM safety net for the Analysis Agent's three propose/
// approve models — same idea as agents/generate/verify.ts's compileAndVerify
// and e2e/diagnose.ts's sanitizeStructuredFix: zod's contract.ts only checks
// SHAPE (field types), never that a cross-reference inside the model
// actually points at something real. Confirmed live that render.ts's
// renderStateDiagram/renderSequenceDiagram silently mint a phantom node for
// any unknown from/to instead of rejecting it, so a hallucinated/typo'd
// reference would otherwise reach a human as a real-looking diagram with no
// indication anything was wrong. Callers run these both right after the
// model responds (propose) AND again at human-approval time (approve) —
// the workbench UI lets a person hand-edit the JSON in a textarea before
// clicking Approve, same reasoning as the Duplicate Step Validation gap.
// ---------------------------------------------------------------------------

/**
 * `state_transition`/`forbidden_transition` rules' `from`/`to` must actually
 * be one of that SAME entity's own declared `states` — `from: null` on a
 * `state_transition` is the documented "created directly into `to`, no prior
 * state" case and is never flagged.
 */
export function findWorkflowViolations(entities: EntityWorkflow[]): string[] {
  const violations: string[] = [];
  for (const entity of entities) {
    const known = new Set(entity.states);
    const knownList = entity.states.join(', ') || 'none';
    for (const rule of entity.rules) {
      if (rule.kind === 'state_transition') {
        if (rule.from !== null && !known.has(rule.from)) {
          violations.push(
            `[${entity.name}] state_transition "${rule.trigger}": from-state "${rule.from}" is not in this entity's own "states" list (${knownList})`,
          );
        }
        if (!known.has(rule.to)) {
          violations.push(
            `[${entity.name}] state_transition "${rule.trigger}": to-state "${rule.to}" is not in this entity's own "states" list (${knownList})`,
          );
        }
      } else if (rule.kind === 'forbidden_transition') {
        if (!known.has(rule.from)) {
          violations.push(
            `[${entity.name}] forbidden_transition: from-state "${rule.from}" is not in this entity's own "states" list (${knownList})`,
          );
        }
        if (!known.has(rule.to)) {
          violations.push(
            `[${entity.name}] forbidden_transition: to-state "${rule.to}" is not in this entity's own "states" list (${knownList})`,
          );
        }
      }
      // guard/invariant rules have no state cross-reference to check.
    }
  }
  return violations;
}

export function verifyWorkflow(entities: EntityWorkflow[]): void {
  const violations = findWorkflowViolations(entities);
  if (violations.length > 0) {
    throw Object.assign(new Error(`Workflow model failed semantic validation:\n${violations.join('\n')}`), { status: 400 });
  }
}

/**
 * A sequence-flow step's `from`/`to` must actually be the reserved "User"
 * actor or one of the report's real component keys — never an invented
 * participant name, per proposeSequenceFlow.ts's own prompt.
 */
export function findSequenceFlowViolations(scenarios: ScenarioFlow[], componentKeys: string[]): string[] {
  const known = new Set([...componentKeys, 'User']);
  const knownList = componentKeys.join(', ') || 'none';
  const violations: string[] = [];
  for (const scenario of scenarios) {
    scenario.steps.forEach((step, i) => {
      if (!known.has(step.from)) {
        violations.push(
          `[${scenario.name}] step ${i + 1} ("${step.label}"): "from" participant "${step.from}" is not "User" or a real report component key (${knownList})`,
        );
      }
      if (!known.has(step.to)) {
        violations.push(
          `[${scenario.name}] step ${i + 1} ("${step.label}"): "to" participant "${step.to}" is not "User" or a real report component key (${knownList})`,
        );
      }
    });
  }
  return violations;
}

export function verifySequenceFlow(scenarios: ScenarioFlow[], componentKeys: string[]): void {
  const violations = findSequenceFlowViolations(scenarios, componentKeys);
  if (violations.length > 0) {
    throw Object.assign(new Error(`Sequence flow model failed semantic validation:\n${violations.join('\n')}`), { status: 400 });
  }
}

/**
 * Entirely mechanical scan of every component's `.uiPages[].route` — same
 * untyped-cast convention as render.ts's renderArchitectureDiagram, since
 * a report component's shape (reportSchema.ts's ReportComponentSchema) is a
 * `.passthrough()` and doesn't pin down `uiPages` at all.
 */
export function collectReportRoutes(report: DiscoveryReport): Set<string> {
  const routes = new Set<string>();
  for (const component of Object.values(report.components)) {
    const pages = (component as { uiPages?: unknown[] }).uiPages;
    if (!Array.isArray(pages)) continue;
    for (const page of pages) {
      const route = (page as { route?: unknown }).route;
      if (typeof route === 'string') routes.add(route);
    }
  }
  return routes;
}

/**
 * Only a page's own `route` is checked against the report's real routes —
 * NOT a `navigation` transition's `to`, which proposeUiFlow.ts's own prompt
 * explicitly allows to be an inferred route not literally listed in the
 * report (e.g. a detail page's route), so there is no honest closed set to
 * validate it against.
 */
export function findUiFlowViolations(pages: UiPageFlow[], knownRoutes: Set<string>): string[] {
  const knownList = [...knownRoutes].join(', ') || 'none';
  const violations: string[] = [];
  for (const page of pages) {
    if (!knownRoutes.has(page.route)) {
      violations.push(`page.route "${page.route}" does not match any real "uiPages[].route" in the source report (${knownList})`);
    }
  }
  return violations;
}

export function verifyUiFlow(pages: UiPageFlow[], knownRoutes: Set<string>): void {
  const violations = findUiFlowViolations(pages, knownRoutes);
  if (violations.length > 0) {
    throw Object.assign(new Error(`UI flow model failed semantic validation:\n${violations.join('\n')}`), { status: 400 });
  }
}

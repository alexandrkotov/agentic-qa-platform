import { z } from 'zod';
import type { AgentProvider } from '../../providers/AgentProvider.ts';
import type { DiscoveryReport } from '../generate/reportSchema.ts';
import { UiPageFlowSchema, type ProposedUiFlow } from './contract.ts';
import { collectReportRoutes, verifyUiFlow } from './verify.ts';

// ---------------------------------------------------------------------------
// One LLM call, structuring a discovery report's `web_ui.uiPages[]` (each
// page's own action list is already structured) into which actions navigate
// to another route vs. stay in place — a distinction the report doesn't spell
// out and prose-parsing can't reliably recover. Same single-holistic-call
// shape as propose.ts, not split by group.
// ---------------------------------------------------------------------------

function buildSystemPrompt(reportJson: string): string {
  return `You are a QA analyst turning a system discovery report's UI page/action inventory into a
structured navigation-flow model. A later, non-LLM step renders this as a flowchart a human reads to
understand how a user moves through the application — so every field must be concrete and
machine-usable, not prose.

## System discovery report
${reportJson}

## Your task
Look at every web-UI-shaped component's "uiPages" array (each entry has a "route" and an "actions"
list). For EVERY page listed there, and for EVERY action on that page, decide whether clicking it
navigates the user to a different route or keeps them on the same page, and produce:
{
  "route": "<the page's route, exactly as given>",
  "transitions": [ <Transition>, ... ]
}

A Transition is one of:
  { "kind": "navigation", "action": "Show history", "to": "/orders" } — the action sends the user to a
    different route (use the target route's exact path; if it's implied but not literally listed as
    its own uiPages entry — e.g. a detail view — still give its route path as best you can infer it)
  { "kind": "in_place_action", "action": "Add Customer", "description": "Submits the form and adds a row to the table on the same page, no navigation" }

Rules:
1. Cover every action listed for every page — do not skip any, and do not invent actions not listed.
2. A redirect described in a page's own "description" (e.g. "Redirects to /customers") is also a
   navigation transition — give it a synthetic action name like "Redirects" if the report doesn't name
   a specific button/link for it.
3. Most CRUD actions on a list/table page (Add/Edit/Delete/Submit and similar) stay on the same page —
   only mark "navigation" when the action's own name/context clearly implies moving to a different
   route (e.g. "View details", "Show history" if that's a separate route, a link to another page).
4. If the report has no web-UI-shaped component at all (no "uiPages" anywhere), return an empty
   "pages" array — do not invent pages.
5. Never invent a target route not implied by the report — if genuinely unsure whether an action
   navigates or not, prefer "in_place_action" (the safer default for a typical CRUD table/form UI).

## Output contract — read carefully
Output ONLY a single valid JSON object of the shape { "pages": [ <page>, ... ] }, no markdown fences,
no prose before or after.`;
}

const USER_MESSAGE = 'Produce the structured UI navigation flow model for this report per your instructions.';

export async function proposeUiFlow(
  provider: AgentProvider,
  report: DiscoveryReport,
  sourceReportPath: string,
  /** Which target system's descriptor sourceReportPath belongs to, for the usage log's descriptor filter — see admin/server.ts's descriptorFromReportName(). Optional; omitted callers just get an unlabeled usage entry. */
  descriptorLabel?: string,
): Promise<ProposedUiFlow> {
  const raw = await provider.run({
    systemPrompt: buildSystemPrompt(JSON.stringify(report, null, 2)),
    userMessage: USER_MESSAGE,
    mcpServers: [],
    tools: [],
    maxIterations: 5,
    operation: 'workflow-ui-flow-propose',
    descriptor: descriptorLabel,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `UI flow proposal response did not contain a JSON object (response started with: ${raw.slice(0, 200)})`,
    );
  }
  const parsed = z.object({ pages: z.array(UiPageFlowSchema) }).parse(JSON.parse(jsonMatch[0]));
  verifyUiFlow(parsed.pages, collectReportRoutes(report));

  return {
    generatedAt: new Date().toISOString(),
    sourceReportPath,
    pages: parsed.pages,
  };
}

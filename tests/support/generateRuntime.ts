// Shared runtime for scenarios produced by the Generate Agent pipeline
// (agent-service/src/agents/generate/). Every generated <group>.steps.ts file
// wires a fixed set of literal, group-scoped step texts to the functions
// here — the actual HTTP/DB/UI mechanics live in exactly one place instead of
// being duplicated per group, the same role support/db.ts and
// support/orderCtx.ts already play for the hand-written domains.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { db, ensureDbConnected } from './db';
import { waitForKafkaMessage } from './kafka';

const API_BASE = process.env.BACKEND_URL ?? 'http://localhost:3000';

export interface Ctx {
  lastResponse: Awaited<ReturnType<APIRequestContext['get']>> | null;
  lastBody: any;
  /** Every created id per top-level REST resource (e.g. "customers", "orders"), in creation order, scoped to one scenario. */
  createdIds: Record<string, number[]>;
  /** Resolves every "{{unique}}" occurrence within one scenario run — see spec.ts's prompt rule 1b. */
  uniqueToken: string;
}

export function resetCtx(): Ctx {
  return {
    lastResponse: null,
    lastBody: null,
    createdIds: {},
    uniqueToken: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
  };
}

// ---------------------------------------------------------------------------
// Placeholder resolution — see spec.ts's system prompt rules 1a/1b. A
// scenario's own structured spec is written before any test run, so it can
// contain neither a real numeric id nor a truly-unique value; both are
// written as placeholders here and resolved against this scenario's own ctx:
//   - "{resource.id}" (whole-string match) -> the id captured from the most
//     recent given/when POST to that resource in THIS scenario.
//   - "{resource[N].id}" -> the Nth (0-indexed, creation order) id captured
//     for that resource in THIS scenario — needed when a scenario creates
//     more than one of the same resource (e.g. two products) and must refer
//     to a specific one, not just "the latest".
//   - "{{unique}}" (anywhere inside a string) -> the same fresh token
//     throughout this scenario run, so two occurrences of "{{unique}}" (e.g.
//     one in "given", one reused on purpose in "when") stay equal to each
//     other, while differing from every other run of the same suite.
// ---------------------------------------------------------------------------

const FIELD_PLACEHOLDER = /^\{(\w+)(?:\[(\d+)\])?\.id\}$/;

function lookupCreatedId(ctx: Ctx, resource: string, index?: string): number {
  const ids = ctx.createdIds[resource];
  if (!ids || ids.length === 0) {
    throw new Error(
      `No previously-created id recorded for resource "${resource}" — check that an earlier given/when step in this scenario actually creates it.`,
    );
  }
  const i = index !== undefined ? Number(index) : ids.length - 1;
  const id = ids[i];
  if (id === undefined) {
    throw new Error(
      `No id recorded at index ${i} for resource "${resource}" — only ${ids.length} were created in this scenario.`,
    );
  }
  return id;
}

function resolveValue(value: unknown, ctx: Ctx): unknown {
  if (typeof value === 'string') {
    const withUniqueResolved = value.includes('{{unique}}') ? value.replaceAll('{{unique}}', ctx.uniqueToken) : value;
    const m = FIELD_PLACEHOLDER.exec(withUniqueResolved);
    if (!m) return withUniqueResolved;
    const [, resource, index] = m;
    return lookupCreatedId(ctx, resource, index);
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, ctx)]));
  }
  return value;
}

/**
 * Path params use the literal `{id}`-style form already shown in the report's
 * own endpoint path (e.g. "/orders/{id}/status") rather than the
 * "{resource.id}" field form — resolved here against the path's OWN
 * top-level resource segment (always "the most recent one", no index form:
 * a path naturally refers to one specific already-identified resource, not
 * "the Nth one created"), regardless of what the placeholder word itself
 * says. Holds for every endpoint in this system (customers/{id},
 * products/{id}, orders/{id}, orders/{id}/status, orders/{id}/items all
 * reference their own resource) — a path whose id param refers to a
 * *different* resource would need a smarter rule, not needed here.
 */
function resolvePath(path: string, ctx: Ctx): string {
  const segments = path.split('/').filter(Boolean);
  const resource = segments[0];
  return path.replace(/\{(\w+)\}/g, () => String(lookupCreatedId(ctx, resource ?? '')));
}

async function safeJson(res: NonNullable<Ctx['lastResponse']>): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ApiActionInput {
  method: string;
  path: string;
  requestBody?: Record<string, unknown> | null;
}

export async function runApiAction(ctx: Ctx, request: APIRequestContext, action: ApiActionInput): Promise<void> {
  const path = resolvePath(action.path, ctx);
  const data = action.requestBody != null ? resolveValue(action.requestBody, ctx) : undefined;
  const res = await request.fetch(`${API_BASE}${path}`, { method: action.method, data });
  ctx.lastResponse = res;
  ctx.lastBody = await safeJson(res);

  if (
    res.ok() &&
    ctx.lastBody &&
    typeof ctx.lastBody === 'object' &&
    !Array.isArray(ctx.lastBody) &&
    typeof ctx.lastBody.id !== 'undefined'
  ) {
    const resource = path.split('/').filter(Boolean)[0];
    if (resource) (ctx.createdIds[resource] ??= []).push(ctx.lastBody.id);
  }
}

/**
 * Finds the target role/label element scoped to whichever ancestor is the
 * smallest one that contains both `scopeText` and that element — needed on
 * any page that repeats the same role/label per row/card (e.g. an "Order
 * history" button once per order). Climbs from the scope text upward rather
 * than guessing a container CSS class/tag (checked against this project's
 * real DOM: order cards are plain "bg-slate-800..." divs with no row/card
 * class to key off), so it needs no knowledge of the target app's markup.
 */
async function findScopedLocator(page: Page, scopeText: string, role: string, label: string) {
  const roleArg = role as Parameters<Page['getByRole']>[0];
  // A bare numeric scope (the overwhelmingly common case: an entity's own
  // id) needs a word boundary — plain substring matching would also match
  // "180" while looking for "18". Non-numeric scope text keeps substring
  // matching, since it's typically a whole distinguishing phrase already.
  const isNumeric = /^\d+$/.test(scopeText.trim());
  const matches = isNumeric
    ? page.getByText(new RegExp(`\\b${scopeText.trim()}\\b`))
    : page.getByText(scopeText, { exact: false });

  // Try every occurrence of the scope text, not just the first — a numeric
  // scope in particular can coincidentally also match unrelated text
  // elsewhere on the page (e.g. an order id of 50 also matching a "$50.00"
  // price cell in a different row), so the first occurrence isn't
  // necessarily the one whose ancestor chain contains the real target.
  const matchCount = await matches.count();
  for (let m = 0; m < matchCount; m++) {
    let current = matches.nth(m);
    for (let i = 0; i < 8; i++) {
      const target = current.getByRole(roleArg, { name: label });
      if ((await target.count()) === 1) return target;
      current = current.locator('xpath=..');
    }
  }
  throw new Error(
    `Could not find a unique "${role}" element named "${label}" near any of the ${matchCount} occurrence(s) of text "${scopeText}" on the page.`,
  );
}

export interface UiActionInput {
  role: string;
  label: string;
  route?: string;
  value?: string;
  /** Distinguishing visible text of the row/card to act within — see findScopedLocator(). */
  scope?: string;
}

export async function runUiAction(ctx: Ctx, page: Page, action: UiActionInput): Promise<void> {
  if (action.route) await page.goto(action.route);
  const scope = action.scope != null ? String(resolveValue(action.scope, ctx)) : null;
  const locator = scope
    ? await findScopedLocator(page, scope, action.role, action.label)
    : page.getByRole(action.role as Parameters<Page['getByRole']>[0], { name: action.label });
  // The Gherkin renderer always writes an explicit "value": null (not an
  // omitted key) when there's no value — JSON.parse gives null, not
  // undefined, and typeof null === 'object', so a strict `=== undefined`
  // check here would send that null into .fill() instead of clicking.
  if (action.value == null) {
    await locator.click();
  } else if (action.role === 'combobox') {
    await locator.selectOption(action.value);
  } else {
    await locator.fill(action.value);
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export function expectStatusCode(ctx: Ctx, { statusCode }: { statusCode: number }): void {
  expect(ctx.lastResponse?.status()).toBe(statusCode);
}

export function expectBodyField(ctx: Ctx, { field, expected }: { field: string; expected: unknown }): void {
  const actual = ctx.lastBody?.[field];
  const resolvedExpected = resolveValue(expected, ctx);
  // Same Postgres-numeric-as-string quirk as expectDbRow (e.g. a price
  // field comes back "39.99", a spec author writes the plain number 39.99).
  if (isNumericLike(actual) && isNumericLike(resolvedExpected)) {
    expect(Number(actual)).toBe(Number(resolvedExpected));
  } else {
    expect(actual).toEqual(resolvedExpected);
  }
}

/**
 * "matches" may itself contain a "{word}" placeholder standing in for an id
 * the assertion's author couldn't know ahead of time (e.g. a correction's
 * "Cannot transition order {id} from SUBMITTED to DRAFT") — that placeholder
 * becomes a `\d+` wildcard rather than a literal substitution, since the
 * point is "some id", not one we necessarily captured under that exact name.
 */
export function expectErrorMessage(ctx: Ctx, { matches }: { matches: string }): void {
  const sentinel = ' ';
  // Bare "{word}" (e.g. a correction's own "{id}") and the same
  // "{resource.id}"/"{resource[N].id}" form resolveValue() understands
  // elsewhere both become the same wildcard here — the model doesn't
  // reliably stick to the bare form even when a correction's own text does,
  // generalizing instead from the {resource.id} convention used in every
  // other field.
  const withSentinels = matches.replace(/\{[\w.[\]]+\}/g, sentinel);
  const escaped = withSentinels.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped.split(sentinel).join('\\d+'), 'i');
  expect(JSON.stringify(ctx.lastBody ?? {})).toMatch(pattern);
}

/** Postgres NUMERIC columns come back as fixed-scale strings (e.g. "75.00"), while a spec's expected value is often a plain author-written number ("75") — compare numerically whenever both sides look like numbers, falling back to string equality otherwise. */
function isNumericLike(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim());
}

export async function expectDbRow(
  ctx: Ctx,
  { table, where, expectedFields }: { table: string; where: Record<string, unknown>; expectedFields: Record<string, unknown> },
): Promise<void> {
  await ensureDbConnected();
  const resolvedWhere = resolveValue(where, ctx) as Record<string, unknown>;
  const keys = Object.keys(resolvedWhere);
  const conditions = keys.map((k, i) => `"${k}" = $${i + 1}`).join(' AND ');
  const res = await db.query(`SELECT * FROM "${table}" WHERE ${conditions}`, keys.map((k) => resolvedWhere[k]));
  expect(res.rowCount).toBeGreaterThan(0);
  const row = res.rows[0];
  const resolvedExpected = resolveValue(expectedFields, ctx) as Record<string, unknown>;
  for (const [field, value] of Object.entries(resolvedExpected)) {
    const actual = row[field];
    if (isNumericLike(actual) && isNumericLike(value)) {
      expect(Number(actual)).toBe(Number(value));
    } else {
      expect(String(actual)).toBe(String(value));
    }
  }
}

export async function expectUiText(
  ctx: Ctx,
  page: Page,
  { role, label, expectedText, scope }: { role: string; label: string; expectedText: string; scope?: string | null },
): Promise<void> {
  const resolvedScope = scope != null ? String(resolveValue(scope, ctx)) : null;
  const locator = resolvedScope
    ? await findScopedLocator(page, resolvedScope, role, label)
    : page.getByRole(role as Parameters<Page['getByRole']>[0], { name: label });
  await expect(locator).toContainText(expectedText);
}

export async function expectUiVisible(
  ctx: Ctx,
  page: Page,
  { role, label, visible, scope }: { role: string; label: string; visible: boolean; scope?: string | null },
): Promise<void> {
  const resolvedScope = scope != null ? String(resolveValue(scope, ctx)) : null;
  const locator = resolvedScope
    ? await findScopedLocator(page, resolvedScope, role, label)
    : page.getByRole(role as Parameters<Page['getByRole']>[0], { name: label });
  if (visible) await expect(locator).toBeVisible();
  else await expect(locator).toBeHidden();
}

/**
 * The generated .steps.ts file's own Before hook already called
 * ensureKafkaConsumerReady() for this group's topics (derived by render.ts
 * from the group's own spec) before this scenario's given/when steps ran —
 * required because the consumer only sees messages produced after it
 * subscribes, so it must already be listening before the action that
 * triggers the message, not merely before this assertion checks for it.
 */
export async function expectKafkaMessage(
  ctx: Ctx,
  { topic, expectedFields }: { topic: string; expectedFields: Record<string, unknown> },
): Promise<void> {
  const resolved = resolveValue(expectedFields, ctx) as Record<string, unknown>;
  const message = await waitForKafkaMessage(topic, (msg) =>
    Object.entries(resolved).every(([field, value]) => String(msg[field]) === String(value)),
  );
  expect(message).toBeTruthy();
}

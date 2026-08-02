import { type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared helper for pages that repeat the same role+label more than once
// (e.g. one "Show history" button per order card) — a bare
// page.getByRole(role, { name: label }) is ambiguous there. Generated step
// definitions (agent-service/src/agents/generate/spec.ts's prompt) are told
// to import this specifically for that case; everywhere else they write a
// plain page.getByRole/getByPlaceholder/getByLabel call directly.
// ---------------------------------------------------------------------------

/**
 * Finds the target role/label element scoped to whichever ancestor is the
 * smallest one that contains both `scopeText` and that element — needed on
 * any page that repeats the same role/label per row/card. Climbs from the
 * scope text upward rather than guessing a container CSS class/tag, so it
 * needs no knowledge of the target app's markup.
 */
export async function findScopedLocator(page: Page, scopeText: string, role: string, label: string) {
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

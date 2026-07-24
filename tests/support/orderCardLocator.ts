import type { Page } from '@playwright/test';

// Order cards render as plain divs (ARIA role "generic"), not table rows —
// role="row" only applies to the item sub-table inside each card. Anchor on
// "Order #<id>" text (word-boundary guarded so #1 doesn't match #14/#140)
// plus the "Show history" button, which is present on every card regardless
// of status. XPath's ancestor:: axis returns nearest-ancestor-first, so [1]
// gets the closest containing element that also has "Show history" — the
// card boundary — rather than filtering/guessing across the whole page.
export function orderCardLocator(page: Page, orderId: number) {
  const heading = page.getByText(new RegExp(`Order #${orderId}\\b`));
  return heading.locator('xpath=ancestor::*[contains(., "Show history")][1]');
}

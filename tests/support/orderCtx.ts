// Shared, cross-file state for order-related setup steps used by
// orders-items.steps.ts, orders-status.steps.ts, and orders-validation.steps.ts.
// Canonical setup Given()s live in steps/orders-common.steps.ts; this module
// only holds the mutable state object + reset function.
export const orderCtx: Record<string, any> = {};

export function resetOrderCtx(): void {
  for (const key of Object.keys(orderCtx)) {
    delete orderCtx[key];
  }
}
import {
  apiActionPhrase,
  uiActionPhrase,
  statusCodePhrase,
  bodyFieldPhrase,
  errorMessagePhrase,
  dbRowPhrase,
  uiTextPhrase,
  uiVisiblePhrase,
} from './phrases.ts';

/** Escapes a string for embedding inside a single-quoted TS string literal. */
function tsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ---------------------------------------------------------------------------
// Stage 3, no LLM: the .steps.ts file for a render-group is always this same
// 8-step skeleton, parameterized only by the group's own key — every scenario
// in the group's .feature file resolves against these same 8 definitions
// (see templates/gherkin.ts), and all the actual HTTP/DB/UI work happens in
// the shared tests/support/generateRuntime.ts, not here.
// ---------------------------------------------------------------------------

export function renderStepsFile(key: string): string {
  return `import { createBdd } from 'playwright-bdd';
import {
  resetCtx,
  runApiAction,
  runUiAction,
  expectStatusCode,
  expectBodyField,
  expectErrorMessage,
  expectDbRow,
  expectUiText,
  expectUiVisible,
  type Ctx,
} from '../support/generateRuntime';

const { When, Then, Before } = createBdd();

let ctx: Ctx = resetCtx();
Before({ tags: '@${key}' }, async () => {
  ctx = resetCtx();
});

When(${tsString(apiActionPhrase(key))}, async ({ request }, docString: string) => {
  await runApiAction(ctx, request, JSON.parse(docString));
});

When(${tsString(uiActionPhrase(key))}, async ({ page }, docString: string) => {
  await runUiAction(ctx, page, JSON.parse(docString));
});

Then(${tsString(statusCodePhrase(key))}, async ({}, docString: string) => {
  expectStatusCode(ctx, JSON.parse(docString));
});

Then(${tsString(bodyFieldPhrase(key))}, async ({}, docString: string) => {
  expectBodyField(ctx, JSON.parse(docString));
});

Then(${tsString(errorMessagePhrase(key))}, async ({}, docString: string) => {
  expectErrorMessage(ctx, JSON.parse(docString));
});

Then(${tsString(dbRowPhrase(key))}, async ({}, docString: string) => {
  await expectDbRow(ctx, JSON.parse(docString));
});

Then(${tsString(uiTextPhrase(key))}, async ({ page }, docString: string) => {
  await expectUiText(ctx, page, JSON.parse(docString));
});

Then(${tsString(uiVisiblePhrase(key))}, async ({ page }, docString: string) => {
  await expectUiVisible(ctx, page, JSON.parse(docString));
});
`;
}

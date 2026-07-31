import { createBdd } from 'playwright-bdd';
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
Before({ tags: '@orders-3' }, async () => {
  ctx = resetCtx();
});

When('an API request is sent for "orders-3":', async ({ request }, docString: string) => {
  await runApiAction(ctx, request, JSON.parse(docString));
});

When('a UI action is performed for "orders-3":', async ({ page }, docString: string) => {
  await runUiAction(ctx, page, JSON.parse(docString));
});

Then('the "orders-3" response has this status code:', async ({}, docString: string) => {
  expectStatusCode(ctx, JSON.parse(docString));
});

Then('the "orders-3" response body has this field:', async ({}, docString: string) => {
  expectBodyField(ctx, JSON.parse(docString));
});

Then('the "orders-3" response matches this error message:', async ({}, docString: string) => {
  expectErrorMessage(ctx, JSON.parse(docString));
});

Then('the database has this row for "orders-3":', async ({}, docString: string) => {
  await expectDbRow(ctx, JSON.parse(docString));
});

Then('the "orders-3" UI shows this text:', async ({ page }, docString: string) => {
  await expectUiText(ctx, page, JSON.parse(docString));
});

Then('the "orders-3" UI element has this visibility:', async ({ page }, docString: string) => {
  await expectUiVisible(ctx, page, JSON.parse(docString));
});

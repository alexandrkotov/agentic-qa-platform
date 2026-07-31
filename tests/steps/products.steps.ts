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
Before({ tags: '@products' }, async () => {
  ctx = resetCtx();
});

When('an API request is sent for "products":', async ({ request }, docString: string) => {
  await runApiAction(ctx, request, JSON.parse(docString));
});

When('a UI action is performed for "products":', async ({ page }, docString: string) => {
  await runUiAction(ctx, page, JSON.parse(docString));
});

Then('the "products" response has this status code:', async ({}, docString: string) => {
  expectStatusCode(ctx, JSON.parse(docString));
});

Then('the "products" response body has this field:', async ({}, docString: string) => {
  expectBodyField(ctx, JSON.parse(docString));
});

Then('the "products" response matches this error message:', async ({}, docString: string) => {
  expectErrorMessage(ctx, JSON.parse(docString));
});

Then('the database has this row for "products":', async ({}, docString: string) => {
  await expectDbRow(ctx, JSON.parse(docString));
});

Then('the "products" UI shows this text:', async ({ page }, docString: string) => {
  await expectUiText(ctx, page, JSON.parse(docString));
});

Then('the "products" UI element has this visibility:', async ({ page }, docString: string) => {
  await expectUiVisible(ctx, page, JSON.parse(docString));
});

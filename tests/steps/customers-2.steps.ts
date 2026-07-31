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
Before({ tags: '@customers-2' }, async () => {
  ctx = resetCtx();
});

When('an API request is sent for "customers-2":', async ({ request }, docString: string) => {
  await runApiAction(ctx, request, JSON.parse(docString));
});

When('a UI action is performed for "customers-2":', async ({ page }, docString: string) => {
  await runUiAction(ctx, page, JSON.parse(docString));
});

Then('the "customers-2" response has this status code:', async ({}, docString: string) => {
  expectStatusCode(ctx, JSON.parse(docString));
});

Then('the "customers-2" response body has this field:', async ({}, docString: string) => {
  expectBodyField(ctx, JSON.parse(docString));
});

Then('the "customers-2" response matches this error message:', async ({}, docString: string) => {
  expectErrorMessage(ctx, JSON.parse(docString));
});

Then('the database has this row for "customers-2":', async ({}, docString: string) => {
  await expectDbRow(ctx, JSON.parse(docString));
});

Then('the "customers-2" UI shows this text:', async ({ page }, docString: string) => {
  await expectUiText(ctx, page, JSON.parse(docString));
});

Then('the "customers-2" UI element has this visibility:', async ({ page }, docString: string) => {
  await expectUiVisible(ctx, page, JSON.parse(docString));
});

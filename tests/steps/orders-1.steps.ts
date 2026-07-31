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
  expectKafkaMessage,
  type Ctx,
} from '../support/generateRuntime';
import { ensureKafkaConsumerReady } from '../support/kafka';

const { When, Then, Before } = createBdd();

let ctx: Ctx = resetCtx();
Before({ tags: '@orders-1' }, async () => {
  ctx = resetCtx();
  await ensureKafkaConsumerReady(["orders.status-changed"]);
});

When('an API request is sent for "orders-1":', async ({ request }, docString: string) => {
  await runApiAction(ctx, request, JSON.parse(docString));
});

When('a UI action is performed for "orders-1":', async ({ page }, docString: string) => {
  await runUiAction(ctx, page, JSON.parse(docString));
});

Then('the "orders-1" response has this status code:', async ({}, docString: string) => {
  expectStatusCode(ctx, JSON.parse(docString));
});

Then('the "orders-1" response body has this field:', async ({}, docString: string) => {
  expectBodyField(ctx, JSON.parse(docString));
});

Then('the "orders-1" response matches this error message:', async ({}, docString: string) => {
  expectErrorMessage(ctx, JSON.parse(docString));
});

Then('the database has this row for "orders-1":', async ({}, docString: string) => {
  await expectDbRow(ctx, JSON.parse(docString));
});

Then('the "orders-1" UI shows this text:', async ({ page }, docString: string) => {
  await expectUiText(ctx, page, JSON.parse(docString));
});

Then('the "orders-1" UI element has this visibility:', async ({ page }, docString: string) => {
  await expectUiVisible(ctx, page, JSON.parse(docString));
});

Then('a Kafka message for "orders-1" matches this:', async ({}, docString: string) => {
  await expectKafkaMessage(ctx, JSON.parse(docString));
});

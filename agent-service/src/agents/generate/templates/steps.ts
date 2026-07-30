import {
  apiActionPhrase,
  uiActionPhrase,
  statusCodePhrase,
  bodyFieldPhrase,
  errorMessagePhrase,
  dbRowPhrase,
  uiTextPhrase,
  uiVisiblePhrase,
  kafkaMessagePhrase,
} from './phrases.ts';

/** Escapes a string for embedding inside a single-quoted TS string literal. */
function tsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ---------------------------------------------------------------------------
// Stage 3, no LLM: the .steps.ts file for a render-group is always this same
// step skeleton, parameterized only by the group's own key — every scenario
// in the group's .feature file resolves against these same definitions (see
// templates/gherkin.ts), and all the actual HTTP/DB/UI/Kafka work happens in
// the shared tests/support/generateRuntime.ts, not here.
//
// kafkaTopics is derived by render.ts from the group's own approved spec
// (every distinct "topic" its scenarios' kafka_message assertions reference)
// — never hardcoded here. When empty, no Kafka consumer is subscribed at
// all, so groups that don't need Kafka pay no connection cost for it.
// ---------------------------------------------------------------------------

export function renderStepsFile(key: string, kafkaTopics: string[] = []): string {
  const needsKafka = kafkaTopics.length > 0;
  const runtimeImports = [
    'resetCtx',
    'runApiAction',
    'runUiAction',
    'expectStatusCode',
    'expectBodyField',
    'expectErrorMessage',
    'expectDbRow',
    'expectUiText',
    'expectUiVisible',
    ...(needsKafka ? ['expectKafkaMessage'] : []),
    'type Ctx',
  ];
  const kafkaImport = needsKafka ? `\nimport { ensureKafkaConsumerReady } from '../support/kafka';` : '';
  const kafkaSetup = needsKafka ? `\n  await ensureKafkaConsumerReady(${JSON.stringify(kafkaTopics)});` : '';
  const kafkaStep = needsKafka
    ? `\n\nThen(${tsString(kafkaMessagePhrase(key))}, async ({}, docString: string) => {
  await expectKafkaMessage(ctx, JSON.parse(docString));
});`
    : '';

  return `import { createBdd } from 'playwright-bdd';
import {
  ${runtimeImports.join(',\n  ')},
} from '../support/generateRuntime';${kafkaImport}

const { When, Then, Before } = createBdd();

let ctx: Ctx = resetCtx();
Before({ tags: '@${key}' }, async () => {
  ctx = resetCtx();${kafkaSetup}
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
});${kafkaStep}
`;
}

import type { Action, Assertion, ScenarioSpec } from '../contract.ts';
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

// ---------------------------------------------------------------------------
// Stage 3, no LLM: pure functions turning a ScenarioSpec's structured
// given/when/then into Gherkin text. Every Given/When/Then line is one of a
// fixed set of literal, group-scoped phrases (phrases.ts) followed by a JSON
// docstring carrying the actual data — see templates/steps.ts for the step
// definitions these lines resolve against, and tests/support/generateRuntime.ts
// for what actually executes them.
// ---------------------------------------------------------------------------

const STEP_INDENT = '    ';
const DOC_INDENT = STEP_INDENT + '  ';

function docstringBlock(payload: unknown): string {
  const json = JSON.stringify(payload, null, 2);
  const content = json
    .split('\n')
    .map((line) => DOC_INDENT + line)
    .join('\n');
  return `${DOC_INDENT}"""\n${content}\n${DOC_INDENT}"""`;
}

function actionStep(keyword: string, key: string, action: Action): string {
  const [phrase, payload] =
    action.kind === 'api'
      ? [apiActionPhrase(key), { method: action.method, path: action.path, requestBody: action.requestBody ?? null }]
      : [
          uiActionPhrase(key),
          { role: action.role, label: action.label, route: action.route ?? null, value: action.value ?? null, scope: action.scope ?? null },
        ];
  return `${STEP_INDENT}${keyword} ${phrase}\n${docstringBlock(payload)}`;
}

function assertionStep(keyword: string, key: string, assertion: Assertion): string {
  const [phrase, payload] = ((): [string, unknown] => {
    switch (assertion.kind) {
      case 'status_code':
        return [statusCodePhrase(key), { statusCode: assertion.statusCode }];
      case 'body_field':
        return [bodyFieldPhrase(key), { field: assertion.field, expected: assertion.expected }];
      case 'error_message':
        return [errorMessagePhrase(key), { matches: assertion.matches }];
      case 'db_row':
        return [dbRowPhrase(key), { table: assertion.table, where: assertion.where, expectedFields: assertion.expectedFields }];
      case 'ui_text':
        return [
          uiTextPhrase(key),
          { role: assertion.role, label: assertion.label, expectedText: assertion.expectedText, scope: assertion.scope ?? null },
        ];
      case 'ui_visible':
        return [
          uiVisiblePhrase(key),
          { role: assertion.role, label: assertion.label, visible: assertion.visible, scope: assertion.scope ?? null },
        ];
      case 'kafka_message':
        return [kafkaMessagePhrase(key), { topic: assertion.topic, expectedFields: assertion.expectedFields }];
    }
  })();
  return `${STEP_INDENT}${keyword} ${phrase}\n${docstringBlock(payload)}`;
}

export function renderScenario(scenario: ScenarioSpec, key: string): string {
  const lines: string[] = [];
  lines.push(`  @${scenario.type} @${key}`);
  lines.push(`  Scenario: ${scenario.scenarioName}`);
  if (scenario.unconfirmed) {
    lines.push(`${STEP_INDENT}# TODO (unconfirmed): ${scenario.unconfirmed}`);
  }

  scenario.given.forEach((action, i) => {
    lines.push(actionStep(i === 0 ? 'Given' : 'And', key, action));
  });
  lines.push(actionStep('When', key, scenario.when));
  scenario.then.forEach((assertion, i) => {
    lines.push(assertionStep(i === 0 ? 'Then' : 'And', key, assertion));
  });

  return lines.join('\n');
}

export function renderFeature(key: string, scenarios: ScenarioSpec[]): string {
  const body = scenarios.map((s) => renderScenario(s, key)).join('\n\n');
  return `Feature: ${key}\n\n${body}\n`;
}

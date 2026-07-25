export interface E2EScenarioConfig {
  id: string;
  title: string; // exact Cucumber scenario name
  featureName: string; // exact Gherkin "Feature:" name (cucumber-json nests scenarios under features)
  featurePath: string; // relative to tests/
  stepsPaths: string[]; // relative to tests/ — read as source context for diagnosis
}

// v1: exactly one hardcoded scenario. Prove the closed loop before
// generalizing to a scenario selector (see docs/phase4-status.md).
export const SCENARIOS: E2EScenarioConfig[] = [
  {
    id: 'submit-draft-order',
    title: 'Submit DRAFT order',
    featureName: 'Order status management',
    featurePath: 'features/orders-status.feature',
    stepsPaths: ['steps/orders-status.steps.ts', 'steps/orders-common.steps.ts'],
  },
];

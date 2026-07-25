export interface E2EScenarioConfig {
  id: string;
  title: string; // exact Cucumber scenario name
  featureName: string; // exact Gherkin "Feature:" name (cucumber-json nests scenarios under features)
  featurePath: string; // relative to tests/
  stepsPaths: string[]; // relative to tests/ — read as source context for diagnosis
}

// Deliberately spans three different scenario "shapes" — not three more
// E2E-style checks — to test whether the runner/evidence/diagnose mechanism
// is genuinely scenario-agnostic or whether it needs specialization per
// shape (open question in docs/phase4-status.md, "E2E Agent" naming note):
//   - submit-draft-order: cross-layer — UI action, then verified via both
//     a direct API call AND a direct Postgres query. The original "E2E"-shaped case.
//   - create-customer-valid: UI-driven — action + assertion happen through
//     the page, with a DB check but no explicit API assertion.
//   - invalid-customer-id: pure API — no UI, no direct DB query at all.
export const SCENARIOS: E2EScenarioConfig[] = [
  {
    id: 'submit-draft-order',
    title: 'Submit DRAFT order',
    featureName: 'Order status management',
    featurePath: 'features/orders-status.feature',
    stepsPaths: ['steps/orders-status.steps.ts', 'steps/orders-common.steps.ts'],
  },
  {
    id: 'create-customer-valid',
    title: 'Create customer with valid data',
    featureName: 'Customer Management',
    featurePath: 'features/customers.feature',
    stepsPaths: ['steps/customers.steps.ts'],
  },
  {
    id: 'invalid-customer-id',
    title: 'Invalid customer ID in API',
    featureName: 'Customer Management',
    featurePath: 'features/customers.feature',
    stepsPaths: ['steps/customers.steps.ts'],
  },
];

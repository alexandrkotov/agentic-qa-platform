// Single source of truth for the 8 literal step-text phrases used by both
// gherkin.ts (writes .feature files) and steps.ts (registers matching step
// definitions in .steps.ts files). Both sides MUST build the exact same
// string from the same render-group key — if they ever drifted (e.g. one
// side tweaks wording, the other doesn't), Cucumber would report an
// "Undefined step", the exact class of report/code mismatch this whole
// redesign exists to eliminate. Importing from one place instead of
// duplicating the template literal in both files is what prevents that.

export const apiActionPhrase = (key: string) => `an API request is sent for "${key}":`;
export const uiActionPhrase = (key: string) => `a UI action is performed for "${key}":`;
export const statusCodePhrase = (key: string) => `the "${key}" response has this status code:`;
export const bodyFieldPhrase = (key: string) => `the "${key}" response body has this field:`;
export const errorMessagePhrase = (key: string) => `the "${key}" response matches this error message:`;
export const dbRowPhrase = (key: string) => `the database has this row for "${key}":`;
export const uiTextPhrase = (key: string) => `the "${key}" UI shows this text:`;
export const uiVisiblePhrase = (key: string) => `the "${key}" UI element has this visibility:`;

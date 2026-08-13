/**
 * Tier 1 of the "Record setup" feature (see memory `project_setup_script_autogen_idea` and this
 * repo's own README "Adding a new target" section) — a purely mechanical, no-Claude-call transform
 * from a raw `npx playwright codegen <url>` recording into a draft `SetupFn`. Deliberately does
 * NOT attempt the two things that actually made `setup/trilium.ts` and `setup/nocodb.ts`
 * trustworthy: finding the target's own real "am I configured yet" endpoint (a research task, not
 * a text transform), and deciding which recorded steps are optional/cosmetic (needs a live check —
 * see `setup/nocodb.ts`'s own header comment for the post-signup-survey example). Both stay a
 * human/Claude-in-chat job; this module only saves the mechanical part: wrapping the recording into
 * this project's `SetupFn` shape, parametrizing typed secrets, and dropping the one recorded
 * pattern that's unambiguously redundant (a `.click()` immediately before a `.fill()` on the exact
 * same locator — codegen always records the focusing click even though `.fill()` focuses on its
 * own).
 *
 * Regex/line-based, not a real AST parser — `playwright codegen`'s own output is reliably one full
 * `await page.X;` statement per line, uniform enough that a real parser (the `typescript` package
 * is already a dependency) would be more machinery than this needs.
 */

export interface ConvertedDraft {
  /** Full SetupFn file content — for copying into bootstrap/setup/<name>.ts, not auto-saved (the
   *  workbench container can't write agent-service/src/ at runtime — see this project's own
   *  README/memory for why). */
  code: string;
  /** Suggested env var names — human sets real values in descriptors/<name>.env. */
  envVars: string[];
  /** Always non-empty — this tier's own honest limitations, meant to be shown, not buried. */
  warnings: string[];
}

interface Step {
  /** The locator chain text, e.g. `page.getByRole('textbox', { name: 'Password', exact: true })`. */
  chain: string;
  action: 'click' | 'check' | 'uncheck' | 'fill' | 'press' | 'other';
  /** Raw literal argument text for fill/press (still quoted), before any parametrization. */
  argLiteral?: string;
}

const STEP_RE = /^\s*await\s+(page\..+?);\s*$/;
const GOTO_RE = /^page\.goto\(\s*(['"`])(.*?)\1\s*(?:,.*)?\)$/;
const TRAILING_CALL_RE = /^(.*)\.(click|check|uncheck)\(\s*\)$/;
const TRAILING_FILL_OR_PRESS_RE = /^(.*)\.(fill|press)\(\s*(['"`])((?:\\.|(?!\3).)*)\3\s*\)$/;
const NAME_ATTR_RE = /name:\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

function classify(stmt: string): Step {
  const fillOrPress = stmt.match(TRAILING_FILL_OR_PRESS_RE);
  if (fillOrPress) {
    return { chain: fillOrPress[1], action: fillOrPress[2] as 'fill' | 'press', argLiteral: fillOrPress[4] };
  }
  const call = stmt.match(TRAILING_CALL_RE);
  if (call) {
    return { chain: call[1], action: call[2] as 'click' | 'check' | 'uncheck' };
  }
  return { chain: stmt, action: 'other' };
}

/** Last `name: '...'` in the chain wins — the outermost/most specific locator in a chain like
 *  `page.getByRole('textbox', { name: 'Password', exact: true })` only ever has one, but a chained
 *  `.filter({ ... })` could add a second; the field's own name is what a human actually typed
 *  next to, so it's the more useful source for a variable name. */
function fieldNameFromChain(chain: string): string | null {
  let last: string | null = null;
  for (const m of chain.matchAll(NAME_ATTR_RE)) last = m[2];
  return last;
}

function toEnvVarName(fieldName: string | null, fallbackIndex: number): string {
  const cleaned = (fieldName ?? `FIELD_${fallbackIndex}`)
    .replace(/^\*+\s*/, '') // leading "* " on a required-field label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || `FIELD_${fallbackIndex}`;
}

export function convertRecording(raw: string, descriptorName: string): ConvertedDraft {
  const warnings = [
    'No real idempotency check — this draft only has a defensive "expected element never ' +
      'appeared, assume already configured" fallback around the first step. Find the target\'s ' +
      'own real "am I configured yet" signal by hand (see setup/trilium.ts\'s GET /api/setup/status ' +
      'or setup/nocodb.ts\'s GET /api/v2/meta/nocodb/info for worked examples) and replace it.',
    'Every recorded action is kept as-is — some may be optional/cosmetic (password-visibility ' +
      'icon toggles, a post-setup onboarding survey) and safe to trim. Verify live whether skipping ' +
      'the tail of the recording still leaves the instance usable before committing (see ' +
      'setup/nocodb.ts\'s own header comment for a worked example) — a mechanical pass can\'t tell.',
  ];

  const lines = raw.split('\n');
  const statements: string[] = [];
  let gotoPath = '/';
  for (const line of lines) {
    const m = line.match(STEP_RE);
    if (!m) continue;
    const stmt = m[1];
    const goto = stmt.match(GOTO_RE);
    if (goto) {
      try {
        gotoPath = new URL(goto[2]).pathname || '/';
      } catch {
        gotoPath = goto[2].replace(/^https?:\/\/[^/]+/, '') || '/';
      }
      continue;
    }
    statements.push(stmt);
  }

  const steps = statements.map(classify);

  // Drop a `.click()` immediately followed by a `.fill()`/`.press()` on the identical chain —
  // codegen always records the focusing click even though fill()/press() focus on their own.
  const kept: Step[] = [];
  for (let i = 0; i < steps.length; i++) {
    const cur = steps[i];
    const next = steps[i + 1];
    if (cur.action === 'click' && next && next.chain === cur.chain && (next.action === 'fill' || next.action === 'press')) {
      continue; // redundant focusing click — the next step's fill/press does its own focusing
    }
    kept.push(cur);
  }

  // Parametrize fill()/press() literals — same literal value reuses the same var (password +
  // confirmation, or the same password retyped on a later login screen).
  const varByValue = new Map<string, string>();
  const envVars: string[] = [];
  let fallbackIndex = 0;
  const codeSteps = kept.map((step) => {
    if (step.action === 'other') {
      // chain is the full, unparsed original statement here (neither
      // TRAILING_FILL_OR_PRESS_RE nor TRAILING_CALL_RE matched it) — emit
      // verbatim, don't re-append an action call onto it.
      return `      await ${step.chain};`;
    }
    if (step.action !== 'fill' && step.action !== 'press') {
      return `      await ${step.chain}.${step.action}();`;
    }
    const literal = step.argLiteral ?? '';
    let varName = varByValue.get(literal);
    if (!varName) {
      fallbackIndex++;
      varName = toEnvVarName(fieldNameFromChain(step.chain), fallbackIndex);
      varByValue.set(literal, varName);
      envVars.push(varName);
    }
    return `      await ${step.chain}.${step.action}(${varName});`;
  });

  const envReads = envVars
    .map(
      (v) =>
        `  const ${v} = env.${descriptorName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${v};\n` +
        `  if (!${v}) throw new Error('${descriptorName} setup needs ${descriptorName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${v} in descriptors/${descriptorName}.env');`,
    )
    .join('\n');

  const firstChain = kept[0]?.chain ?? 'page.locator("body")';
  const fnName = `setup${descriptorName.replace(/(^\w|[-_]\w)/g, (s) => s.replace(/[-_]/, '').toUpperCase())}`;

  const code = `import { chromium } from 'playwright';
import type { SetupFn } from '../setupTarget.ts';
import { createSetupPage } from '../setupPage.ts';

/**
 * DRAFT — generated by the "Record setup" mechanical transform (Tier 1, no Claude call), not yet
 * reviewed. Before this belongs in bootstrap/setup/${descriptorName}.ts:
 * - Replace the defensive fallback below with a real idempotency check (see this file's own
 *   comment above the fallback).
 * - Verify live whether every recorded step is actually needed (see warnings from the generator).
 * - Rename env vars below if awkward, and set their real values in descriptors/${descriptorName}.env.
 */
const ${fnName}: SetupFn = async (env, onProgress, onFrame) => {
  const baseUrl = env.FRONTEND_URL;
  if (!baseUrl) throw new Error('${descriptorName} setup needs FRONTEND_URL in descriptors/${descriptorName}.env');
${envReads}
  const log = (message: string) => onProgress?.(message);

  const browser = await chromium.launch();
  try {
    const { page, finish } = await createSetupPage(browser, '${descriptorName}', onFrame);
    try {
      await page.goto(\`\${baseUrl}${gotoPath}\`, { waitUntil: 'networkidle', timeout: 30000 });

      // DEFENSIVE FALLBACK — no real idempotency check yet, see this file's own header comment.
      // If the very first recorded element never shows up, assume the instance is already
      // configured rather than failing outright.
      try {
        await ${firstChain}.waitFor({ timeout: 5000 });
      } catch {
        log('First expected element never appeared — assuming already configured.');
        return;
      }

      log('Running the recorded steps...');
${codeSteps.join('\n')}

      log('Setup complete (draft — verify this is really the right completion signal).');
    } finally {
      const videoPath = await finish();
      if (videoPath) log(\`Recording saved: \${videoPath}\`);
    }
  } finally {
    await browser.close();
  }
};

export default ${fnName};
`;

  return { code, envVars, warnings };
}

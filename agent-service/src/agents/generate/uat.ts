import { readFile, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// User-provided UAT / acceptance-test notes — free text, one blob per target
// system, stored in a file sibling to its descriptor (e.g.
// descriptors/orderflow.json -> descriptors/orderflow.uat.md). Same sidecar
// convention as corrections.ts's per-scenario corrections, just keyed by
// descriptor alone rather than by scenario name — there's exactly one UAT
// blob per system, not one per scenario. Read by spec.ts (Stage 2) as extra
// prompt context; edited via the admin UI/API (see uatExtract.ts for how
// uploaded files/Google links become this plain text in the first place).
// Never touched by discovery.ts.
// ---------------------------------------------------------------------------

function uatPathFor(descriptorPath: string): string {
  return descriptorPath.replace(/\.json$/, '.uat.md');
}

export async function loadUatContext(descriptorPath: string): Promise<string> {
  try {
    return await readFile(uatPathFor(descriptorPath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function saveUatContext(descriptorPath: string, text: string): Promise<void> {
  await writeFile(uatPathFor(descriptorPath), text, 'utf-8');
}

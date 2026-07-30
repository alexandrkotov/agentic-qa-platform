import { readFile, writeFile } from 'node:fs/promises';
import { CorrectionsSchema, type Corrections } from './contract.ts';

// ---------------------------------------------------------------------------
// Manual scenario-fact corrections — free text, keyed by exact scenario name,
// stored in a file sibling to its descriptor (e.g. descriptors/orderflow.json
// -> descriptors/orderflow.corrections.json). Independent of grouping (a
// correction survives regrouping because it's keyed by name, not by group)
// and per target system (the same scenario name in a different descriptor's
// report is a different fact). Read by spec.ts (Stage 2) and edited via the
// admin UI/API — never touched by discovery.ts.
// ---------------------------------------------------------------------------

function correctionsPathFor(descriptorPath: string): string {
  return descriptorPath.replace(/\.json$/, '.corrections.json');
}

export async function loadCorrections(descriptorPath: string): Promise<Corrections> {
  let raw: string;
  try {
    raw = await readFile(correctionsPathFor(descriptorPath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return CorrectionsSchema.parse(JSON.parse(raw));
}

export async function saveCorrections(descriptorPath: string, corrections: Corrections): Promise<void> {
  const parsed = CorrectionsSchema.parse(corrections);
  await writeFile(correctionsPathFor(descriptorPath), JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
}

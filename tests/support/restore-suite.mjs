import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Restores tests/features + tests/steps from an archived snapshot
// (archive/bdd-test-suite-<descriptor>-<timestamp>/) and updates
// tests/.current-descriptor to match. Usage:
//   node restore-suite.mjs [descriptor] [snapshotName]
// - No args: descriptor comes from tests/.current-descriptor, restores its
//   most recent snapshot.
// - descriptor only: restores that descriptor's most recent snapshot.
// - descriptor + snapshotName: restores that ONE exact archive/ directory
//   (must belong to the given descriptor) instead of always "latest" — this
//   is what lets the workbench's browse/restore UI restore an older
//   timestamp, not just the newest.
// tests/features/tests/steps are no longer git-tracked themselves — the two
// archive/ snapshots are (see the root .gitignore's own comment) — so this
// script is the one real way tests/ gets real suite content, shared by:
//   - CI (.github/workflows/tests.yml, right after checkout — nothing else
//     it does depends on pnpm/workbench being ready yet)
//   - the hub's POST /api/demo/switch route (agent-service/src/admin/server.ts)
//   - the workbench's POST /api/generate/snapshots/:name/restore route,
//     which always passes both args
//   - the README's own Quick Start, run by hand
// Deliberately dependency-free (only node:fs/node:path/node:url) so CI can
// call it before `pnpm install` even runs.
//
// Paths are resolved from this script's own location, not process.cwd() —
// works the same whether invoked from the repo root (CI, README) or from
// inside the workbench container (APP_ROOT there mounts tests/ and archive/
// as siblings the same way the real repo root does — see server.ts's own
// APP_ROOT/TESTS_ROOT/APP_ARCHIVE_DIR comments). Either way, "two
// directories up from this file" is the correct root.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // .../tests/support
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const TESTS_DIR = join(REPO_ROOT, 'tests');
const ARCHIVE_DIR = join(REPO_ROOT, 'archive');
const CURRENT_DESCRIPTOR_FILE = join(TESTS_DIR, '.current-descriptor');

async function resolveDescriptor(argDescriptor) {
  if (argDescriptor) return argDescriptor;
  let content;
  try {
    content = await readFile(CURRENT_DESCRIPTOR_FILE, 'utf8');
  } catch (err) {
    throw new Error(
      `No descriptor given and couldn't read ${CURRENT_DESCRIPTOR_FILE}: ${err.message}`
    );
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(`No descriptor given and ${CURRENT_DESCRIPTOR_FILE} is empty.`);
  }
  return trimmed;
}

async function findLatestSnapshot(descriptor) {
  const prefix = `bdd-test-suite-${descriptor}-`;
  let entries;
  try {
    entries = await readdir(ARCHIVE_DIR, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Can't read ${ARCHIVE_DIR}: ${err.message}`);
  }
  // The timestamp suffix (e.g. 2026-08-11T06-22-17-222Z) sorts correctly as
  // a plain string, so the last match after sorting is the most recent.
  const matches = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort();
  if (matches.length === 0) {
    throw new Error(`No ${ARCHIVE_DIR}/${prefix}* snapshot found for descriptor "${descriptor}".`);
  }
  return join(ARCHIVE_DIR, matches[matches.length - 1]);
}

// Restores ONE specific snapshot by its exact archive/ directory name,
// instead of always "latest" — used by the workbench's own browse/restore
// UI (POST /api/generate/snapshots/:name/restore in server.ts), which lets
// a human pick an older timestamp, not just the newest. Still validated
// against a real readdir() (not just resolved by string-joining process.argv
// into a path) and cross-checked against the given descriptor, the same
// defense-in-depth server.ts's own resolveSnapshotDirByName() applies before
// ever spawning this script.
async function findNamedSnapshot(descriptor, name) {
  let entries;
  try {
    entries = await readdir(ARCHIVE_DIR, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Can't read ${ARCHIVE_DIR}: ${err.message}`);
  }
  const match = entries.find((e) => e.isDirectory() && e.name === name);
  if (!match) {
    throw new Error(`No ${ARCHIVE_DIR}/${name} snapshot found.`);
  }
  if (!name.startsWith(`bdd-test-suite-${descriptor}-`)) {
    throw new Error(`"${name}" doesn't belong to descriptor "${descriptor}" (expected prefix "bdd-test-suite-${descriptor}-").`);
  }
  return join(ARCHIVE_DIR, name);
}

async function main() {
  const argDescriptor = process.argv[2];
  const argSnapshotName = process.argv[3];
  const descriptor = await resolveDescriptor(argDescriptor);
  const snapshotDir = argSnapshotName
    ? await findNamedSnapshot(descriptor, argSnapshotName)
    : await findLatestSnapshot(descriptor);
  console.log(`Restoring "${descriptor}"'s suite from ${snapshotDir}`);

  for (const sub of ['features', 'steps']) {
    const src = join(snapshotDir, 'tests', sub);
    const dest = join(TESTS_DIR, sub);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(src, dest, { recursive: true });
    console.log(`  tests/${sub} <- ${src}`);
  }

  await writeFile(CURRENT_DESCRIPTOR_FILE, `${descriptor}\n`, 'utf8');
  console.log(`tests/.current-descriptor -> ${descriptor}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

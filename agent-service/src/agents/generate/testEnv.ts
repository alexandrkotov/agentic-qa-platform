import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseDotenv } from 'dotenv';

// ---------------------------------------------------------------------------
// Per-descriptor test-run environment overrides — plain KEY=VALUE lines (real
// dotenv syntax), stored in a file sibling to its descriptor (e.g.
// descriptors/uptime-kuma.json -> descriptors/uptime-kuma.env). Same sidecar
// convention as corrections.ts/uat.ts, keyed by descriptor alone.
//
// Exists because server.ts's TEST_RUN_ENV base (BACKEND_URL/FRONTEND_URL/
// DATABASE_URL pointed at this project's own orderflow compose network —
// http://app:3000 etc.) is wrong for any externally deployed target (e.g. a
// docker-compose component reachable only via host.docker.internal:<port>).
// Before this file existed, running tests against such a target required
// passing FRONTEND_URL/credentials by hand on every single invocation — real,
// live-verified need (Uptime Kuma), not a speculative one. See
// buildTestRunEnv() in server.ts for how these overlay the orderflow base.
//
// Read by server.ts's /api/tests/run and /api/e2e/* routes at run time;
// edited via the admin UI/API (GET/PUT /api/descriptors/:name/env). Never
// touched by discovery.ts. Deliberately plain dotenv text, not JSON — this
// is a real .env file in every sense (same syntax as agent-service/.env),
// just scoped to one target instead of the whole process.
// ---------------------------------------------------------------------------

function testEnvPathFor(descriptorPath: string): string {
  return descriptorPath.replace(/\.json$/, '.env');
}

export async function loadTestEnvOverrides(descriptorPath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(testEnvPathFor(descriptorPath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseDotenv(raw);
}

/** Raw text, for the admin UI's edit box — same "just the text" shape as loadUatContext(). */
export async function loadTestEnvText(descriptorPath: string): Promise<string> {
  try {
    return await readFile(testEnvPathFor(descriptorPath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function saveTestEnvText(descriptorPath: string, text: string): Promise<void> {
  await writeFile(testEnvPathFor(descriptorPath), text, 'utf-8');
}

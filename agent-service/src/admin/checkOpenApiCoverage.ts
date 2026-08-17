// Guards against openapi.json (Workbench Swagger, see hub/index.html's
// "Workbench Swagger" section and static/api-docs.html) drifting out of
// sync with the real routes in server.ts. Hand-authoring the spec was a
// deliberate choice (see D:\_My_Claude_files\Workbench Tools API\plan-en.md
// — matches this codebase's existing hand-authored-artifact style, rather
// than deriving it mechanically from the route handlers), so nothing
// enforces the two stay in sync automatically — this script is the
// mitigation instead. Run by hand whenever routes change:
//
//   pnpm run check:openapi
//
// Not wired into CI in this first pass (see the plan's own "Not in scope"
// section) — an easy, obvious follow-up if this drifts in practice.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = join(__dirname, 'server.ts');
const OPENAPI_JSON = join(__dirname, 'static', 'openapi.json');

type RouteKey = string; // "METHOD /path", Express :param converted to OpenAPI {param}

/** Matches `app.get('/api/...'`, `app.post("/api/...:name..."`, etc. — the
 *  same four-ish HTTP methods this file's own app.<method>() calls ever use.
 *  Deliberately simple (no full TS parse) — every real route in server.ts is
 *  written as a literal string on the same line as its own app.<method>()
 *  call, confirmed by inspecting the file directly, so a regex scan is
 *  enough and stays trivially readable/auditable itself. */
const ROUTE_CALL_PATTERN = /\bapp\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g;

/** Express's `:name` path-parameter syntax -> OpenAPI's `{name}` syntax, so
 *  routes extracted from server.ts compare directly against paths already
 *  keyed that way in openapi.json. */
function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

async function extractServerRoutes(): Promise<Set<RouteKey>> {
  const text = await readFile(SERVER_TS, 'utf-8');
  const routes = new Set<RouteKey>();
  for (const match of text.matchAll(ROUTE_CALL_PATTERN)) {
    const [, method, path] = match;
    routes.add(`${method.toUpperCase()} ${toOpenApiPath(path)}`);
  }
  return routes;
}

async function extractSpecRoutes(): Promise<Set<RouteKey>> {
  const spec = JSON.parse(await readFile(OPENAPI_JSON, 'utf-8')) as { paths?: Record<string, Record<string, unknown>> };
  const routes = new Set<RouteKey>();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      routes.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

async function main(): Promise<void> {
  const [serverRoutes, specRoutes] = await Promise.all([extractServerRoutes(), extractSpecRoutes()]);

  const undocumented = [...serverRoutes].filter((r) => !specRoutes.has(r)).sort();
  const stale = [...specRoutes].filter((r) => !serverRoutes.has(r)).sort();

  if (undocumented.length === 0 && stale.length === 0) {
    console.log(`openapi.json matches server.ts — ${serverRoutes.size} routes, all accounted for.`);
    return;
  }

  if (undocumented.length > 0) {
    console.log(`Routes in server.ts with no entry in openapi.json (${undocumented.length}):`);
    for (const r of undocumented) console.log(`  ${r}`);
  }
  if (stale.length > 0) {
    console.log(`Entries in openapi.json with no matching route in server.ts (${stale.length}):`);
    for (const r of stale) console.log(`  ${r}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

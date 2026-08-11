// A descriptor (descriptors/<name>.json, descriptors/<name>.env) is checked
// into git and shared across every machine that clones this repo — but a
// sqlite component's `path` (descriptor/components/sqlite.ts) and a
// test-run env override's SQLITE_DB_PATH (tests/support/db.ts) necessarily
// point somewhere under THIS deployment's own mirrored targets/ mount (see
// sqlite.ts's resolveSafePath / dockerCompose.ts's mirrored-mount comment),
// whose absolute prefix differs on every one of those machines: this dev
// host's own checkout path, a GitHub Actions runner's ("/home/runner/work/...")
// checkout path, etc.
//
// Confirmed live: descriptors/uptime-kuma.json + uptime-kuma.env hardcoded
// this dev host's own absolute path. That worked here purely by coincidence
// (HOST_PROJECT_ROOT on this machine happens to equal it), and failed
// outright in CI — every sqlite step errored "unable to open database file"
// — the moment a genuinely different runner checkout path was involved.
//
// Fix: descriptors write the literal placeholder `${HOST_PROJECT_ROOT}`
// instead of a hardcoded prefix, expanded here against this container's own
// HOST_PROJECT_ROOT env var (docker-compose.yml: HOST_PROJECT_ROOT: ${PWD}) —
// the same value bootstrap/deployTarget.ts and probeTarget.ts already trust
// for exactly this reason, so it's guaranteed to already be correct wherever
// this runs. Deliberately NOT relying on dotenv-expand-style automatic
// expansion: plain `dotenv`'s parse() (agents/generate/testEnv.ts) does no
// expansion of its own, so callers run this explicitly wherever a value that
// might carry the placeholder is actually used.
export function expandHostProjectRoot(value: string): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) return value;
  return value.replaceAll('${HOST_PROJECT_ROOT}', hostRoot);
}

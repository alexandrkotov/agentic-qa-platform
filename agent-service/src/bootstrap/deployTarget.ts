import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { connect } from 'node:net';
import { runCommand } from '../util/runCommand.ts';
import type { DockerComposeComponent } from '../descriptor/schema.ts';

// ---------------------------------------------------------------------------
// Docker-outside-of-Docker (DooD) path mirroring — the load-bearing
// assumption this whole module depends on. `workbench` talks to the HOST's
// own Docker daemon over the mounted socket (same pattern
// descriptor/components/kafka.ts already uses for its sibling MCP
// container), but unlike a plain `docker run <image>`, `docker compose`
// resolves a target repo's own relative bind-mount paths (e.g. wger's
// `./config/nginx.conf`) against the HOST's filesystem, not this
// container's — so the clone has to live at an absolute path that's
// IDENTICAL on both sides (docker-compose.yml's own
// `${PWD}/targets:${PWD}/targets` mount + HOST_PROJECT_ROOT env var make
// that true in practice). A silent mismatch here doesn't error — Docker
// just creates an empty directory where the real bind source should be —
// so `assertMirroredMount()` below checks this container's own mounts via
// `docker inspect` before trusting HOST_PROJECT_ROOT at all, rather than
// assuming the comment above stayed accurate.
// ---------------------------------------------------------------------------

class DeployTargetError extends Error {}

async function assertMirroredMount(): Promise<string> {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) {
    throw new DeployTargetError(
      'HOST_PROJECT_ROOT is not set — docker-compose.yml should pass it into the workbench service',
    );
  }
  const targetsDir = join(hostRoot, 'targets');

  // Docker sets a container's hostname to its own short ID by default
  // (docker-compose.yml doesn't override `hostname:` for workbench), so
  // this is "my own container" without needing the compose project/service
  // name passed in separately.
  const selfId = hostname();
  const { code, output } = await runCommand(
    'docker',
    ['inspect', selfId, '--format', '{{json .Mounts}}'],
    process.cwd(),
    process.env,
  );
  if (code !== 0) {
    throw new DeployTargetError(`could not inspect own container "${selfId}" to verify the targets/ mount: ${output}`);
  }

  let mounts: Array<{ Source: string; Destination: string }>;
  try {
    mounts = JSON.parse(output);
  } catch {
    throw new DeployTargetError(`docker inspect returned non-JSON output: ${output.slice(0, 200)}`);
  }

  const targetsMount = mounts.find((m) => m.Destination === targetsDir);
  if (!targetsMount) {
    throw new DeployTargetError(
      `no bind mount found at ${targetsDir} inside this container — docker-compose.yml's ` +
        `"\${PWD}/targets:\${PWD}/targets" mount is missing or HOST_PROJECT_ROOT doesn't match how this container was actually started`,
    );
  }
  if (targetsMount.Source !== targetsMount.Destination) {
    throw new DeployTargetError(
      `targets/ is mounted from "${targetsMount.Source}" but expected to match its own destination ` +
        `"${targetsMount.Destination}" — the mirrored-path assumption bootstrap/deployTarget.ts depends on ` +
        `does not hold, deploying would silently create empty directories instead of finding the real clone`,
    );
  }

  return targetsDir;
}

// ---------------------------------------------------------------------------
// Per-target paths — repo/ (the actual git clone, left untouched by
// anything generated) and .aqap/ (this module's own output: the resolved
// compose config, later joined by state.json in the port-allocation step)
// are kept as separate sibling directories deliberately: writing generated
// files into the clone itself would make `git fetch --depth 1` conflict
// with its own working tree on every redeploy.
// ---------------------------------------------------------------------------

export interface TargetPaths {
  repoDir: string;
  aqapDir: string;
  resolvedConfigPath: string;
  statePath: string;
}

export function resolveTargetPaths(targetsDir: string, name: string): TargetPaths {
  const base = join(targetsDir, name);
  return {
    repoDir: join(base, 'repo'),
    aqapDir: join(base, '.aqap'),
    resolvedConfigPath: join(base, '.aqap', 'resolved.json'),
    statePath: join(base, '.aqap', 'state.json'),
  };
}

// ---------------------------------------------------------------------------
// Clone / update
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, '.git', 'HEAD'));
    return true;
  } catch {
    return false;
  }
}

/**
 * `git fetch --depth 1` + `reset --hard FETCH_HEAD`, deliberately not
 * `git pull` — a third-party repo this project doesn't control can
 * force-push or rename its default branch at any time, and `git pull`
 * just refuses to proceed when that happens instead of giving us the
 * clone we actually asked for.
 */
async function cloneOrUpdateRepo(
  repoUrl: string,
  ref: string | undefined,
  repoDir: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  const onLine = (line: string) => onProgress?.(line);

  if (!(await pathExists(repoDir))) {
    onProgress?.(`$ git clone --no-checkout -- ${repoUrl} ${repoDir}`);
    const { code, output } = await runCommand(
      'git',
      ['clone', '--no-checkout', '--', repoUrl, repoDir],
      process.cwd(),
      process.env,
      onLine,
    );
    if (code !== 0) {
      throw new DeployTargetError(`git clone failed (exit ${code}): ${output.slice(-800)}`);
    }
  }

  const refArg = ref ?? 'HEAD';
  onProgress?.(`$ git fetch --depth 1 origin ${refArg}`);
  const fetch = await runCommand(
    'git',
    ['fetch', '--depth', '1', 'origin', refArg],
    repoDir,
    process.env,
    onLine,
  );
  if (fetch.code !== 0) {
    throw new DeployTargetError(`git fetch failed (exit ${fetch.code}): ${fetch.output.slice(-800)}`);
  }

  onProgress?.('$ git reset --hard FETCH_HEAD');
  const reset = await runCommand(
    'git',
    ['reset', '--hard', 'FETCH_HEAD'],
    repoDir,
    process.env,
    onLine,
  );
  if (reset.code !== 0) {
    throw new DeployTargetError(`git reset failed (exit ${reset.code}): ${reset.output.slice(-800)}`);
  }
}

// ---------------------------------------------------------------------------
// Flatten — `docker compose config` resolves `include:` into one model,
// normalizes both `ports:` syntaxes into one long form, and resolves every
// relative path (bind mounts, env_file, etc.) to an absolute one — which
// also makes the mirrored-path assumption checkable in the output (a
// relative bind mount that resolved to some path OTHER than under repoDir
// would mean something's wrong) rather than staying implicit. Deploying
// this resolved JSON directly (instead of a hand-written override file)
// sidesteps Compose's documented "conflicting names via include: → warns,
// doesn't merge" behavior entirely, since there's nothing left to merge.
// ---------------------------------------------------------------------------

function projectNameFor(name: string): string {
  return `aqap-target-${name}`;
}

async function flattenComposeConfig(
  component: DockerComposeComponent,
  repoDir: string,
  name: string,
  onProgress?: (message: string) => void,
): Promise<unknown> {
  const composeFile = component.composeFile ?? 'docker-compose.yml';
  const composeFilePath = join(repoDir, composeFile);
  const projectName = projectNameFor(name);

  onProgress?.(`$ docker compose -f ${composeFile} --project-directory . -p ${projectName} config --format json`);
  const { code, output } = await runCommand(
    'docker',
    [
      'compose',
      '-f', composeFilePath,
      '--project-directory', repoDir,
      '-p', projectName,
      'config',
      '--format', 'json',
    ],
    repoDir,
    process.env,
    (line) => {
      // `docker compose config`'s own JSON result also arrives on stdout —
      // don't echo the (large, single-line) JSON payload itself as
      // "progress", only genuine diagnostic lines (warnings, etc.).
      if (!line.trim().startsWith('{')) onProgress?.(line);
    },
  );
  if (code !== 0) {
    throw new DeployTargetError(`docker compose config failed (exit ${code}): ${output.slice(-1200)}`);
  }

  try {
    return JSON.parse(output);
  } catch {
    throw new DeployTargetError(`docker compose config did not return valid JSON: ${output.slice(0, 400)}`);
  }
}

// ---------------------------------------------------------------------------
// Public entry point for this increment — clone + flatten only, stops
// before `up` (port allocation / actually starting containers / postUpExec
// is bootstrap/deployTarget.ts's next increment). Mirrors
// bootstrap/discovery.ts's own shape: takes an already-resolved component,
// an `onProgress` callback for NDJSON streaming, returns the artifact path.
// ---------------------------------------------------------------------------

export interface FlattenResult {
  paths: TargetPaths;
  projectName: string;
  resolved: unknown;
}

export async function flattenTarget(
  component: DockerComposeComponent,
  name: string,
  onProgress?: (message: string) => void,
): Promise<FlattenResult> {
  const targetsDir = await assertMirroredMount();
  const paths = resolveTargetPaths(targetsDir, name);

  await mkdir(paths.repoDir, { recursive: true });
  await mkdir(paths.aqapDir, { recursive: true });

  onProgress?.(`Cloning ${component.repoUrl}${component.ref ? `@${component.ref}` : ''} into ${paths.repoDir}`);
  await cloneOrUpdateRepo(component.repoUrl, component.ref, paths.repoDir, onProgress);

  onProgress?.('Resolving compose configuration');
  const resolved = await flattenComposeConfig(component, paths.repoDir, name, onProgress);

  await writeFile(paths.resolvedConfigPath, JSON.stringify(resolved, null, 2), 'utf-8');
  onProgress?.(`Resolved config written to ${paths.resolvedConfigPath}`);

  return { paths, projectName: projectNameFor(name), resolved };
}

// ---------------------------------------------------------------------------
// Port allocation — see the plan's own reasoning (memory
// project_external_target_demo_idea): keep the target's own declared port
// when it's free (wger's config assumes port 80 via SITE_URL, remapping it
// for no reason risks redirect/CSRF weirdness downstream); remap only on an
// actual conflict, preferring whatever port a PREVIOUS deploy of this same
// target already used (so a URL a human hand-wrote into a descriptor
// doesn't silently break on redeploy) before falling back to scanning for
// something free.
//
// Every host-side check here (docker ps's own published-ports list, a
// connect probe to host.docker.internal) is run from THIS container, which
// sits on its own bridge network — none of them are airtight (a host
// process bound before Docker started won't show up in either), so they
// only make the FIRST attempt usually right. The actual guarantee is
// Compose's own "port is already allocated" failure at `up` time, which
// upTarget() below retries against fresh candidates, bounded.
// ---------------------------------------------------------------------------

interface ComposePort {
  target: number;
  published?: string | number;
  protocol?: string;
  [key: string]: unknown;
}
interface ComposeService {
  ports?: ComposePort[];
  [key: string]: unknown;
}
interface ComposeConfig {
  services?: Record<string, ComposeService>;
  [key: string]: unknown;
}

export interface PortMapping {
  service: string;
  containerPort: number;
  protocol: string;
  publishedPort: number;
}

export interface DeployState {
  deployedAt: string;
  projectName: string;
  ports: PortMapping[];
}

async function readState(statePath: string): Promise<DeployState | null> {
  try {
    return JSON.parse(await readFile(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Best-effort — `docker ps`'s own view of what's already published on the host, parsed from its "0.0.0.0:PORT->..." column. */
async function getDockerPublishedPorts(): Promise<Set<number>> {
  const { code, output } = await runCommand('docker', ['ps', '--format', '{{.Ports}}'], process.cwd(), process.env);
  const ports = new Set<number>();
  if (code !== 0) return ports;
  for (const match of output.matchAll(/:(\d+)->/g)) ports.add(Number(match[1]));
  return ports;
}

/** Best-effort — true if something answers on host.docker.internal:port, false on refusal/timeout (probably free). Not authoritative; see the module comment above. */
function probeHostPort(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host: 'host.docker.internal', port, timeout: timeoutMs });
    const done = (taken: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(taken);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function allocatePort(
  desiredPort: number,
  dockerPorts: Set<number>,
  excluded: Set<number>,
): Promise<number> {
  const looksFree = async (port: number) => {
    if (dockerPorts.has(port) || excluded.has(port)) return false;
    return !(await probeHostPort(port));
  };

  if (await looksFree(desiredPort)) return desiredPort;

  const BASE = 20000;
  const MAX_SCAN = 500;
  for (let offset = 0; offset < MAX_SCAN; offset++) {
    const candidate = BASE + offset;
    if (await looksFree(candidate)) return candidate;
  }
  throw new DeployTargetError(`could not find a free host port after scanning ${MAX_SCAN} candidates from ${BASE}`);
}

/** Mutates `config`'s own `services.*.ports[].published` values in place and returns the resulting map — entries with no `published` value (an ephemeral/random host port) are left untouched, there's nothing to remap. */
async function assignPorts(
  config: ComposeConfig,
  previous: DeployState | null,
  excluded: Set<number>,
  onProgress?: (message: string) => void,
): Promise<PortMapping[]> {
  const dockerPorts = await getDockerPublishedPorts();
  const claimed = new Set<number>(excluded);
  const mappings: PortMapping[] = [];

  for (const [serviceName, service] of Object.entries(config.services ?? {})) {
    for (const portEntry of service.ports ?? []) {
      if (portEntry.published === undefined || portEntry.published === '' || portEntry.published === null) continue;
      const originalPort = Number(portEntry.published);
      if (!Number.isFinite(originalPort)) continue;
      const protocol = portEntry.protocol ?? 'tcp';

      const prior = previous?.ports.find(
        (p) => p.service === serviceName && p.containerPort === portEntry.target && p.protocol === protocol,
      );
      const desired = prior?.publishedPort ?? originalPort;

      const chosen = await allocatePort(desired, dockerPorts, claimed);
      claimed.add(chosen);
      portEntry.published = String(chosen);

      if (chosen === originalPort) {
        onProgress?.(`Port ${originalPort} (${serviceName}) — kept as declared, free`);
      } else if (prior && chosen === desired) {
        onProgress?.(`Port ${originalPort} (${serviceName}) → ${chosen} (reused from a previous deploy)`);
      } else {
        onProgress?.(`Port ${originalPort} (${serviceName}) → ${chosen} (remapped — original was taken)`);
      }

      mappings.push({ service: serviceName, containerPort: portEntry.target, protocol, publishedPort: chosen });
    }
  }

  return mappings;
}

// ---------------------------------------------------------------------------
// up / postUpExec / down
// ---------------------------------------------------------------------------

const UP_RETRY_ATTEMPTS = 5;
const POST_UP_EXEC_ATTEMPTS = 10;
const POST_UP_EXEC_DELAY_MS = 10_000;

function isPortConflictError(output: string): boolean {
  return /port is already allocated|address already in use/i.test(output);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runComposeUp(
  resolvedConfigPath: string,
  projectName: string,
  onProgress?: (message: string) => void,
): Promise<{ code: number; output: string }> {
  onProgress?.(`$ docker compose --ansi never -f ${resolvedConfigPath} -p ${projectName} up -d`);
  return runCommand(
    'docker',
    // --ansi is a top-level `docker compose` flag, not one `up` itself
    // accepts — confirmed live: putting it after `up -d` fails outright
    // with "unknown flag: --ansi" rather than being silently ignored.
    ['compose', '--ansi', 'never', '-f', resolvedConfigPath, '-p', projectName, 'up', '-d'],
    process.cwd(),
    process.env,
    (line) => onProgress?.(line),
  );
}

/**
 * `up -d` returns once containers are *created*, not once whatever they run
 * on start (migrations, etc.) has finished — so each `postUpExec` entry
 * gets its own bounded retry loop rather than one blind attempt right after
 * `up`. `-T`: required for non-interactive `exec`, otherwise Compose fails
 * every call with "the input device is not a TTY".
 */
async function runPostUpExec(
  component: DockerComposeComponent,
  resolvedConfigPath: string,
  projectName: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  for (const entry of component.postUpExec ?? []) {
    onProgress?.(`Running on "${entry.service}": ${entry.command.join(' ')}`);
    let lastCode = 1;
    let lastOutput = '';
    for (let attempt = 1; attempt <= POST_UP_EXEC_ATTEMPTS; attempt++) {
      const result = await runCommand(
        'docker',
        ['compose', '-f', resolvedConfigPath, '-p', projectName, 'exec', '-T', entry.service, ...entry.command],
        process.cwd(),
        process.env,
        (line) => onProgress?.(line),
      );
      lastCode = result.code;
      lastOutput = result.output;
      if (result.code === 0) break;
      if (attempt < POST_UP_EXEC_ATTEMPTS) {
        onProgress?.(
          `Attempt ${attempt}/${POST_UP_EXEC_ATTEMPTS} failed (exit ${result.code}) — retrying in ${POST_UP_EXEC_DELAY_MS / 1000}s (the service may still be starting up)`,
        );
        await sleep(POST_UP_EXEC_DELAY_MS);
      }
    }
    if (lastCode !== 0) {
      throw new DeployTargetError(
        `postUpExec on "${entry.service}" (${entry.command.join(' ')}) failed after ${POST_UP_EXEC_ATTEMPTS} attempts (exit ${lastCode}): ${lastOutput.slice(-800)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// In-process lock — deploy/undeploy of the SAME target must never
// interleave (a concurrent `up` and `down` racing on the same compose
// project is exactly the kind of thing that produces confusing partial
// state). Rejects immediately rather than queuing: a second click on
// "Deploy" while one is already running should read as "already in
// progress", not silently wait its turn.
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(name)) {
    throw new DeployTargetError(`a deploy/undeploy for "${name}" is already in progress`);
  }
  const promise = fn();
  locks.set(name, promise);
  try {
    return await promise;
  } finally {
    locks.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface DeployResult {
  paths: TargetPaths;
  projectName: string;
  ports: PortMapping[];
}

export async function deployTarget(
  component: DockerComposeComponent,
  name: string,
  onProgress?: (message: string) => void,
): Promise<DeployResult> {
  return withLock(name, async () => {
    const { paths, projectName, resolved } = await flattenTarget(component, name, onProgress);
    const config = resolved as ComposeConfig;
    const previous = await readState(paths.statePath);

    const excluded = new Set<number>();
    let mappings: PortMapping[] = [];

    for (let attempt = 1; attempt <= UP_RETRY_ATTEMPTS; attempt++) {
      onProgress?.(`Allocating ports (attempt ${attempt}/${UP_RETRY_ATTEMPTS})`);
      mappings = await assignPorts(config, attempt === 1 ? previous : null, excluded, onProgress);
      await writeFile(paths.resolvedConfigPath, JSON.stringify(config, null, 2), 'utf-8');

      const up = await runComposeUp(paths.resolvedConfigPath, projectName, onProgress);
      if (up.code === 0) break;

      for (const m of mappings) excluded.add(m.publishedPort);

      if (attempt === UP_RETRY_ATTEMPTS || !isPortConflictError(up.output)) {
        throw new DeployTargetError(`docker compose up failed (exit ${up.code}): ${up.output.slice(-1200)}`);
      }
      onProgress?.(`Port conflict on attempt ${attempt}/${UP_RETRY_ATTEMPTS} — reallocating and retrying`);
    }

    if (component.postUpExec && component.postUpExec.length > 0) {
      await runPostUpExec(component, paths.resolvedConfigPath, projectName, onProgress);
    }

    const state: DeployState = { deployedAt: new Date().toISOString(), projectName, ports: mappings };
    await writeFile(paths.statePath, JSON.stringify(state, null, 2), 'utf-8');
    onProgress?.(`Deployed. Port map: ${JSON.stringify(Object.fromEntries(mappings.map((m) => [`${m.service}:${m.containerPort}`, m.publishedPort])))}`);

    return { paths, projectName, ports: mappings };
  });
}

export async function undeployTarget(name: string, onProgress?: (message: string) => void): Promise<void> {
  return withLock(name, async () => {
    const targetsDir = await assertMirroredMount();
    const paths = resolveTargetPaths(targetsDir, name);
    const projectName = projectNameFor(name);

    onProgress?.(`$ docker compose -f ${paths.resolvedConfigPath} -p ${projectName} down`);
    const { code, output } = await runCommand(
      'docker',
      ['compose', '-f', paths.resolvedConfigPath, '-p', projectName, 'down'],
      process.cwd(),
      process.env,
      (line) => onProgress?.(line),
    );
    if (code !== 0) {
      throw new DeployTargetError(`docker compose down failed (exit ${code}): ${output.slice(-1200)}`);
    }
    onProgress?.(`Target "${name}" stopped`);
  });
}

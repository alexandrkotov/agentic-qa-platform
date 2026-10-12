import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { runCommand } from '../util/runCommand.ts';
import type { ProcessComponent, ProcessSpec } from '../descriptor/schema.ts';
import {
  DeployCancelledError,
  DeployTargetError,
  activeDeploys,
  checkCancelled,
  sleep,
  withLock,
} from './deployCommon.ts';
import { cloneOrUpdateRepo } from './gitClone.ts';
import {
  projectNameFor,
  resolveTargetPaths,
  type DeployResult,
  type DeployState,
  type PortMapping,
  type TargetPaths,
} from './deployTarget.ts';

// ---------------------------------------------------------------------------
// The non-Docker sibling of deployTarget.ts: a `process` component (see
// descriptor/schema.ts) is a git repo that gets cloned, built from source
// and run as plain child processes *inside this container* — no second
// Docker daemon is involved, so none of deployTarget.ts's DooD path
// mirroring (assertMirroredMount) applies, and ports are the descriptor's
// own FIXED ones (published 1:1 by docker-compose.yml's workbench service)
// rather than allocated per deploy.
//
// Same on-disk convention as the Docker path (targets/<name>/repo + .aqap/),
// and the same `state.json` shape (DeployState) so everything downstream
// that reads a target's published ports keeps working — extended here with
// the PIDs this module needs to stop what it started.
// ---------------------------------------------------------------------------

interface RecordedProcess {
  name: string;
  pid: number;
  port: number;
  /** Written into the child's environment at spawn time; /proc/<pid>/environ is how we later prove a PID read back from state.json still belongs to *this* process and not an unrelated one that recycled the number. */
  token: string;
}

interface ProcessState extends DeployState {
  processes: RecordedProcess[];
}

const TOKEN_ENV = 'AQAP_PROCESS_TOKEN';
const HEALTH_ATTEMPTS = 120;
const HEALTH_DELAY_MS = 1000;
const STOP_GRACE_MS = 5000;

/** Not itself a mount assertion — nothing here needs one — just the same `${HOST_PROJECT_ROOT}/targets` location every other bootstrap module uses, so a target's files land in one place regardless of how it was deployed. */
function resolveProcessTargetsDir(): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) {
    throw new DeployTargetError(
      'HOST_PROJECT_ROOT is not set — docker-compose.yml should pass it into the workbench service',
    );
  }
  return join(hostRoot, 'targets');
}

async function readProcessState(statePath: string): Promise<ProcessState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf-8')) as Partial<ProcessState>;
    if (!Array.isArray(parsed.processes)) return null; // a Docker deploy's state.json, or something else — not ours
    return parsed as ProcessState;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True only if `pid` is alive AND carries this entry's own token in its environment — a recycled PID (container restarted, state.json outlived it) belongs to someone else and must never be signalled. */
async function isOurProcess(entry: RecordedProcess): Promise<boolean> {
  if (!isAlive(entry.pid)) return false;
  try {
    const environ = await readFile(`/proc/${entry.pid}/environ`, 'latin1');
    return environ.split('\0').includes(`${TOKEN_ENV}=${entry.token}`);
  } catch {
    return false;
  }
}

/** Signals the whole process group (children are spawned detached, so pid === pgid) — a start command like `pnpm ... preview` forks the real server as a child, and signalling only the wrapper would leave it holding the port. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

async function stopProcess(entry: RecordedProcess, onProgress?: (message: string) => void): Promise<void> {
  if (!(await isOurProcess(entry))) return;
  onProgress?.(`Stopping "${entry.name}" (pid ${entry.pid})`);
  signalGroup(entry.pid, 'SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && isAlive(entry.pid)) await sleep(100);
  if (isAlive(entry.pid)) {
    onProgress?.(`"${entry.name}" ignored SIGTERM — sending SIGKILL`);
    signalGroup(entry.pid, 'SIGKILL');
  }
}

/** True if something already accepts connections on 127.0.0.1:port. Used BEFORE starting a process: without it a stale server from elsewhere on that port would make the health check below pass against the wrong thing. */
function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function tailOf(path: string, chars = 1500): Promise<string> {
  try {
    return (await readFile(path, 'utf-8')).slice(-chars);
  } catch {
    return '(no log output)';
  }
}

async function waitUntilHealthy(
  spec: ProcessSpec,
  exited: () => boolean,
  logPath: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `http://127.0.0.1:${spec.port}${spec.healthCheckPath ?? '/'}`;
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++) {
    checkCancelled(signal);
    if (exited()) {
      throw new DeployTargetError(`"${spec.name}" exited before it became ready. Last log output:\n${await tailOf(logPath)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        onProgress?.(`"${spec.name}" is answering at ${url}`);
        return;
      }
    } catch {
      // not up yet
    }
    if (attempt === 1) onProgress?.(`Waiting for "${spec.name}" to answer at ${url}…`);
    await sleep(HEALTH_DELAY_MS, signal);
  }
  throw new DeployTargetError(
    `"${spec.name}" did not answer at ${url} after ${HEALTH_ATTEMPTS} attempts. Last log output:\n${await tailOf(logPath)}`,
  );
}

/** Build/install env: CI-style non-interactive defaults so a package manager never stops to ask a question nobody can answer. */
function buildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CI: 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
}

async function runStep(
  label: string,
  argv: string[],
  cwd: string,
  onProgress: ((message: string) => void) | undefined,
  signal: AbortSignal,
): Promise<void> {
  onProgress?.(`$ ${argv.join(' ')}   (${label})`);
  const { code, output } = await runCommand(
    argv[0]!,
    argv.slice(1),
    cwd,
    buildEnv(),
    (line) => onProgress?.(line),
    signal,
  );
  checkCancelled(signal);
  if (code !== 0) {
    throw new DeployTargetError(`${label} failed (exit ${code}): ${output.slice(-1200)}`);
  }
}

function resolveCwd(paths: TargetPaths, spec: ProcessSpec): string {
  return spec.cwd ? join(paths.repoDir, spec.cwd) : paths.repoDir;
}

export async function deployProcessTarget(
  component: ProcessComponent,
  name: string,
  onProgress?: (message: string) => void,
): Promise<DeployResult> {
  return withLock(name, async () => {
    const controller = new AbortController();
    activeDeploys.set(name, controller);
    const signal = controller.signal;
    const started: RecordedProcess[] = [];
    try {
      const paths = resolveTargetPaths(resolveProcessTargetsDir(), name);
      const logsDir = join(paths.aqapDir, 'logs');
      await mkdir(logsDir, { recursive: true });

      // Self-healing first step, same spirit as deployTarget.ts's
      // cleanupExistingContainers: anything a previous (possibly
      // interrupted) deploy left running is stopped before we start, so
      // every deploy begins from a known-clean state and a fixed port is
      // never held by our own stale child.
      const previous = await readProcessState(paths.statePath);
      if (previous) {
        for (const entry of previous.processes) await stopProcess(entry, onProgress);
        await unlink(paths.statePath).catch(() => {});
      }

      checkCancelled(signal);
      await cloneOrUpdateRepo(component.repoUrl, component.ref, paths.repoDir, onProgress, signal);

      if (component.installCommand) {
        await runStep('install', component.installCommand, paths.repoDir, onProgress, signal);
      }

      const deployId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      for (const spec of component.processes) {
        checkCancelled(signal);
        const cwd = resolveCwd(paths, spec);

        if (spec.buildCommand) {
          await runStep(`build "${spec.name}"`, spec.buildCommand, cwd, onProgress, signal);
        }

        if (await portInUse(spec.port)) {
          throw new DeployTargetError(
            `port ${spec.port} (needed by "${spec.name}") is already in use by something that is not part of this deploy`,
          );
        }

        const logPath = join(logsDir, `${spec.name}.log`);
        const logFd = openSync(logPath, 'w');
        const token = `${name}:${spec.name}:${deployId}`;
        onProgress?.(`$ ${spec.startCommand.join(' ')}   (start "${spec.name}", log: ${logPath})`);
        const child = spawn(spec.startCommand[0]!, spec.startCommand.slice(1), {
          cwd,
          env: { ...buildEnv(), [TOKEN_ENV]: token },
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
        closeSync(logFd); // the child holds its own copy of the descriptor now
        let exited = false;
        let spawnError: Error | null = null;
        child.once('exit', () => {
          exited = true;
        });
        child.once('error', (err) => {
          exited = true;
          spawnError = err;
        });
        child.unref();

        if (child.pid === undefined) {
          // spawn() reports a missing binary asynchronously via 'error'; give it a tick so the message names the real cause.
          await sleep(50);
          throw new DeployTargetError(
            `could not start "${spec.name}": ${(spawnError as Error | null)?.message ?? 'no PID was assigned'}`,
          );
        }
        started.push({ name: spec.name, pid: child.pid, port: spec.port, token });

        await waitUntilHealthy(spec, () => exited, logPath, onProgress, signal);
      }

      const mappings: PortMapping[] = component.processes.map((p) => ({
        service: p.name,
        containerPort: p.port,
        protocol: 'tcp',
        publishedPort: p.port,
      }));
      const projectName = projectNameFor(name);
      const state: ProcessState = {
        deployedAt: new Date().toISOString(),
        projectName,
        ports: mappings,
        processes: started,
      };
      await writeFile(paths.statePath, JSON.stringify(state, null, 2), 'utf-8');
      onProgress?.(`Deployed. Port map: ${JSON.stringify(Object.fromEntries(mappings.map((m) => [m.service, m.publishedPort])))}`);

      return { paths, projectName, ports: mappings };
    } catch (err) {
      // Whatever failed or was cancelled, nothing this attempt started may
      // be left holding a fixed port — the next deploy would otherwise hit
      // "port already in use" against its own predecessor's debris.
      if (started.length > 0) {
        onProgress?.(
          err instanceof DeployCancelledError
            ? 'Cancelled — stopping the processes already started…'
            : 'Deploy failed — stopping the processes already started…',
        );
        for (const entry of started) await stopProcess(entry, onProgress);
      }
      throw err;
    } finally {
      activeDeploys.delete(name);
    }
  });
}

export async function undeployProcessTarget(name: string, onProgress?: (message: string) => void): Promise<void> {
  return withLock(name, async () => {
    const paths = resolveTargetPaths(resolveProcessTargetsDir(), name);
    const state = await readProcessState(paths.statePath);
    if (!state) {
      onProgress?.(`No recorded processes for "${name}" — nothing to stop`);
      return;
    }
    for (const entry of state.processes) await stopProcess(entry, onProgress);
    await unlink(paths.statePath).catch(() => {});
    onProgress?.(`Target "${name}" stopped`);
  });
}

/** Names of this target's recorded processes that are genuinely still running — the process-component counterpart of getTargetContainerNames(), backing the same status route. */
export async function getProcessTargetNames(name: string): Promise<string[]> {
  let targetsDir: string;
  try {
    targetsDir = resolveProcessTargetsDir();
  } catch {
    return [];
  }
  const state = await readProcessState(resolveTargetPaths(targetsDir, name).statePath);
  if (!state) return [];
  const running: string[] = [];
  for (const entry of state.processes) {
    if (await isOurProcess(entry)) running.push(entry.name);
  }
  return running;
}

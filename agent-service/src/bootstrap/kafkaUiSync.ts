import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../util/runCommand.ts';
import { getRunningContainerNames, projectNameFor, resolveTargetPaths } from './deployTarget.ts';
import { targetsDirFromEnv } from './targetsDir.ts';
import { detectKafkaServices, type ComposeConfig } from './kafkaDetect.ts';
import { resolveComposeServiceNetworks } from './composeNetworks.ts';

// ---------------------------------------------------------------------------
// Kafka UI Multi-Cluster, item (б) — keeps kafka-ui's own multi-cluster
// config in sync with whatever's actually deployed. Fully automatic (no
// separate human approval gate), the same "mechanical, free, no descriptor
// write" spirit as descriptor/components/mssql.ts's own on-demand network
// join — kafka-ui's cluster list isn't persisted anywhere a wrong guess
// could do lasting harm, it's fully regenerated from real, currently-live
// Docker state every time this runs.
//
// Two candidate sources, each with a genuinely different join mechanism:
// 1. The OrderFlow demo bundle (docker-compose.demo-orderflow.yml) — its
//    broker already lives directly on the shared `agentic-qa-platform-net`
//    (same network kafka-ui itself is on by default), so no network join
//    is needed, just a cluster entry.
// 2. Any generic docker-compose-component target under targets/ — its own
//    broker lives on that target's OWN isolated compose network (kafka-ui
//    is not on it by default, same reason
//    descriptor/components/mssql.ts needs an on-demand join for queries).
//    kafka-ui needs a PERSISTENT join here — it polls continuously, unlike
//    a single mssql tool call that can join-query-leave per request.
//
// `syncKafkaUi()` NEVER THROWS — a kafka-ui hiccup must never block the
// deploy/undeploy a human actually asked for. Every failure is reported as
// a progress message and swallowed, same best-effort spirit as
// mssql.ts's own leaveNetwork().
// ---------------------------------------------------------------------------

const ORDERFLOW_DEMO_PROJECT = 'bdd-target-demo-orderflow';
const ORDERFLOW_ALIAS = 'kafka-orderflow';
const KAFKA_UI_PROJECT = 'agentic-qa-platform';
const KAFKA_UI_SERVICE = 'kafka-ui';
const KAFKA_PORT = 9092;
const OVERRIDE_DIR_NAME = '.kafka-ui';
const OVERRIDE_FILE_NAME = 'clusters.override.yml';

interface KafkaCluster {
  name: string;
  bootstrapServers: string;
  /** Real Docker network name(s) kafka-ui needs to be joined to for this cluster — absent for the OrderFlow demo bundle, already on the shared network. */
  joinNetworks?: string[];
}

// ---------------------------------------------------------------------------
// Candidate source 1 — the OrderFlow demo bundle. Checked the same way
// admin/server.ts's own /api/demo/status route already does (running-only,
// not `-a` — see getRunningContainerNames()'s own doc comment for why that
// distinction is a real, previously-live bug, not style).
// ---------------------------------------------------------------------------

async function detectOrderflowDemoCluster(excludeTarget?: string): Promise<KafkaCluster | null> {
  if (excludeTarget === 'demo-orderflow') return null;
  const running = await getRunningContainerNames(ORDERFLOW_DEMO_PROJECT);
  if (running.length === 0) return null;
  return { name: 'orderflow', bootstrapServers: `${ORDERFLOW_ALIAS}:${KAFKA_PORT}` };
}

// ---------------------------------------------------------------------------
// Candidate source 2 — generic docker-compose-component targets under
// targets/. Each one that's actually live (running containers, not just
// leftover files on disk — resolved.json/state.json outlive `undeploy`,
// see deployTarget.ts's own undeployTarget(), which never deletes them)
// and whose resolved config has a kafka-shaped service (bootstrap/
// kafkaDetect.ts, shared with deployTarget.ts's own alias injection) joins
// the list.
// ---------------------------------------------------------------------------

async function listTargetDirNames(targetsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(targetsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function detectGenericTargetClusters(targetsDir: string, excludeTarget?: string): Promise<KafkaCluster[]> {
  const clusters: KafkaCluster[] = [];
  const names = (await listTargetDirNames(targetsDir))
    .filter((n) => n !== excludeTarget)
    .sort();

  for (const name of names) {
    const running = await getRunningContainerNames(projectNameFor(name));
    if (running.length === 0) continue;

    const { resolvedConfigPath } = resolveTargetPaths(targetsDir, name);
    let config: ComposeConfig;
    try {
      config = JSON.parse(await readFile(resolvedConfigPath, 'utf-8'));
    } catch {
      continue; // containers exist but no readable resolved.json — nothing to detect from, not an error worth failing the whole sync over
    }

    // Only the first detected broker service becomes this target's cluster
    // — the alias (kafka-<name>, planted by deployTarget.ts's own
    // injectKafkaBrokerAliases()) is per TARGET, not per service, by
    // design; a target with more than one broker service isn't a case
    // this app has actually needed to model.
    const [kafkaService] = detectKafkaServices(config);
    if (!kafkaService) continue;

    try {
      const networks = await resolveComposeServiceNetworks(name, kafkaService.serviceName);
      clusters.push({ name, bootstrapServers: `kafka-${name}:${KAFKA_PORT}`, joinNetworks: networks });
    } catch {
      continue; // best-effort — a target mid-redeploy or with a stale resolved.json just gets skipped this sync, picked up again next time
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Override file — full rewrite every sync, never incremental, so a
// shrinking cluster count never leaks a stale KAFKA_CLUSTERS_<N>_* pair
// from a previous, larger sync. Lives under targets/ (already mirrored
// into workbench via docker-compose.yml's own `${PWD}/targets:${PWD}/targets`
// bind mount, same one deployTarget.ts/probeTarget.ts already rely on) —
// no new mount needed, and already covered by `.gitignore`'s `/targets/`
// rule. JSON.stringify() for scalar values is a deliberate, minimal way to
// get valid, correctly-escaped YAML flow scalars without pulling in a YAML
// library this repo doesn't otherwise need.
// ---------------------------------------------------------------------------

function buildOverrideYaml(clusters: KafkaCluster[]): string {
  if (clusters.length === 0) {
    return 'services:\n  kafka-ui:\n    environment: {}\n';
  }
  const envLines = clusters.flatMap((c, i) => [
    `      KAFKA_CLUSTERS_${i}_NAME: ${JSON.stringify(c.name)}`,
    `      KAFKA_CLUSTERS_${i}_BOOTSTRAPSERVERS: ${JSON.stringify(c.bootstrapServers)}`,
  ]);
  return `services:\n  kafka-ui:\n    environment:\n${envLines.join('\n')}\n`;
}

async function writeOverrideFile(targetsDir: string, clusters: KafkaCluster[]): Promise<string> {
  const dir = join(targetsDir, OVERRIDE_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, OVERRIDE_FILE_NAME);
  await writeFile(filePath, buildOverrideYaml(clusters), 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Force-recreate — same HOST_PROJECT_ROOT-resolved-path pattern
// admin/server.ts's own orderflowDemoComposeFile() already uses for the
// demo bundle's compose file. docker-compose.yml's own base
// `KAFKA_CLUSTERS_0_*` stays as-is (a fallback for a fresh clone that's
// never synced yet) — the override's later-file-wins merge cleanly
// replaces it once real clusters exist. `--no-deps` — this must never
// start/touch any other service in docker-compose.yml.
// ---------------------------------------------------------------------------

function repoComposeFile(): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (!hostRoot) {
    throw new Error('HOST_PROJECT_ROOT is not set — docker-compose.yml should pass it into the workbench service');
  }
  return join(hostRoot, 'docker-compose.yml');
}

async function recreateKafkaUi(overrideFilePath: string, onProgress: (message: string) => void): Promise<void> {
  const composeFile = repoComposeFile();
  const args = ['compose', '-f', composeFile, '-f', overrideFilePath, '-p', KAFKA_UI_PROJECT, 'up', '-d', '--force-recreate', '--no-deps', KAFKA_UI_SERVICE];
  onProgress(`$ docker ${args.join(' ')}`);
  const { code, output } = await runCommand('docker', args, process.cwd(), process.env, onProgress);
  if (code !== 0) {
    throw new Error(`docker compose up --force-recreate failed for kafka-ui (exit ${code}): ${output.slice(-800)}`);
  }
}

// ---------------------------------------------------------------------------
// Network join — runs AFTER the recreate above, every sync: force-recreate
// resets kafka-ui's own dynamic network attachments back to just the base
// `agentic-qa-platform-net`, so whatever it was joined to before is gone
// and has to be re-established fresh each time.
// ---------------------------------------------------------------------------

async function findKafkaUiContainer(): Promise<string | null> {
  const { code, output } = await runCommand(
    'docker',
    [
      'ps',
      '--filter', `label=com.docker.compose.project=${KAFKA_UI_PROJECT}`,
      '--filter', `label=com.docker.compose.service=${KAFKA_UI_SERVICE}`,
      '--format', '{{.Names}}',
    ],
    process.cwd(),
    process.env,
  );
  if (code !== 0) return null;
  const names = output.split('\n').map((s) => s.trim()).filter(Boolean);
  return names[0] ?? null;
}

/** Tolerant of "already exists" — same reasoning as mssql.ts's own joinNetwork(). */
async function joinNetwork(network: string, container: string): Promise<void> {
  const { code, output } = await runCommand('docker', ['network', 'connect', network, container], process.cwd(), process.env);
  if (code !== 0 && !/already exists/i.test(output)) {
    throw new Error(`"docker network connect ${network} ${container}" failed (exit ${code}): ${output.slice(-400)}`);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface SyncKafkaUiOptions {
  /**
   * Excludes this target from the scan — used by admin/server.ts BEFORE
   * tearing down (or redeploying) a target, so kafka-ui detaches from that
   * target's own network before Compose tries to remove it. Without this,
   * `docker compose down` (or the self-healing cleanup at the start of a
   * redeploy) can fail with "network has active endpoints" if kafka-ui is
   * still attached from a previous sync.
   */
  excludeTarget?: string;
}

export async function syncKafkaUi(onProgress?: (message: string) => void, opts?: SyncKafkaUiOptions): Promise<void> {
  const log = (message: string) => onProgress?.(`[kafka-ui] ${message}`);
  try {
    const targetsDir = targetsDirFromEnv();
    const orderflowCluster = await detectOrderflowDemoCluster(opts?.excludeTarget);
    const genericClusters = await detectGenericTargetClusters(targetsDir, opts?.excludeTarget);
    const clusters = orderflowCluster ? [orderflowCluster, ...genericClusters] : genericClusters;

    log(
      clusters.length > 0
        ? `Syncing ${clusters.length} cluster(s): ${clusters.map((c) => c.name).join(', ')}`
        : 'No Kafka clusters currently deployed — kafka-ui will fall back to its default single-cluster config.',
    );

    const overridePath = await writeOverrideFile(targetsDir, clusters);
    await recreateKafkaUi(overridePath, log);

    const container = await findKafkaUiContainer();
    if (!container) {
      log('kafka-ui container not found after recreate — skipping network join (bring up the platform\'s own docker-compose.yml first).');
      return;
    }
    for (const cluster of clusters) {
      for (const network of cluster.joinNetworks ?? []) {
        await joinNetwork(network, container);
        log(`Joined "${container}" to network "${network}" for cluster "${cluster.name}"`);
      }
    }
  } catch (err) {
    log(`sync failed, continuing anyway: ${(err as Error).message}`);
  }
}

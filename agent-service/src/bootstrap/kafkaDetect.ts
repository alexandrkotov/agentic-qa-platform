// ---------------------------------------------------------------------------
// Kafka broker detection by image — shared by two genuinely different
// consumers, each with its own reachability mechanism, not duplicated
// detection logic:
//
// 1. bootstrap/probeTarget.ts's own candidate pass, which proposes a
//    descriptor `kafka` component for kafka-mcp-server (Discovery). That
//    MCP server runs `--network=host` (descriptor/components/kafka.ts), so
//    it needs `host.docker.internal:<publishedPort>` — same constraint
//    probeTarget.ts's own DB passes already have.
// 2. bootstrap/kafkaUiSync.ts, which keeps kafka-ui's own multi-cluster
//    config in sync with whatever's actually deployed. kafka-ui is a
//    container that sits ON the docker network (not host-network), so it
//    needs no published port at all — it gets network-joined to the
//    target's own compose network directly, addressing the broker by a
//    predictable `kafka-<targetName>` alias (see deployTarget.ts's own
//    injectKafkaBrokerAliases(), which plants that alias at deploy time).
//
// Same whole-path-segment matching style as probeTarget.ts's own
// DB_IMAGE_PATTERNS (`(^|\/)...(:|$)`) — deliberately NOT a bare substring
// match, so e.g. "provectuslabs/kafka-ui" or
// "ghcr.io/tuannvm/kafka-mcp-server" (both real images already used
// elsewhere in this repo) never false-positive as a broker themselves.
// ---------------------------------------------------------------------------

export interface ComposeVolume {
  type: string;
  source?: string;
  target?: string;
  [key: string]: unknown;
}
export interface ComposePort {
  target: number;
  published?: string | number;
  protocol?: string;
  [key: string]: unknown;
}
export interface ComposeService {
  image?: string;
  environment?: Record<string, string>;
  ports?: ComposePort[];
  volumes?: ComposeVolume[];
  networks?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface ComposeConfig {
  services?: Record<string, ComposeService>;
  networks?: Record<string, { name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

// apache/kafka: the same image this repo's own OrderFlow demo bundle uses
// (docker-compose.demo-orderflow.yml). cp-kafka/cp-server: Confluent
// Platform's broker images — cp-server is the newer "Confluent Server"
// image, also a real broker, not just a component around one.
const KAFKA_IMAGE_PATTERNS = [/(^|\/)(kafka|cp-kafka|cp-server)(:|$)/i];

function isKafkaImage(image: string): boolean {
  return KAFKA_IMAGE_PATTERNS.some((re) => re.test(image));
}

export interface DetectedKafkaService {
  serviceName: string;
  image: string;
}

/** Pure, no I/O — same "mechanical, free" shape as probeTarget.ts's own detectDbCandidates(). */
export function detectKafkaServices(config: ComposeConfig): DetectedKafkaService[] {
  const found: DetectedKafkaService[] = [];
  for (const [serviceName, service] of Object.entries(config.services ?? {})) {
    const image = service.image;
    if (image && isKafkaImage(image)) found.push({ serviceName, image });
  }
  return found;
}

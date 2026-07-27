import type { McpServerConfig } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { KafkaComponent } from '../schema.ts';

export const kafkaBuilder: ComponentBuilder<KafkaComponent> = {
  mcpServers(component, key): McpServerConfig[] {
    const env: Record<string, string> = {
      KAFKA_BROKERS: component.brokers.join(','),
      MCP_TRANSPORT: 'stdio',
    };
    if (component.clientId) env.KAFKA_CLIENT_ID = component.clientId;
    if (component.sasl) {
      env.KAFKA_SASL_MECHANISM = component.sasl.mechanism;
      env.KAFKA_SASL_USER = component.sasl.username;
      env.KAFKA_SASL_PASSWORD = component.sasl.password;
    }
    if (component.tls) {
      env.KAFKA_TLS_ENABLE = String(component.tls.enabled);
      if (component.tls.insecureSkipVerify !== undefined) {
        env.KAFKA_TLS_INSECURE_SKIP_VERIFY = String(component.tls.insecureSkipVerify);
      }
    }

    // tuannvm/kafka-mcp-server is a Go binary, not npm-distributed — run the
    // published image instead of assuming it's installed on PATH. --network=host
    // so it can reach brokers exposed on localhost the same way agent-service
    // itself does (see McpServerConfig.env's doc comment for why env vars go as
    // `-e` args here rather than via the field itself: they need to land inside
    // the container, not in the `docker` CLI process's own environment).
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    return [
      {
        name: key,
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network=host',
          ...envArgs,
          'ghcr.io/tuannvm/kafka-mcp-server:latest',
        ],
      },
    ];
  },

  promptSection(_component, key): string {
    return `### Kafka (${key})
Use the \`${key}__*\` tools to explore the cluster:
1. \`${key}__cluster_overview\` — overall health summary.
2. \`${key}__list_topics\` — all topics with partition/replication info.
3. \`${key}__describe_topic\` and \`${key}__describe_configs\` for each topic of interest — config and metadata.
4. \`${key}__consume_messages\` — sample a few recent messages per topic to infer the payload
   schema (do not assume a schema from the topic name alone).
5. \`${key}__list_consumer_groups\` / \`${key}__describe_consumer_group\` — note any consumer
   groups and their lag, if present.

Existing messages may predate recent code changes — do not treat them as the final word on
current payload shape.

Report this component's findings under \`components["${key}"]\` as:
{ "topics": [{ "name": "", "partitions": 0, "sampleMessages": [], "inferredSchema": {} }],
  "consumerGroups": [{ "groupId": "", "lag": 0 }] }`;
  },
};

import type { McpServerConfig } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { KafkaConsumerComponent } from '../schema.ts';

export const kafkaConsumerBuilder: ComponentBuilder<KafkaConsumerComponent> = {
  mcpServers(component, key): McpServerConfig[] {
    const env: Record<string, string> = {
      KAFKA_BROKERS: component.brokers.join(','),
      MCP_TRANSPORT: 'stdio',
    };

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

  promptSection(component, key): string {
    return `### Kafka topic (${key})
Use the \`${key}__consume_messages\` tool to fetch the ${component.sampleSize ?? 5} most recent
messages from the topic \`${component.topic}\`.

Report how many messages were found, their inferred JSON shape (do not assume a schema from the
topic name alone), and flag any message that isn't valid JSON as an anomaly.

Report this component's findings under \`components["${key}"]\` as:
{ "topic": "", "messageCount": 0, "sampleMessages": [], "inferredSchema": {}, "anomalies": [] }`;
  },
};
import type { CustomTool, McpServerConfig } from '../providers/AgentProvider.ts';
import { componentKey, type SystemComponent, type SystemDescriptor } from './schema.ts';
import { postgresBuilder } from './components/postgres.ts';
import { restApiBuilder } from './components/restApi.ts';
import { kafkaBuilder } from './components/kafka.ts';
import { kafkaConsumerBuilder } from './components/kafkaConsumer.ts';
import { webUiBuilder } from './components/webUi.ts';
import { dockerComposeBuilder } from './components/dockerCompose.ts';

/**
 * Per-component-type wiring: which MCP server(s) / custom tool(s) it needs, and the
 * prompt section describing how to explore it. Each builder is written by hand — this
 * is where the actual prompt engineering for a component type lives, kept small and
 * visible per type rather than folded into one monolithic discovery prompt.
 */
export interface ComponentBuilder<C extends SystemComponent> {
  mcpServers?(component: C, key: string): McpServerConfig[];
  tools?(component: C, key: string): CustomTool[];
  promptSection(component: C, key: string): string;
}

type BuilderMap = {
  [K in SystemComponent['type']]: ComponentBuilder<Extract<SystemComponent, { type: K }>>;
};

export const componentRegistry: BuilderMap = {
  postgres: postgresBuilder,
  'rest-api': restApiBuilder,
  kafka: kafkaBuilder,
  'kafka-consumer': kafkaConsumerBuilder,
  'web-ui': webUiBuilder,
  'docker-compose': dockerComposeBuilder,
};

export interface AssembledDiscovery {
  mcpServers: McpServerConfig[];
  tools: CustomTool[];
  componentPromptSections: string[];
}

export function assembleDiscovery(descriptor: SystemDescriptor): AssembledDiscovery {
  const mcpServers: McpServerConfig[] = [];
  const tools: CustomTool[] = [];
  const componentPromptSections: string[] = [];

  for (const component of descriptor.components) {
    const key = componentKey(component);
    // Safe by construction: componentRegistry is keyed by the same discriminant
    // (`component.type`) that selects this branch of the SystemComponent union.
    const builder = componentRegistry[component.type] as ComponentBuilder<typeof component>;

    mcpServers.push(...(builder.mcpServers?.(component, key) ?? []));
    tools.push(...(builder.tools?.(component, key) ?? []));
    componentPromptSections.push(builder.promptSection(component, key));
  }

  return { mcpServers, tools, componentPromptSections };
}

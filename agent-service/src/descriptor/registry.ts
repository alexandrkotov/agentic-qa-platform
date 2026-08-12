import type { CustomTool, McpServerConfig } from '../providers/AgentProvider.ts';
import { componentKey, type SystemComponent, type SystemDescriptor } from './schema.ts';
import { postgresBuilder } from './components/postgres.ts';
import { restApiBuilder } from './components/restApi.ts';
import { kafkaBuilder } from './components/kafka.ts';
import { kafkaConsumerBuilder } from './components/kafkaConsumer.ts';
import { webUiBuilder } from './components/webUi.ts';
import { dockerComposeBuilder } from './components/dockerCompose.ts';
import { sqliteBuilder } from './components/sqlite.ts';
import { mysqlBuilder } from './components/mysql.ts';
import { mongoBuilder } from './components/mongo.ts';
import { mssqlBuilder } from './components/mssql.ts';

/**
 * Per-component-type wiring: which MCP server(s) / custom tool(s) it needs, and the
 * prompt section describing how to explore it. Each builder is written by hand — this
 * is where the actual prompt engineering for a component type lives, kept small and
 * visible per type rather than folded into one monolithic discovery prompt.
 */
/**
 * `descriptorName` is only here for mssql.ts's own network-join mechanism
 * (see that file's header comment) — it needs the descriptor's own top-level
 * `name` to find `targets/<name>/.aqap/resolved.json` and read the real
 * Docker network the target's compose service lives on. No other builder
 * reads this today; adding it as an optional field here (rather than a
 * parallel signature just for mssqlBuilder) keeps every component builder
 * on one shared shape.
 */
export interface BuilderContext {
  descriptorName?: string;
}

export interface ComponentBuilder<C extends SystemComponent> {
  mcpServers?(component: C, key: string): McpServerConfig[];
  tools?(component: C, key: string, ctx: BuilderContext): CustomTool[];
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
  sqlite: sqliteBuilder,
  mysql: mysqlBuilder,
  mongo: mongoBuilder,
  mssql: mssqlBuilder,
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
  const ctx: BuilderContext = { descriptorName: descriptor.name };

  for (const component of descriptor.components) {
    const key = componentKey(component);
    // Safe by construction: componentRegistry is keyed by the same discriminant
    // (`component.type`) that selects this branch of the SystemComponent union.
    const builder = componentRegistry[component.type] as ComponentBuilder<typeof component>;

    mcpServers.push(...(builder.mcpServers?.(component, key) ?? []));
    tools.push(...(builder.tools?.(component, key, ctx) ?? []));
    componentPromptSections.push(builder.promptSection(component, key));
  }

  return { mcpServers, tools, componentPromptSections };
}

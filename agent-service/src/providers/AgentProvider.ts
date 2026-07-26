export interface McpServerConfig {
  /** Unique short name, used to namespace tool names — alphanumeric + underscore only */
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CustomTool {
  name: string;
  description: string;
  /** JSON Schema properties for the tool's input object */
  parameters: Record<string, { type: string; description?: string }>;
  required?: string[];
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export interface AgentRunOptions {
  systemPrompt: string;
  userMessage: string;
  mcpServers?: McpServerConfig[];
  tools?: CustomTool[];
  /** Override model; defaults to provider-specific config value */
  model?: string;
  maxIterations?: number;
  /** Label for the usage/cost log, e.g. "discovery", "generate:customers", "e2e-diagnose:submit-draft-order". */
  operation?: string;
}

export interface AgentProvider {
  run(options: AgentRunOptions): Promise<string>;
}

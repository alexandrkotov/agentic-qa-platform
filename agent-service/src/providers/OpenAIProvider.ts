import { Agent, MCPServerStdio, run, tool } from '@openai/agents';
import { z } from 'zod';
import type { AgentProvider, AgentRunOptions, CustomTool } from './AgentProvider.ts';
import { config } from '../config.ts';
import { recordUsage } from '../usageLog.ts';

/** Convert a CustomTool to an @openai/agents tool instance */
function toOpenAITool(ct: CustomTool) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(ct.parameters)) {
    let zodType: z.ZodTypeAny;
    switch (def.type) {
      case 'number':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      default:
        zodType = z.string();
    }
    if (def.description) zodType = zodType.describe(def.description);
    shape[key] = zodType;
  }

  return tool({
    name: ct.name,
    description: ct.description,
    parameters: z.object(shape),
    execute: async (input) => ct.execute(input as Record<string, unknown>),
  });
}

export class OpenAIProvider implements AgentProvider {
  constructor() {
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAIProvider');
    }
    process.env.OPENAI_API_KEY = config.openaiApiKey;
  }

  async run({
    systemPrompt,
    userMessage,
    mcpServers = [],
    tools = [],
    model = config.model.openai,
    operation = 'unspecified',
    descriptor,
  }: AgentRunOptions): Promise<string> {
    const mcpInstances = mcpServers.map(
      (s) =>
        new MCPServerStdio({
          name: s.name,
          command: s.command,
          args: s.args,
          env: s.env,
        }),
    );

    try {
      for (const server of mcpInstances) {
        await server.connect();
        console.log(`[MCP/OpenAI] Connected: ${server.name}`);
      }

      const openaiTools = tools.map(toOpenAITool);

      const agent = new Agent({
        name: 'qa-discovery-agent',
        model,
        instructions: systemPrompt,
        tools: openaiTools,
        mcpServers: mcpInstances,
      });

      console.log(
        `[OpenAI] Starting agent with model=${model}, mcpServers=${mcpInstances.length}, tools=${openaiTools.length}`,
      );

      const result = await run(agent, userMessage);

      const usage = result.state.usage;
      console.log(
        `[OpenAI] Usage: ${usage.inputTokens.toLocaleString()} input + ` +
          `${usage.outputTokens.toLocaleString()} output tokens across ${usage.requests} request(s) ` +
          `— cost not tracked (OpenAI pricing not in this codebase's pricing table)`,
      );
      await recordUsage({
        timestamp: new Date().toISOString(),
        operation,
        provider: 'openai',
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: null,
        descriptor: descriptor ?? null,
      });

      return result.finalOutput ?? '';
    } finally {
      for (const server of mcpInstances) {
        try {
          await server.close();
          console.log(`[MCP/OpenAI] Disconnected: ${server.name}`);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}

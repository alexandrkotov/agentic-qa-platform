import Anthropic from '@anthropic-ai/sdk';
import type { AgentProvider, AgentRunOptions } from './AgentProvider.ts';
import { McpManager } from '../mcp/McpManager.ts';
import { config } from '../config.ts';

export class ClaudeProvider implements AgentProvider {
  private readonly client: Anthropic;

  constructor() {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for ClaudeProvider');
    }
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  async run({
    systemPrompt,
    userMessage,
    mcpServers = [],
    tools = [],
    model = config.model.claude,
    maxIterations = 50,
  }: AgentRunOptions): Promise<string> {
    const mcp = new McpManager();

    try {
      if (mcpServers.length > 0) {
        await mcp.connect(mcpServers);
      }

      const mcpTools = await mcp.listAllTools();

      const anthropicTools: Anthropic.Tool[] = [
        ...mcpTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: {
            type: 'object' as const,
            properties: t.parameters as Record<string, unknown>,
            required: t.required ?? [],
          },
        })),
        ...tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: {
            type: 'object' as const,
            properties: t.parameters as Record<string, unknown>,
            required: t.required ?? [],
          },
        })),
      ];

      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: userMessage },
      ];

      console.log(
        `[Claude] Starting agent with model=${model}, tools=${anthropicTools.length}, maxIterations=${maxIterations}`,
      );

      for (let i = 0; i < maxIterations; i++) {
        const response = await this.client.messages.create({
          model,
          max_tokens: 8096,
          system: systemPrompt,
          tools: anthropicTools.length > 0 ? anthropicTools : undefined,
          messages,
        });

        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
          const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
          return text?.text ?? '';
        }

        if (response.stop_reason === 'tool_use') {
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const block of response.content) {
            if (block.type !== 'tool_use') continue;

            const input = block.input as Record<string, unknown>;
            console.log(`  [tool →] ${block.name}  ${JSON.stringify(input).slice(0, 160)}`);

            try {
              let result: string;

              const isMcp = mcpTools.some((t) => t.name === block.name);
              if (isMcp) {
                result = await mcp.callTool(block.name, input);
              } else {
                const customTool = tools.find((t) => t.name === block.name);
                if (!customTool) throw new Error(`Unknown tool: ${block.name}`);
                result = await customTool.execute(input);
              }

              console.log(`  [tool ←] ${block.name}  ${result.slice(0, 120).replace(/\n/g, ' ')}`);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            } catch (err) {
              const msg = (err as Error).message;
              console.error(`  [tool ✗] ${block.name}: ${msg}`);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Error: ${msg}`,
                is_error: true,
              });
            }
          }

          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        // Unknown stop reason — stop loop
        break;
      }

      return 'Agent reached max iterations without a final response.';
    } finally {
      await mcp.disconnectAll();
    }
  }
}

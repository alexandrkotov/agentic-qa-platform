import Anthropic from '@anthropic-ai/sdk';
import type { AgentProvider, AgentRunOptions } from './AgentProvider.ts';
import { McpManager } from '../mcp/McpManager.ts';
import { config } from '../config.ts';
import { estimateClaudeCostUsd } from '../pricing.ts';
import { recordUsage } from '../usageLog.ts';

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
    operation = 'unspecified',
    descriptor,
    onProgress,
  }: AgentRunOptions): Promise<string> {
    const mcp = new McpManager();
    const totalUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

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

      const startMsg = `[Claude] Starting agent with model=${model}, tools=${anthropicTools.length}, maxIterations=${maxIterations}`;
      console.log(startMsg);
      onProgress?.(startMsg);

      for (let i = 0; i < maxIterations; i++) {
        const response = await this.client.messages.create({
          model,
          // If you change this, also check DEFAULT_MAX_SCENARIOS_PER_GROUP in
          // agents/generate/budget.ts — its default was chosen empirically to
          // stay safe under this exact ceiling, and nothing keeps the two
          // numbers in sync automatically.
          max_tokens: 8096,
          system: systemPrompt,
          tools: anthropicTools.length > 0 ? anthropicTools : undefined,
          messages,
        });

        totalUsage.input_tokens += response.usage.input_tokens;
        totalUsage.output_tokens += response.usage.output_tokens;
        totalUsage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens ?? 0;
        totalUsage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;

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
            const callMsg = `[tool →] ${block.name}  ${JSON.stringify(input).slice(0, 160)}`;
            console.log(`  ${callMsg}`);
            onProgress?.(callMsg);

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

              const resultMsg = `[tool ←] ${block.name}  ${result.slice(0, 120).replace(/\n/g, ' ')}`;
              console.log(`  ${resultMsg}`);
              onProgress?.(resultMsg);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            } catch (err) {
              const msg = (err as Error).message;
              const errMsg = `[tool ✗] ${block.name}: ${msg}`;
              console.error(`  ${errMsg}`);
              onProgress?.(errMsg);
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
      const cost = estimateClaudeCostUsd(model, totalUsage);
      const costStr = cost === null ? 'cost unknown for this model' : `~$${cost.toFixed(4)}`;
      const usageMsg =
        `[Claude] Usage: ${totalUsage.input_tokens.toLocaleString()} input + ` +
        `${totalUsage.output_tokens.toLocaleString()} output tokens ` +
        `(cache write ${totalUsage.cache_creation_input_tokens.toLocaleString()}, ` +
        `cache read ${totalUsage.cache_read_input_tokens.toLocaleString()}) — ${costStr}`;
      console.log(usageMsg);
      onProgress?.(usageMsg);
      await recordUsage({
        timestamp: new Date().toISOString(),
        operation,
        provider: 'claude',
        model,
        inputTokens: totalUsage.input_tokens,
        outputTokens: totalUsage.output_tokens,
        cacheCreationTokens: totalUsage.cache_creation_input_tokens,
        cacheReadTokens: totalUsage.cache_read_input_tokens,
        costUsd: cost,
        descriptor: descriptor ?? null,
      });
      await mcp.disconnectAll();
    }
  }
}

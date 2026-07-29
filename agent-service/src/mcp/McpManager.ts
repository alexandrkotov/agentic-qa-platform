import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../providers/AgentProvider.ts';

export interface McpToolDefinition {
  /** Prefixed name: serverName__toolName */
  name: string;
  description: string;
  parameters: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export class McpManager {
  private clients = new Map<string, Client>();

  async connect(servers: McpServerConfig[]): Promise<void> {
    for (const server of servers) {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...process.env, ...server.env } as Record<string, string>,
      });

      const client = new Client({ name: `agent-service/${server.name}`, version: '0.1.0' });
      await client.connect(transport);
      this.clients.set(server.name, client);
      console.log(`[MCP] Connected: ${server.name}`);
    }
  }

  async listAllTools(): Promise<McpToolDefinition[]> {
    const all: McpToolDefinition[] = [];

    for (const [serverName, client] of this.clients) {
      const { tools } = await client.listTools();

      for (const tool of tools) {
        const prefixedName = `${serverName}__${tool.name}`;

        const schema = tool.inputSchema as {
          properties?: Record<string, { type?: string; description?: string }>;
          required?: string[];
        };

        const parameters: Record<string, { type: string; description?: string }> = {};
        for (const [key, val] of Object.entries(schema.properties ?? {})) {
          parameters[key] = { type: val.type ?? 'string', description: val.description };
        }

        all.push({
          name: prefixedName,
          description: `[${serverName}] ${tool.description ?? ''}`,
          parameters,
          required: schema.required,
        });
      }
    }

    return all;
  }

  async callTool(prefixedName: string, input: Record<string, unknown>): Promise<string> {
    const sep = prefixedName.indexOf('__');
    if (sep === -1) throw new Error(`Invalid prefixed tool name: ${prefixedName}`);

    const serverName = prefixedName.slice(0, sep);
    const toolName = prefixedName.slice(sep + 2);

    const client = this.clients.get(serverName);
    if (!client) throw new Error(`No MCP client for server: ${serverName}`);

    const result = await client.callTool({ name: toolName, arguments: input });

    const content = result.content as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }

  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
        console.log(`[MCP] Disconnected: ${name}`);
      } catch {
        // ignore errors on cleanup
      }
    }
    this.clients.clear();
  }
}

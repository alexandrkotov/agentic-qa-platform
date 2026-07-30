# agent-service

Autonomous QA agent that explores a target application and generates test scenarios.
Uses **Anthropic Claude** (primary) and **OpenAI** (secondary) as interchangeable AI providers,
with tools delivered via the **Model Context Protocol (MCP)**.

## Architecture

```
src/
  index.ts                # CLI entry point
  config.ts               # Environment config
  providers/
    AgentProvider.ts      # Shared interface for all providers
    ClaudeProvider.ts     # Anthropic SDK + manual agentic loop
    OpenAIProvider.ts     # @openai/agents with native MCP support
  mcp/
    McpManager.ts         # MCP client: connect / list tools / call tools / disconnect
  tools/
    swagger.ts            # Custom HTTP tool: fetches OpenAPI JSON spec
  bootstrap/
    discovery.ts          # Phase 1 — System Discovery: system prompt, MCP configs, report writer
reports/                  # Generated JSON reports (git-ignored)
```

## Prerequisites

**1. Install dependencies**

```bash
cd agent-service
pnpm install
```

**2. Install Playwright's Chromium browser** (one-time, required for `@playwright/mcp`)

```bash
node_modules/.pnpm/@playwright+mcp@0.0.78/node_modules/@playwright/mcp/node_modules/.bin/playwright install chromium
```

**3. Configure environment**

```bash
cp .env.example .env
```

Edit `.env` and fill in your API keys:

```dotenv
ANTHROPIC_API_KEY=sk-ant-...   # Required for Claude provider
OPENAI_API_KEY=sk-...          # Required for OpenAI provider
```

Make sure the target application is running (`docker compose up` from the project root).

## Running

```bash
# Phase 1 — System Discovery (Claude, default)
pnpm discovery

# Phase 1 — System Discovery (OpenAI)
pnpm discovery:openai
```

Each run saves a timestamped JSON report to `reports/discovery-<ISO-timestamp>.json`.

---

## Providers

Both providers implement the same `AgentProvider` interface:

```typescript
interface AgentProvider {
  run(options: AgentRunOptions): Promise<string>;
}

interface AgentRunOptions {
  systemPrompt: string;
  userMessage: string;
  mcpServers?: McpServerConfig[];  // MCP servers to connect to
  tools?: CustomTool[];            // Additional non-MCP tools
  model?: string;
  maxIterations?: number;
}
```

### ClaudeProvider

Uses `@anthropic-ai/sdk` with a manual agentic loop. Connects to MCP servers via
`@modelcontextprotocol/sdk` (StdioClientTransport), lists their tools, and routes tool
calls back to the appropriate MCP client.

```typescript
import { ClaudeProvider } from './providers/ClaudeProvider.ts';

const provider = new ClaudeProvider();
const report = await provider.run({
  systemPrompt: 'You are a QA agent...',
  userMessage: 'Explore the application.',
  mcpServers: [playwrightMcp, postgresMcp],
  tools: [fetchSwaggerTool],
  model: 'claude-opus-4-5',
  maxIterations: 60,
});
```

### OpenAIProvider

Uses `@openai/agents` with its native `MCPServerStdio` support. MCP servers are registered
directly on the `Agent` instance — no manual tool routing needed.

```typescript
import { OpenAIProvider } from './providers/OpenAIProvider.ts';

const provider = new OpenAIProvider();
const report = await provider.run({
  systemPrompt: 'You are a QA agent...',
  userMessage: 'Explore the application.',
  mcpServers: [playwrightMcp, postgresMcp],
  tools: [fetchSwaggerTool],
  model: 'gpt-4o',
});
```

---

## MCP Tools

MCP servers are defined as `McpServerConfig` objects and spawned as child processes via stdio.

```typescript
interface McpServerConfig {
  name: string;      // Short unique name — used to namespace tool names
  command: string;
  args: string[];
  env?: Record<string, string>;
}
```

### Playwright MCP

Provides browser automation tools: `browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_type`, and more.

```typescript
const playwrightMcp: McpServerConfig = {
  name: 'playwright',
  command: './node_modules/.bin/playwright-mcp',
  args: ['--headless', '--browser', 'chromium'],
};
```

In `ClaudeProvider`, tool names are prefixed with the server name to avoid collisions:
`playwright__browser_navigate`, `playwright__browser_snapshot`, etc.

### Postgres MCP

Provides a `query` tool for executing SQL against PostgreSQL.

```typescript
const postgresMcp: McpServerConfig = {
  name: 'postgres',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-postgres', config.databaseUrl],
};
```

Example tool call the agent makes:

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
```

---

## Custom Tools

Non-MCP tools are defined as `CustomTool` objects and work with both providers.

```typescript
interface CustomTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description?: string }>;
  required?: string[];
  execute: (input: Record<string, unknown>) => Promise<string>;
}
```

### fetch_swagger_spec

Fetches the OpenAPI JSON spec from the backend. No parameters required.

```typescript
// src/tools/swagger.ts
export const fetchSwaggerTool: CustomTool = {
  name: 'fetch_swagger_spec',
  description: 'Fetch the complete OpenAPI/Swagger JSON spec from the backend.',
  parameters: {},
  execute: async () => {
    const res = await fetch('http://localhost:3000/docs-json');
    return JSON.stringify(await res.json(), null, 2);
  },
};
```

### Adding a new custom tool

```typescript
// src/tools/myTool.ts
import type { CustomTool } from '../providers/AgentProvider.ts';

export const myTool: CustomTool = {
  name: 'my_tool',
  description: 'Does something useful.',
  parameters: {
    url: { type: 'string', description: 'Target URL' },
  },
  required: ['url'],
  execute: async ({ url }) => {
    const res = await fetch(url as string);
    return await res.text();
  },
};
```

Then pass it to `provider.run({ tools: [myTool] })`.

---

## Adding a New Phase

1. Create `src/bootstrap/<phase-name>.ts`
2. Export a `run<PhaseName>(provider: AgentProvider): Promise<void>` function
3. Add a `case` in `src/index.ts`
4. Add a script in `package.json`

```typescript
// src/bootstrap/myPhase.ts
export async function runMyPhase(provider: AgentProvider): Promise<void> {
  const discoveryReport = JSON.parse(
    await readFile('reports/discovery-latest.json', 'utf-8'),
  );
  const result = await provider.run({
    systemPrompt: MY_PHASE_SYSTEM_PROMPT,
    userMessage: JSON.stringify(discoveryReport),
    tools: [writeFileTool],
  });
  // ...
}
```

See `src/agents/generate/` and `src/bootstrap/generateGroup.ts` / `generateSpec.ts` / `generateRender.ts`
for a real, non-toy example of this pattern — three separate phases (`generate-group`, `generate-spec`,
`generate-render`), each with its own bootstrap file and `case` in `src/index.ts`, gated by human
approval between them.

---

## Provider Comparison (Phase 1 Results)

| Metric | Claude opus-4-5 | OpenAI gpt-4o |
|---|---|---|
| Test scenarios generated | **27** | 4 |
| Business rules extracted | **13** | 3 |
| UI pages documented | 4 (inferred) | 0 |
| Correct report timestamp | ✅ | ❌ (hallucinated 2023) |
| Included internal tables | No | Yes (`_prisma_migrations`) |
| Security scenarios | 3 | 1 |

Claude is used as the primary provider for downstream phases.

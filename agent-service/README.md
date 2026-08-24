# agent-service

The backend for every agent in this platform, and for the Workbench control panel that drives
them from a browser. Explores a *live* target system (declared as a **System Descriptor**, not
hardcoded — see the root README) and runs it through Discovery → Generate → E2E → Analysis → Load.
Uses **Anthropic Claude** (primary) and **OpenAI** (secondary) as interchangeable AI providers,
with tools delivered via the **Model Context Protocol (MCP)** where an official server exists, and
hand-written custom tools where one doesn't.

## Architecture

```
src/
  index.ts                 # CLI entry point — discovery / generate-group / generate-spec /
                            # generate-render / e2e / apply-fix
  config.ts                # Environment config
  pricing.ts, usageLog.ts  # Per-call token/cost tracking — backs the live usage/cost dashboard
  providers/
    AgentProvider.ts        # Shared interface for both providers
    ClaudeProvider.ts       # Anthropic SDK + manual agentic loop
    OpenAIProvider.ts       # @openai/agents with native MCP support
  mcp/
    McpManager.ts           # MCP client: connect / list tools / call tools / disconnect
  descriptor/
    schema.ts               # System Descriptor zod schema — one entry per component type
    registry.ts              # Maps a component type to its builder
    components/              # One builder per type: postgres, mysql, mongo, mssql, sqlite,
                              # rest-api, web-ui, kafka, kafka-consumer, docker-compose — each
                              # owns its own MCP/tool config AND its own prompt section
  bootstrap/
    discovery.ts             # Runs the System Discovery Agent against a descriptor
    generateGroup.ts, generateSpec.ts, generateRender.ts   # Generate's 3 CLI stages
    deployTarget.ts, probeTarget.ts, kafkaUiSync.ts, kafkaDetect.ts   # docker-compose targets
    setupTarget.ts, setup/<name>.ts   # First-run setup script registry + per-target scripts
    clearTargetData.ts, composeNetworks.ts, targetsDir.ts, convertRecording.ts, setupPage.ts
  agents/
    generate/                # Stage 2/3 internals: spec.ts, render.ts, merge.ts, budget.ts,
                              # verify.ts (deterministic checker), corrections.ts, testEnv.ts, uat.ts
    e2e/                      # diagnose.ts, apply.ts/applyCore.ts, runner.ts, scenarios.ts, evidence.ts
    workflow/                 # Analysis: propose.ts/proposeUiFlow.ts/proposeSequenceFlow.ts,
                              # verify.ts (semantic checks), render.ts (Mermaid)
    loadtest/                 # spec.ts — Claude-authored k6 scripts
  admin/
    server.ts                # Express server behind the Workbench, http://localhost:4400
    agentStatus.ts            # GET /agent/status — the hardware-monitor client's own contract
    static/                   # index.html / visualize.html / generate.html / e2e.html / load.html /
                              # api-docs.html — 5 tabs + the platform's own Swagger UI, plain HTML
descriptors/                 # System Descriptor JSON files (mostly git-ignored, see root README)
reports/                     # Discovery/Analysis reports, AI usage log (git-ignored)
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

Make sure the target you want to explore is actually reachable first — e.g. `docker compose up`
from the project root for the bundled OrderFlow demo, or a deployed external target (see the root
README's "The System Descriptor").

## Running

```bash
# Discovery — explores descriptors/orderflow.json by default
pnpm discovery
pnpm discovery -- --descriptor descriptors/<name>.json   # or any other descriptor
pnpm discovery:openai                                     # OpenAI provider instead of Claude

# Generate — three human-approved stages, run in sequence
pnpm generate:group                                                          # Stage 1, no LLM call
pnpm generate:spec -- --grouping reports/generate-grouping-approved-<ts>.json # Stage 2, after approving it
pnpm generate:render -- --spec reports/generate-spec-approved-<ts>.json      # Stage 3, after approving that

# E2E Agent
pnpm e2e -- --scenario <id-or-title-or-tag>       # runs a scenario, diagnoses only on failure
pnpm apply-fix -- --report reports/e2e-<...>.json # applies a proposed fix, only after typing y/yes

# Workbench — the browser control panel for all of the above, plus Analysis and Load
pnpm workbench   # http://localhost:4400
```

Each Discovery run saves a timestamped JSON report to `reports/discovery-<ISO-timestamp>-<descriptor>.json`.
Analysis (diagrams) and Load (k6 scripts) have no CLI entry point of their own — reachable only
through the Workbench. See the root README's "The agents" / "The Workbench" for what each of these
actually does; this file is the technical reference underneath them.

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
calls back to the appropriate MCP client. The default provider for every agent.

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
directly on the `Agent` instance — no manual tool routing needed. Available on Discovery/
Generate-spec/E2E via `--provider openai`, mainly to compare the two on the same task.

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
Used wherever an official (or otherwise trustworthy) server already exists for the job — an
official MongoDB server, a real third-party Kafka one, Postgres's own official one. Where none
exists (MySQL, MSSQL, SQLite, the Swagger fetch), a hand-written **Custom Tool** (below) does the
same job instead.

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
`browser_type`, and more. Backs the `web-ui` component type.

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

Provides a `query` tool for executing SQL against PostgreSQL, via
`@modelcontextprotocol/server-postgres`. Backs the `postgres` component type.

```typescript
const postgresMcp: McpServerConfig = {
  name: 'postgres',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-postgres', config.databaseUrl],
};
```

### Mongo MCP

Provides schema/sample-document tools via the official `mongodb-mcp-server`. Backs the `mongo`
component type — `?directConnection=true` is required in the connection string for a single-node
replica set (e.g. Wekan's own `mongod`), otherwise the server's topology discovery hangs trying to
reach an internal hostname it can't resolve.

### Kafka MCP

Whole-broker exploration (topics, configs, sample messages, consumer groups) via
[`tuannvm/kafka-mcp-server`](https://github.com/tuannvm/kafka-mcp-server), spawned via
`docker run --network=host ...` — the same "docker-outside-of-docker" pattern the Workbench itself
uses to deploy targets. Backs both the `kafka` (whole-broker) and `kafka-consumer` (one topic,
narrower prompt) component types.

---

## Custom Tools

Non-MCP tools are defined as `CustomTool` objects and work with both providers. Rather than living
in one central file, each lives right next to the descriptor component it belongs to — every
builder in `src/descriptor/components/` can export its own `tools(component, key): CustomTool[]`,
scoped to that one component instance's own `key` (so two `rest-api` components in the same
descriptor never collide on a shared tool name).

```typescript
interface CustomTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description?: string }>;
  required?: string[];
  execute: (input: Record<string, unknown>) => Promise<string>;
}
```

### `fetch_swagger_spec__<key>` — `rest-api` component

Fetches the OpenAPI JSON spec (`swaggerUrl`, with `headers` applied if the descriptor sets any) and
hands it to the model whole. No parameters.

```typescript
// src/descriptor/components/restApi.ts (trimmed)
tools(component, key): CustomTool[] {
  if (component.swaggerUrl) {
    const swaggerUrl = component.swaggerUrl;
    return [{
      name: `fetch_swagger_spec__${key}`,
      description: `Fetch the complete OpenAPI/Swagger JSON spec for ${swaggerUrl}.`,
      parameters: {},
      execute: async () => {
        const res = await fetch(swaggerUrl, { headers: component.headers });
        if (!res.ok) throw new Error(`GET ${swaggerUrl} → ${res.status} ${res.statusText}`);
        return JSON.stringify(await res.json(), null, 2);
      },
    }];
  }
  // ...knownEndpoints fallback when no live spec exists
}
```

### `mysql_query__<key>` / MSSQL's own equivalent — read-only SQL

No official MCP server exists for MySQL/MariaDB or MSSQL, so `mysql.ts`/`mssql.ts` each define a
real query tool by hand instead — read-only `SELECT`/`SHOW`/`DESCRIBE`, shelling out to the real
`mysql` CLI (MySQL) or using the `mssql` npm package (MSSQL) rather than parsing a connection
string by hand for every call.

### `sqlite` component — the real `sqlite3` CLI

Same reasoning again: no npm package worth trusting for this, so `sqlite.ts` shells out to the real
`sqlite3` binary against a docker-compose-deployed target's own bind-mounted `.db` file (path
resolved via `${HOST_PROJECT_ROOT}`, see "Adding a New Target" below).

### Adding a new custom tool

For a brand-new descriptor component type, add a `tools()` method to its builder in
`src/descriptor/components/` (see `mysql.ts` above for a real, non-toy example) — the registry
wires it in automatically, nothing else to touch. For a one-off tool not tied to any component
type, define a `CustomTool` anywhere and pass it directly:

```typescript
const myTool: CustomTool = {
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

provider.run({ tools: [myTool] });
```

---

## System Descriptor Components, in Depth

A `docker-compose` component is different in kind from the rest (`postgres`/`mysql`/`mongo`/
`mssql`/`sqlite`/`rest-api`/`web-ui`/`kafka`/`kafka-consumer`, described in the root README's own
component table): the Discovery Agent never explores it directly, it's only a record of where the
descriptor's *other* components came from. It names a repo that ships its own `docker-compose.yml`
— the Workbench's "Deploy target" action ([`src/bootstrap/deployTarget.ts`](src/bootstrap/deployTarget.ts))
clones it and runs that compose file for real, via the same Docker socket
[`src/descriptor/components/kafka.ts`](src/descriptor/components/kafka.ts) already uses for its own
sibling MCP container, reusing the target's own declared host ports where they're free and
remapping only on a real conflict. Once a deploy is up, "Propose components"
([`src/bootstrap/probeTarget.ts`](src/bootstrap/probeTarget.ts)) mechanically inspects the running
stack — the same flattened compose config and port map the deploy already wrote to disk, plus a
handful of real HTTP requests — and drops candidate `web-ui`/`rest-api`/`postgres`/`mysql`/`mongo`/
`mssql`/`sqlite`/`kafka` components straight into the descriptor editor, pre-filled and ready to
review. No Claude call here either; an engine this app has no component type for yet, or a
database whose port was never published to the host, is reported honestly as "couldn't
auto-detect" rather than guessed at. A human still reviews, edits, and saves — same
propose-then-confirm shape as every other agent output in this app, just entirely mechanical this
time. Proven end to end against [wger](https://github.com/wger-project/wger) and
[Uptime Kuma](https://github.com/louislam/uptime-kuma), two real, unrelated open-source apps this
project has never seen before.

**Kafka UI (`:8081`) is multi-cluster and stays in sync automatically.** Any target with a detected
Kafka broker (by image — the same `probeTarget.ts` pass above) gets a predictable
`kafka-<targetName>` network alias planted at deploy time (`deployTarget.ts`'s own
`injectKafkaBrokerAliases()`) and a live entry in Kafka UI's own cluster list, kept correct on
every deploy/undeploy by [`src/bootstrap/kafkaUiSync.ts`](src/bootstrap/kafkaUiSync.ts) — no human
step needed beyond the ordinary Deploy/Undeploy click. Kafka UI itself is a container on the
Docker network (not host-network like `kafka-mcp-server`), so it reaches each broker via a network
join rather than a published port — works even for a target that never publishes its broker's
port at all.

**Multiple targets can be deployed and stay up at the same time, with zero conflict.** Each deploy
is its own Compose project (`deployTarget.ts`'s own `projectNameFor()`), so each gets its own
Docker network and its own independently allocated host ports — `assignPorts()`'s
remap-on-conflict logic already guarantees no two targets' published ports collide, with no
coordination needed between them. Confirmed live: wger (7 services) and Uptime Kuma ran fully
deployed at once for real stretches of this project's own development, neither one ever told to
coexist deliberately — nothing in the design assumes only one target is ever live. The only real
cost is host resources (CPU/RAM for however many stacks happen to be up); there's no artificial
single-target limit anywhere in the architecture.

---

## Adding a New Phase

The shape every phase so far has followed: a `src/bootstrap/<phase-name>.ts` file exporting a
`run<PhaseName>(...)` function, a matching `case` in `src/index.ts`, and a script in `package.json`.
The exact signature isn't fixed — Discovery's `runDiscoveryForDescriptor()` takes a provider and a
descriptor, Generate's `runGenerateGroup()` takes neither (Stage 1 has no LLM call at all), and each
later stage takes whatever its own approval flow actually needs. Read the real bootstrap file for
the phase closest to what you're building rather than assuming one canonical shape.

See `src/agents/generate/` and `src/bootstrap/generateGroup.ts` / `generateSpec.ts` / `generateRender.ts`
for a real, non-toy example — three separate phases (`generate-group`, `generate-spec`,
`generate-render`), each with its own bootstrap file and `case` in `src/index.ts`, gated by human
approval between them.

---

## Adding a New Target

Everything in "System Descriptor Components, in Depth" above composes into one path for onboarding
a brand-new external target system so it just works end to end — including CI, with zero pipeline
edits. Checklist, in order:

1. **Descriptor + deploy.** Create `descriptors/<name>.json` with a `docker-compose` component
   pointing at the target's own deploy-manifest repo (see above), deploy it from the Workbench,
   then use "Propose components" to mechanically draft the rest — currently proposes `web-ui`/
   `rest-api`/`postgres`/`mysql`/`mongo`/`mssql`/`sqlite`/`kafka` components straight from the
   running stack. If the target has its own Kafka broker, Kafka UI (`:8081`) picks it up
   automatically too, no extra step — see above.
2. **Portable paths.** Any component field that names a file under this deployment's own mirrored
   `targets/` mount (today, only `sqlite`'s `path`) must use the `${HOST_PROJECT_ROOT}` placeholder
   — e.g. `"${HOST_PROJECT_ROOT}/targets/<name>/repo/data/foo.db"` — not a literal absolute prefix.
   `src/descriptor/components/sqlite.ts`'s `resolveSafePath` expands it against this container's
   own `HOST_PROJECT_ROOT` env var at read time. A hardcoded dev-machine path works by pure
   coincidence on the machine it was written on and breaks everywhere else (this exact bug shipped
   once, real symptom: `sqlite3` failing with "unable to open database file" on a CI runner whose
   checkout lives at a different path than the author's laptop).
3. **Env overrides, if needed.** A target only reachable via `host.docker.internal:<port>` (not
   this project's own `app`/`frontend` compose network) needs `descriptors/<name>.env` —
   `FRONTEND_URL`/`BACKEND_URL`/credentials/etc., editable from the Workbench's Test Suite tab. See
   `src/agents/generate/testEnv.ts`'s own comment for the full mechanism.
4. **Generate + write the suite.** Run Discovery → Generate → Write & Run as usual. Writing the
   suite (`POST /api/generate/render`) automatically records which descriptor `tests/features/`/
   `tests/steps/` now belong to, in `tests/.current-descriptor` — this is what lets CI (below) stay
   descriptor-agnostic; nothing to edit by hand.
5. **First-run setup, only if the target needs it.** Most targets don't — either a one-time manual
   step already covers it (e.g. copying a `.env`, running an install wizard once against a target
   whose data then persists in its own volume) or there's no such wizard at all. It's needed when a
   target's own admin account/config does **not** survive a fresh `docker-compose` deploy (its data
   lives outside git, in a directory the bind mount only populates once something has walked
   through the app's own first-run wizard) — CI hits exactly this on every single run. When it
   applies, create `src/bootstrap/setup/<name>.ts` with a default export matching `SetupFn`
   (`(env, onProgress?) => Promise<void>`) — the filename **is** the registration, matching the
   descriptor's own name; nothing else to wire up (`bootstrap/setupTarget.ts`'s `hasSetup`/
   `runSetup` discover it dynamically). Use real Playwright browser automation of the target's
   actual wizard, not an undocumented internal API — see
   [`src/bootstrap/setup/uptime-kuma.ts`](src/bootstrap/setup/uptime-kuma.ts) as the reference
   example, or record one live through the Workbench's Discovery tab ("Record Setup" — an embedded
   noVNC session that saves straight into this file). Check whether setup is already done before
   doing anything (the target's own "am I configured yet" endpoint, or equivalent) and return early
   if so — CI calls this unconditionally on every run, so it has to be a safe no-op against an
   already-set-up instance, not just a fresh one. A descriptor with no script here still gets a
   real HTTP 400 (not a silent skip) if something explicitly calls
   `POST /api/descriptors/<name>/setup` for it — CI treats that 400 as "nothing to do" and moves on.

From here, CI just works: `.github/workflows/tests.yml`'s `e2e` job reads `tests/.current-descriptor`,
restores that descriptor's own archived suite via `tests/support/restore-suite.mjs` (`tests/features`/
`tests/steps` aren't git-tracked themselves, see the root README's "The test suite"), then drives
the real Workbench over its own HTTP API — `/deploy` → `/setup` → `/tests/run` → `/undeploy` — the
same routes a human already uses from the browser, not a separate reimplementation. Swapping which
target's suite `tests/.current-descriptor` names (step 4 above, next time — or the hub's own
"Deploy ... and its BDD suite" buttons) is the only thing that changes what CI runs; the workflow
file itself never needs touching again. A target's own setup script (if it has one) is also
bundled automatically into every archive snapshot (`POST /api/generate/snapshot`) alongside its
descriptor/corrections/env, so a snapshot stays self-contained enough to actually reproduce the
target's tested state, not just its test code.

---

## Provider Comparison (historical)

A one-time comparison from early Discovery development, kept for context — not re-run since, and
not representative of today's much larger discovery reports (this project now spans 9 descriptors
and 10 component types, not the single small app this ran against):

| Metric | Claude opus-4-5 | OpenAI gpt-4o |
|---|---|---|
| Test scenarios generated | **27** | 4 |
| Business rules extracted | **13** | 3 |
| UI pages documented | 4 (inferred) | 0 |
| Correct report timestamp | ✅ | ❌ (hallucinated 2023) |
| Included internal tables | No | Yes (`_prisma_migrations`) |
| Security scenarios | 3 | 1 |

Claude has been the default provider ever since; OpenAI stays supported as a comparison option on
Discovery/Generate-spec/E2E (`--provider openai`), not because it won this comparison.

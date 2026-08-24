# Running this locally, in full

The [Quick start](../README.md#quick-start) in the root README gets a real target (Uptime Kuma)
deployed and its test suite green with a handful of commands. This is the full manual walkthrough
underneath it — `.env` files for each part, database migrations by hand, running Discovery/
Generate/E2E from the CLI instead of the Workbench — useful either for understanding what each
Quick start step is actually doing, or for working against OrderFlow (this repo's own bundled app)
instead of an external target. Assumes the [Prerequisites](../README.md#prerequisites) from the
root README; every command runs from the repo root unless noted.

## 1. Clone and prepare environment files

None of the `.env` files are committed (all gitignored) — recreate them from what each part
actually reads:

```bash
# app/.env — only used for local Prisma commands run from the host (migrations, studio);
# the containerized app itself gets DATABASE_URL from docker-compose.yml instead.
echo 'DATABASE_URL="postgresql://user:pass@localhost:5432/testdb"' > app/.env

# tests/.env — read by tests/support/db.ts for direct DB assertions/cleanup
echo 'DATABASE_URL=postgresql://user:pass@localhost:5432/testdb' > tests/.env

# agent-service/.env — only needed if you're going to run discovery/generate yourself
cd agent-service && cp .env.example .env
# then edit .env and fill in ANTHROPIC_API_KEY (and OPENAI_API_KEY if you want the
# OpenAI-provider comparison run) — see agent-service/README.md for details
cd ..
```

No prompt files to prepare — the discovery/generate system prompts are plain TypeScript string
constants committed directly in `agent-service/src/bootstrap/*.ts`, not externalized.

## 2. Start the app stack

```bash
docker compose up -d --build                                                                     # platform
docker compose -p bdd-target-demo-orderflow -f docker-compose.demo-orderflow.yml up -d --build   # demo: OrderFlow
```

The first command starts `kafka-ui` (cluster admin UI, `:8081` — for humans only, nothing in this
repo depends on it), `report` (nginx, `:8080` — serves the Cucumber test report at `/` once you
generate one in step 4, and the AI usage/cost log at `/usage/`, which shows a friendly placeholder
until any agent call happens in step 5 or 6; the same container also serves the hub page above on
the default port, `:80`), `workbench` (the Workbench control panel — 5 tabs, Discovery/Analysis/
Test Suite/E2E/Load, `:4400`), `influxdb`+`grafana`+`k6` (the Load pipeline's own storage/dashboard/
runner, Grafana at `:9091`), and `codegen-recorder` (the always-on noVNC session behind the
Discovery tab's "Record Setup"). It also creates the `agentic-qa-platform-net` network the second
command's own project joins — always run this one first.

The second command starts `app` (NestJS, `:3000`), `frontend` (React/Vite, `:5173`), `db`
(Postgres, `:5432`), and `kafka` (single-node broker, external listener `:9094`) — the bundled
OrderFlow demo, its own compose project (`bdd-target-demo-orderflow`) so it can be torn down and
redeployed independently of the platform above (the hub's own buttons do exactly this, suite
included). Kafka is intentionally not persisted across rebuilds (no volume) — it's a derived event
stream, not data worth keeping, and `app`'s health-gated dependency on it means a full `--build`
always comes up clean regardless.

## 3. Database migrations

The demo compose file's own `app` service runs `prisma migrate deploy` automatically on every
start (needed so a fresh `pgdata` volume — e.g. after the hub's "Deploy OrderFlow" button does a
clean teardown+redeploy — always ends up with a real schema, not just `prisma generate`) — nothing
to do here normally. To re-run migrations by hand against an already-running container:

```bash
docker compose -p bdd-target-demo-orderflow -f docker-compose.demo-orderflow.yml exec app npx prisma migrate deploy
```

Once step 2 is done, `http://localhost:3000/customers` and `http://localhost:5173` should both
respond.

## 4. Run the test suite

`tests/features`/`tests/steps` start out empty (gitignored — see "The test suite" in the root
README) — restore one of the two git-tracked `archive/bdd-test-suite-*` snapshots into them first:

```bash
node tests/support/restore-suite.mjs uptime-kuma   # or: orderflow
cd tests
pnpm install
npx playwright install --with-deps chromium   # one-time, downloads the browser
pnpm run test      # bddgen + playwright test — checkmark output in terminal + writes JSON
pnpm run report    # renders reports/cucumber-html/ from that JSON
pnpm run cleanup   # sweeps the test data this run created out of the database
```

Running against `uptime-kuma` needs it deployed+set up first (see the root README's Quick start);
running against `orderflow` needs `tests/.env`'s `DATABASE_URL` pointed at
`postgresql://user:pass@localhost:5432/testdb` (step 1 already sets this by default).

Then open `http://localhost:8080/` to view the Cucumber HTML report (served by the `report`
container from step 2 — refresh the page any time you regenerate the report, no restart needed).

## 5. (Optional) Re-run the agents yourself

The discovery report and generated test suite are already committed — you don't need to run the
discovery/generate agents to use this repo. If you want to see them work, or point them at a
modified app:

```bash
cd agent-service
pnpm install
# one-time: install the Chromium build Playwright MCP needs
node_modules/.pnpm/@playwright+mcp@0.0.78/node_modules/@playwright/mcp/node_modules/.bin/playwright install chromium

pnpm discovery          # explores descriptors/orderflow.json by default, writes agent-service/reports/discovery-<timestamp>-orderflow.json
pnpm discovery -- --descriptor descriptors/kafka-demo.json   # or point it at the bare-Kafka descriptor instead

# Generate — three human-approved stages (see the root README's "The agents" section). The workbench
# UI already drives all three end to end; the CLI equivalents, run in sequence:
pnpm generate:group                                                          # Stage 1 — writes a proposed grouping
pnpm generate:spec -- --grouping reports/generate-grouping-approved-<ts>.json # Stage 2 — after approving it
pnpm generate:render -- --spec reports/generate-spec-approved-<ts>.json      # Stage 3 — after approving that

# The Workbench (descriptors, Discovery, Analysis, the Generate pipeline, test runs, E2E) already runs
# via `docker compose up` (http://localhost:4400) -- pnpm workbench below is only for iterating on
# its own code without rebuilding its Docker image:
pnpm workbench          # http://localhost:4400
```

See [`agent-service/README.md`](../agent-service/README.md) for provider switching
(`--provider openai`), `--group` filtering for `generate:spec` retries, and the full architecture
reference.

## 6. (Optional) Try the E2E Agent

Unlike discovery/generate, this one is meant to be run against the test suite you already have
(step 4) whenever you want — it's not a one-time bootstrap step:

```bash
cd agent-service

# Suggest mode: runs one scenario for real, diagnoses it only if it fails. Nothing is written
# to tests/. --scenario accepts an exact id, an exact title, or a Gherkin tag (e.g. "security"
# runs all 5 security scenarios in the currently-checked-in Uptime Kuma suite; omit --scenario
# to run all 20, but read the console warning first — it's much slower than running the suite
# directly via `pnpm run test` in tests/).
pnpm e2e -- --scenario "Create HTTP monitor with valid URL"

# If it failed and a fix was proposed, the console prints the report path. Review the report,
# then, only if you want to try the fix:
pnpm apply-fix -- --report reports/e2e-<scenario-id>-<timestamp>.json
# Shows the exact before/after and asks "Apply this fix and re-run the scenario? [y/N]" —
# nothing happens until you type y/yes. Nothing is ever committed automatically either way.
```

Every call above (and every `discovery`/`generate:spec` call from step 5) is logged with token usage
and cost to `http://localhost:8080/usage/` — open it in a browser and leave it open, it
auto-refreshes every 5 seconds.

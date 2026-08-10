import { z } from 'zod';

// ---------------------------------------------------------------------------
// Component types — one entry per system building block the discovery agent
// knows how to explore. Adding a new kind of target system means adding a
// branch here plus a matching builder in registry.ts — nothing else.
// ---------------------------------------------------------------------------

const PostgresComponentSchema = z.object({
  type: z.literal('postgres'),
  /** Required only when a descriptor has more than one component of this type. */
  name: z.string().optional(),
  connectionString: z.string(),
});

const RestApiComponentSchema = z.object({
  type: z.literal('rest-api'),
  name: z.string().optional(),
  swaggerUrl: z.string().url(),
  /** Base URL for calls made while verifying behavior; defaults to swaggerUrl's origin. */
  baseUrl: z.string().url().optional(),
});

const KafkaComponentSchema = z.object({
  type: z.literal('kafka'),
  name: z.string().optional(),
  brokers: z.array(z.string()).min(1),
  clientId: z.string().optional(),
  sasl: z
    .object({
      mechanism: z.enum(['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512']),
      username: z.string(),
      password: z.string(),
    })
    .optional(),
  tls: z
    .object({
      enabled: z.boolean().default(false),
      insecureSkipVerify: z.boolean().optional(),
    })
    .optional(),
});

const KafkaConsumerComponentSchema = z.object({
  type: z.literal('kafka-consumer'),
  name: z.string().optional(),
  brokers: z.array(z.string()).min(1),
  topic: z.string(),
  sampleSize: z.number().int().positive().optional(),
});

const WebUiComponentSchema = z.object({
  type: z.literal('web-ui'),
  name: z.string().optional(),
  baseUrl: z.string().url(),
  /** Routes to visit during exploration, e.g. ['/', '/customers', '/products']. */
  routes: z.array(z.string()).min(1),
});

/**
 * SQLite has no network protocol, so there's no connection string the way
 * postgres has — this is a plain file read. Absolute-only + no ".."
 * segments is the same defense-in-depth spirit as composeFile above; the
 * builder (descriptor/components/sqlite.ts) additionally requires the
 * resolved path to sit under this container's own mirrored targets/ mount
 * before ever spawning sqlite3 against it, since a descriptor is a file a
 * human hand-edits and this schema alone can't know what's actually safe
 * to read on a given deployment.
 */
const SqliteComponentSchema = z.object({
  type: z.literal('sqlite'),
  name: z.string().optional(),
  /** Path to the .db file as seen from inside the workbench container —
   *  e.g. a docker-compose-deployed target's bind-mounted data dir (see
   *  dockerCompose.ts's mirrored-mount comment for why that path is
   *  directly visible here with no extra plumbing). */
  path: z.string().refine((p) => p.startsWith('/') && !p.split('/').includes('..'), {
    message: 'path must be an absolute path with no ".." segments',
  }),
});

/**
 * Deployment provenance, not something to explore — a target system that
 * ships its own docker-compose.yml (e.g. wger's separate deploy-manifest
 * repo) gets cloned and deployed via the Docker socket already mounted
 * into the `workbench` container (see bootstrap/deployTarget.ts), *before*
 * any real components are added by hand with their now-live URLs. This
 * component's own registry builder (descriptor/components/dockerCompose.ts)
 * contributes no MCP servers/tools; it only documents where the rest of
 * the descriptor's components came from.
 *
 * Stays part of the discriminated union rather than a separate top-level
 * field: the natural intermediate state (a descriptor that only describes
 * a pending deployment, nothing else yet) needs `components.min(1)` below
 * to accept it, which union membership gives for free.
 */
const DockerComposeComponentSchema = z.object({
  type: z.literal('docker-compose'),
  name: z.string().optional(),
  /** Clone URL for the repo containing the target's own compose file — http(s) only, not e.g. a `--upload-pack=` flag smuggled in as a fake "url" (this becomes a `git clone` argument). */
  repoUrl: z
    .string()
    .url()
    .refine((u) => ['http:', 'https:'].includes(new URL(u).protocol), {
      message: 'repoUrl must be an http(s) clone URL',
    }),
  /** Branch/tag/commit to pin the clone to — reproducibility across redeploys; omitted means the repo's own default branch. */
  ref: z.string().optional(),
  /**
   * Path to the compose file within the clone, relative to the repo root.
   * Deliberately NOT `.default('docker-compose.yml')`: `PUT /api/descriptors/:name`
   * round-trips this schema over the user's own saved JSON, so a zod
   * default would get silently materialized into their file on every save
   * — unlike every other optional field here. Apply the `docker-compose.yml`
   * fallback at the call site (deployTarget.ts) instead. Guarded against
   * absolute paths and `..` segments since it ends up joined into a `-f`
   * argument — same defense-in-depth spirit as resolveDescriptorFile's
   * NAME_PATTERN in admin/server.ts.
   */
  composeFile: z
    .string()
    .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
      message: 'composeFile must be a relative path with no ".." segments',
    })
    .optional(),
  /** Commands run once via `docker compose exec -T <service> <command...>` after `up` succeeds, before the target is considered ready (e.g. wger's `web ./manage.py setup-powersync-storage`). */
  postUpExec: z
    .array(
      z.object({
        service: z.string(),
        command: z.array(z.string()).min(1),
      }),
    )
    .optional(),
});

export type PostgresComponent = z.infer<typeof PostgresComponentSchema>;
export type RestApiComponent = z.infer<typeof RestApiComponentSchema>;
export type KafkaComponent = z.infer<typeof KafkaComponentSchema>;
export type KafkaConsumerComponent = z.infer<typeof KafkaConsumerComponentSchema>;
export type WebUiComponent = z.infer<typeof WebUiComponentSchema>;
export type DockerComposeComponent = z.infer<typeof DockerComposeComponentSchema>;
export type SqliteComponent = z.infer<typeof SqliteComponentSchema>;

const SystemComponentSchema = z.discriminatedUnion('type', [
  PostgresComponentSchema,
  RestApiComponentSchema,
  KafkaComponentSchema,
  KafkaConsumerComponentSchema,
  WebUiComponentSchema,
  DockerComposeComponentSchema,
  SqliteComponentSchema,
]);

export const SystemDescriptorSchema = z
  .object({
    name: z.string().optional(),
    components: z.array(SystemComponentSchema).min(1),
    /**
     * Free-text instructions spliced verbatim into the discovery system prompt,
     * after the per-component sections. For system-specific business-rule
     * verification that doesn't generalize across target systems (e.g. "create
     * an order, submit it, confirm the OrderStatusHistory sequence") — the same
     * escape hatch Phase 2's `domain.extraInstructions` uses, so this stays
     * confined to descriptors that need it (like orderflow.json) instead of leaking
     * into the generic component builders.
     */
    extraInstructions: z.string().optional(),
    /**
     * Raw SQL statements run, in order, via a direct (write-capable) Postgres
     * connection after the discovery agent finishes — not exposed to the LLM at
     * all. For cleaning up test fixtures the agent's own (deliberately
     * read-only) postgres tool cannot delete itself.
     */
    cleanupSql: z.array(z.string()).optional(),
  })
  .refine(
    (descriptor) => {
      const byType = new Map<string, number>();
      for (const c of descriptor.components) {
        byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
      }
      return descriptor.components.every(
        (c) => c.name !== undefined || (byType.get(c.type) ?? 0) === 1,
      );
    },
    { message: 'Multiple components of the same type require explicit distinct `name` fields' },
  );

export type SystemComponent = z.infer<typeof SystemComponentSchema>;
export type SystemDescriptor = z.infer<typeof SystemDescriptorSchema>;

/**
 * Component key used to key MCP server names, tool-name prefixes, and the report's
 * `components` map. Sanitized to alphanumeric + underscore — McpServerConfig.name
 * namespaces tool names and must not contain hyphens (see AgentProvider.ts), even
 * though component `type` values like "rest-api" and "web-ui" do.
 */
export function componentKey(component: SystemComponent): string {
  return (component.name ?? component.type).replace(/-/g, '_');
}

export function parseSystemDescriptor(json: unknown): SystemDescriptor {
  return SystemDescriptorSchema.parse(json);
}

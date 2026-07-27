import { z } from 'zod';

// ---------------------------------------------------------------------------
// Component types — one entry per system building block the recon agent
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

const WebUiComponentSchema = z.object({
  type: z.literal('web-ui'),
  name: z.string().optional(),
  baseUrl: z.string().url(),
  /** Routes to visit during exploration, e.g. ['/', '/customers', '/products']. */
  routes: z.array(z.string()).min(1),
});

export type PostgresComponent = z.infer<typeof PostgresComponentSchema>;
export type RestApiComponent = z.infer<typeof RestApiComponentSchema>;
export type KafkaComponent = z.infer<typeof KafkaComponentSchema>;
export type WebUiComponent = z.infer<typeof WebUiComponentSchema>;

const SystemComponentSchema = z.discriminatedUnion('type', [
  PostgresComponentSchema,
  RestApiComponentSchema,
  KafkaComponentSchema,
  WebUiComponentSchema,
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

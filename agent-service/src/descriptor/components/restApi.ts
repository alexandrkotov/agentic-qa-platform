import type { CustomTool } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { RestApiComponent } from '../schema.ts';

function swaggerToolName(key: string): string {
  return `fetch_swagger_spec__${key}`;
}

function probeToolName(key: string): string {
  return `probe_endpoint__${key}`;
}

// SVG badges are tiny; a raw /metrics dump on a real system could be huge —
// cap what actually lands in the agent's context regardless of what a given
// known endpoint happens to return.
const MAX_BODY_PREVIEW = 2000;

export const restApiBuilder: ComponentBuilder<RestApiComponent> = {
  tools(component, key): CustomTool[] {
    if (component.swaggerUrl) {
      const swaggerUrl = component.swaggerUrl;
      return [
        {
          name: swaggerToolName(key),
          description: `Fetch the complete OpenAPI/Swagger JSON spec for the "${key}" REST API. Returns all endpoints, request/response schemas, and validation constraints.`,
          parameters: {},
          required: [],
          execute: async () => {
            const res = await fetch(swaggerUrl);
            if (!res.ok) {
              throw new Error(`GET ${swaggerUrl} → ${res.status} ${res.statusText}`);
            }
            const spec = await res.json();
            return JSON.stringify(spec, null, 2);
          },
        },
      ];
    }

    // No OpenAPI/Swagger spec — knownEndpoints is a hand-verified list
    // instead (see schema.ts's own comment). Fail loud here, before any
    // paid call starts, rather than lazily inside execute() the first time
    // the agent happens to call this tool.
    if (!component.knownEndpoints) {
      throw new Error(`rest-api component "${key}" needs either swaggerUrl or knownEndpoints.`);
    }
    if (!component.baseUrl) {
      throw new Error(`rest-api component "${key}" needs baseUrl when using knownEndpoints (no swagger response to derive an origin from).`);
    }
    const baseUrl = component.baseUrl;
    const known = component.knownEndpoints;

    return [
      {
        name: probeToolName(key),
        description: `Send a real HTTP request to one of "${key}"'s known endpoints — must exactly match one of the method+path pairs listed in your instructions, nothing else — and return its status, content-type, and a body preview.`,
        parameters: {
          method: { type: 'string', description: 'HTTP method, exactly as listed for this endpoint.' },
          path: { type: 'string', description: 'Path, exactly as listed for this endpoint.' },
        },
        required: ['method', 'path'],
        execute: async (input) => {
          const method = String(input.method ?? '').toUpperCase();
          const path = String(input.path ?? '');
          // Scoped to exactly the declared list — same "only what's been
          // explicitly vetted, not whatever an agent guesses might exist"
          // reasoning as sqlite.ts's targets/-scoping guard. Keeps the
          // resulting report grounded in endpoints a human already
          // confirmed are real, not ones the agent invents.
          const match = known.find((e) => e.method.toUpperCase() === method && e.path === path);
          if (!match) {
            throw new Error(
              `"${method} ${path}" is not one of this component's known endpoints — use one of the exact method+path pairs listed in your instructions.`,
            );
          }
          const res = await fetch(new URL(path, baseUrl).toString(), { method });
          const contentType = res.headers.get('content-type') ?? '';
          const bodyText = await res.text();
          return JSON.stringify({
            status: res.status,
            contentType,
            bodyPreview: bodyText.slice(0, MAX_BODY_PREVIEW),
          });
        },
      },
    ];
  },

  promptSection(component, key): string {
    if (component.swaggerUrl) {
      return `### REST API (${key})
Call \`${swaggerToolName(key)}\` to get the complete OpenAPI specification for ${component.swaggerUrl}.
Extract: all endpoints (method + path + description), request body schemas, response schemas,
and any validation rules (minLength, enum, required fields, etc.).

Report this component's findings under \`components["${key}"]\` as:
{ "endpoints": [{ "method": "GET|POST|PATCH|DELETE", "path": "/api/path", "description": "...", "requestBody": {}, "responseSchema": {} }] }`;
    }

    const known = component.knownEndpoints ?? [];
    const list = known.map((e) => `- ${e.method} ${e.path}${e.description ? ` — ${e.description}` : ''}`).join('\n');
    return `### REST API (${key}) — no OpenAPI/Swagger spec exists for this system
Use \`${probeToolName(key)}\` to send a real request to EACH of the following known endpoints
(exact method + path — do not invent others, this tool refuses anything not on this list):
${list}

For each, note the real status code, content-type, and what the body actually contains.

Report this component's findings under \`components["${key}"]\` as:
{ "endpoints": [{ "method": "GET|POST|PATCH|DELETE", "path": "/api/path", "description": "one line describing what was actually observed" }] }`;
  },
};

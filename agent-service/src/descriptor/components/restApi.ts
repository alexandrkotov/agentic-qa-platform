import type { CustomTool } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { RestApiComponent } from '../schema.ts';

function swaggerToolName(key: string): string {
  return `fetch_swagger_spec__${key}`;
}

export const restApiBuilder: ComponentBuilder<RestApiComponent> = {
  tools(component, key): CustomTool[] {
    return [
      {
        name: swaggerToolName(key),
        description: `Fetch the complete OpenAPI/Swagger JSON spec for the "${key}" REST API. Returns all endpoints, request/response schemas, and validation constraints.`,
        parameters: {},
        required: [],
        execute: async () => {
          const res = await fetch(component.swaggerUrl);
          if (!res.ok) {
            throw new Error(`GET ${component.swaggerUrl} → ${res.status} ${res.statusText}`);
          }
          const spec = await res.json();
          return JSON.stringify(spec, null, 2);
        },
      },
    ];
  },

  promptSection(component, key): string {
    return `### REST API (${key})
Call \`${swaggerToolName(key)}\` to get the complete OpenAPI specification for ${component.swaggerUrl}.
Extract: all endpoints (method + path + description), request body schemas, response schemas,
and any validation rules (minLength, enum, required fields, etc.).

Report this component's findings under \`components["${key}"]\` as:
{ "endpoints": [{ "method": "GET|POST|PATCH|DELETE", "path": "/api/path", "description": "...", "requestBody": {}, "responseSchema": {} }] }`;
  },
};

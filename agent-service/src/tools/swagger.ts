import type { CustomTool } from '../providers/AgentProvider.ts';
import { config } from '../config.ts';

export const fetchSwaggerTool: CustomTool = {
  name: 'fetch_swagger_spec',
  description:
    'Fetch the complete OpenAPI/Swagger JSON spec from the backend. Returns all endpoints, request/response schemas, and validation constraints.',
  parameters: {},
  required: [],
  execute: async () => {
    const url = `${config.backendUrl}/docs-json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
    const spec = await res.json();
    return JSON.stringify(spec, null, 2);
  },
};

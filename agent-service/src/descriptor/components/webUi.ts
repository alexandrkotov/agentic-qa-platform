import type { McpServerConfig } from '../../providers/AgentProvider.ts';
import type { ComponentBuilder } from '../registry.ts';
import type { WebUiComponent } from '../schema.ts';

export const webUiBuilder: ComponentBuilder<WebUiComponent> = {
  mcpServers(_component, key): McpServerConfig[] {
    return [
      {
        name: key,
        // Local binary so the Chromium installed via `playwright install chromium` is found.
        command: './node_modules/.bin/playwright-mcp',
        args: ['--headless', '--browser', 'chromium'],
      },
    ];
  },

  promptSection(component, key): string {
    const routeList = component.routes.map((r) => `${component.baseUrl}${r}`).join('\n- ');
    return `### UI Exploration (${key})
Use the \`${key}__*\` playwright tools to navigate each of the following routes and take a
snapshot, noting all form fields, buttons, and accessibility roles (textbox, spinbutton, combobox):
- ${routeList}

Report this component's findings under \`components["${key}"]\` as:
{ "uiPages": [{ "route": "/", "title": "...", "formFields": [], "actions": [] }] }`;
  },
};

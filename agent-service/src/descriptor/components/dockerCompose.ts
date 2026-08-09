import type { ComponentBuilder } from '../registry.ts';
import type { DockerComposeComponent } from '../schema.ts';

/**
 * No `mcpServers`/`tools` — unlike every other component type, there is
 * nothing here for the discovery agent to explore. This component only
 * records where the descriptor's *other* components actually came from
 * (a target deployed via `docker compose up`, see bootstrap/deployTarget.ts,
 * triggered separately from a "Deploy target" action before discovery ever
 * runs). The promptSection below is deliberately negative: it tells the
 * agent to ignore this component rather than inventing something to say
 * about it, since buildSystemPrompt's own report contract otherwise reads
 * as "produce one components[key] entry per section listed here".
 */
export const dockerComposeBuilder: ComponentBuilder<DockerComposeComponent> = {
  promptSection(component, key): string {
    return `### Deployment note (${key}) — not a component to explore
This target's infrastructure was deployed from \`${component.repoUrl}\`
via \`docker compose\`. This entry itself has nothing to explore — do
not call any tools for it and do not add a \`components["${key}"]\`
entry to your report. The *other* components listed above (if any) are
what this deployment actually produced; explore those normally.`;
  },
};

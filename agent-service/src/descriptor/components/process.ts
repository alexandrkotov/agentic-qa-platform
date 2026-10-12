import type { ComponentBuilder } from '../registry.ts';
import type { ProcessComponent } from '../schema.ts';

/**
 * No `mcpServers`/`tools` — same shape as dockerComposeBuilder, and for the
 * same reason: this component only records where the descriptor's *other*
 * components came from (here: a repo cloned, built from source and run as
 * plain processes inside `workbench`, see bootstrap/deployProcessTarget.ts,
 * triggered from the same "Deploy target" action before discovery runs).
 * The promptSection is deliberately negative so the agent doesn't invent a
 * `components[key]` report entry for it.
 */
export const processBuilder: ComponentBuilder<ProcessComponent> = {
  promptSection(component, key): string {
    const ports = component.processes.map((p) => `${p.name} (port ${p.port})`).join(', ');
    return `### Deployment note (${key}) — not a component to explore
This target was built from source from \`${component.repoUrl}\` and run as
plain processes: ${ports}. This entry itself has nothing to explore — do
not call any tools for it and do not add a \`components["${key}"]\`
entry to your report. The *other* components listed above (if any) are
what this deployment actually produced; explore those normally.`;
  },
};

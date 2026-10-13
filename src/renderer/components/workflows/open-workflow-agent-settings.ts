/**
 * The workflow agent pane's way into Settings > Workflows, where the Workflow
 * agent is chosen. Nothing is inferred: until that choice is made the pane asks
 * for it rather than starting an agent nobody chose (`workflow-agent-choice.ts`).
 *
 * The panel opens on the tab it was last left on, so the tab is set first, as
 * the board manager's way to the Automation agent does. The Workflow agent card
 * is the tab's first, so it is on screen without a scroll.
 */

import { useConfigStore } from '../../stores/config-store';

export function openWorkflowAgentSettings(): void {
  const store = useConfigStore.getState();
  store.setLastSettingsTab('workflows');
  store.setSettingsOpen(true);
}

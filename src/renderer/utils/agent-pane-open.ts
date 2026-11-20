import type { BrowserPaneOpenPurpose } from '../../shared/types';
import { useSessionStore } from '../stores/session-store';

/**
 * Set a Browser pane's open state for an agent's `kangentic_browser_open_pane`
 * push, by the purpose the agent gave (decision 46 in
 * `docs/architecture/embedded-browser/decision-log.md`). Shared by the board's
 * bridge and the Command Terminal's, so the two cannot disagree.
 *
 * - `for-user` (and a push with no purpose, as every push was before): show the
 *   pane, which also ends a hold.
 * - `own-work`: mount the pane HELD, behind the terminal, the way the Browser
 *   pill hides it. A pane that is already open is left as it is, so an agent
 *   never hides a pane the user is looking at.
 *
 * Called before any window mounts, so the split row has its final shape on its
 * first render (`.claude/rules/retained-pane-never-remounts.md`).
 */
export function applyAgentPaneOpen(ownerKey: string, purpose: BrowserPaneOpenPurpose | undefined): void {
  const session = useSessionStore.getState();
  if (purpose === 'own-work') {
    if (!session.browserOpenTasks.has(ownerKey)) session.setBrowserOpen(ownerKey, false, { hold: true });
    return;
  }
  session.setBrowserOpen(ownerKey, true);
}

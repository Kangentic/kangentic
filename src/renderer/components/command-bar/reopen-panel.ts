/**
 * Reopens the Command Terminal panel on a launch that finds it was showing at
 * quit, as a board task window comes back. `AppConfig.commandTerminalOpenProjectId`
 * is the record: `useCommandBar` writes it as the panel opens and hides, and a
 * quit writes nothing, so it still names the project.
 *
 * Only over a terminal that came back. With none (auto-resume off, a transcript
 * gone), a reopened panel would start a fresh terminal, which runs a cold start's
 * checkout with nobody at the desk.
 */
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { selectLiveCommandTerminalSlots } from '../../stores/session-store/transient-session-slice';

// hmr-safe: set and read inside one boot's reopen; a reload mid-reopen only replays a fade.
let panelEnterSkipped = false;

/** Whether the panel about to mount is a restore, which paints flat (`restore-no-animation-replay.md`). */
export function isPanelEnterSkipped(): boolean {
  return panelEnterSkipped;
}

/** The restored panel has mounted, so the next open is a user's and fades in. */
export function clearPanelEnterSkip(): void {
  panelEnterSkipped = false;
}

export async function reopenCommandTerminalPanelAfterRestart(projectId: string): Promise<void> {
  const config = useConfigStore.getState();
  if (config.globalConfig.commandTerminalOpenProjectId !== projectId) return;
  useSessionStore.getState().setCommandBarOpening(true);
  // A wait that failed only means main cannot say: the live check below still decides.
  await window.electronAPI.sessions.waitForCommandTerminalRestore(projectId).catch(() => undefined);
  useSessionStore.getState().setCommandBarOpening(false);
  if (useProjectStore.getState().currentProject?.id !== projectId) return;
  const sessionState = useSessionStore.getState();
  if (sessionState.commandBarVisible) return;
  if (selectLiveCommandTerminalSlots(sessionState.sessions, projectId).size === 0) {
    config.saveCommandTerminalOpenProject(null);
    return;
  }
  panelEnterSkipped = true;
  // Armed here, with the project confirmed current, so `useCommandBar` runs its
  // own open: the reconcile, and a detached window's check.
  sessionState.setPendingOpenCommandTerminal(true);
}

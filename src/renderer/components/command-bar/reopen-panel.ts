/**
 * Reopens the Command Terminal panel on a launch that finds it was showing at
 * quit, as a board task window comes back. `AppConfig.commandTerminalOpenProjectId`
 * is the record: `useCommandBar` writes it as the panel opens and hides, and a
 * quit writes nothing, so it still names the project.
 *
 * Only over a terminal that came back. With none (auto-resume off, a transcript
 * gone), a reopened panel would start a fresh terminal, which runs a cold start's
 * checkout with nobody at the desk.
 *
 * Main's wait gives up at a ceiling, so Ctrl+Shift+P never hangs on a wedged
 * restore. The reopen has nobody waiting on it, so it keeps asking past that
 * ceiling: a restore slower than it (a loaded machine, a large project) used to
 * end here with the panel left shut and the record erased, and the terminals
 * came back a moment later with nothing to show them.
 */
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { selectLiveCommandTerminalSlots } from '../../stores/session-store/transient-session-slice';

/** How many more times the reopen asks once main's wait reaches its ceiling: about a minute in all. */
export const RESTORE_WAIT_EXTRA_ASKS = 6;

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

/**
 * Whether main says the restore is over. A wait that failed only means main
 * cannot say, and the live check after it still decides, so that reads as over.
 */
async function restoreIsOver(projectId: string): Promise<boolean> {
  try {
    return (await window.electronAPI.sessions.waitForCommandTerminalRestore(projectId)) !== false;
  } catch {
    return true;
  }
}

/** The reopen still has a panel to open: its project is current and the panel is shut. */
function reopenStillWanted(projectId: string): boolean {
  if (useProjectStore.getState().currentProject?.id !== projectId) return false;
  return !useSessionStore.getState().commandBarVisible;
}

export async function reopenCommandTerminalPanelAfterRestart(projectId: string): Promise<void> {
  const config = useConfigStore.getState();
  if (config.globalConfig.commandTerminalOpenProjectId !== projectId) return;
  // The title-bar toggle shows the wait only up to main's ceiling, as an open does.
  useSessionStore.getState().setCommandBarOpening(true);
  let restoreOver = await restoreIsOver(projectId);
  useSessionStore.getState().setCommandBarOpening(false);
  for (let asked = 0; !restoreOver && asked < RESTORE_WAIT_EXTRA_ASKS && reopenStillWanted(projectId); asked += 1) {
    restoreOver = await restoreIsOver(projectId);
  }
  if (!reopenStillWanted(projectId)) return;
  const sessionState = useSessionStore.getState();
  if (selectLiveCommandTerminalSlots(sessionState.sessions, projectId).size === 0) {
    // Forget the record only once the restore is over with nothing back. One
    // still running keeps it, so the next launch can reopen over what it brings.
    if (restoreOver) config.saveCommandTerminalOpenProject(null);
    return;
  }
  panelEnterSkipped = true;
  // Armed here, with the project confirmed current, so `useCommandBar` runs its
  // own open: the reconcile, and a detached window's check.
  sessionState.setPendingOpenCommandTerminal(true);
}

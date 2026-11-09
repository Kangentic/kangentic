/**
 * A Command Terminal's Browser pane ends with its terminal.
 *
 * A task's browser is cleaned up off its `sessions` row (`markRecordExited`
 * destroys its lanes, `closeTaskWindows` its pop-out). A Command Terminal has
 * no such row, so none of that ran: its offscreen page, its detached Browser
 * window, and its saved URL outlived it, and the next terminal in the same slot
 * inherited them. This runs the same cleanup off the one edge every Command
 * Terminal end shares, its registry row's `session-removed`, whichever path
 * ended it (Stop, a phone's end, the agent exiting, the PTY dying).
 *
 * The exception is a RESPAWN. A branch switch and a resume in place end the
 * slot's session through the same `session:killTransient` as Stop, then start
 * the slot again under a new session id. The page belongs to the slot, not the
 * session, and the pane stays mounted through the gap, so the renderer marks
 * the kill as a respawn and this keeps the browser while the slot's next start
 * runs. A respawn whose start fails leaves the slot empty, and the slot then
 * ends its browser as a Stop would have.
 */

import type { Session } from '../../../shared/types';
import { IPC } from '../../../shared/ipc-channels';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import { commandTerminalBrowserOwner } from '../../../shared/browser-owner';
import { browserPaneRegistry } from '../../browser/browser-pane-registry';
import { destroyLanesForTask } from '../../browser/browser-lane-manager';
import { browserUrlStore } from '../../browser/browser-url-store';
import { discardAnnotationDraft } from '../../browser/annotation-drafts';
import { commandTerminalBrowserStore } from '../../browser/command-terminal-browser-store';
import { releaseViewportOverridesForSession } from '../../browser/viewport-override';
import { popOutWindowManager } from '../../pop-out/pop-out-window-manager';
import { broadcast } from '../../pop-out/window-broadcast';
import { isShuttingDown } from '../../shutdown-state';
import type { IpcContext } from '../ipc-context';
import { resolveProjectContext } from './project-repos';

/**
 * How long a respawned slot waits before it checks for its next terminal. The
 * renderer starts it right after the kill returns; a start still in flight at
 * the check (a branch switch's checkout) re-arms it.
 */
export const RESPAWN_SETTLE_MS = 5_000;

// Sessions whose kill is a respawn of their slot, set before the kill and
// spent by its removal, which `endCommandTerminal` emits synchronously.
const respawningSessionIds = new Set<string>();

// Slots a respawn emptied, by owner key, each with the timer that checks
// whether the slot's next terminal arrived.
const pendingRespawnChecks = new Map<string, ReturnType<typeof setTimeout>>();

/** The kill of this session is a respawn of its slot: keep the slot's browser. */
export function markCommandTerminalRespawn(sessionId: string): void {
  respawningSessionIds.add(sessionId);
}

/** Drop a respawn mark once its kill has returned, spent or not. */
export function forgetCommandTerminalRespawn(sessionId: string): void {
  respawningSessionIds.delete(sessionId);
}

export interface CommandTerminalBrowserCleanupHooks {
  /**
   * The crash restore's own question (`isRestorableAfterHostLoss`), injected so
   * this helper does not import the restore handler, which imports the
   * transient-session handler, which imports this. A pty host crash removes a
   * terminal's row before its restore brings it back, and that terminal did not
   * end: its page, URL and layout stay for the conversation that returns, as
   * its leftover processes do (`CommandTerminalLeftoverReaper`). One the restore
   * does not bring back is ended from the restore (`restoreLostCommandTerminals`).
   */
  willRestore?: (session: Session) => boolean;
  /** Whether a start in flight holds the slot (`transient-sessions.ts`'s reservation). */
  isSlotStarting?: (projectId: string, slot: string) => boolean;
}

export function installCommandTerminalBrowserCleanup(
  context: IpcContext,
  hooks: CommandTerminalBrowserCleanupHooks = {},
): void {
  const willRestore = hooks.willRestore ?? (() => false);
  const isSlotStarting = hooks.isSlotStarting ?? (() => false);
  context.sessionManager.on('session-removed', (sessionId: string, session?: Session) => {
    const respawn = respawningSessionIds.delete(sessionId);
    if (!session || !isCommandTerminalSession(session)) return;
    const slot = session.commandTerminalSlot;
    const projectId = session.projectId;
    if (!slot || !projectId) return;
    if (respawn) {
      awaitRespawnedSlot(context, projectId, slot, sessionId, isSlotStarting);
      return;
    }
    if (willRestore(session)) return;
    endCommandTerminalBrowserSafely(context, projectId, slot, sessionId);
  });
}

/**
 * End the slot's browser unless a terminal runs in it again: the restore's
 * answer for a terminal it did not bring back to its own slot, and a respawn's
 * for a start that never came. Nothing ends during a quit, which keeps the
 * layout for the restart restore.
 */
export function endCommandTerminalBrowserIfSlotEmpty(
  context: IpcContext,
  projectId: string,
  slot: string,
  sessionId: string,
): void {
  if (isShuttingDown()) return;
  try {
    if (context.sessionManager.findLiveCommandTerminalSession(projectId, slot)) return;
  } catch {
    // No answer is no end: a browser closed in error costs the user a page.
    return;
  }
  endCommandTerminalBrowserSafely(context, projectId, slot, sessionId);
}

function awaitRespawnedSlot(
  context: IpcContext,
  projectId: string,
  slot: string,
  sessionId: string,
  isSlotStarting: (projectId: string, slot: string) => boolean,
): void {
  const ownerKey = commandTerminalBrowserOwner(projectId, slot);
  const check = (): void => {
    pendingRespawnChecks.delete(ownerKey);
    if (isSlotStarting(projectId, slot)) {
      schedule();
      return;
    }
    endCommandTerminalBrowserIfSlotEmpty(context, projectId, slot, sessionId);
  };
  const schedule = (): void => {
    const existing = pendingRespawnChecks.get(ownerKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(check, RESPAWN_SETTLE_MS);
    timer.unref?.();
    pendingRespawnChecks.set(ownerKey, timer);
  };
  schedule();
}

function endCommandTerminalBrowserSafely(context: IpcContext, projectId: string, slot: string, sessionId: string): void {
  try {
    endCommandTerminalBrowser(context, projectId, slot, sessionId);
  } catch (error) {
    // Best-effort, like the task path: a browser that fails to close must
    // never stand in the way of the terminal's own end.
    console.warn(`[browser-pane] Could not close the browser of Command Terminal ${slot}:`, error);
  }
}

function endCommandTerminalBrowser(context: IpcContext, projectId: string, slot: string, sessionId: string): void {
  const ownerKey = commandTerminalBrowserOwner(projectId, slot);
  const pendingCheck = pendingRespawnChecks.get(ownerKey);
  if (pendingCheck) {
    clearTimeout(pendingCheck);
    pendingRespawnChecks.delete(ownerKey);
  }

  // Mark first: the pane's unregister must not stand a lane up for it. The
  // hand-off would refuse anyway (the slot has no live session), but the mark
  // also gives the retired handle the right words for an agent still holding it.
  const panes = browserPaneRegistry.getByTaskId(ownerKey, projectId).filter((entry) => entry.kind === 'pane');
  if (panes.length > 0) browserPaneRegistry.markDeliberateClose(panes.map((entry) => entry.sessionId));

  // The renderer discards the open flag, the hold and the saved pane state.
  // Before the pop-out closes, since closing it with the flag set is a dock.
  if (!context.mainWindow.isDestroyed()) {
    broadcast(context.mainWindow, IPC.BROWSER_PANE_CLOSE_REQUEST, projectId, [ownerKey]);
  }
  if (popOutWindowManager.has('browser', { projectId, taskId: ownerKey })) {
    popOutWindowManager.close('browser', { projectId, taskId: ownerKey });
  }
  destroyLanesForTask(ownerKey);
  void releaseViewportOverridesForSession(sessionId).catch((error: unknown) => {
    console.warn(`[browser-viewport] Could not reset viewports for session ${sessionId.slice(0, 8)}:`, error);
  });

  // The next terminal in this slot starts on no page, with its pane closed and
  // no annotations, not on this one's.
  const { projectPath } = resolveProjectContext(context, projectId);
  if (projectPath) {
    browserUrlStore.clear(projectPath, ownerKey);
    commandTerminalBrowserStore.clear(projectPath, slot);
    void discardAnnotationDraft(projectPath, ownerKey, { retire: true }).catch((error: Error) => {
      console.warn(`[command-terminal] Failed to remove annotation draft for ${slot}: ${error.message}`);
    });
  }
}

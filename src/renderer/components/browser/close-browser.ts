import { useSessionStore } from '../../stores/session-store';

/**
 * The user's Close: discard a task's Browser pane and free its guest.
 *
 * Distinct from Hide (the Browser pill), which keeps the guest mounted behind
 * the terminal for the agent. Close is the only user path that ends the guest
 * while the agent session is live, so the two things that keep a guest alive
 * are both told:
 *
 *  1. Main retires the guest's surface handle with reason `user-closed` BEFORE
 *     the pane unmounts. The hand-off (`browser-lane-handoff.ts`) does not act
 *     on that reason, so no offscreen lane is stood up at the same URL - a lane
 *     is another renderer process, and the point of closing is to get the
 *     memory back. The agent's next call answers `surface-gone: the user
 *     closed the browser`, with the `open_pane` hint; reopening is allowed.
 *  2. The open flag is cleared WITHOUT a hold, so the pane unmounts and the
 *     guest dies with its node. The task's saved URL is untouched: the next
 *     Show opens the same page as a fresh document.
 *
 * Both the pane's own toolbar control and the task kebab's "Close browser"
 * call this, so a pane the user cannot see (hidden or parked) closes the same
 * way as one they can. A pane on its empty state has no guest and no entry in
 * `browserGuestTasks`; closing it is then just the hide without the hold.
 */
export async function closeBrowserForTask(taskId: string): Promise<void> {
  const webContentsId = useSessionStore.getState().browserGuestTasks.get(taskId);
  if (webContentsId !== undefined) {
    try {
      await window.electronAPI.browser.closePaneByUser(webContentsId);
    } catch {
      // Main will still unregister on the unmount below; the only loss is the
      // reason word, and a lane it might stand up ends with the session.
    }
  }
  useSessionStore.getState().setBrowserOpen(taskId, false);
}

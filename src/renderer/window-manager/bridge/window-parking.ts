/**
 * The BOARD layer's park-on-close policy, and the reaper that ends a park.
 *
 * An Electron `<webview>` guest dies the instant its DOM node unmounts, so
 * closing a task-detail window used to destroy its Browser pane's guest: main
 * handed the page off to an offscreen lane (a fresh document), and reopening
 * the task built another fresh pane. Every close/reopen therefore cost the
 * page its per-tab state twice, which an agent verifying an app whose auth
 * lives in `sessionStorage` experienced as being logged out at random.
 *
 * Retention already keeps such a window mounted and hidden across a project
 * switch. Parking extends the same mechanism to a USER close: when the window's
 * task has its Browser pane open AND a running agent session, the close hides
 * the window in place (`parkWindow`) instead of removing it, and reopening the
 * task un-parks it - same guest, same surface handle, `sessionStorage` intact.
 *
 * The generic window store knows only the mechanism. This module is the policy
 * (WHEN to park) and the reaper (WHEN a park ends), and it lives on the board
 * layer because both read the session store, which the store module must not
 * import (`session-store` -> `terminal-arrival-focus` -> `dictation-target` ->
 * `window-store` would close a cycle into a Pattern E pinned module).
 *
 * No module-scope mutable state, so nothing here needs HMR preservation.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useWindowStore } from '../store/window-store';
import type { ManagedWindow } from '../store/types';

/** True when the task's agent session is running: the guest has an owner worth preserving. */
function taskHasLiveSession(taskId: string): boolean {
  return useSessionStore.getState()._sessionByTaskId.get(taskId)?.status === 'running';
}

/**
 * True when the task's Browser pane is MOUNTED in its window: showing
 * (`browserOpenTasks`) or hidden-but-held (`browserHeldTasks`, the user put it
 * away while the agent may still be driving it). Either way there is a guest
 * worth keeping.
 */
function taskHasMountedPane(taskId: string): boolean {
  const { browserOpenTasks, browserHeldTasks } = useSessionStore.getState();
  return browserOpenTasks.has(taskId) || browserHeldTasks.has(taskId);
}

/**
 * Whether closing this window must PARK it rather than remove it. Consulted by
 * `WindowFrame` once the close animation has played, against live store state.
 *
 * Bounded deliberately to a Browser pane the user actually opened (showing, or
 * hidden and held) on a task whose agent is live: nothing else in a window is
 * worth keeping mounted invisibly, and a park costs a composited zero-opacity
 * webview for as long as it lasts.
 */
export function shouldParkTaskDetailWindowOnClose(managedWindow: ManagedWindow): boolean {
  if (managedWindow.kind !== 'task-detail') return false;
  if (!taskHasMountedPane(managedWindow.anchor)) return false;
  return taskHasLiveSession(managedWindow.anchor);
}

/**
 * End every hidden-pane arrangement the moment nothing is left to keep it
 * alive for. Two arrangements share this reaper because they share the reason
 * to exist (a guest an agent may be driving) and the reason to end (that agent
 * is gone):
 *
 * - A PARKED window is dropped (for real) when its pane is no longer mounted
 *   (an agent's `close_pane` or a hydration discarded it) or its agent session
 *   stopped running.
 * - A HELD pane's hold is released when its task's session stops running, so
 *   the pane unmounts inside its still-visible window (nothing to keep) and,
 *   more importantly, never re-mounts invisibly under a LATER session of the
 *   same task: the hold is not persisted, but the store outlives sessions.
 *
 * Both stores are unscoped across projects, so a window that also survived a
 * project switch is reaped by the same code.
 *
 * Mounted with the board bridges, which are renderer-lifetime: the windows this
 * reaps are precisely the ones nobody can see, so it must outlive any subtree.
 */
export function useParkedWindowReaper(): void {
  useEffect(() => {
    const reap = (): void => {
      const session = useSessionStore.getState();
      for (const taskId of session.browserHeldTasks) {
        if (!taskHasLiveSession(taskId)) session.releaseBrowserHold(taskId);
      }
      const store = useWindowStore.getState();
      for (const managedWindow of Object.values(store.windows)) {
        if (managedWindow.parked !== true) continue;
        if (taskHasMountedPane(managedWindow.anchor) && taskHasLiveSession(managedWindow.anchor)) continue;
        // The deliberate drop: the guest dies with the node. Main's hand-off is
        // told the close was deliberate only when the agent asked (`close_pane`);
        // a session that ended gets no lane either, since there is no agent
        // left to carry the page for.
        store.closeWindow(managedWindow.id);
      }
    };
    reap();
    const unsubscribes = [
      useWindowStore.subscribe((state, previous) => {
        if (state.windows !== previous.windows) reap();
      }),
      useSessionStore.subscribe((state, previous) => {
        if (
          state.sessions === previous.sessions &&
          state.browserOpenTasks === previous.browserOpenTasks &&
          state.browserHeldTasks === previous.browserHeldTasks
        ) {
          return;
        }
        reap();
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, []);
}

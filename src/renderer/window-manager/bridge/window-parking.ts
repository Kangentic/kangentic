/**
 * The BOARD layer's park-on-close policy, the reaper that ends a park, and the
 * window input a user's open and a parked open share.
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
 * An agent's `kangentic_browser_open_pane` uses the same hiding from the other
 * direction: a task with no window gets one BORN parked, so the pane has a host
 * and nothing appears (`useBrowserPaneRequestBridge`). The user opening the task
 * later un-parks it exactly as they would a window they closed.
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
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { monitorWindowManager, useWindowStore } from '../store/window-store';
import { isLayerMounted, subscribeLayerMounts } from '../store/layer-mount-registry';
import { monitorDetailAnchor } from '../store/monitor-anchor';
import { isWindowDormant } from '../store/types';
import type { ManagedWindow } from '../store/types';
import type { Task } from '../../../shared/types';

/**
 * The window a task's detail opens with, whoever asks. One builder, so the
 * user's open and an agent's parked one cannot disagree about what a task window
 * is. Reads the session store for the task's live session.
 */
export function taskDetailWindowInput(task: Task): {
  kind: 'task-detail';
  anchor: string;
  sessionId: string | null;
  title: string;
  openedDone: boolean;
  skipEnterAnimation: true;
} {
  const board = useBoardStore.getState();
  return {
    kind: 'task-detail',
    anchor: task.id,
    sessionId: useSessionStore.getState()._sessionByTaskId.get(task.id)?.id ?? null,
    title: task.title,
    // Baseline for auto-close: a task opened while already Done/archived (e.g. from
    // the Completed Tasks list) must NOT auto-close - only a later transition into
    // Done does. Captured here so it survives the content remount the Done fly causes.
    openedDone:
      task.archived_at !== null
      || board.swimlanes.find((lane) => lane.id === task.swimlane_id)?.role === 'done',
    // Terminal-hosting windows open FLAT, deliberately.
    //
    // The entrance is a `scale()` transform, and a transform does not change an
    // element's border box - so it never triggers ResizeObserver - while it DOES
    // change `getBoundingClientRect()`, which is what xterm's FitAddon measures.
    // Any terminal that fits mid-animation computes `cols` from a shrunken box
    // and is never corrected, because the real box never moved. That reads as a
    // frozen, horizontally-overflowing terminal until the user resizes by hand.
    //
    // Correctness over motion: a surface that spawns a terminal is worth more
    // fast and accurate than animated.
    skipEnterAnimation: true,
  };
}

/**
 * Whether the in-app Agent Monitor is showing this task's detail, so a pane for
 * it mounts there. The layer has to be mounted: the Monitor's windows outlive its
 * overlay, and a window with no layer mounts no pane. The detached Monitor is a
 * renderer of its own that hosts no `<webview>`, so it never answers yes here.
 */
export function monitorMountsDetail(projectId: string, taskId: string): boolean {
  if (!isLayerMounted(monitorWindowManager)) return false;
  const anchor = monitorDetailAnchor(projectId, taskId);
  return Object.values(monitorWindowManager.store.getState().windows).some(
    (candidate) => candidate.anchor === anchor && !isWindowDormant(candidate),
  );
}

/** True when the task's agent session is running: the guest has an owner worth preserving. */
function taskHasLiveSession(taskId: string): boolean {
  return useSessionStore.getState()._sessionByTaskId.get(taskId)?.status === 'running';
}

/**
 * True when the task has a live `<webview>` guest worth keeping mounted: its
 * Browser pane is showing (`browserOpenTasks`) or hidden-but-held
 * (`browserHeldTasks`, the user put it away while the agent may still be
 * driving it), AND a guest has actually registered for it.
 *
 * The guest check is what makes this "worth keeping" rather than merely
 * "mounted". Pane open state is a store flag the user sets by pressing a pill;
 * it says nothing about whether a page exists. A pane with no URL renders the
 * empty state and never attaches a `<webview>`, so without this check, opening
 * the pane and closing the window would hide a window forever with nothing
 * inside it to preserve. `browserGuestTasks` is set on the guest's `dom-ready`
 * and cleared when its node unmounts, so it is exactly the "there is a page
 * here" fact. It also covers the popped-out case: a pop-out hosts the guest in
 * its own window and clears this entry here, and an in-app pane that is not
 * mounted is not worth parking for.
 *
 * The open/held check is kept alongside it. A guest can only register while the
 * pane is mounted, so it is redundant today, but it keeps the predicate honest
 * about which arrangements it covers rather than relying on that coupling.
 */
function taskHasPreservableGuest(taskId: string): boolean {
  const { browserOpenTasks, browserHeldTasks, browserGuestTasks } = useSessionStore.getState();
  if (!browserGuestTasks.has(taskId)) return false;
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
  if (!taskHasPreservableGuest(managedWindow.anchor)) return false;
  return taskHasLiveSession(managedWindow.anchor);
}

/**
 * One pass of the sweep `useParkedWindowReaper` runs. Returns when the next
 * window born parked stops waiting for its guest, or null when none is waiting.
 */
export function sweepHiddenPanes(now: number): number | null {
  const session = useSessionStore.getState();
  for (const taskId of session.browserHeldTasks) {
    if (!taskHasLiveSession(taskId)) session.releaseBrowserHold(taskId);
  }
  const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
  let nextGraceEnd: number | null = null;
  const store = useWindowStore.getState();
  for (const managedWindow of Object.values(store.windows)) {
    if (managedWindow.parked !== true) continue;
    const projectId = managedWindow.retainedProjectId ?? currentProjectId;
    const heldByMonitor = projectId !== null && monitorMountsDetail(projectId, managedWindow.anchor);
    if (!heldByMonitor) {
      const graceEnd = managedWindow.guestPendingUntil;
      if (graceEnd !== undefined && graceEnd > now) {
        nextGraceEnd = nextGraceEnd === null ? graceEnd : Math.min(nextGraceEnd, graceEnd);
        continue;
      }
      if (taskHasPreservableGuest(managedWindow.anchor) && taskHasLiveSession(managedWindow.anchor)) continue;
    }
    // The deliberate drop: the guest dies with the node. Main's hand-off is
    // told the close was deliberate only when the agent asked (`close_pane`);
    // a session that ended gets no lane either, since there is no agent
    // left to carry the page for.
    store.closeWindow(managedWindow.id);
  }
  return nextGraceEnd;
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
 * A window BORN parked has no guest until the page's `dom-ready`, so the sweep
 * leaves it alone until `guestPendingUntil`. Nothing writes to a store when that
 * time passes, so the sweep arms a timer for it.
 *
 * A parked window is also dropped when the mounted Agent Monitor takes its task:
 * a dormant window is not reported to main, so nothing else tells the board to
 * let go, and the Monitor's own pane would be a second guest for one task.
 *
 * Both stores are unscoped across projects, so a window that also survived a
 * project switch is reaped by the same code.
 *
 * Returns what stops it.
 */
export function startParkedWindowReaper(): () => void {
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const reap = (): void => {
    const now = Date.now();
    const nextGraceEnd = sweepHiddenPanes(now);
    // After the sweep, never before: its `closeWindow` comes back here through
    // the window store's subscription, and a timer that nested pass armed would
    // otherwise be overwritten with nothing left to clear it.
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = nextGraceEnd === null ? null : setTimeout(reap, nextGraceEnd - now);
  };
  reap();
  const unsubscribes = [
    useWindowStore.subscribe((state, previous) => {
      if (state.windows !== previous.windows) reap();
    }),
    monitorWindowManager.store.subscribe((state, previous) => {
      if (state.windows !== previous.windows) reap();
    }),
    // The Monitor's windows outlive its overlay, so opening it takes a task too.
    subscribeLayerMounts(reap),
    useSessionStore.subscribe((state, previous) => {
      if (
        state.sessions === previous.sessions &&
        state.browserOpenTasks === previous.browserOpenTasks &&
        state.browserHeldTasks === previous.browserHeldTasks &&
        // The reaper's predicate reads this too, so a guest going away has to
        // wake it: otherwise a parked window whose page died would sit hidden
        // until some unrelated store write happened to run the sweep.
        state.browserGuestTasks === previous.browserGuestTasks
      ) {
        return;
      }
      reap();
    }),
  ];
  return () => {
    if (graceTimer) clearTimeout(graceTimer);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/**
 * Mounted with the board bridges, which are renderer-lifetime: the windows this
 * reaps are precisely the ones nobody can see, so it must outlive any subtree.
 */
export function useParkedWindowReaper(): void {
  useEffect(() => startParkedWindowReaper(), []);
}

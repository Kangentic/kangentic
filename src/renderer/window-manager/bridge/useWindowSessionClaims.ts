/**
 * Keeps `session-store.dialogSessionIds` (the set of sessions owned by open
 * detail windows) reconciled to the actual open windows, re-deriving it from the
 * HMR-preserved window-store.
 *
 * Why this exists (HMR resilience): the window-store survives a Vite Fast Refresh
 * (Pattern A preserve), but `dialogSessionIds` lives in the session-store and is
 * established by each window's per-mount claim (`useTaskSessionState`). That claim
 * only re-fires when a window's `session?.id` changes, so if ANY other code
 * resets `dialogSessionIds` out from under the open windows (a project-switch
 * reset re-triggered by HMR re-syncing `currentProject`, say), the windows do not
 * re-claim and their sessions silently drop out of the bottom-panel focus set,
 * which makes the main process suppress their PTY output (a frozen, unresizable
 * terminal). This effect re-derives the claim set from the source of truth (the
 * open windows) whenever it diverges, so such a clobber self-heals on the next
 * render instead of leaving a dead terminal.
 *
 * It is the steady-state safety net, NOT the open-time handoff: the synchronous
 * `useLayoutEffect` claim in `useTaskSessionState` still runs first so the bottom
 * panel drops a terminal before the new window mounts it (one xterm per PTY).
 * This effect is additive to that and only corrects divergence after the fact, so
 * it never causes a two-xterm race at open.
 *
 * Mounted once by `WindowLayer`.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useWindowStore } from '../store/window-store';

export function useWindowSessionClaims(): void {
  const windows = useWindowStore((state) => state.windows);
  const sessions = useSessionStore((state) => state.sessions);
  const dialogSessionIds = useSessionStore((state) => state.dialogSessionIds);

  useEffect(() => {
    // The live session of each open detail window, resolved by anchor (the taskId
    // for task-detail windows) - a window's stored `sessionId` can be stale after a
    // respawn, but the anchor is durable.
    const ownedSessionIds: string[] = [];
    for (const managedWindow of Object.values(windows)) {
      // Only task-detail windows claim a session by anchor (their anchor is a
      // taskId). A conversation window's anchor is a session id - skip it.
      if (managedWindow.kind !== 'task-detail') continue;
      const session = sessions.find((candidate) => candidate.taskId === managedWindow.anchor);
      if (session && !ownedSessionIds.includes(session.id)) ownedSessionIds.push(session.id);
    }

    // `dialogSessionIds` is exactly the window-owned claim set (nothing else
    // writes it), so reconcile it to the owned set whenever they diverge.
    const inSync =
      ownedSessionIds.length === dialogSessionIds.length &&
      ownedSessionIds.every((sessionId) => dialogSessionIds.includes(sessionId));
    if (!inSync) useSessionStore.setState({ dialogSessionIds: ownedSessionIds });
  }, [windows, sessions, dialogSessionIds]);
}

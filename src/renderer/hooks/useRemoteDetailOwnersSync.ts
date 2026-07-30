/**
 * Mirrors main's "which task details are open in ANOTHER renderer" push into the
 * session store.
 *
 * Terminal ownership is one xterm per PTY, and until this existed it was enforced
 * per renderer: the bottom panel consulted `dialogSessionIds`, which only ever
 * knew about detail windows in its OWN renderer. A detail hosted in the detached
 * Agent Monitor is a separate renderer with separate stores, so the main window
 * could not tell the session already had a terminal on screen and mounted a second
 * xterm on the same live PTY. Both fitted to their own width and both called
 * `sessions.resize`, so the PTY ended up sized for whichever fitted last and the
 * board's panel showed a blank or mis-wrapped terminal.
 *
 * Only main can answer this (a pop-out is invisible to the main window), so main
 * publishes it, already filtered to exclude this renderer's own claims.
 *
 * Mounted in `AppLayout`, i.e. the main window only, which is the only renderer
 * with a bottom panel to protect. A pop-out does not need it: two pop-out surfaces
 * cannot both host the same detail, because the ownership arbiter in main forbids
 * a detail being open twice at all.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../stores/session-store';

export function useRemoteDetailOwnersSync(): void {
  useEffect(() => {
    const ownership = window.electronAPI?.taskDetailOwnership;
    if (!ownership?.onRemoteOwnersChanged) return;
    return ownership.onRemoteOwnersChanged((owners) => {
      const taskIds = owners.map((owner) => owner.taskId);
      // Write only on a real change: this fires on every ownership mutation in any
      // renderer, and a fresh array would re-render every panel consumer AND
      // re-publish the focused-session set, which gates whether main streams PTY
      // bytes at all (`useFocusedSessionsSync`).
      //
      // Compared as a SET, not positionally. Main's owner map is keyed by
      // `projectId:taskId` and iterated in insertion order, so a reordering that
      // leaves the membership identical is not a change worth reacting to - and a
      // positional compare would treat it as one.
      const current = useSessionStore.getState().remoteDetailTaskIds;
      const incoming = new Set(taskIds);
      const same =
        current.length === taskIds.length
        && current.every((taskId) => incoming.has(taskId));
      if (!same) useSessionStore.setState({ remoteDetailTaskIds: taskIds });
    });
  }, []);
}

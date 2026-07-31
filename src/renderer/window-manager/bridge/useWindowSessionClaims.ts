/**
 * Keeps `session-store.dialogSessionIds` (the set of sessions owned by open
 * detail windows) reconciled to the actual open windows, re-deriving it from the
 * HMR-preserved window stores.
 *
 * It reconciles across EVERY window-manager instance in this renderer
 * (`allWindowManagers`), not just the board's, because `dialogSessionIds` is
 * renderer-global: one array in the session store, read by the bottom terminal
 * panel to decide whether to render its own xterm. Walking a single layer made
 * this reconciler authoritative over claims it could not see, so it erased them:
 * a monitor window would claim its session, this effect would recompute "owned"
 * from the board's (empty) store, and reset the array a frame later. The panel
 * then re-mounted an xterm for a PTY the monitor window was already showing.
 * Two xterms on one PTY each fit to their own width and each call
 * `sessions.resize`, so the PTY ends up sized for whichever fitted last and the
 * agent's TUI repaints at a width the other terminal cannot display - which
 * reads as a frozen, horizontally-overflowing terminal that "fixes itself" the
 * moment you resize the window by hand.
 *
 * The same array also drives the FOCUSED set (rule 1 of `deriveFocusedSessionIds`),
 * so a window whose claim is missing here is a window whose PTY bytes the main
 * process suppresses. One correct claim set fixes both.
 *
 * Why this exists at all (HMR resilience): the window stores survive a Vite Fast
 * Refresh (Pattern E instance pin), but `dialogSessionIds` lives in the session
 * store and is established by each window's per-mount claim
 * (`useTaskSessionState`). That claim only re-fires when a window's `session?.id`
 * changes, so if anything resets `dialogSessionIds` out from under the open
 * windows (a project-switch reset re-triggered by HMR re-syncing `currentProject`,
 * say), the windows do not re-claim and their sessions silently drop out of the
 * focus set. This effect re-derives the claim set from the source of truth (the
 * open windows) whenever it diverges, so such a clobber self-heals.
 *
 * It is the steady-state safety net, NOT the open-time handoff: the synchronous
 * `useLayoutEffect` claim in `useTaskSessionState` still runs first so the bottom
 * panel drops a terminal before the new window mounts it (one xterm per PTY).
 * This effect is additive and only corrects divergence after the fact, so it
 * never causes a two-xterm race at open.
 *
 * Mounted once by `WindowLayer`. It subscribes to the stores imperatively rather
 * than with a selector hook per manager, so the manager list can grow without
 * changing this component's hook order.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { allWindowManagers } from '../store/window-store';
import { isLayerMounted, subscribeLayerMounts } from '../store/layer-mount-registry';

export function useWindowSessionClaims(): void {
  useEffect(() => {
    const reconcile = (): void => {
      const { sessions, dialogSessionIds } = useSessionStore.getState();

      // The live session of each open detail window, resolved by ANCHOR rather
      // than the window's stored `sessionId` (which is captured at open time and
      // goes stale after a respawn). Each manager decodes its own anchor, since
      // the board anchors by taskId and the monitor by `projectId:taskId`.
      const ownedSessionIds: string[] = [];
      for (const manager of allWindowManagers) {
        // A layer whose surface is unmounted has no xterm, whatever its store
        // still remembers - the stores outlive their subtrees on purpose. The
        // monitor's layer lives inside MonitorPage, so it unmounts every time the
        // monitor is closed or detached; counting its windows there would hold the
        // claim forever and permanently starve the bottom panel of that terminal.
        if (!isLayerMounted(manager)) continue;
        const toTaskId = manager.options.anchorToTaskId;
        for (const managedWindow of Object.values(manager.store.getState().windows)) {
          // Only task-detail windows claim a session by anchor. A conversation
          // window's anchor is a session id, and a command terminal's is a slot.
          if (managedWindow.kind !== 'task-detail') continue;
          const taskId = toTaskId ? toTaskId(managedWindow.anchor) : managedWindow.anchor;
          const session = sessions.find((candidate) => candidate.taskId === taskId);
          if (session && !ownedSessionIds.includes(session.id)) ownedSessionIds.push(session.id);
        }
      }

      // `dialogSessionIds` is exactly the window-owned claim set (nothing else
      // writes it), so reconcile it whenever the two diverge. Writing only on
      // divergence is what stops the session-store subscription below from
      // re-entering this reconcile forever.
      const inSync =
        ownedSessionIds.length === dialogSessionIds.length &&
        ownedSessionIds.every((sessionId) => dialogSessionIds.includes(sessionId));
      if (!inSync) useSessionStore.setState({ dialogSessionIds: ownedSessionIds });
    };

    /**
     * The claim-relevant shape of the window layers: which layers are mounted and
     * which task-detail anchors they hold. Deliberately excludes geometry, focus,
     * and z-order, none of which can change which session is claimed.
     *
     * O(windows), and no `sessions` scan - that is the whole point of computing it
     * before deciding whether to reconcile. Anchors are ids (a task uuid, or
     * `projectId:taskId`) and prefixes are fixed literals, so neither can contain
     * the delimiters.
     */
    const windowSetFingerprint = (): string => {
      const parts: string[] = [];
      for (const manager of allWindowManagers) {
        if (!isLayerMounted(manager)) continue;
        parts.push(manager.options.idPrefix);
        for (const managedWindow of Object.values(manager.store.getState().windows)) {
          if (managedWindow.kind !== 'task-detail') continue;
          parts.push(managedWindow.anchor);
        }
      }
      return parts.join('|');
    };

    let lastWindowFingerprint = windowSetFingerprint();

    /**
     * A window store fires on every committed frame of a drag or resize, and
     * geometry never changes the claim set, so an ungated reconcile ran the full
     * cross-layer O(windows x sessions) scan on the pointer-move thread. Bail on an
     * unchanged fingerprint instead - the same derive-then-compare gate
     * `useDetailOwnershipSync` uses for its own window-store subscription.
     */
    const reconcileOnWindowChange = (): void => {
      const fingerprint = windowSetFingerprint();
      if (fingerprint === lastWindowFingerprint) return;
      lastWindowFingerprint = fingerprint;
      reconcile();
    };

    reconcile();
    const unsubscribes = allWindowManagers.map((manager) =>
      manager.store.subscribe(reconcileOnWindowChange),
    );
    /**
     * Only `sessions` (which session a window's anchor resolves to) and
     * `dialogSessionIds` (the value being reconciled, and the thing this effect
     * exists to self-heal) can change the answer. Every high-frequency session
     * write - usage reports, activity states, telemetry events, first output -
     * lands on a sibling record map and leaves both identities alone, so without
     * this gate the full scan ran several times a second per running agent.
     */
    unsubscribes.push(
      useSessionStore.subscribe((state, previous) => {
        if (
          state.sessions === previous.sessions &&
          state.dialogSessionIds === previous.dialogSessionIds
        ) {
          return;
        }
        reconcile();
      }),
    );
    // A layer mounting or unmounting changes the claim set without changing any
    // store, so it needs its own trigger. It also moves the fingerprint, so
    // rebaseline here or the next window-store event replays this reconcile.
    unsubscribes.push(subscribeLayerMounts(() => {
      lastWindowFingerprint = windowSetFingerprint();
      reconcile();
    }));
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  }, []);
}

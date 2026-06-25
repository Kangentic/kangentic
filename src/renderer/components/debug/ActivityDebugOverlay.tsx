import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bug, GripVertical, X, Loader2, Mail, Lock, Wrench, Users, Terminal, RotateCw } from 'lucide-react';
import type { ActivityStatsSnapshot, ActivityReason, ActivityState } from '../../../shared/types';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useBoardStore } from '../../stores/board-store';
import { useToastStore } from '../../stores/toast-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { ActivityTimeline } from './ActivityTimeline';

const POLL_INTERVAL_MS = 2_000;

/**
 * Module-scoped position cache. Survives close+reopen within the same
 * JS context (HMR included) so the user does not have to re-drag on
 * every Ctrl+Shift+D toggle. `null` until the user drags - on first
 * open the overlay defaults to a centered position. Resets only on
 * full page reload.
 *
 * Only the drag-end handler writes to this. The window-resize clamp
 * deliberately does NOT persist here so a clamp from a centered start
 * is not mistaken for a user-set position on the next mount.
 */
let cachedPosition: OverlayPosition | null = null;

/**
 * Floating panel showing live activity-engine state for each running
 * session in the current project. Gated by the
 * `developer.activityDebugOverlay` global setting (Developer settings
 * tab, below the shared-settings separator). Reads `globalConfig` so a
 * per-project override cannot accidentally toggle it. Polls
 * `getActivityStats` every 2 seconds while mounted.
 *
 * The outer component always mounts so the keyboard shortcut listener
 * stays installed regardless of whether the panel is currently visible.
 * Inner content is only rendered when the toggle is on.
 */
export function ActivityDebugOverlay() {
  const overlayEnabled = useConfigStore((state) => {
    const developerConfig = state.globalConfig.developer ?? {};
    return developerConfig.activityDebugOverlay === true;
  });
  const updateConfig = useConfigStore((state) => state.updateConfig);

  // Default Ctrl/Cmd+Shift+D toggles the overlay (combo from the central
  // keybinding registry). Power-user-only, not exposed in any in-app UI besides
  // the Developer settings. Truly global: no INPUT/TEXTAREA target filter (would
  // block the shortcut whenever xterm's hidden textarea has focus, which is the
  // common case while a task detail dialog is open). The listener stays
  // installed regardless of whether the panel is visible.
  useKeybinding('debug.toggleOverlay', () => {
    const next = !overlayEnabled;
    void updateConfig({ developer: { activityDebugOverlay: next } });
    useToastStore.getState().addToast({
      message: next ? 'Activity engine debug overlay enabled' : 'Activity engine debug overlay disabled',
      variant: 'info',
    });
  });

  if (!overlayEnabled) return null;
  return <ActivityDebugOverlayContent />;
}

/** Persisted across HMR + close+reopen so the overlay stays where the user dragged it. */
interface OverlayPosition {
  /** Left edge in px from window left. */
  left: number;
  /** Top edge in px from window top. */
  top: number;
}

/** Estimated panel height for initial centering. Real height is dynamic;
 *  this only affects the default landing spot. */
const PANEL_ESTIMATED_HEIGHT_PX = 300;

/** Grid layout knobs. The overlay grows to fit a balanced grid of
 *  per-session snapshots: 1×1, 1×2, 2×2, 2×3, 3×3, then engages a
 *  scrollbar past 9 sessions. Width is recomputed each render from
 *  the current snapshot count. */
const MAX_COLS = 3;
const COL_WIDTH_PX = 360;
const GAP_PX = 12;
const PANEL_PADDING_X_PX = 24;
const SCROLL_THRESHOLD_SESSIONS = 10;

interface GridLayout {
  cols: number;
  widthPx: number;
}

export function computeGridLayout(sessionCount: number): GridLayout {
  if (sessionCount <= 1) {
    return { cols: 1, widthPx: COL_WIDTH_PX + PANEL_PADDING_X_PX };
  }
  const cols = Math.min(Math.ceil(Math.sqrt(sessionCount)), MAX_COLS);
  const widthPx = COL_WIDTH_PX * cols + GAP_PX * (cols - 1) + PANEL_PADDING_X_PX;
  return { cols, widthPx };
}

/**
 * Compute the default position when the overlay opens with no cached
 * position. Centers the panel on the viewport so the user sees it
 * immediately on enabling debug mode; subsequent drags persist via
 * `cachedPosition`.
 */
function computeCenteredPosition(panelWidthPx: number, panelHeightPx: number = PANEL_ESTIMATED_HEIGHT_PX): OverlayPosition {
  const left = Math.max(20, (window.innerWidth - panelWidthPx) / 2);
  const top = Math.max(20, (window.innerHeight - panelHeightPx) / 2);
  return { left, top };
}

/**
 * Field-by-field comparison of two activity reasons. Used by the
 * structural-sharing pass in the poll loop so React.memo on the
 * status pill / snapshot row sees a stable reference when the engine
 * state genuinely hasn't changed between polls.
 */
export function reasonsEqual(a: ActivityReason, b: ActivityReason): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'tool': {
      const other = b as Extract<ActivityReason, { kind: 'tool' }>;
      return a.pendingCount === other.pendingCount && a.currentTool === other.currentTool;
    }
    case 'subagent': {
      const other = b as Extract<ActivityReason, { kind: 'subagent' }>;
      return a.depth === other.depth;
    }
    case 'background-shell': {
      const other = b as Extract<ActivityReason, { kind: 'background-shell' }>;
      if (a.count !== other.count) return false;
      if (a.ids.length !== other.ids.length) return false;
      for (let index = 0; index < a.ids.length; index++) {
        if (a.ids[index] !== other.ids[index]) return false;
      }
      return true;
    }
    case 'turn-active':
    case 'idle':
    case 'permission':
      return true;
  }
}

/**
 * Structural-equality check used to preserve snapshot identity across
 * polls. The IPC layer always returns fresh objects, which would defeat
 * React.memo on every child. By holding the prior snapshot in a ref
 * and reusing it when content matches, we keep `prev === next` for
 * memoized components and React bails out the subtree without doing
 * any reconciliation work.
 *
 * The recentTransitions array is treated as a ring buffer of immutable
 * records: a length change OR a different last-entry signature means
 * the timeline shifted. Middle entries can never mutate in place.
 */
export function snapshotsContentEqual(a: ActivityStatsSnapshot, b: ActivityStatsSnapshot): boolean {
  if (a === b) return true;
  if (a.sessionId !== b.sessionId) return false;
  if (a.activity !== b.activity) return false;
  if (a.pendingToolCount !== b.pendingToolCount) return false;
  if (a.subagentDepth !== b.subagentDepth) return false;
  if (a.anonymousBackgroundShellCount !== b.anonymousBackgroundShellCount) return false;
  if (a.turnActive !== b.turnActive) return false;
  if (a.permissionPending !== b.permissionPending) return false;
  if (a.pendingIdleArmed !== b.pendingIdleArmed) return false;
  if (a.backgroundShellIds.length !== b.backgroundShellIds.length) return false;
  for (let index = 0; index < a.backgroundShellIds.length; index++) {
    if (a.backgroundShellIds[index] !== b.backgroundShellIds[index]) return false;
  }
  if (!reasonsEqual(a.reason, b.reason)) return false;
  if (a.recentTransitions.length !== b.recentTransitions.length) return false;
  const lastA = a.recentTransitions[a.recentTransitions.length - 1];
  const lastB = b.recentTransitions[b.recentTransitions.length - 1];
  if ((lastA?.ts ?? 0) !== (lastB?.ts ?? 0)) return false;
  if ((lastA?.trigger ?? '') !== (lastB?.trigger ?? '')) return false;
  return true;
}

function ActivityDebugOverlayContent() {
  const sessions = useSessionStore((state) => state.sessions);
  // Stable, comma-joined key of every transient (Command Terminal) session id, so
  // the label memo only recomputes when the set changes.
  const transientSessionIdsKey = useSessionStore((state) =>
    Object.values(state.transientSessions).map((entry) => entry.sessionId).sort().join(','),
  );
  const tasks = useBoardStore((state) => state.tasks);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  // The poll loop subscribes to a STABLE list of sessionIds. If we
  // depended on `sessions.filter(...)` directly, the filter result is
  // a new array every render and the effect would tear down + re-arm
  // the interval on every parent re-render (including the re-render
  // triggered by setSnapshots inside the poll itself). Memo + array-
  // identity-by-id-string flattens that into a stable dep.
  const projectSessionIds = useMemo(() => {
    return sessions
      .filter((session) => session.projectId === currentProjectId && session.status === 'running')
      .map((session) => session.id);
  }, [sessions, currentProjectId]);
  const projectSessionIdsKey = projectSessionIds.join(',');

  // Resolve a friendly label per session: "Command Terminal" for the
  // transient session, the task title for task-bound sessions, falling
  // back to the short session id.
  const sessionLabels = useMemo(() => {
    const transientIds = new Set(transientSessionIdsKey ? transientSessionIdsKey.split(',') : []);
    const labels = new Map<string, string>();
    for (const session of sessions) {
      if (transientIds.has(session.id)) {
        labels.set(session.id, 'Command Terminal');
        continue;
      }
      const task = session.taskId ? tasks.find((t) => t.id === session.taskId) : null;
      labels.set(session.id, task?.title ?? session.id.slice(0, 8));
    }
    return labels;
  }, [sessions, tasks, transientSessionIdsKey]);

  const [snapshots, setSnapshots] = useState<ActivityStatsSnapshot[]>([]);
  // Wall-clock anchor captured at the start of each poll tick and
  // prop-drilled to children that need a "now" value (timeline window,
  // activity-log ages, header wall-clock readout). Stable between
  // polls so the timeline's `useMemo` caches actually hit on off-cycle
  // re-renders triggered by `sessionEvents` updates or other store
  // subscriptions. Updated every 2 s alongside `setSnapshots`.
  const [pollNow, setPollNow] = useState<number>(() => Date.now());
  // Cache prior snapshot references keyed by sessionId. Each poll
  // checks structural equality against the cache and reuses the prior
  // reference when content matches, so memoized children short-circuit
  // via shallow `prev === next` comparison.
  const previousSnapshotsRef = useRef<Map<string, ActivityStatsSnapshot>>(new Map());
  // Tracks whether the snapshot poll has run at least once for the current
  // project session set. Without this guard the DesyncDiagnostic would
  // briefly flash on every overlay open / projectSessionIds change because
  // `snapshots` defaults to `[]` and the first poll's IPC roundtrip is
  // async. The diagnostic message is alarming ("engine has no state for N
  // sessions") and would be wrong during the loading window.
  const [firstPollComplete, setFirstPollComplete] = useState(false);

  // Grid layout grows with the running snapshot count. When fewer than
  // one snapshot is rendered (loading or desync states) we still want a
  // sensible single-column width so those copy-heavy fallbacks read
  // naturally.
  const gridLayout = useMemo(
    () => computeGridLayout(Math.max(snapshots.length, 1)),
    [snapshots.length],
  );

  // Drag-to-reposition. The panel is always pixel-positioned: on first
  // open it lands centered on the viewport; subsequent drags update
  // both the React state and the module-scoped `cachedPosition` so
  // close+reopen restores the last dragged spot.
  //
  // Lag-free recipe (Windows can fire pointermove at 1000Hz):
  //   1. Position lives in a ref. The drag handler writes DOM-direct
  //      via panel.style.left/top so pointermove does NOT trigger
  //      React re-renders.
  //   2. Snapshot polling is paused while a drag is active so the
  //      overlay's content does not re-render mid-drag. A render
  //      mid-drag would re-apply stale `style={{ left, top }}` from
  //      React state and snap the panel back.
  //   3. Panel dimensions are captured once on pointer-down. Reading
  //      offsetWidth/offsetHeight on every move would force a layout
  //      reflow per pointermove tick.
  //   4. State is committed once on pointer-up. After the commit, the
  //      next poll re-renders with the current position and the next
  //      drag starts fresh.
  // Position starts as `null` until the layout effect below has
  // measured the panel and confirmed `window.innerWidth > 0`. Doing
  // the centering math in a `useState` lazy initializer used to read
  // `window.innerWidth` during Electron's startup window when the
  // outer BrowserWindow is still zero-sized; `computeCenteredPosition`
  // would floor to its (20, 20) minimum and the panel would mount in
  // the top-left corner where it stayed until the user dragged it.
  // Driving the first commit from a layout effect that bails until
  // dimensions are real eliminates that path.
  const [position, setPosition] = useState<OverlayPosition | null>(() => cachedPosition);
  // True once the panel has been positioned for the current mount.
  // When false the panel renders with `visibility: hidden` so the
  // user never sees a flash at the className-anchored top-left
  // position before the transform commits. Starts true only if a
  // cached drag position exists (we trust that immediately).
  const [isPositioned, setIsPositioned] = useState<boolean>(cachedPosition !== null);
  const positionRef = useRef<OverlayPosition | null>(position);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    panelWidth: number;
    panelHeight: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Fires the moment the panel attaches to the DOM. Earlier we relied
  // on a `useLayoutEffect` keyed on `[isPositioned, hasOverlayContent]`
  // to detect the contentless-to-content transition, but the deps
  // didn't actually change in the bug path: on the contentless mount
  // the effect bailed (panelRef.current was null because the JSX
  // returned null), `isPositioned` stayed `false`, and when content
  // arrived `hasOverlayContent` flipped true so the effect re-ran -
  // EXCEPT auto-spawn flows can race the effect's measurement.
  // Driving centering from the ref callback removes the indirection:
  // the moment React attaches the DOM node we have a real rect, and
  // we commit the centered position in the same synchronous flush.
  const isPositionedRef = useRef(isPositioned);
  isPositionedRef.current = isPositioned;
  const handlePanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (node === null) {
      // Panel unmounted (component returned null because all sessions
      // ended). Reset positioning state so the NEXT mount re-centers
      // against current window/panel dimensions rather than reusing
      // a position that was computed against a possibly-different
      // panel size or window state.
      isPositionedRef.current = false;
      setIsPositioned(false);
      setPosition(null);
      return;
    }
    if (isPositionedRef.current) return;
    if (window.innerWidth === 0 || window.innerHeight === 0) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    isPositionedRef.current = true;
    setPosition(computeCenteredPosition(rect.width, rect.height));
    setIsPositioned(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Reset the loading guard when the session set changes so the user
    // doesn't see the diagnostic briefly carry over from a different set.
    setFirstPollComplete(false);
    const idsAtMount = projectSessionIdsKey.length === 0 ? [] : projectSessionIdsKey.split(',');
    const poll = async () => {
      // Skip mid-drag: a setSnapshots while dragging would re-render
      // the panel and re-apply stale `style.left/top` from state,
      // causing visual snap-back until the next pointermove fixes it.
      if (dragRef.current !== null) return;
      const results: ActivityStatsSnapshot[] = [];
      const nextCache = new Map<string, ActivityStatsSnapshot>();
      const previousCache = previousSnapshotsRef.current;
      for (const sessionId of idsAtMount) {
        try {
          const snapshot = await window.electronAPI.sessions.getActivityStats(sessionId);
          if (snapshot) {
            // Structural sharing: reuse the prior reference when nothing
            // user-visible changed. This is what makes React.memo on the
            // row components actually short-circuit; without it, every
            // poll would produce a new object reference and force a full
            // re-render of every session row even when their state was
            // unchanged.
            const previousSnapshot = previousCache.get(sessionId);
            const stableSnapshot =
              previousSnapshot && snapshotsContentEqual(previousSnapshot, snapshot)
                ? previousSnapshot
                : snapshot;
            results.push(stableSnapshot);
            nextCache.set(sessionId, stableSnapshot);
          }
        } catch {
          // Ignore probe failures - the overlay is best-effort.
        }
      }
      if (!cancelled) {
        previousSnapshotsRef.current = nextCache;
        // Capture one canonical wall clock per poll tick so all
        // children share the same "now" anchor. Updating this every
        // tick (rather than only when snapshots change) is intentional:
        // the timeline's now-marker, gridlines, and the captured-at
        // readout must advance with real time even on idle sessions.
        setPollNow(Date.now());
        setSnapshots((prev) => {
          // If every per-session reference matches the prior state,
          // bail out of the setState entirely so React skips the
          // render cycle. With structural sharing in place this is the
          // common case during steady-state.
          if (prev.length === results.length) {
            let allMatch = true;
            for (let index = 0; index < results.length; index++) {
              if (prev[index] !== results[index]) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) return prev;
          }
          return results;
        });
        setFirstPollComplete(true);
      }
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectSessionIdsKey]);

  // Sync positionRef with state ONLY when not actively dragging. During
  // a drag the ref holds the live cursor position and must not be
  // overwritten by stale committed state if React re-renders.
  if (dragRef.current === null) {
    positionRef.current = position;
  }

  // GPU-accelerated transform-only positioning: `translate3d()` only
  // triggers Composite, never Layout or Paint, which is what makes a
  // drag feel buttery at 60-144 fps. Writing to `left`/`top` would
  // trigger a layout reflow on every move (even DOM-direct).
  const applyPositionToDom = useCallback((left: number, top: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }, []);

  // Apply position via a layout effect rather than inline `style` in
  // JSX. Critical for smoothness: this component subscribes to several
  // Zustand stores (sessions, tasks, project, config) which re-render
  // it frequently during an active session. If `style={{ transform }}`
  // were inline in JSX, every store update would race the DOM-direct
  // writes from the drag handler - the React re-render would re-apply
  // a stale transform, then the next pointermove would correct it.
  // Using useLayoutEffect with `position` as the only dep means the
  // transform write only happens on commit-to-state events: initial
  // mount and pointer-up. During a drag the ref+rAF path owns the DOM
  // uncontested.
  useLayoutEffect(() => {
    if (position === null) return;
    applyPositionToDom(position.left, position.top);
  }, [position, applyPositionToDom]);

  // Backstop for the Electron-startup edge case: the panel ref
  // callback bails when `window.innerWidth === 0` (BrowserWindow
  // hasn't finished its initial layout yet). The first resize fires
  // when dimensions become real, and this listener does the same
  // measure-then-center the ref callback would have done.
  useEffect(() => {
    if (isPositioned) return;
    const tryCenter = () => {
      // Re-check the ref each call: a resize landing between the
      // first successful `tryCenter` and React's re-render would
      // otherwise re-run the measure-and-setState path with the same
      // result. The ref is the freshest source - the closure's
      // `isPositioned` is the value captured when the effect ran.
      if (isPositionedRef.current) return false;
      if (window.innerWidth === 0 || window.innerHeight === 0) return false;
      const panel = panelRef.current;
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      isPositionedRef.current = true;
      setPosition(computeCenteredPosition(rect.width, rect.height));
      setIsPositioned(true);
      return true;
    };
    if (tryCenter()) return;
    const onResize = () => { tryCenter(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isPositioned]);

  // rAF coalescing: pointermove can fire at 1000Hz on Windows, but we
  // only paint at the display refresh rate (60-144 fps). Storing the
  // latest x/y in a ref and flushing once per frame eliminates
  // redundant style writes and lets the browser composite at frame
  // rate. Pending-frame ref tracks whether a flush is queued.
  const pendingFrameRef = useRef<number | null>(null);
  const flushPendingPosition = useCallback(() => {
    pendingFrameRef.current = null;
    const current = positionRef.current;
    if (!current) return;
    applyPositionToDom(current.left, current.top);
  }, [applyPositionToDom]);

  // Track the currently-active native pointer listeners so unmount
  // cleanup can remove them. Without this, toggling the overlay off
  // (Ctrl+Shift+D, project switch, etc.) MID-DRAG would leak window
  // listeners until the next pointer-up - and a later pointer-up for
  // an unrelated drag could match the captured pointerId.
  const activeDragListenersRef = useRef<{
    onMove: (event: PointerEvent) => void;
    onUp: (event: PointerEvent) => void;
  } | null>(null);

  useEffect(() => {
    return () => {
      const listeners = activeDragListenersRef.current;
      if (listeners) {
        window.removeEventListener('pointermove', listeners.onMove);
        window.removeEventListener('pointerup', listeners.onUp);
        window.removeEventListener('pointercancel', listeners.onUp);
        activeDragListenersRef.current = null;
      }
      if (pendingFrameRef.current !== null) {
        cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
      dragRef.current = null;
    };
  }, []);

  // Native pointermove/pointerup listeners attached on pointer-down.
  // Bypasses React's synthetic event system (cheaper per-event) and
  // uses pointer capture so the move stream stays on the panel even
  // if the cursor leaves the header.
  const onHeaderPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-overlay-button]')) return;
    const rect = panel.getBoundingClientRect();
    const dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      // Cache panel dimensions once: reading offsetWidth/offsetHeight
      // per move would force a layout reflow on every pointermove tick.
      // Width is also dynamic now (grid grows with session count) so we
      // measure it instead of relying on a fixed constant.
      panelWidth: rect.width,
      panelHeight: rect.height,
    };
    dragRef.current = dragState;
    // Anchor at the current spot before any move arrives so the panel
    // doesn't jump.
    applyPositionToDom(rect.left, rect.top);
    positionRef.current = { left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();

    // Native handlers: lighter per-event than React synthetic events.
    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== moveEvent.pointerId) return;
      const maxLeft = window.innerWidth - drag.panelWidth;
      const maxTop = window.innerHeight - drag.panelHeight;
      const left = Math.max(0, Math.min(maxLeft, moveEvent.clientX - drag.offsetX));
      const top = Math.max(0, Math.min(maxTop, moveEvent.clientY - drag.offsetY));
      positionRef.current = { left, top };
      // Coalesce writes into one per animation frame.
      if (pendingFrameRef.current === null) {
        pendingFrameRef.current = requestAnimationFrame(flushPendingPosition);
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      if (dragRef.current?.pointerId !== upEvent.pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      activeDragListenersRef.current = null;
      if (pendingFrameRef.current !== null) {
        cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
        // Apply the latest position synchronously so the final paint
        // matches positionRef.current before React's re-render.
        flushPendingPosition();
      }
      dragRef.current = null;
      // Commit final position to React state so future re-renders
      // produce DOM matching the current visual position. Mirror to
      // the module-scoped cache so close+reopen restores the same spot.
      const final = positionRef.current;
      setPosition(final);
      cachedPosition = final;
    };
    activeDragListenersRef.current = { onMove, onUp };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [applyPositionToDom, flushPendingPosition]);

  // Re-clamp the cached position when the grid grows (e.g. snapshots
  // jump from 1 to 4 and the panel widens). Without this, a panel
  // dragged near the right or bottom edge can drift off-screen on the
  // next render. Layout effect rather than effect: avoids a 1-frame
  // flash where the panel paints partially off-screen at the old
  // position before the clamp commits a corrected one. Safe to read
  // height here because layout has already run for the new width.
  // Skipped during an active drag because the poll-driven snapshot
  // updates are paused mid-drag, so `gridLayout.widthPx` cannot change
  // while `dragRef.current` is set.
  useLayoutEffect(() => {
    const panelHeight = panelRef.current?.getBoundingClientRect().height ?? PANEL_ESTIMATED_HEIGHT_PX;
    const maxLeft = Math.max(0, window.innerWidth - gridLayout.widthPx);
    const maxTop = Math.max(0, window.innerHeight - panelHeight);
    setPosition((prev) => {
      // Pre-positioning state: nothing to clamp yet. The first-mount
      // centering effect will commit a position that is already
      // bounded against the current window dimensions.
      if (prev === null) return prev;
      const clampedLeft = Math.min(prev.left, maxLeft);
      const clampedTop = Math.min(prev.top, maxTop);
      if (clampedLeft === prev.left && clampedTop === prev.top) return prev;
      // Do not persist clamp results to cachedPosition. cachedPosition
      // is reserved for explicit drag-end commits so the next mount can
      // distinguish "user has placed this" from "system clamped a
      // centered default" - the former should be respected, the latter
      // should be re-centered against real dimensions on reopen.
      return { left: clampedLeft, top: clampedTop };
    });
  }, [gridLayout.widthPx]);

  const handleClose = useCallback(() => {
    void updateConfig({ developer: { activityDebugOverlay: false } });
  }, [updateConfig]);

  if (snapshots.length === 0 && projectSessionIds.length === 0) return null;

  return (
    <div
      ref={handlePanelRef}
      className="fixed top-0 left-0 z-50 bg-surface-raised border border-edge rounded-md shadow-lg text-xs select-none"
      style={{
        // Width is dynamic: the overlay grows with the running session
        // count to fit a balanced grid (1×1, 1×2, 2×2, 2×3, 3×3) up to
        // MAX_COLS, then engages a scrollbar past SCROLL_THRESHOLD.
        width: gridLayout.widthPx,
        // Transform is applied via useLayoutEffect, not here. Putting
        // it in JSX would race with the DOM-direct writes from the
        // drag handler whenever a parent re-render fires.
        // - willChange: hints the browser to keep this on its own
        //   composite layer (GPU) so transform changes never fall back
        //   to CPU paint.
        // - touchAction:'none': prevents browser from swallowing the
        //   pointer stream for native scroll/pan, which would stutter
        //   the drag on touch devices.
        // - visibility: kept hidden until the centering layout effect
        //   has measured the real panel and committed a centered
        //   transform. Without this gate, the className anchors the
        //   panel at top-0 left-0 for one paint before the transform
        //   commits - that is the "tucked into the top-left corner"
        //   flash users were seeing on first launch.
        willChange: 'transform',
        touchAction: 'none',
        visibility: isPositioned ? 'visible' : 'hidden',
      }}
      data-testid="activity-debug-overlay"
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-edge cursor-grab active:cursor-grabbing"
        onPointerDown={onHeaderPointerDown}
        title="Drag to reposition"
      >
        <GripVertical size={12} className="text-fg-disabled shrink-0" />
        <div className="flex items-center gap-1.5 text-fg-faint flex-1 min-w-0">
          <Bug size={12} />
          <span className="font-medium">Activity Engine Debugger</span>
          {/* Wall-clock timestamp for the most recent poll. Critical
              when a screenshot is shared with an agent or pasted into
              a bug report - the rest of the overlay uses now-relative
              timestamps that lose meaning the moment the image
              leaves the live session. The captured-at line anchors
              every other timestamp in absolute time so a recipient
              can reason about whether a "1.4s since signal" reading
              was hours old or fresh. */}
          <CapturedAt pollNow={pollNow} />
        </div>
        <button
          type="button"
          data-overlay-button
          onClick={handleClose}
          className="text-fg-faint hover:text-fg-tertiary"
          title="Close (Ctrl+Shift+D)"
        >
          <X size={12} />
        </button>
      </div>
      <div
        className={`p-3 overflow-auto ${
          snapshots.length >= SCROLL_THRESHOLD_SESSIONS ? 'max-h-96' : 'max-h-[80vh]'
        }`}
      >
        {!firstPollComplete ? (
          <div className="flex items-center gap-2 text-fg-faint text-[11px]">
            <Loader2 size={12} className="animate-spin" />
            <span>Loading activity state...</span>
          </div>
        ) : snapshots.length === 0 ? (
          <DesyncDiagnostic
            projectSessionIds={projectSessionIds}
            sessionLabels={sessionLabels}
          />
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, 1fr))` }}
          >
            {snapshots.map((snapshot) => (
              <SnapshotRow
                key={snapshot.sessionId}
                snapshot={snapshot}
                label={sessionLabels.get(snapshot.sessionId) ?? snapshot.sessionId.slice(0, 8)}
                pollNow={pollNow}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Rendered when the renderer believes one or more sessions in the
 * current project are running (`projectSessionIds.length > 0`) but
 * `getActivityStats` returned null for every one of them. That means
 * the activity engine's `states` map has no entry for those sessions,
 * which should be impossible while the registry reports them as
 * running - either the renderer's session list is locally stale (a
 * status flip's push event was missed) or the main-process registry
 * and engine have genuinely drifted.
 *
 * Showing the affected session ids + a Resync button turns the
 * formerly-mute "No running sessions" copy into something the user
 * can act on: clicking Resync re-runs `syncSessions()` and either
 * recovers (renderer cache leak) or confirms the desync survives a
 * fresh fetch (main-side bug to investigate with these specific ids).
 */
function DesyncDiagnostic({
  projectSessionIds,
  sessionLabels,
}: {
  projectSessionIds: string[];
  sessionLabels: Map<string, string>;
}) {
  const [resyncing, setResyncing] = useState(false);
  const handleResync = useCallback(async () => {
    setResyncing(true);
    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      setResyncing(false);
    }
  }, []);
  const sessionWord = projectSessionIds.length === 1 ? 'session' : 'sessions';
  return (
    <div className="space-y-2 text-[11px]">
      <div className="text-fg-secondary">
        Activity engine has no state for {projectSessionIds.length} {sessionWord} the
        renderer believes are running. The renderer cache or the
        registry/engine pair has drifted.
      </div>
      <div className="space-y-1">
        {projectSessionIds.map((sessionId) => (
          <div key={sessionId} className="flex items-center gap-2 min-w-0">
            <span className="font-medium text-fg-secondary truncate" title={sessionId}>
              {sessionLabels.get(sessionId) ?? sessionId.slice(0, 8)}
            </span>
            <span className="font-mono text-fg-disabled shrink-0" title="Session ID prefix">
              {sessionId.slice(0, 8)}
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        data-overlay-button
        onClick={handleResync}
        disabled={resyncing}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-surface-raised border border-edge text-fg-secondary hover:bg-surface-hover disabled:opacity-60"
        title="Re-fetch sessions and activity from the main process"
      >
        <RotateCw size={12} className={resyncing ? 'animate-spin' : ''} />
        <span>{resyncing ? 'Resyncing...' : 'Resync'}</span>
      </button>
    </div>
  );
}

const SnapshotRow = memo(function SnapshotRow({ snapshot, label, pollNow }: { snapshot: ActivityStatsSnapshot; label: string; pollNow: number }) {
  const bgShellCount = snapshot.backgroundShellIds.length + snapshot.anonymousBackgroundShellCount;
  // Subscribe to the per-session event stream for the timeline's event
  // ticks track. Reads from the shared cache populated by the activity
  // log subsystem; cheap because we only re-render when these events
  // change.
  const sessionEvents = useSessionStore((state) => state.sessionEvents[snapshot.sessionId]);
  // Model identifier (e.g. claude-opus-4-7, codex/o4-mini) is the
  // most telegraphed-adapter info available to the renderer. The
  // shared `Session` IPC type doesn't carry adapter name; the model
  // id implicitly identifies the adapter for screenshot diagnosis
  // ("claude-*" → Claude adapter, "codex-*" → Codex, etc.).
  const modelId = useSessionStore((state) => state.sessionUsage[snapshot.sessionId]?.model.id);
  return (
    <div className="space-y-2 min-w-0 border border-edge/50 rounded-md p-2.5 bg-surface/30">
      {/* Title on row 1, status pill on row 2 underneath, always left-aligned.
          Layout stays consistent regardless of title length so long board
          names don't push the pill to a right-floated second line. */}
      <div className="flex items-center gap-2 text-[11px] min-w-0">
        <span className="font-medium text-fg-secondary truncate" title={snapshot.sessionId}>{label}</span>
        <span className="font-mono text-fg-disabled shrink-0" title="Session ID prefix">
          {snapshot.sessionId.slice(0, 8)}
        </span>
        {modelId && (
          <span className="font-mono text-fg-disabled shrink-0 truncate" title="Model id (adapter is implicit from the prefix - claude-* / codex-* / etc.)">
            {modelId}
          </span>
        )}
      </div>
      <StatusRow snapshot={snapshot} />

      {/* Counter grid: full names, hover tooltips explaining each. Non-zero
          counters are emphasized; zeros and "no" flags are dimmed so the
          eye lands on what's actually active. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <CounterRow
          label="Pending tools"
          value={snapshot.pendingToolCount}
          tooltip="Tool calls currently in flight (PreToolUse fired, PostToolUse not yet)"
        />
        <CounterRow
          label="Subagents"
          value={snapshot.subagentDepth}
          tooltip="Active nested Task subagent depth"
        />
        <CounterRow
          label="Background shells"
          value={bgShellCount}
          tooltip="Bash(run_in_background:true) calls plus shells the watcher adopted from the OS process tree"
        />
        <FlagRow
          label="Turn active"
          value={snapshot.turnActive}
          tooltip="True between any thinking-initiating event (Prompt, ToolStart, BackgroundShellStart, etc.) and the next idle event"
        />
        <FlagRow
          label="Permission"
          value={snapshot.permissionPending}
          tooltip="Agent is waiting for the user to approve a tool use"
        />
      </div>

      {/* Recent transitions: timeline of state changes. Each line is one
          transition; the trigger label tells you which event/timer/force
          path caused it. Read top-to-bottom = oldest-to-newest. */}
      {snapshot.recentTransitions.length > 0 && (
        <RecentTransitions snapshot={snapshot} pollNow={pollNow} />
      )}

      {/* Visual timeline + compensation counter strip. Renders the last
          120s as four horizontal tracks: state band, event ticks, PTY
          chunk ticks, and the active timer (watchdog) deadline. Counter
          strip above tallies recovery events for quick glance: all
          zeros = clean session. */}
      <ActivityTimeline snapshot={snapshot} sessionEvents={sessionEvents} pollNow={pollNow} />
    </div>
  );
});

/**
 * Section showing the most recent engine state transitions. Renders
 * the last 5 entries from the ring buffer; the timeline graph
 * underneath (`ActivityTimeline`) provides the longer historical view
 * visually, so the text log stays a tight "what's the agent doing
 * right now" digest. Older entries remain in the engine's 50-entry
 * ring and are accessible via `kangentic_devtools_engine_state` for
 * agents that need exact timestamps.
 *
 * Each row's trigger label gets a hover tooltip explaining the engine
 * path that fired.
 */
const VISIBLE_TRANSITIONS = 5;

const RecentTransitions = memo(function RecentTransitions({ snapshot, pollNow }: { snapshot: ActivityStatsSnapshot; pollNow: number }) {
  const allEntries = snapshot.recentTransitions;
  if (allEntries.length === 0) return null;
  const visibleEntries = allEntries.length > VISIBLE_TRANSITIONS
    ? allEntries.slice(allEntries.length - VISIBLE_TRANSITIONS)
    : allEntries;
  // Anchor timestamps to the parent's poll-time "now" so each row reads
  // as "Xs ago" using the same wall-clock value the timeline chart
  // does. Sharing the anchor (rather than each component calling
  // `Date.now()` independently) keeps the activity-log ages and the
  // chart's gridlines in lockstep - the +1.8s entry sits at exactly
  // the matching x-position on the chart's `-120s … now` axis.
  const now = pollNow;

  return (
    <div className="space-y-1 pt-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider font-medium text-fg-faint">
          Activity log
        </span>
        <span
          className="text-[10px] text-fg-disabled tabular-nums"
          title={`Showing last ${visibleEntries.length} of ${allEntries.length} ring-buffer entries (full history via kangentic_devtools_engine_state)`}
        >
          {visibleEntries.length}/{allEntries.length}
        </span>
      </div>
      <div className="space-y-1">
        {visibleEntries.map((entry, index) => {
          const ageSeconds = Math.max(0, (now - entry.ts) / 1000);
          const ageLabel = ageSeconds < 0.1 ? 'now' : `-${ageSeconds.toFixed(1)}s`;
          const isTransition = entry.from !== entry.to;
          return (
            <div key={`${entry.ts}-${index}`} className="flex items-center gap-2 font-mono text-[11px] min-w-0">
              <span className="text-fg-disabled w-12 shrink-0 tabular-nums">{ageLabel}</span>
              {isTransition ? (
                <span className="flex items-center gap-1 shrink-0">
                  <ActivityChip state={entry.from} />
                  <span className="text-fg-disabled">→</span>
                  <ActivityChip state={entry.to} />
                </span>
              ) : (
                <span className="shrink-0 text-fg-disabled italic" title={`Still in ${entry.to}`}>
                  {entry.to}
                </span>
              )}
              <span
                className="text-fg-faint truncate cursor-help"
                title={triggerExplanation(entry.trigger, entry.reasonKind)}
              >
                {entry.trigger}
              </span>
              {entry.counterDelta && (
                <span className="text-fg-disabled shrink-0 ml-auto" title="Counter changes during this step">
                  {entry.counterDelta}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

/**
 * Module-scoped trigger lookup table. Hoisted out of `triggerExplanation`
 * so it isn't reallocated on every call (the function is invoked per
 * activity-log row per render, so the table would otherwise churn ~50
 * objects per second under the 2s poll cadence).
 */
const TRIGGER_EXACT_EXPLANATIONS: Record<string, string> = {
  'force-thinking': 'PTY tracker / heartbeat recovery / external caller forced the session into thinking',
  'force-idle': 'PTY silence timeout / shutdown / external caller forced idle and reset all counters',
  'interrupted': 'User pressed Esc - all counters reset and session forced to idle',
  'timer:stability': 'The 400ms idle stability window expired and the queued idle commit fired',
  'timer:stale-thinking': 'The 180s stale-thinking watchdog forced idle (turn was active but no other counters held it)',
  'timer:bg-shell-hatch': 'The 5-min orphan-bg-shell escape hatch fired (only bg shells were holding thinking, no signals received)',
  'event:bg-shells-adopted': 'Watcher saw shell-like processes the hooks did not fire for and adopted them as anonymous bg shells',
};

/**
 * Plain-language explanation of a transition trigger. Surfaces the
 * trigger vocabulary without requiring the reader to grep the engine
 * source. Falls back to a generic prefix-based hint for unknown
 * triggers.
 */
export function triggerExplanation(trigger: string, reasonKind: ActivityReason['kind']): string {
  const reasonHint = `Reason at commit: ${reasonKind}`;

  if (trigger in TRIGGER_EXACT_EXPLANATIONS) return `${TRIGGER_EXACT_EXPLANATIONS[trigger]}. ${reasonHint}`;

  // Pattern-match for parameterized triggers.
  if (trigger.startsWith('event:bg-shell-ended:')) {
    return `Background shell ended. ${reasonHint}`;
  }
  if (trigger.startsWith('event:idle:')) {
    const detail = trigger.split(':')[2];
    return `Idle event with detail "${detail}" - usually a permission prompt or PTY-driven idle. ${reasonHint}`;
  }
  if (trigger.startsWith('event:')) {
    const eventType = trigger.slice('event:'.length);
    return `Hook event "${eventType}" was processed. ${reasonHint}`;
  }
  if (trigger.startsWith('timer:')) {
    return `Engine timer fired. ${reasonHint}`;
  }

  return `Trigger: ${trigger}. ${reasonHint}`;
}

/**
 * Single source of truth for the engine's current state. One pill
 * combines:
 *   - the activity state (thinking/idle/permission, communicated by
 *     the pill's color)
 *   - the reason WHY (communicated by the icon and the trailing text)
 *
 * Replaces the previous `ActivityBadge + ReasonCallout` pair, which
 * duplicated the state in two places.
 */
/**
 * Live wall-clock readout in the overlay header. Refreshes once per
 * second so the displayed time stays close to "now" without spinning
 * the rAF clock. The whole point of this readout is anchoring shared
 * screenshots in absolute time - precision below a second adds noise
 * without value, since the rest of the overlay's timestamps round to
 * 0.1s anyway.
 */
/**
 * Format a Date as HH:MM:SS (24-hour, zero-padded). Pure function so
 * tests can pass an arbitrary Date without touching `Date.now()`.
 */
export function formatHHMMSS(date: Date): string {
  return (
    `${String(date.getHours()).padStart(2, '0')}:`
    + `${String(date.getMinutes()).padStart(2, '0')}:`
    + `${String(date.getSeconds()).padStart(2, '0')}`
  );
}

function CapturedAt({ pollNow }: { pollNow: number }) {
  const formatted = formatHHMMSS(new Date(pollNow));
  return (
    <span
      className="font-mono text-[10px] text-fg-disabled tabular-nums shrink-0 ml-auto pr-1"
      title="Wall-clock time at the most recent poll. Anchors the now-relative timestamps elsewhere in the overlay so a screenshot stays interpretable when shared."
    >
      {formatted}
    </span>
  );
}

const StatusRow = memo(function StatusRow({ snapshot }: { snapshot: ActivityStatsSnapshot }) {
  const presentation = statusPresentation(snapshot);
  const { Icon, iconClass, pillClasses, label } = presentation;
  // The engine's "is the agent alive" metric. Critical for diagnosis:
  // a thinking session at "178s since signal" is one tick away from a
  // stale-thinking watchdog fire; an idle session at "60s since signal"
  // has been quiet for a minute. Surfacing this inline next to the pill
  // means a screenshot of the overlay carries the answer to "how long
  // ago did anything actually happen" without needing a separate query.
  const signalLabel = formatSignalAge(snapshot.msSinceLastSignal);
  // The stuck-pending-tools watchdog uses the FRESHER of lastSignalAt and
  // lastPtyOutputAt, so a long quiet test run streaming PTY output is not
  // force-idled. Surface PTY age too, so a screenshot shows why a session
  // with a stale signal is still (correctly) thinking.
  const ptyLabel = formatPtyAge(snapshot.msSincePtyOutput);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium ${pillClasses}`}>
        <Icon size={12} className={`shrink-0 ${iconClass}`} />
        <span className="truncate">{label}</span>
      </div>
      {signalLabel && (
        <span
          className="text-[11px] font-mono text-fg-disabled tabular-nums truncate"
          title="Wall-clock time since the engine last received an activity-proving signal (events.jsonl, status.json heartbeat). Watchdog deadlines fire `lastSignalAt + thresholdMs`."
        >
          {signalLabel}
        </span>
      )}
      {ptyLabel && (
        <span
          className="text-[11px] font-mono text-fg-disabled tabular-nums truncate"
          title="Wall-clock time since the last PTY output chunk. The stuck-pending-tools watchdog uses the fresher of this and the signal age, so a streaming foreground tool is not force-idled."
        >
          {ptyLabel}
        </span>
      )}
    </div>
  );
});

/**
 * Format `msSinceLastSignal` as a compact human-readable age. Returns
 * null when no signal has arrived yet for this session - avoid
 * surfacing a meaningless "0.0s" placeholder.
 */
export function formatSignalAge(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms}ms since signal`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s since signal`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(1)}m since signal`;
}

/**
 * Format `msSincePtyOutput` as a compact human-readable age. Returns null
 * when no PTY chunk has arrived yet (avoid a meaningless "0.0s" placeholder).
 */
export function formatPtyAge(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms}ms since pty`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s since pty`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(1)}m since pty`;
}

function statusPresentation(snapshot: ActivityStatsSnapshot): {
  Icon: typeof Wrench;
  iconClass: string;
  pillClasses: string;
  label: string;
} {
  // Permission overrides everything - it's its own top-level state.
  if (snapshot.activity === 'permission') {
    return {
      Icon: Lock,
      iconClass: 'text-amber-400',
      pillClasses: 'bg-amber-500/15 text-amber-200 border border-amber-500/25',
      label: 'Awaiting permission',
    };
  }
  if (snapshot.activity === 'idle') {
    return {
      Icon: Mail,
      iconClass: 'text-fg-faint',
      pillClasses: 'bg-fg-faint/10 text-fg-secondary border border-fg-faint/20',
      label: 'Idle',
    };
  }
  // Thinking - icon and trailing text reflect the dominant reason.
  const reason = snapshot.reason;
  const pill = 'bg-green-500/15 text-green-100 border border-green-500/25';
  switch (reason.kind) {
    case 'tool':
      return {
        Icon: Wrench,
        iconClass: 'text-blue-300',
        pillClasses: pill,
        label: reason.currentTool
          ? `Thinking · running ${reason.currentTool}`
          : `Thinking · ${reason.pendingCount} tool${reason.pendingCount === 1 ? '' : 's'} in flight`,
      };
    case 'subagent':
      return {
        Icon: Users,
        iconClass: 'text-purple-300',
        pillClasses: pill,
        label: `Thinking · ${reason.depth} subagent${reason.depth === 1 ? '' : 's'}`,
      };
    case 'background-shell': {
      const idsHint = reason.ids.length > 0 ? ` (${reason.ids.join(', ')})` : '';
      return {
        Icon: Terminal,
        iconClass: 'text-emerald-300',
        pillClasses: pill,
        label: `Thinking · ${reason.count} background shell${reason.count === 1 ? '' : 's'}${idsHint}`,
      };
    }
    case 'turn-active':
      return {
        Icon: Loader2,
        iconClass: 'text-green-300 animate-spin',
        pillClasses: pill,
        label: 'Thinking · turn active',
      };
    // These two shouldn't reach here in practice - thinking implies a
    // non-idle/non-permission reason - but TypeScript needs them.
    case 'idle':
      return {
        Icon: Loader2,
        iconClass: 'text-green-300 animate-spin',
        pillClasses: pill,
        label: 'Thinking',
      };
    case 'permission':
      return {
        Icon: Lock,
        iconClass: 'text-amber-300',
        pillClasses: pill,
        label: 'Thinking · awaiting permission',
      };
  }
}

/**
 * Compact text-only activity indicator for the recent-transitions row.
 * Smaller than the status pill, no background fill - just colored
 * text so the from/to in `idle → thinking` reads naturally.
 */
const ActivityChip = memo(function ActivityChip({ state }: { state: ActivityState }) {
  const color = state === 'thinking'
    ? 'text-green-300'
    : state === 'permission'
      ? 'text-amber-300'
      : 'text-fg-faint';
  return <span className={`shrink-0 ${color}`}>{state}</span>;
});

/**
 * Numeric counter row. Non-zero values are emphasized; zeros are
 * dimmed so the eye lands on what is actually active.
 */
const CounterRow = memo(function CounterRow({ label, value, tooltip }: { label: string; value: number; tooltip: string }) {
  const isActive = value > 0;
  return (
    <div className="flex items-center justify-between gap-2" title={tooltip}>
      <span className="text-fg-faint truncate cursor-help">{label}</span>
      <span
        className={`font-mono tabular-nums shrink-0 ${
          isActive ? 'text-fg-primary font-medium' : 'text-fg-disabled'
        }`}
      >
        {value}
      </span>
    </div>
  );
});

/**
 * Boolean flag row. "yes" is emphasized in amber; "no" is dimmed.
 */
const FlagRow = memo(function FlagRow({ label, value, tooltip }: { label: string; value: boolean; tooltip: string }) {
  return (
    <div className="flex items-center justify-between gap-2" title={tooltip}>
      <span className="text-fg-faint truncate cursor-help">{label}</span>
      <span
        className={`font-mono tabular-nums shrink-0 ${
          value ? 'text-amber-300 font-medium' : 'text-fg-disabled'
        }`}
      >
        {value ? 'yes' : 'no'}
      </span>
    </div>
  );
});

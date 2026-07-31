/**
 * Session-update coalescer.
 *
 * Single funnel for every session-store push mutation that can re-render a
 * board TaskCard (usage, activity-log events, spawn progress, session status,
 * activity state, first output, exit, idle-timeout). It does two jobs:
 *
 *   1. Coalesce. High-frequency usage/event pushes are batched into one
 *      microtask flush, so N pushes that arrive in the same event-loop turn
 *      cause one React render instead of N. (React 19 auto-batches the set()
 *      calls in flush.)
 *   2. Drag gate. While a board drag is active, ALL session pushes are held and
 *      flushed on drag end. An in-flight spawn (creating a worktree, streaming
 *      first output) therefore never re-renders a `useSortable` card mid-drag,
 *      which would otherwise force dnd-kit to re-measure on the same thread as
 *      the pointer-move pipeline and drop frames. Outside a drag the
 *      side-effect-bearing handlers run immediately (no behavior change), so
 *      only the high-frequency usage/event stream is coalesced when idle. The
 *      optimistic move/drop never routes through here (it lives in board-store),
 *      so drop responsiveness is unaffected.
 *   3. Reload gate. Background-originated full reloads (`enqueueReload`) carry
 *      the same drag hazard as session pushes: an agent-driven `loadBoard()` /
 *      `loadBacklog()` / `loadConfig()` landing mid-drag reconciles the board
 *      and re-renders the changed lane, clearing dnd-kit's measured rects on the
 *      pointer-move thread (the reason `dragStartRectRef` exists). They are held
 *      while a drag is active and flushed once on drag end, deduped by key so N
 *      agent events that each requested a reload collapse to one. When idle they
 *      run immediately (no behavior change). User-initiated reloads (drop,
 *      detail-dialog actions, project switch, confirm dialogs, drag-cancel) do
 *      NOT route through here - they already fire at/after drag end.
 *
 * Usage and events keep their dedicated batch store actions (`batchUpdateUsage`
 * / `batchAddEvents`) for efficient last-write-wins / append semantics. The
 * other handlers carry side effects (auto-focus, notifications, auto-name) that
 * read the store AFTER their own write, so when held they are buffered as
 * whole-body thunks (and run unchanged when idle) to keep read-after-write
 * atomic. Held thunks flush in arrival order, which keeps lifecycle ordering
 * correct (`upsertSession` clears `spawnProgress[taskId]`, so a status thunk
 * after a spawn-progress thunk resolves to the right state).
 *
 * HMR: a board drag never survives a module reload (every `<DndContext>`
 * re-keys via `hmrGeneration`), and App.tsx's `vite:afterUpdate` handler
 * re-fetches authoritative state from the main process, which supersedes any
 * buffered renderer-side push. So on HMR we DISCARD buffers and reset the gate
 * rather than preserve or flush them - `resetCoalescerForHmr()` is called from
 * that handler. This mirrors the manual HMR discipline in `auto-name-scheduler.ts`.
 */
import type { SessionEvent, SessionUsage } from '../../shared/types';
import { useSessionStore } from '../stores/session-store';

// hmr-safe: transient in-flight buffer; discarded on HMR (the vite:afterUpdate
// resync re-fetches authoritative state, superseding any buffered push).
const pendingUsage = new Map<string, SessionUsage>();
// hmr-safe: transient in-flight buffer; see pendingUsage.
const pendingEvents: Array<{ sessionId: string; event: SessionEvent }> = [];
// hmr-safe: transient in-flight buffer; see pendingUsage.
const pendingThunks: Array<() => void> = [];
/**
 * The closed set of background reloads that route through the drag gate. The
 * shared 'board' key (used by both auto-move in App.tsx and agent invalidation
 * in useAgentDrivenInvalidation.ts) is what collapses their reloads to one.
 */
export type ReloadKey = 'board' | 'backlog' | 'config' | 'applyConfig';

// hmr-safe: transient in-flight buffer; see pendingUsage. Keyed so repeated
// reload requests during a drag (e.g. 'board') collapse to the last reload.
const pendingReloads = new Map<ReloadKey, () => void>();

// hmr-safe: a board drag never survives a module reload - every <DndContext>
// re-keys via hmrGeneration, so dragActive correctly resets to false on reload.
let dragActive = false;

/**
 * Whether a board drag is currently in progress. Read by other renderer
 * subsystems that want to pause expensive per-frame work during a drag (e.g. the
 * incoming xterm write queue, which holds its buffer instead of parsing mid-drag).
 */
export function isBoardDragActive(): boolean {
  return dragActive;
}

// hmr-safe: subscriptions are owned by live components (each re-registers on
// remount). resetCoalescerForHmr NOTIFIES rather than clears, so a held consumer
// (e.g. a paused write queue) resumes; a stale listener firing on an
// already-reset consumer is a no-op.
const dragEndListeners = new Set<() => void>();

/**
 * Subscribe to board-drag-end. Fires after `endBoardDrag()` has cleared the gate
 * and flushed (also via the 30s watchdog and the window-blur backstop, which
 * both route through `endBoardDrag`). Returns an unsubscribe function.
 */
export function onBoardDragEnd(listener: () => void): () => void {
  dragEndListeners.add(listener);
  return () => { dragEndListeners.delete(listener); };
}

function notifyDragEndListeners(): void {
  // Copy first so an unsubscribe during iteration cannot skip a listener.
  for (const listener of Array.from(dragEndListeners)) {
    try {
      listener();
    } catch {
      // A listener throwing must not block the others or the flush path.
    }
  }
}
// hmr-safe: transient scheduler flag; a stale microtask from a replaced module
// no-ops because flush() reads live buffers and re-checks dragActive.
let flushScheduled = false;

/**
 * Backstop against a permanently stuck reload gate. dnd-kit does not fire
 * onDragEnd / onDragCancel when the <DndContext> unmounts mid-drag (a view or
 * project switch) or when the window loses a pointerup (Windows alt-tab to an
 * overlapping window). Either leaves dragActive stuck true, parking every
 * agent-driven loadBoard() forever - the "MCP-created task only appears after
 * the next drag" bug. The unmount cleanup in useBoardDragDrop and the blur
 * flush below recover promptly; this timer is the last-resort guarantee that
 * the gate cannot stay closed without a live drag. 30s is comfortably longer
 * than any real drag (including hover-to-autoscroll), so a premature fire only
 * costs one mid-drag reload's frame jitter, and the timer re-arms on the next
 * drag.
 */
const DRAG_GATE_WATCHDOG_MS = 30_000;
// hmr-safe: transient watchdog handle; resetCoalescerForHmr clears it, and a
// drag never survives a module reload (the <DndContext> re-keys).
let dragGateWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

function clearDragGateWatchdog(): void {
  if (dragGateWatchdogTimer !== null) {
    clearTimeout(dragGateWatchdogTimer);
    dragGateWatchdogTimer = null;
  }
}

/**
 * Flush the gate if the window loses focus mid-drag. A blurred window cannot
 * receive the pointerup that ends a drag, so dnd-kit may never fire onDragEnd
 * (it cancels on visibilitychange, but not on a plain blur such as alt-tab to
 * an overlapping window or a DevTools focus steal). Exported for unit tests.
 * Worst case if a real drag is mid-flight when focus is stolen: that one drag
 * loses jitter protection for its remainder, a perf nicety, not correctness.
 */
export function flushDragGateOnWindowBlur(): void {
  if (!dragActive) return;
  console.warn('[reload-gate] window blur during active drag; flushing gate');
  endBoardDrag();
}

function flush(): void {
  flushScheduled = false;

  const store = useSessionStore.getState();

  // Usage and activity-log events apply even mid-drag. Neither can change a card's
  // HEIGHT, which is the only thing that disturbs a drag: dnd-kit's ResizeObserver
  // is live only while dragging and re-measures the whole tail of a lane when a card
  // resizes. Freezing them instead froze every context bar on the board for the
  // length of the gesture, which is far more disruptive than the render it avoided.
  if (pendingUsage.size > 0) {
    const usageCopy = new Map(pendingUsage);
    pendingUsage.clear();
    store.batchUpdateUsage(usageCopy);
  }

  if (pendingEvents.length > 0) {
    const eventsCopy = [...pendingEvents];
    pendingEvents.length = 0;
    store.batchAddEvents(eventsCopy);
  }

  // Everything below stays parked for the drag. Thunks can mount the context footer
  // on a spawn (a real height change), and reloads can change the sortable item set
  // itself - `SortableContext` compares `items` as id strings by value, so a
  // mid-gesture reconcile re-measures the lane AND disables transforms, snapping
  // displaced cards. `endBoardDrag()` clears the flag and calls flush() directly.
  //
  // Parking thunks is all-or-nothing on purpose: they flush in arrival order, which
  // is what keeps lifecycle ordering correct (`upsertSession` clears
  // `spawnProgress[taskId]`). Letting some through mid-drag could invert that order.
  if (dragActive) return;

  if (pendingThunks.length > 0) {
    const thunksCopy = [...pendingThunks];
    pendingThunks.length = 0;
    for (const thunk of thunksCopy) thunk();
  }

  // Reloads drain last. They are independent full re-fetches (loadBoard etc.)
  // with no ordering dependency on the session-push thunks above.
  if (pendingReloads.size > 0) {
    const reloadsCopy = [...pendingReloads.values()];
    pendingReloads.clear();
    for (const reload of reloadsCopy) reload();
  }
}

function schedule(): void {
  // NOT held during a board drag. Usage and activity-log events cannot disturb a
  // drag: `TaskCard` never subscribes to `events` at all, and the usage path only
  // moves the context bar's width and percent text inside a footer whose layout is
  // deliberately always rendered (see TaskCard's "card height is STABLE" note), so
  // no card changes height. Height is what actually matters here - dnd-kit's
  // ResizeObserver is live only while dragging and re-measures the whole tail of a
  // lane when a card resizes; a plain re-render never triggers it, because
  // droppables register in a `useEffect(..., [id])` and the default measuring
  // strategy is WhileDragging, not Always.
  //
  // The microtask coalescing below is the load-bearing half and stays.
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/** Queue a usage update (last write wins per session). */
export function enqueueUsage(sessionId: string, data: SessionUsage): void {
  pendingUsage.set(sessionId, data);
  schedule();
}

/** Queue an activity-log event (appended in arrival order). */
export function enqueueEvent(sessionId: string, event: SessionEvent): void {
  pendingEvents.push({ sessionId, event });
  schedule();
}

/**
 * Run a side-effect-bearing session push (activity, status, spawn progress, first
 * output). Runs immediately, preserving synchronous in-order behavior and keeping
 * intermediate states like spawn-progress phases visible.
 *
 * These used to be parked for the duration of a board drag, which froze every
 * card's activity indicator until the drop - agents are independent of a board
 * gesture, so a card that stops reporting while you drag an unrelated task reads as
 * the app hanging. The hold was justified by a claim that a re-render "forces
 * dnd-kit to re-measure on the pointer-move thread", which is not how dnd-kit
 * works: droppables register in a `useEffect(..., [id])` and the default measuring
 * strategy is WhileDragging, so a re-render re-measures nothing.
 *
 * What DOES disturb a drag is a card changing HEIGHT, because dnd-kit runs a
 * ResizeObserver while dragging that re-measures every card below the one that
 * resized. That is now prevented at the source: the activity mark is height-neutral
 * by construction, and TaskCard's running-state spinner is structurally identical
 * to `ContextUsageFooter`, so a resolving model name no longer grows the card.
 *
 * `pendingThunks` and the drain in `flush()` are retained: `endBoardDrag()` still
 * flushes anything parked by an older code path, and the buffer is the documented
 * mechanism for reintroducing a hold if one is ever needed again.
 */
export function enqueueSessionUpdate(thunk: () => void): void {
  thunk();
}

/**
 * Run a background-originated full reload (`loadBoard` / `loadBacklog` /
 * `loadConfig` / `applyConfigChange`). When no board drag is active it runs
 * immediately, preserving the pre-existing behavior (callers keep their own
 * upstream debounce). While a drag is active it is held, keyed by `ReloadKey`
 * so repeated requests collapse to one reload, and flushed on drag end - so an
 * agent-driven reconcile never re-renders a sortable lane mid-gesture. Only
 * background pushes (agent invalidation, auto-move, kangentic.json / label-color
 * file watches) route through here; user-initiated reloads already fire at or
 * after drag end.
 */
export function enqueueReload(key: ReloadKey, thunk: () => void): void {
  if (dragActive) {
    if (__KANGENTIC_DEV__) {
      console.debug('[reload-gate] parked reload', key, '(drag active, flushes on drag end)');
    }
    pendingReloads.set(key, thunk);
    return;
  }
  thunk();
}

/** Mark the start of a board drag. While active, all queued updates are held. */
export function beginBoardDrag(): void {
  if (__KANGENTIC_DEV__) console.debug('[reload-gate] begin board drag');
  dragActive = true;
  // Arm the stuck-gate backstop and listen for a focus-stealing blur that
  // would swallow the drag's pointerup. Both clear in endBoardDrag.
  clearDragGateWatchdog();
  dragGateWatchdogTimer = setTimeout(() => {
    console.warn(
      '[reload-gate] watchdog fired after',
      DRAG_GATE_WATCHDOG_MS,
      'ms with no drag end; force-clearing a stuck drag gate',
    );
    endBoardDrag();
  }, DRAG_GATE_WATCHDOG_MS);
  if (typeof window !== 'undefined') {
    // Remove before add so a stray begin without a paired end cannot stack a
    // second listener, mirroring the clearDragGateWatchdog() re-arm above.
    window.removeEventListener('blur', flushDragGateOnWindowBlur);
    window.addEventListener('blur', flushDragGateOnWindowBlur);
  }
}

/**
 * Mark the end of a board drag and flush everything that was held. Call this
 * synchronously at the top of handleDragEnd / handleDragCancel, before any
 * await, so the buffer stops growing while the async drop resolves. Idempotent:
 * the watchdog or a blur flush may call it before the real drag end does.
 */
export function endBoardDrag(): void {
  if (__KANGENTIC_DEV__) {
    console.debug('[reload-gate] end board drag, held reloads:', pendingReloads.size);
  }
  clearDragGateWatchdog();
  if (typeof window !== 'undefined') {
    window.removeEventListener('blur', flushDragGateOnWindowBlur);
  }
  dragActive = false;
  flush();
  // Resume any consumer that paused for the drag (e.g. held write queues).
  notifyDragEndListeners();
}

/**
 * Discard all buffered updates and reset the gate. Called from App.tsx's
 * `vite:afterUpdate` handler: the resync there re-fetches authoritative state
 * from the main process, so buffered renderer-side pushes are stale and must
 * not be applied.
 */
export function resetCoalescerForHmr(): void {
  pendingUsage.clear();
  pendingEvents.length = 0;
  pendingThunks.length = 0;
  pendingReloads.clear();
  clearDragGateWatchdog();
  if (typeof window !== 'undefined') {
    window.removeEventListener('blur', flushDragGateOnWindowBlur);
  }
  dragActive = false;
  flushScheduled = false;
  // Notify (do NOT clear) so a held write queue resumes after the HMR reset.
  // Live terminals do not remount on an unrelated Fast Refresh, so their
  // subscriptions remain valid; a kick on an already-drained queue is a no-op.
  notifyDragEndListeners();
}

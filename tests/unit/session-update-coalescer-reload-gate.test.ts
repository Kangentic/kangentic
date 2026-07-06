/**
 * Unit tests for the reload gate in the session-update coalescer
 * (`src/renderer/lib/session-update-coalescer.ts`).
 *
 * Background: a board drag is a renderer-only gesture (dnd-kit tracks the
 * pointer with refs + direct DOM writes and issues no IPC mid-gesture). The one
 * thing that still re-renders a sortable lane mid-drag is a background-originated
 * full reload - an agent-driven `loadBoard()` / `loadBacklog()`, a kangentic.json
 * file-watch `applyConfigChange()`, or a label-color `loadConfig()` - which
 * reconciles the board and clears dnd-kit's measured rects on the pointer-move
 * thread, causing the reported drag jitter. `enqueueReload(key, thunk)` defers
 * those reloads while a drag is active and flushes them once on drag end, keyed
 * so repeated requests collapse to one. These tests lock that behavior; they go
 * red the moment the gate is removed (a reload would run immediately mid-drag).
 *
 * Strategy mirrors auto-name-scheduler.test.ts: mock the only store the module
 * imports (`useSessionStore`, read inside `flush()`), then drive the module's
 * exported lifecycle directly. `resetCoalescerForHmr()` clears the module-scope
 * buffers between tests for isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  useSessionStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/session-store', () => ({ useSessionStore: mocks.useSessionStore }));

// Imported AFTER the mock. Pulls in the coalescer, which reads `import.meta.hot`
// (undefined in vitest, harmless).
import {
  enqueueReload,
  enqueueSessionUpdate,
  beginBoardDrag,
  endBoardDrag,
  flushDragGateOnWindowBlur,
  resetCoalescerForHmr,
  isBoardDragActive,
  onBoardDragEnd,
} from '../../src/renderer/lib/session-update-coalescer';

beforeEach(() => {
  vi.clearAllMocks();
  // flush() unconditionally reads useSessionStore.getState(); give it the two
  // batch actions it may call (unused by the reload-only tests below).
  mocks.useSessionStore.getState.mockReturnValue({
    batchUpdateUsage: vi.fn(),
    batchAddEvents: vi.fn(),
  });
  // Reset module-scope buffers + the drag flag so each test starts clean.
  resetCoalescerForHmr();
});

describe('enqueueReload - reload gate', () => {
  it('runs the reload immediately when no drag is active (no behavior change)', () => {
    const reload = vi.fn();
    enqueueReload('board', reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('holds the reload while a drag is active and runs it on drag end', () => {
    const reload = vi.fn();
    beginBoardDrag();
    enqueueReload('board', reload);
    // The whole point of the fix: the reconcile must NOT run mid-gesture.
    expect(reload).not.toHaveBeenCalled();

    endBoardDrag();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('dedupes by key: repeated same-key reloads during a drag collapse to the last one, run once', () => {
    const firstReload = vi.fn();
    const secondReload = vi.fn();
    beginBoardDrag();
    enqueueReload('board', firstReload);
    enqueueReload('board', secondReload);
    expect(firstReload).not.toHaveBeenCalled();
    expect(secondReload).not.toHaveBeenCalled();

    endBoardDrag();
    // Last write wins (loadBoard is idempotent, so running the latest once is
    // correct); the superseded thunk never runs.
    expect(firstReload).not.toHaveBeenCalled();
    expect(secondReload).toHaveBeenCalledTimes(1);
  });

  it('flushes distinct keys independently on drag end', () => {
    const boardReload = vi.fn();
    const backlogReload = vi.fn();
    const configReload = vi.fn();
    beginBoardDrag();
    enqueueReload('board', boardReload);
    enqueueReload('backlog', backlogReload);
    enqueueReload('config', configReload);

    endBoardDrag();
    expect(boardReload).toHaveBeenCalledTimes(1);
    expect(backlogReload).toHaveBeenCalledTimes(1);
    expect(configReload).toHaveBeenCalledTimes(1);
  });

  it('flushes held reloads alongside held session-update thunks on drag end', () => {
    const sessionThunk = vi.fn();
    const reload = vi.fn();
    beginBoardDrag();
    enqueueSessionUpdate(sessionThunk);
    enqueueReload('board', reload);
    expect(sessionThunk).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    endBoardDrag();
    expect(sessionThunk).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('discards a held reload on HMR reset (it must not run after reset)', () => {
    const staleReload = vi.fn();
    beginBoardDrag();
    enqueueReload('board', staleReload);

    // HMR resync re-fetches authoritative state, superseding any buffered push.
    resetCoalescerForHmr();
    // The drag flag is also cleared, so a subsequent reload runs immediately and
    // the stale one never fires.
    const freshReload = vi.fn();
    enqueueReload('board', freshReload);

    expect(staleReload).not.toHaveBeenCalled();
    expect(freshReload).toHaveBeenCalledTimes(1);
  });
});

/**
 * The hardening leg: dnd-kit fires no dragEnd/dragCancel when the <DndContext>
 * unmounts mid-drag or the window loses a pointerup, which would otherwise
 * leave dragActive=true and park every agent-driven loadBoard() forever (the
 * "MCP-created task only appears after the next drag" bug). Two structural
 * guarantees recover the gate: a watchdog timer and a window-blur flush.
 */
describe('enqueueReload - stuck-gate recovery', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('watchdog force-flushes a reload parked by an unpaired beginBoardDrag(), and clears the gate', () => {
    const reload = vi.fn();
    beginBoardDrag(); // no paired endBoardDrag - simulates a mid-drag unmount
    enqueueReload('board', reload);
    expect(reload).not.toHaveBeenCalled();

    // A reload cannot be parked indefinitely: the watchdog fires after 30s.
    vi.advanceTimersByTime(30_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    // The gate is cleared, so a subsequent reload runs immediately.
    const laterReload = vi.fn();
    enqueueReload('board', laterReload);
    expect(laterReload).toHaveBeenCalledTimes(1);
  });

  it('a paired drag clears the watchdog: nothing fires after drag end', () => {
    const reload = vi.fn();
    beginBoardDrag();
    enqueueReload('board', reload);
    endBoardDrag();
    expect(reload).toHaveBeenCalledTimes(1);

    // The watchdog timer was cleared by endBoardDrag, so advancing past it
    // neither warns nor re-runs anything.
    vi.advanceTimersByTime(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('re-arms the watchdog per drag (only the second, unpaired drag trips it)', () => {
    beginBoardDrag();
    endBoardDrag();
    const reload = vi.fn();
    beginBoardDrag();
    enqueueReload('board', reload);

    vi.advanceTimersByTime(30_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('window-blur flush releases a reload parked during a drag', () => {
    const reload = vi.fn();
    beginBoardDrag();
    enqueueReload('board', reload);
    expect(reload).not.toHaveBeenCalled();

    flushDragGateOnWindowBlur();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('window-blur flush is a no-op when no drag is active', () => {
    const reload = vi.fn();
    flushDragGateOnWindowBlur();
    expect(warnSpy).not.toHaveBeenCalled();
    // The gate is not active, so a reload runs immediately as usual.
    enqueueReload('board', reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

/**
 * The drag-active getter + drag-end subscription power the xterm write-queue
 * pause: consumers read `isBoardDragActive()` to HOLD their work and subscribe
 * via `onBoardDragEnd` to resume it.
 */
describe('board-drag signal for external consumers', () => {
  it('isBoardDragActive tracks begin/end', () => {
    expect(isBoardDragActive()).toBe(false);
    beginBoardDrag();
    expect(isBoardDragActive()).toBe(true);
    endBoardDrag();
    expect(isBoardDragActive()).toBe(false);
  });

  it('onBoardDragEnd fires on endBoardDrag, and unsubscribe stops delivery', () => {
    const listener = vi.fn();
    const unsubscribe = onBoardDragEnd(listener);

    beginBoardDrag();
    endBoardDrag();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    beginBoardDrag();
    endBoardDrag();
    expect(listener).toHaveBeenCalledTimes(1); // no further deliveries
  });

  it('onBoardDragEnd also fires via the window-blur backstop', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listener = vi.fn();
    const unsubscribe = onBoardDragEnd(listener);

    beginBoardDrag();
    flushDragGateOnWindowBlur(); // routes through endBoardDrag
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    warnSpy.mockRestore();
  });

  it('resetCoalescerForHmr notifies listeners and keeps subscriptions intact', () => {
    const listener = vi.fn();
    const unsubscribe = onBoardDragEnd(listener);

    // HMR reset resumes any held consumer (e.g. a paused write queue)...
    resetCoalescerForHmr();
    expect(listener).toHaveBeenCalledTimes(1);

    // ...and does NOT drop the subscription: a later drag end still delivers.
    beginBoardDrag();
    endBoardDrag();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

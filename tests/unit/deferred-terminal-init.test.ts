/**
 * Contract coverage for the SHARED deferred terminal init (task #468 for the
 * deferral itself; the Command Terminal stale-frame work for sharing it).
 *
 * runDeferredTerminalInit schedules `initTerminal()` into a
 * requestAnimationFrame instead of calling it synchronously in the commit
 * that mounts the pane. That deferral is a measured perf contract, not a
 * stylistic choice: folding the xterm construction (open + WebGL context +
 * fit, ~10ms) into the mount commit produced a 40-60ms pointer-thread stall
 * when a spawning session's pane mounted mid-drag, and StrictMode's dev-only
 * mount -> unmount -> remount built TWO xterm instances per mount (one
 * discarded, its geometry-changing work racing the survivor through the
 * settle pipeline). With the rAF, the first mount's cleanup cancels its
 * scheduled init before it runs, so exactly one terminal is constructed.
 *
 * This file imports the REAL controller from useDeferredTerminalInit.ts
 * (earlier coverage replicated TerminalTab's inline effect body verbatim,
 * because a hook cannot render without a DOM environment - extracting the
 * imperative core removed both the replica and its drift risk). The
 * assertions are the contract:
 *
 *   1. No init in the mount tick - the commit frame never pays the xterm cost.
 *   2. Init runs on the next animation frame when the host has dimensions.
 *   3. Cleanup cancels a pending scheduled init (rAF never fires -> no init).
 *   4. A StrictMode-shaped mount/cleanup/mount sequence inits exactly ONCE.
 *   5. A zero-dimension host no-ops the rAF and retries via ResizeObserver
 *      when dimensions arrive (the display:none tab path).
 *   6. Once initialized, later observer fires and re-schedules are no-ops.
 *   7. onInit (CommandTerminalPane's fit + focus) runs with the init, and
 *      never for an init that was cancelled.
 *
 * Plus a source-level pin that BOTH hosts route through the shared hook:
 * this repo has no component-render tier, and a host quietly hand-rolling a
 * synchronous init again is exactly the regression that produced the
 * throwaway-xterm race.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The init queue subscribes to the session-update coalescer's drag gate, and the
// coalescer reads the session store inside flush(); mock the store the same way
// tests/unit/session-update-coalescer-reload-gate.test.ts does.
const mocks = vi.hoisted(() => ({
  useSessionStore: { getState: vi.fn() },
}));
vi.mock('../../src/renderer/stores/session-store', () => ({ useSessionStore: mocks.useSessionStore }));

import { runDeferredTerminalInit } from '../../src/renderer/hooks/useDeferredTerminalInit';
import {
  resetTerminalInitQueue,
  pendingTerminalInitCount,
  ECHO_SETTLE_MS,
  TYPING_HOLD_CAP_MS,
  TYPING_HOLD_HARD_CAP_MS,
  TYPING_QUIET_MS,
} from '../../src/renderer/utils/terminal-init-queue';
import { noteTerminalKeydown, resetTerminalTyping } from '../../src/renderer/utils/terminal-typing';
import {
  beginBoardDrag,
  endBoardDrag,
  flushDragGateOnWindowBlur,
  resetCoalescerForHmr,
} from '../../src/renderer/lib/session-update-coalescer';

// ---------------------------------------------------------------------------
// Deterministic rAF + ResizeObserver stubs
// ---------------------------------------------------------------------------

type FrameCallback = (now: number) => void;

const scheduledFrames = new Map<number, FrameCallback>();
let nextFrameHandle = 1;

function flushAnimationFrame(): void {
  const callbacks = [...scheduledFrames.values()];
  scheduledFrames.clear();
  for (const callback of callbacks) callback(0);
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observedTargets: unknown[] = [];
  disconnected = false;
  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: unknown): void {
    this.observedTargets.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    if (!this.disconnected) this.callback();
  }
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  scheduledFrames.clear();
  nextFrameHandle = 1;
  FakeResizeObserver.instances = [];
  mocks.useSessionStore.getState.mockReturnValue({
    batchUpdateUsage: vi.fn(),
    batchAddEvents: vi.fn(),
  });
  // The init queue is module state shared by every host. Clearing `scheduledFrames` above
  // drops any pump frame it had scheduled, so without this reset the queue would still
  // believe a pump is pending and never schedule another one.
  resetTerminalInitQueue();
  // The drag gate is module state too: a test that begins a drag and fails before ending
  // it must not hold every later test's inits.
  resetCoalescerForHmr();
  // And the typing hold: a key noted by one test must not hold the next one's inits.
  resetTerminalTyping();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback): number => {
    const handle = nextFrameHandle;
    nextFrameHandle += 1;
    scheduledFrames.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    scheduledFrames.delete(handle);
  });
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared deferred terminal init contract', () => {
  it('never inits synchronously in the mount tick', () => {
    const initTerminal = vi.fn();
    runDeferredTerminalInit({
      element: { offsetWidth: 800, offsetHeight: 300 },
      initializedRef: { current: false },
      initTerminal,
    });
    expect(initTerminal).not.toHaveBeenCalled();
  });

  it('inits on the next animation frame when the host has dimensions', () => {
    const initTerminal = vi.fn();
    const initialized = { current: false };
    runDeferredTerminalInit({
      element: { offsetWidth: 800, offsetHeight: 300 },
      initializedRef: initialized,
      initTerminal,
    });
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
    expect(initialized.current).toBe(true);
  });

  it('cleanup cancels a pending scheduled init', () => {
    const initTerminal = vi.fn();
    const cleanup = runDeferredTerminalInit({
      element: { offsetWidth: 800, offsetHeight: 300 },
      initializedRef: { current: false },
      initTerminal,
    });
    cleanup();
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
  });

  it('a StrictMode mount/cleanup/mount sequence constructs exactly one terminal', () => {
    const initTerminal = vi.fn();
    const initialized = { current: false };
    const element = { offsetWidth: 800, offsetHeight: 300 };
    // StrictMode runs the first effect pass and its cleanup back to back,
    // before any frame can fire, then mounts again for real.
    const firstCleanup = runDeferredTerminalInit({ element, initializedRef: initialized, initTerminal });
    firstCleanup();
    runDeferredTerminalInit({ element, initializedRef: initialized, initTerminal });
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
    expect(initialized.current).toBe(true);
  });

  it('a zero-dimension host defers to the ResizeObserver and inits when sized', () => {
    const initTerminal = vi.fn();
    const initialized = { current: false };
    const element = { offsetWidth: 0, offsetHeight: 0 };
    runDeferredTerminalInit({ element, initializedRef: initialized, initTerminal });
    // The scheduled frame fires while the host is still 0x0: no init.
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    expect(initialized.current).toBe(false);
    // The host gains dimensions; the observer re-schedules; the next frame inits.
    element.offsetWidth = 800;
    element.offsetHeight = 300;
    FakeResizeObserver.instances[0].fire();
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
    expect(initialized.current).toBe(true);
  });

  it('observer fires after initialization are no-ops (no second init, observer disconnects)', () => {
    const initTerminal = vi.fn();
    const initialized = { current: false };
    const element = { offsetWidth: 800, offsetHeight: 300 };
    runDeferredTerminalInit({ element, initializedRef: initialized, initTerminal });
    flushAnimationFrame();
    const observer = FakeResizeObserver.instances[0];
    expect(observer.disconnected).toBe(true);
    observer.fire();
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('runs onInit with the init, and never for a cancelled init', () => {
    const callOrder: string[] = [];
    const initialized = { current: false };
    const element = { offsetWidth: 800, offsetHeight: 300 };
    runDeferredTerminalInit({
      element,
      initializedRef: initialized,
      initTerminal: () => callOrder.push('init'),
      onInit: () => callOrder.push('onInit'),
    });
    flushAnimationFrame();
    // CommandTerminalPane's fit + focus ride onInit, same frame, after init.
    expect(callOrder).toEqual(['init', 'onInit']);

    // A cancelled init must not fire onInit either (the StrictMode throwaway).
    const cancelledOnInit = vi.fn();
    const cleanup = runDeferredTerminalInit({
      element,
      initializedRef: { current: false },
      initTerminal: vi.fn(),
      onInit: cancelledOnInit,
    });
    cleanup();
    flushAnimationFrame();
    expect(cancelledOnInit).not.toHaveBeenCalled();
  });
});

/**
 * The serialization contract. Hosts that mount in the SAME commit each schedule their init
 * for the same frame, so before the shared queue their costs compounded: measured against the
 * live app, the worst frames stacked 2-3 inits (~120ms each) into one 330-350ms block. The
 * queue does not make construction cheaper, it caps the longest single block at one init.
 *
 * These assertions are what a revert to per-host requestAnimationFrame would break.
 */
describe('terminal inits are serialized one per frame', () => {
  function mountHost(initTerminal: () => void): () => void {
    return runDeferredTerminalInit({
      element: { offsetWidth: 800, offsetHeight: 300 },
      initializedRef: { current: false },
      initTerminal,
    });
  }

  it('runs only ONE init per frame when three hosts mount in the same commit', () => {
    const order: string[] = [];
    mountHost(() => order.push('a'));
    mountHost(() => order.push('b'));
    mountHost(() => order.push('c'));

    flushAnimationFrame();
    expect(order).toEqual(['a']);
    flushAnimationFrame();
    expect(order).toEqual(['a', 'b']);
    flushAnimationFrame();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('still inits a lone host on the very next frame', () => {
    // The cap must not cost a single terminal anything: the common case is one pane opening.
    const initTerminal = vi.fn();
    mountHost(initTerminal);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('a cancelled host is dropped from the queue and never delays the ones behind it', () => {
    const order: string[] = [];
    mountHost(() => order.push('a'));
    const cancelSecond = mountHost(() => order.push('b'));
    mountHost(() => order.push('c'));

    cancelSecond();
    expect(pendingTerminalInitCount()).toBe(2);

    flushAnimationFrame();
    flushAnimationFrame();
    expect(order).toEqual(['a', 'c']);
  });

  it('a zero-dimension host releases its turn immediately instead of delaying the host behind it', () => {
    // A host that is still 0x0 when its FIFO turn arrives must yield the queue right away - the
    // ResizeObserver re-schedules it once it is sized. If it instead consumed its turn without
    // releasing the queue, the sized host mounted right behind it would pay for the stall.
    const order: string[] = [];
    const zeroDimensionElement = { offsetWidth: 0, offsetHeight: 0 };
    const zeroDimensionInitialized = { current: false };
    runDeferredTerminalInit({
      element: zeroDimensionElement,
      initializedRef: zeroDimensionInitialized,
      initTerminal: () => order.push('zero-dimension host'),
    });
    const sizedHostInitialized = { current: false };
    runDeferredTerminalInit({
      element: { offsetWidth: 800, offsetHeight: 300 },
      initializedRef: sizedHostInitialized,
      initTerminal: () => order.push('sized host'),
    });

    expect(pendingTerminalInitCount()).toBe(2);

    // The zero-dimension host's FIFO turn arrives first and no-ops: nothing inits, and the
    // queue depth drops by exactly one slot - the slot was genuinely released, not silently
    // held onto for another frame.
    flushAnimationFrame();
    expect(order).toEqual([]);
    expect(zeroDimensionInitialized.current).toBe(false);
    expect(pendingTerminalInitCount()).toBe(1);

    // The sized host runs on the very next frame - it is not pushed out further by the
    // zero-dimension host that yielded ahead of it.
    flushAnimationFrame();
    expect(order).toEqual(['sized host']);
    expect(sizedHostInitialized.current).toBe(true);
    expect(pendingTerminalInitCount()).toBe(0);

    // The zero-dimension host was skipped, not dropped: once its ResizeObserver reports real
    // dimensions, it still initializes on the following frame.
    zeroDimensionElement.offsetWidth = 800;
    zeroDimensionElement.offsetHeight = 300;
    FakeResizeObserver.instances[0].fire();
    flushAnimationFrame();
    expect(order).toEqual(['sized host', 'zero-dimension host']);
    expect(zeroDimensionInitialized.current).toBe(true);
  });

  it('holds one-per-frame under a BURST, and still runs every host', () => {
    // The burst is the case that matters most, not the 2-3 hosts a handoff produces:
    // dragging a batch of tasks into a spawning column mounts a pane per task in one
    // commit. Unqueued, ten ~75ms constructions land in a single frame as one ~750ms
    // lock with no paint and no input - and a drag is exactly when a dropped pointer
    // event is least recoverable (dnd-kit loses the drag or the card jumps).
    const order: number[] = [];
    for (let index = 0; index < 10; index++) mountHost(() => order.push(index));

    for (let frame = 1; frame <= 10; frame++) {
      flushAnimationFrame();
      expect(order).toHaveLength(frame);
    }
    // FIFO, and nothing is dropped on the floor.
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pendingTerminalInitCount()).toBe(0);
  });

  it('a host that throws during construction does not strand the queue behind it', () => {
    // A wedged queue would leave every pane behind the thrower permanently blank, which is a
    // far worse failure than the construction error itself.
    const order: string[] = [];
    mountHost(() => { throw new Error('xterm construction failed'); });
    mountHost(() => order.push('survivor'));

    expect(() => flushAnimationFrame()).toThrow('xterm construction failed');
    flushAnimationFrame();
    expect(order).toEqual(['survivor']);
  });
});

/**
 * The board-drag hold. A construction is a 21 to 42ms frame on the production build
 * (75 to 130ms in dev), and a drop's pane mounts while the user is already dragging the
 * next card, so the pump defers every init for the length of a gesture and resumes one
 * frame AFTER the drop frame. These go red if the hold is removed (an init runs mid-drag)
 * or if the resume lands on the drop frame itself (an init runs on the first frame after
 * `endBoardDrag()` instead of the second).
 */
describe('terminal inits are held for a board drag', () => {
  function mountHost(initTerminal: () => void): () => void {
    return runDeferredTerminalInit({
      element: { offsetWidth: 800, offsetHeight: 300 },
      initializedRef: { current: false },
      initTerminal,
    });
  }

  it('does not construct while a drag is active, and keeps the host queued', () => {
    const initTerminal = vi.fn();
    beginBoardDrag();
    mountHost(initTerminal);
    flushAnimationFrame();
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    expect(pendingTerminalInitCount()).toBe(1);
    endBoardDrag();
  });

  it('resumes one frame after the drop frame, then drains one per frame as usual', () => {
    const order: string[] = [];
    beginBoardDrag();
    mountHost(() => order.push('a'));
    mountHost(() => order.push('b'));
    flushAnimationFrame();
    expect(order).toEqual([]);

    // endBoardDrag() notifies synchronously from the pointerup handler; the frame it
    // arms is the drop frame's own animation-frame phase, which must stay construction
    // free because that frame already pays the drop handler.
    endBoardDrag();
    flushAnimationFrame();
    expect(order).toEqual([]);
    flushAnimationFrame();
    expect(order).toEqual(['a']);
    flushAnimationFrame();
    expect(order).toEqual(['a', 'b']);
    expect(pendingTerminalInitCount()).toBe(0);
  });

  it('an init enqueued mid-drag by a host that was already queued before it is not lost', () => {
    const order: string[] = [];
    mountHost(() => order.push('before-drag'));
    beginBoardDrag();
    mountHost(() => order.push('during-drag'));
    flushAnimationFrame();
    expect(order).toEqual([]);
    endBoardDrag();
    flushAnimationFrame();
    flushAnimationFrame();
    flushAnimationFrame();
    expect(order).toEqual(['before-drag', 'during-drag']);
  });

  it('a drag that ends with nothing queued arms no frame', () => {
    beginBoardDrag();
    endBoardDrag();
    expect(scheduledFrames.size).toBe(0);
  });

  it('the 30s watchdog ends a stuck gate and the held inits resume', () => {
    // Fake only the timer the watchdog uses; the animation-frame stub above stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const initTerminal = vi.fn();
      beginBoardDrag();
      mountHost(initTerminal);
      flushAnimationFrame();
      expect(initTerminal).not.toHaveBeenCalled();
      // No drop ever arrives (a <DndContext> unmounted mid-drag); the watchdog fires.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.advanceTimersByTime(30_000);
      warn.mockRestore();
      flushAnimationFrame();
      flushAnimationFrame();
      expect(initTerminal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an init enqueued in the same tick as the drop still skips the drop frame', () => {
    // Two independent reviewers found this race: a pump armed WHILE the drag is still
    // active is still pending (sitting in scheduledFrames) when the drop lands, so it
    // fires in the drop frame's own animation-frame phase and constructs there, defeating
    // the extra frame resumeAfterDrag exists to buy. Every test above hides this because
    // each one calls flushAnimationFrame() between the mid-drag mountHost(...) and
    // endBoardDrag(), which discharges that pending pump while the drag is still active.
    // This test enqueues and ends the drag with no flush in between, so a pump that slips
    // past the schedulePump() drag guard is still pending when the drop frame fires.
    const initTerminal = vi.fn();
    beginBoardDrag();
    mountHost(initTerminal);
    endBoardDrag();
    // The drop frame: must stay construction-free even though a pump could have been
    // armed mid-drag and left pending until now.
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    // The frame after the drop frame: the held init resumes here, as designed.
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('the window-blur backstop ends a stuck gate and the held inits resume', () => {
    // dnd-kit does not fire onDragEnd/onDragCancel when the window loses a pointerup
    // mid-drag (alt-tabbing to an overlapping window), so the coalescer's blur backstop
    // is the other real path into endBoardDrag() besides the drop and the 30s watchdog
    // above. The init queue's hold depends on EVERY drag-terminating path reaching
    // onBoardDragEnd, so the blur path needs its own coverage.
    const initTerminal = vi.fn();
    beginBoardDrag();
    mountHost(initTerminal);
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    // The blur backstop warns before flushing the gate; mute it the same way the
    // watchdog test above mutes its own console.warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    flushDragGateOnWindowBlur();
    warn.mockRestore();
    flushAnimationFrame();
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });
});

/**
 * The typing hold. A construction that lands between two keys holds the second key's echo
 * for the whole frame, so the pump waits for a pause in the typing, capped so a user who
 * never pauses still gets the terminal. Timers and the clock are faked together: the hold
 * reads `performance.now()` and re-checks on a `setTimeout`.
 */
describe('terminal inits are held while the user types', () => {
  function mountHost(initTerminal: () => void): () => void {
    return runDeferredTerminalInit({
      element: { offsetWidth: 800, offsetHeight: 300 },
      initializedRef: { current: false },
      initTerminal,
    });
  }

  function typeKey(key = 'a'): void {
    noteTerminalKeydown({ key });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  afterEach(() => {
    resetTerminalInitQueue();
    resetTerminalTyping();
    vi.useRealTimers();
  });

  it('does not construct between keys, and constructs at the first pause', () => {
    const initTerminal = vi.fn();
    typeKey();
    mountHost(initTerminal);
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    expect(pendingTerminalInitCount()).toBe(1);

    vi.advanceTimersByTime(TYPING_QUIET_MS - 1);
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
    expect(pendingTerminalInitCount()).toBe(0);
  });

  it('a key pressed during the hold moves the pause later', () => {
    const initTerminal = vi.fn();
    typeKey();
    mountHost(initTerminal);
    flushAnimationFrame();
    vi.advanceTimersByTime(300);
    typeKey();
    // The retry armed for the first key fires here, finds the second key too recent, and
    // re-arms for the rest of the second key's quiet window.
    vi.advanceTimersByTime(TYPING_QUIET_MS - 300);
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('typing that never pauses still gets the terminal at the cap', () => {
    const initTerminal = vi.fn();
    typeKey();
    mountHost(initTerminal);
    flushAnimationFrame();
    // A key every 200 ms, well inside the quiet window, for longer than the cap.
    for (let elapsed = 200; elapsed < TYPING_HOLD_CAP_MS; elapsed += 200) {
      vi.advanceTimersByTime(200);
      typeKey();
      flushAnimationFrame();
      expect(initTerminal).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(200);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('past the cap, the build waits for the last key\'s echo instead of landing on it', () => {
    const initTerminal = vi.fn();
    typeKey();
    mountHost(initTerminal);
    flushAnimationFrame();
    // A key every 100 ms up to and including the cap: the pump that finds the cap passed
    // runs just after a key.
    for (let elapsed = 100; elapsed <= TYPING_HOLD_CAP_MS; elapsed += 100) {
      vi.advanceTimersByTime(100);
      typeKey();
      flushAnimationFrame();
      expect(initTerminal).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(ECHO_SETTLE_MS - 1);
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('a held key, which autorepeats inside the echo gap, still gets the terminal at the hard cap', () => {
    const initTerminal = vi.fn();
    typeKey();
    mountHost(initTerminal);
    flushAnimationFrame();
    const autorepeatMs = 30;
    for (let elapsed = autorepeatMs; elapsed < TYPING_HOLD_HARD_CAP_MS; elapsed += autorepeatMs) {
      vi.advanceTimersByTime(autorepeatMs);
      typeKey();
      flushAnimationFrame();
      expect(initTerminal).not.toHaveBeenCalled();
    }
    for (let extra = 0; extra < 4; extra += 1) {
      vi.advanceTimersByTime(autorepeatMs);
      typeKey();
      flushAnimationFrame();
    }
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('a bare modifier is not typing', () => {
    const initTerminal = vi.fn();
    typeKey('Shift');
    typeKey('Control');
    mountHost(initTerminal);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('a shortcut ends the typing, so a terminal it opens is not held, while AltGr text still holds', () => {
    const shortcutOpens = vi.fn();
    typeKey();
    noteTerminalKeydown({ key: 'P', ctrlKey: true });
    mountHost(shortcutOpens);
    flushAnimationFrame();
    expect(shortcutOpens).toHaveBeenCalledTimes(1);

    const heldBehindAltGr = vi.fn();
    noteTerminalKeydown({ key: '@', ctrlKey: true, altKey: true, getModifierState: (modifier) => modifier === 'AltGraph' });
    mountHost(heldBehindAltGr);
    flushAnimationFrame();
    expect(heldBehindAltGr).not.toHaveBeenCalled();
  });

  it('a character typed with Option (Alt alone) still holds, while Alt with a non-character key is a shortcut', () => {
    // macOS's Option types `@` on a German layout: altKey set, no AltGraph state.
    const heldBehindOption = vi.fn();
    noteTerminalKeydown({ key: '@', altKey: true, getModifierState: () => false });
    mountHost(heldBehindOption);
    flushAnimationFrame();
    expect(heldBehindOption).not.toHaveBeenCalled();

    resetTerminalInitQueue();
    const altArrowOpens = vi.fn();
    noteTerminalKeydown({ key: 'ArrowDown', altKey: true, getModifierState: () => false });
    mountHost(altArrowOpens);
    flushAnimationFrame();
    expect(altArrowOpens).toHaveBeenCalledTimes(1);
  });

  it('a pointer press ends the typing, so a terminal the click asks for is not held', () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    const initTerminal = vi.fn();
    typeKey();
    fakeWindow.dispatchEvent(new Event('pointerdown'));
    mountHost(initTerminal);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });

  it('useTerminal stamps keys in the capture phase, where xterm cannot stop them first', () => {
    // xterm binds keydown on its textarea in the capture pass and stops propagation for
    // every key it consumes, so a bubble listener on the same textarea never runs: in the
    // preview the stamp stayed empty through a whole typing run. No unit tier has a DOM to
    // show that, so the registration is pinned as text.
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'), 'utf-8');
    expect(source).toMatch(/textarea\?\.addEventListener\('keydown', noteTerminalKeydown, \{ capture: true/);
  });

  it('a held init that is cancelled leaves nothing to build when the pause comes', () => {
    const initTerminal = vi.fn();
    typeKey();
    const cancel = mountHost(initTerminal);
    flushAnimationFrame();
    cancel();
    vi.advanceTimersByTime(TYPING_QUIET_MS);
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    expect(pendingTerminalInitCount()).toBe(0);
  });
});

describe('both terminal hosts route through the shared hook', () => {
  const repoRoot = join(__dirname, '..', '..');

  it.each([
    'src/renderer/components/terminal/TerminalTab.tsx',
    'src/renderer/components/command-bar/CommandTerminalPane.tsx',
  ])('%s uses useDeferredTerminalInit and never calls initTerminal itself', (relativePath) => {
    const source = readFileSync(join(repoRoot, relativePath), 'utf8');
    expect(source).toContain('useDeferredTerminalInit({');
    // A direct call is the hand-rolled shape (the pane's old synchronous
    // init) coming back; passing the function to the hook never calls it.
    expect(source).not.toMatch(/initTerminal\(\)/);
  });
});

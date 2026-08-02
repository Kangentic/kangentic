/**
 * Unit coverage for TerminalTab's DEFERRED init contract (task #468).
 *
 * The mount effect in TerminalTab.tsx schedules `initTerminal()` into a
 * requestAnimationFrame instead of calling it synchronously in the commit that
 * mounts the pane. That deferral is a measured perf contract, not a stylistic
 * choice: folding the xterm construction (open + WebGL context + fit, ~10ms)
 * into the mount commit produced a 40-60ms pointer-thread stall when a
 * spawning session's pane mounted mid-drag, and StrictMode's dev-only
 * mount -> unmount -> remount built TWO xterm instances per mount (one
 * discarded). With the rAF, the first mount's cleanup cancels its scheduled
 * init before it runs, so exactly one terminal is constructed.
 *
 * Same trade as use-terminal-scrollback.test.ts: this project's vitest config
 * has no jsdom environment, so the effect body is replicated here verbatim
 * (reading the same globals, which the tests stub deterministically) and the
 * OBSERVABLE contract is asserted. If TerminalTab's effect shape changes, keep
 * this replica in sync - the assertions below are the contract:
 *
 *   1. No init in the mount tick - the commit frame never pays the xterm cost.
 *   2. Init runs on the next animation frame when the host has dimensions.
 *   3. Cleanup cancels a pending scheduled init (rAF never fires -> no init).
 *   4. A StrictMode-shaped mount/cleanup/mount sequence inits exactly ONCE.
 *   5. A zero-dimension host no-ops the rAF and retries via ResizeObserver
 *      when dimensions arrive (the display:none tab path).
 *   6. Once initialized, later observer fires and re-schedules are no-ops.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
// The effect body, replicated from TerminalTab.tsx's init effect. `el` stands
// in for terminalRef.current, `initialized` for the initialized ref.
// ---------------------------------------------------------------------------

interface HostElement {
  offsetWidth: number;
  offsetHeight: number;
}

function runInitEffect(
  el: HostElement,
  initialized: { current: boolean },
  initTerminal: () => void,
): () => void {
  let initRafId: number | null = null;

  const scheduleInit = () => {
    if (initialized.current || initRafId !== null) return;
    initRafId = requestAnimationFrame(() => {
      initRafId = null;
      if (initialized.current) return;
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        initTerminal();
        initialized.current = true;
        observer.disconnect();
      }
    });
  };

  const observer: ResizeObserver = new ResizeObserver(() => {
    if (initialized.current) {
      observer.disconnect();
      return;
    }
    scheduleInit();
  });
  observer.observe(el as unknown as Element);

  scheduleInit();

  return () => {
    if (initRafId !== null) cancelAnimationFrame(initRafId);
    observer.disconnect();
    initialized.current = false;
  };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  scheduledFrames.clear();
  nextFrameHandle = 1;
  FakeResizeObserver.instances = [];
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

describe('TerminalTab deferred init contract', () => {
  it('never inits synchronously in the mount tick', () => {
    const initTerminal = vi.fn();
    runInitEffect({ offsetWidth: 800, offsetHeight: 300 }, { current: false }, initTerminal);
    expect(initTerminal).not.toHaveBeenCalled();
  });

  it('inits on the next animation frame when the host has dimensions', () => {
    const initTerminal = vi.fn();
    const initialized = { current: false };
    runInitEffect({ offsetWidth: 800, offsetHeight: 300 }, initialized, initTerminal);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
    expect(initialized.current).toBe(true);
  });

  it('cleanup cancels a pending scheduled init', () => {
    const initTerminal = vi.fn();
    const cleanup = runInitEffect({ offsetWidth: 800, offsetHeight: 300 }, { current: false }, initTerminal);
    cleanup();
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
  });

  it('a StrictMode mount/cleanup/mount sequence constructs exactly one terminal', () => {
    const initTerminal = vi.fn();
    const initialized = { current: false };
    const el = { offsetWidth: 800, offsetHeight: 300 };
    // StrictMode runs the first effect pass and its cleanup back to back,
    // before any frame can fire, then mounts again for real.
    const firstCleanup = runInitEffect(el, initialized, initTerminal);
    firstCleanup();
    runInitEffect(el, initialized, initTerminal);
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
    expect(initialized.current).toBe(true);
  });

  it('a zero-dimension host defers to the ResizeObserver and inits when sized', () => {
    const initTerminal = vi.fn();
    const initialized = { current: false };
    const el = { offsetWidth: 0, offsetHeight: 0 };
    runInitEffect(el, initialized, initTerminal);
    // The scheduled frame fires while the host is still 0x0: no init.
    flushAnimationFrame();
    expect(initTerminal).not.toHaveBeenCalled();
    expect(initialized.current).toBe(false);
    // The host gains dimensions; the observer re-schedules; the next frame inits.
    el.offsetWidth = 800;
    el.offsetHeight = 300;
    FakeResizeObserver.instances[0].fire();
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
    expect(initialized.current).toBe(true);
  });

  it('observer fires after initialization are no-ops (no second init, observer disconnects)', () => {
    const initTerminal = vi.fn();
    const initialized = { current: false };
    const el = { offsetWidth: 800, offsetHeight: 300 };
    runInitEffect(el, initialized, initTerminal);
    flushAnimationFrame();
    const observer = FakeResizeObserver.instances[0];
    expect(observer.disconnected).toBe(true);
    observer.fire();
    flushAnimationFrame();
    expect(initTerminal).toHaveBeenCalledTimes(1);
  });
});

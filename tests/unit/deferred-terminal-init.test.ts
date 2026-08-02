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
import { runDeferredTerminalInit } from '../../src/renderer/hooks/useDeferredTerminalInit';

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

/**
 * The frame hold's landing: a user's layout change runs at once and opens a
 * landing on its scope, during which a terminal that refits holds its frame
 * rather than reflowing it (`useTerminal`). The unit tier has no DOM, so a fake
 * scope stands in for the element. It also carries a `startViewTransition` that
 * counts its calls, so a test can show nothing freezes the scope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isTerminalLayoutLandingFor,
  LAYOUT_LANDING_CAP_MS,
  LAYOUT_LANDING_MIN_MS,
  runTerminalLayoutChange,
} from '../../src/renderer/utils/terminal-layout-transition';

interface FakeTransition {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition?: () => void;
}

interface FakeScope {
  isConnected: boolean;
  dataset: Record<string, string>;
  starts: number;
  terminal: object;
  /** The terminal panes' boxes the settle loop reads each frame; a test moves them to stand in for a refit. */
  paneBoxes: Array<{ left: number; top: number; width: number; height: number }>;
  contains(element: unknown): boolean;
  querySelectorAll(selector: string): Array<{ getBoundingClientRect(): { left: number; top: number; width: number; height: number } }>;
  startViewTransition?: (update: () => Promise<void>) => FakeTransition;
}

function fakeScope(): FakeScope {
  const scope: FakeScope = {
    isConnected: true,
    dataset: {},
    starts: 0,
    terminal: {},
    paneBoxes: [{ left: 0, top: 0, width: 400, height: 300 }],
    contains(element) { return element === scope.terminal; },
    querySelectorAll() { return scope.paneBoxes.map((box) => ({ getBoundingClientRect: () => box })); },
  };
  scope.startViewTransition = (update) => {
    scope.starts += 1;
    const done = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(update);
    return { ready: done, finished: done };
  };
  return scope;
}

const asElement = (scope: FakeScope) => scope as unknown as HTMLElement;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the scope's landing has ended, and report how long it held. */
async function landingDuration(scope: FakeScope): Promise<number> {
  const startedAt = performance.now();
  while (isTerminalLayoutLandingFor(scope.terminal as Element)) await tick(2);
  return performance.now() - startedAt;
}

describe('runTerminalLayoutChange', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 5));
    vi.stubGlobal('document', { visibilityState: 'visible' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs the change once, at once, and opens a landing on its scope', async () => {
    // The change lands on the next frame: nothing waits for an agent to repaint.
    const scope = fakeScope();
    const change = vi.fn(() => {
      // A terminal that refits inside the change finds the landing open.
      expect(isTerminalLayoutLandingFor(scope.terminal as Element)).toBe(true);
    });
    runTerminalLayoutChange(asElement(scope), change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(isTerminalLayoutLandingFor(scope.terminal as Element)).toBe(true);
    await landingDuration(scope);
    expect(change).toHaveBeenCalledTimes(1);
    // The change never starts a View Transition on the scope: nothing is frozen.
    expect(scope.starts).toBe(0);
  });

  it('opens no landing where there is no scope, or while the window is hidden', () => {
    const change = vi.fn();
    runTerminalLayoutChange(null, change);
    expect(change).toHaveBeenCalledTimes(1);
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    const scope = fakeScope();
    runTerminalLayoutChange(asElement(scope), change);
    expect(change).toHaveBeenCalledTimes(2);
    expect(isTerminalLayoutLandingFor(scope.terminal as Element)).toBe(false);
  });

  it('holds the landing for its minimum, though nothing under the scope moves', async () => {
    // A change can reach its terminals through a render React runs in a task of
    // its own, so a still scope right after the click is not yet the result.
    const scope = fakeScope();
    runTerminalLayoutChange(asElement(scope), () => {});
    const held = await landingDuration(scope);
    expect(held).toBeGreaterThanOrEqual(LAYOUT_LANDING_MIN_MS - 5);
    expect(held).toBeLessThan(LAYOUT_LANDING_CAP_MS);
  });

  it('holds while a terminal pane under the scope is still moving, and ends two still frames after', async () => {
    // A maximize reaches its terminals in hops a frame apart (the panel box, the
    // layer's container size, the windows, each terminal's observer). Ending on
    // one quiet frame let a terminal's last hop land after the landing.
    const scope = fakeScope();
    let hopsLeft = 40;
    let framesAfterLastHop = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(() => {
      if (hopsLeft > 0) {
        hopsLeft -= 1;
        scope.paneBoxes = [{ left: 0, top: 0, width: 400 + (40 - hopsLeft) * 10, height: 300 }];
      } else {
        framesAfterLastHop += 1;
      }
      callback();
    }, 5));
    runTerminalLayoutChange(asElement(scope), () => {});
    await landingDuration(scope);
    expect(hopsLeft).toBe(0);
    expect(framesAfterLastHop).toBeGreaterThanOrEqual(2);
  });

  it('joins a second change to the open landing and runs each once', async () => {
    const scope = fakeScope();
    const first = vi.fn();
    const second = vi.fn();
    runTerminalLayoutChange(asElement(scope), first);
    await tick(40);
    runTerminalLayoutChange(asElement(scope), second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    await landingDuration(scope);
    expect(isTerminalLayoutLandingFor(scope.terminal as Element)).toBe(false);
  });

  it('ends the landing by the cap even if the scope never holds still', async () => {
    const scope = fakeScope();
    let width = 400;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(() => {
      width += 1;
      scope.paneBoxes = [{ left: 0, top: 0, width, height: 300 }];
      callback();
    }, 5));
    runTerminalLayoutChange(asElement(scope), () => {});
    const held = await landingDuration(scope);
    expect(held).toBeGreaterThanOrEqual(LAYOUT_LANDING_CAP_MS - 20);
    expect(held).toBeLessThan(LAYOUT_LANDING_CAP_MS + 200);
  });

  it('a terminal outside any landing finds none', () => {
    expect(isTerminalLayoutLandingFor({} as Element)).toBe(false);
    expect(isTerminalLayoutLandingFor(null)).toBe(false);
  });
});

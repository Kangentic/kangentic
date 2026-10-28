/**
 * The frame hold's landing: a user's layout change runs at once and opens a
 * landing on its scope, during which a terminal that refits holds its frame
 * rather than reflowing it (`useTerminal`). The unit tier has no DOM, so a fake
 * scope stands in for the element. It also carries a `startViewTransition` that
 * counts its calls, so a test can show nothing freezes the scope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  countHiddenFrames,
  isTerminalLayoutLandingFor,
  LAYOUT_LANDING_CAP_MS,
  LAYOUT_LANDING_IDLE_MS,
  LAYOUT_LANDING_MIN_MS,
  nextFrame,
  noteTerminalFitInLanding,
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

  it('keeps a landing open to its idle ceiling while no terminal has fitted in it', async () => {
    // A change can reach its terminals through a render React runs in a task of
    // its own, so a still scope right after the click is not yet the result.
    const scope = fakeScope();
    // The clock starts before the click opens the landing. Started after it,
    // the reading drops whatever the click took, and a loaded runner read 493.6
    // ms against the 495 ms floor.
    const clickedAt = performance.now();
    runTerminalLayoutChange(asElement(scope), () => {});
    await landingDuration(scope);
    const held = performance.now() - clickedAt;
    expect(held).toBeGreaterThanOrEqual(LAYOUT_LANDING_IDLE_MS - 5);
    expect(held).toBeLessThan(LAYOUT_LANDING_CAP_MS);
  });

  it('keeps a landing open for a terminal fit that comes long after the click, then ends soon after it', async () => {
    // The Command Terminal panel's maximize reached its terminals more than
    // 150 ms after the click on a loaded runner (4 of 6 runs on two cores). The
    // scope's boxes had moved and held still, the landing closed, and the
    // terminals reflowed instead of holding their frames.
    const scope = fakeScope();
    const clickedAt = performance.now();
    let fittedAt: number | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(() => {
      if (performance.now() - clickedAt < 20) scope.paneBoxes = [{ left: 0, top: 0, width: 900, height: 600 }];
      if (fittedAt === null && performance.now() - clickedAt > 300) {
        fittedAt = performance.now();
        noteTerminalFitInLanding(scope.terminal as Element);
      }
      callback();
    }, 5));
    runTerminalLayoutChange(asElement(scope), () => {});
    await landingDuration(scope);
    // The fit found the landing open, and the landing closed near the minimum after it,
    // not at the idle ceiling.
    expect(fittedAt).not.toBeNull();
    expect(performance.now() - fittedAt!).toBeLessThan(LAYOUT_LANDING_MIN_MS + 100);
  });

  it('ends near its minimum once a terminal has fitted and the scope holds still', async () => {
    const scope = fakeScope();
    let fitted = false;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(() => {
      if (!fitted) {
        fitted = true;
        noteTerminalFitInLanding(scope.terminal as Element);
      }
      callback();
    }, 5));
    runTerminalLayoutChange(asElement(scope), () => {});
    const held = await landingDuration(scope);
    expect(held).toBeGreaterThanOrEqual(LAYOUT_LANDING_MIN_MS - 5);
    expect(held).toBeLessThan(LAYOUT_LANDING_IDLE_MS - 100);
  });

  it('counts a fit only toward a landing whose scope holds the terminal', async () => {
    const scope = fakeScope();
    runTerminalLayoutChange(asElement(scope), () => {});
    noteTerminalFitInLanding({} as Element);
    noteTerminalFitInLanding(null);
    const held = await landingDuration(scope);
    expect(held).toBeGreaterThanOrEqual(LAYOUT_LANDING_IDLE_MS - 5);
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

/**
 * The swap's dev trace counts the frames that painted with the screen hidden
 * (`framesHidden`), and the maximize spec bounds the blank frames it sees on screen by it. The
 * count came out a frame short when the screen was shown by nextFrame's 50 ms fallback, which a
 * starved runner takes, so one blank frame read as an unaccounted flash.
 */
describe('nextFrame and countHiddenFrames', () => {
  let queued: Array<(frameTime: number) => void> = [];

  /**
   * One frame: the callbacks queued before it began run in order with the frame's time, and any
   * queued meanwhile wait for the next one, as the browser does.
   */
  function runFrame(frameTime: number): void {
    const due = queued;
    queued = [];
    for (const callback of due) callback(frameTime);
  }

  /** Start a nextFrame wait and read what it resolved with once it has. */
  function waitForNextFrame(): { result: () => number | null | undefined } {
    let shownAt: number | null | undefined;
    void nextFrame().then((value) => { shownAt = value; });
    return { result: () => shownAt };
  }

  beforeEach(() => {
    queued = [];
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: (frameTime: number) => void) => queued.push(callback));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('nextFrame resolves with the frame time, or with null when 50 ms pass first', async () => {
    const onFrame = waitForNextFrame();
    runFrame(16);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFrame.result()).toBe(16);

    const onFallback = waitForNextFrame();
    await vi.advanceTimersByTimeAsync(49);
    expect(onFallback.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFallback.result()).toBeNull();
    // The frame that comes late changes nothing.
    runFrame(90);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFallback.result()).toBeNull();
  });

  it('counts a frame painted hidden when the screen is shown by the 50 ms fallback', async () => {
    // The frame after the hide paints hidden, and no later frame comes within 50 ms, so the screen
    // is shown from a timer between frames. One frame painted blank.
    const count = countHiddenFrames();
    runFrame(16);
    const shown = waitForNextFrame();
    await vi.advanceTimersByTimeAsync(50);
    expect(shown.result()).toBeNull();
    expect(count.finish(shown.result() ?? null)).toBe(1);
  });

  it('counts every frame painted hidden on the fallback, and none when there was none', async () => {
    const count = countHiddenFrames();
    runFrame(16);
    runFrame(33);
    runFrame(50);
    const shown = waitForNextFrame();
    await vi.advanceTimersByTimeAsync(50);
    expect(count.finish(shown.result() ?? null)).toBe(3);

    const idle = countHiddenFrames();
    const shownWithNoFrame = waitForNextFrame();
    await vi.advanceTimersByTimeAsync(50);
    expect(idle.finish(shownWithNoFrame.result() ?? null)).toBe(0);
  });

  it('does not count the frame the screen is shown in, when the counter ran first in it', async () => {
    // Frame 1 paints hidden. The show waits for frame 2, where the counter's callback runs before
    // the show's: the screen is visible when frame 2 paints, so one frame painted hidden.
    const count = countHiddenFrames();
    runFrame(16);
    const shown = waitForNextFrame();
    runFrame(33);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.result()).toBe(33);
    expect(count.finish(shown.result() ?? null)).toBe(1);
  });

  it('counts none when the screen is shown in the first frame after the hide', async () => {
    // The swap working: hidden and shown before the first paint.
    const count = countHiddenFrames();
    const shown = waitForNextFrame();
    runFrame(16);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.result()).toBe(16);
    expect(count.finish(shown.result() ?? null)).toBe(0);
  });

  it('does not count the frame the screen is shown in, when the show ran first in it', async () => {
    // The show's callback is ahead of the counter's, so the screen is visible when this frame
    // paints whether or not the counter's callback ran before the show stopped it.
    const shown = waitForNextFrame();
    const count = countHiddenFrames();
    runFrame(16);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.result()).toBe(16);
    expect(count.finish(shown.result() ?? null)).toBe(0);
  });

  it('stops counting once finished', async () => {
    const count = countHiddenFrames();
    runFrame(16);
    expect(count.finish(null)).toBe(1);
    runFrame(33);
    runFrame(50);
    expect(queued).toHaveLength(0);
  });
});

/**
 * The three-way viewport dispatch, and the promise that the number an agent
 * reads back is the one the page actually laid out against.
 *
 * Two things here are worth more than the rest, and both are shapes that would
 * fail silently rather than loudly:
 *
 * 1. WHICH MECHANISM RAN. `entry.kind` is `'pane'` for a docked pane and a
 *    popped-out one alike, so a dispatch that forks on it alone sends a real
 *    OS window down the emulation path. Every case below asserts the two paths
 *    NOT taken as well as the one that was; asserting only "some resize
 *    happened" passes against exactly the bug this guards.
 * 2. MEASURED, NOT ECHOED. A window loses its frame and the pane's chrome to
 *    the viewport, a lane can be clamped, and an override composes with zoom,
 *    so the request and the result differ routinely. Reporting the request
 *    would hand an agent a measurement taken at a width the page never had.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A STATEFUL window, because a static one hides the bugs this file exists to
 * catch. With `getContentSize` frozen, the loop's derived ceiling is computed
 * from a size the window never had, and a resize that silently does nothing
 * looks identical to one that worked - which is exactly how the stale-read
 * exit survived a passing test. A pop-out is frameless (`titleBarStyle:
 * 'hidden'`), so its outer bounds track its content size.
 */
let windowContent = { width: 1280, height: 800 };
/** Outer bounds minus content. Zero for Kangentic's frameless pop-out
 *  (`titleBarStyle: 'hidden'`); a test sets it to model an OS frame. */
let windowFrame = { width: 0, height: 0 };
const setContentSize = vi.fn((width: number, height: number) => {
  windowContent = { width, height };
  windowBounds = {
    ...windowBounds,
    width: width + windowFrame.width,
    height: height + windowFrame.height,
  };
});
const getContentSize = vi.fn(() => [windowContent.width, windowContent.height]);
const laneWindow = vi.fn();
const popOutWindowFor = vi.fn();
const popOutHas = vi.fn(() => false);
const suppressBoundsSave = vi.fn(() => releaseBoundsSave);
const releaseBoundsSave = vi.fn();

const setDeviceMetrics = vi.fn(async () => true);
const clearDeviceMetrics = vi.fn(async () => true);
const getDeviceMetrics = vi.fn(() => null as { width: number; height: number } | null);
const getLayoutMetrics = vi.fn();
const runtimeEvaluate = vi.fn();

/** The docked pane's widget, which is what an auto-fit zoom is computed from. */
const PANE_WIDGET = { width: 740, height: 749 };
const isMaximized = vi.fn(() => false);
const isFullScreen = vi.fn(() => false);
const unmaximize = vi.fn();
const setFullScreen = vi.fn();
const setPosition = vi.fn();
/** Where the window under test currently sits, for the overhang cases. */
let windowBounds = { x: 0, y: 0, width: 1280, height: 800 };

vi.mock('electron', () => ({
  screen: {
    getDisplayMatching: () => ({
      workAreaSize: { width: 2560, height: 1392 },
      workArea: { x: 0, y: 0, width: 2560, height: 1392 },
    }),
    getPrimaryDisplay: () => ({
      workAreaSize: { width: 2560, height: 1392 },
      workArea: { x: 0, y: 0, width: 2560, height: 1392 },
    }),
  },
  BrowserWindow: {
    fromWebContents: () => ({
      // Deliberately the WHOLE-WINDOW size, several times the pane, which is
      // what main sees and what reading it instead of the renderer's report
      // would give. A fit computed against this is 1, so every fit assertion
      // below fails if the wrong source is used.
      getContentSize: () => [2545, 1272],
      getBounds: () => ({ x: 0, y: 0, width: 2545, height: 1272 }),
      isDestroyed: () => false,
      isMaximized: (...args: unknown[]) => isMaximized(...(args as [])),
      isFullScreen: (...args: unknown[]) => isFullScreen(...(args as [])),
      unmaximize: (...args: unknown[]) => unmaximize(...(args as [])),
      setFullScreen: (...args: unknown[]) => setFullScreen(...(args as [])),
    }),
  },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock('../../src/main/browser/cdp/cdp', () => ({
  setDeviceMetrics: (...args: unknown[]) => setDeviceMetrics(...(args as [])),
  clearDeviceMetrics: (...args: unknown[]) => clearDeviceMetrics(...(args as [])),
  getDeviceMetrics: (...args: unknown[]) => getDeviceMetrics(...(args as [])),
  getLayoutMetrics: (...args: unknown[]) => getLayoutMetrics(...(args as [])),
  runtimeEvaluate: (...args: unknown[]) => runtimeEvaluate(...(args as [])),
}));

vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  DEFAULT_LANE_WIDTH: 1280,
  DEFAULT_LANE_HEIGHT: 800,
  laneWindow: (...args: unknown[]) => laneWindow(...(args as [])),
}));

vi.mock('../../src/main/pop-out/pop-out-window-manager', () => ({
  popOutWindowManager: {
    has: (...args: unknown[]) => popOutHas(...(args as [])),
    windowFor: (...args: unknown[]) => popOutWindowFor(...(args as [])),
    suppressBoundsSave: (...args: unknown[]) => suppressBoundsSave(...(args as [])),
  },
}));

import {
  applyViewport,
  clearViewport,
  resolveMechanism,
} from '../../src/main/browser/viewport-override';
import { resetViewportOverrideStore, getViewportOverride } from '../../src/main/browser/viewport-override-store';
import type { BrowserPaneEntry } from '../../src/main/browser/browser-pane-registry';

function entryOf(overrides: Partial<BrowserPaneEntry> = {}): BrowserPaneEntry {
  return {
    sessionId: 'pane_abc12345',
    ownerSessionId: 'agent-1',
    taskId: 'task-1',
    projectId: 'project-1',
    webContentsId: 42,
    url: 'http://localhost:5173',
    kind: 'pane',
    handoff: false,
    // The renderer's report. This, not the host window, is what a fit is
    // computed against: the electron mock's window is 2545 wide on purpose, so
    // a regression that reads the window instead of the pane computes a zoom
    // of 1 and these tests fail.
    widgetSize: { ...PANE_WIDGET },
    ...overrides,
  } as BrowserPaneEntry;
}

function guestOf() {
  // The zoom factor round-trips, because the emulation path READS it back to
  // compensate the override. A stub that always answered 1 would make the
  // compensation test pass without the compensation.
  let zoom = 1;
  return {
    id: 42,
    isDestroyed: () => false,
    setZoomFactor: vi.fn((value: number) => { zoom = value; }),
    getZoomFactor: vi.fn(() => zoom),
    hostWebContents: undefined,
  } as never;
}

/**
 * The page answering with a fixed viewport.
 *
 * `readViewport` asks the page for `innerWidth` / `innerHeight` rather than
 * reading `Page.getLayoutMetrics`, because the latter reports the content box
 * with the scrollbar removed (a 1920 request measured 1905 on a scrolling
 * page). Both are stubbed so the fallback path stays exercised too.
 */
function metricsAlways(width: number, height: number) {
  runtimeEvaluate.mockResolvedValue({ value: { width, height }, error: null });
  getLayoutMetrics.mockResolvedValue({
    viewportWidth: width,
    viewportHeight: height,
    deviceScaleFactor: 1,
    contentWidth: width,
    contentHeight: height,
  });
}

/**
 * The page answering as a real one does: its viewport DERIVES from the
 * window's content size, minus the pane's own toolbars.
 *
 * `metricsAlways` cannot model a window path at all - it returns the same
 * viewport no matter what the window does, so `content - viewport` computes
 * as zero and every chrome-derived number comes out wrong. That is not a
 * finding about the code, only about the stub, so window-resize tests use
 * this.
 *
 * `lagFirstRead` replays the stale frame a real page serves for a tick or two
 * after a resize, which is the failure mode two separate bugs came from.
 */
function metricsFromContent(chrome: { width: number; height: number }, options: { lagFirstRead?: boolean } = {}) {
  let pending = options.lagFirstRead === true;
  let lastReported = { width: windowContent.width - chrome.width, height: windowContent.height - chrome.height };
  runtimeEvaluate.mockImplementation(() => {
    const settled = {
      width: Math.max(0, windowContent.width - chrome.width),
      height: Math.max(0, windowContent.height - chrome.height),
    };
    if (pending && !isSameSize(settled, lastReported)) {
      pending = false;
      return Promise.resolve({ value: lastReported, error: null });
    }
    lastReported = settled;
    return Promise.resolve({ value: settled, error: null });
  });
  getLayoutMetrics.mockResolvedValue(null);
}

function isSameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return a.width === b.width && a.height === b.height;
}

/** A sequence of successive viewport readings, for the correction pass. */
function metricsSequence(...sizes: { width: number; height: number }[]) {
  for (const size of sizes) {
    runtimeEvaluate.mockResolvedValueOnce({ value: size, error: null });
  }
  const last = sizes[sizes.length - 1];
  runtimeEvaluate.mockResolvedValue({ value: last, error: null });
}

/** The zoom the emulation path picks to fit `width` into the pane widget. */
function expectedFitZoom(width: number, height: number): number {
  return Math.min(1, PANE_WIDGET.width / width, PANE_WIDGET.height / height);
}

function windowStub() {
  return {
    setContentSize,
    getContentSize,
    getBounds: () => windowBounds,
    setPosition: (...args: unknown[]) => setPosition(...(args as [])),
    isDestroyed: () => false,
    isMaximized: (...args: unknown[]) => isMaximized(...(args as [])),
    isFullScreen: (...args: unknown[]) => isFullScreen(...(args as [])),
    unmaximize: (...args: unknown[]) => unmaximize(...(args as [])),
    setFullScreen: (...args: unknown[]) => setFullScreen(...(args as [])),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` empties call history but NOT a `mockImplementationOnce`
  // queue, so a once-throw a test queues and does not consume leaks into
  // whichever test runs next. `mockReset` drains it, and these two carry no
  // default implementation to lose.
  setContentSize.mockClear();
  getLayoutMetrics.mockReset();
  runtimeEvaluate.mockReset();
  isMaximized.mockReturnValue(false);
  isFullScreen.mockReturnValue(false);
  windowBounds = { x: 0, y: 0, width: 1280, height: 800 };
  windowContent = { width: 1280, height: 800 };
  windowFrame = { width: 0, height: 0 };
  resetViewportOverrideStore();
  windowContent = { width: 1280, height: 800 };
  popOutHas.mockReturnValue(false);
  suppressBoundsSave.mockReturnValue(releaseBoundsSave);
  setDeviceMetrics.mockResolvedValue(true);
  clearDeviceMetrics.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('viewport mechanism dispatch', () => {
  it('sends a LANE to a real window resize and never to emulation', async () => {
    laneWindow.mockReturnValue(windowStub());
    // The lane starts at its 1280x800 default, so 1920x1080 is a real change.
    // An offscreen window has no chrome, measured on Electron 41.
    metricsFromContent({ width: 0, height: 0 });

    const outcome = await applyViewport(
      guestOf(),
      entryOf({ kind: 'lane', sessionId: 'lane_deadbeef' }),
      { width: 1920, height: 1080 },
      'agent-1',
    );

    expect(outcome.mechanism).toBe('lane-resize');
    expect(laneWindow).toHaveBeenCalledWith('lane_deadbeef');
    expect(setContentSize).toHaveBeenCalledWith(1920, 1080);
    expect(setDeviceMetrics).not.toHaveBeenCalled();
    expect(popOutWindowFor).not.toHaveBeenCalled();
  });

  it('sends a POPPED-OUT pane to its window, not to emulation', async () => {
    // The case a fork on `entry.kind` alone gets wrong: still kind 'pane'.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    // Starts at 1280x800, so 1600x900 is a real change rather than a no-op.
    metricsFromContent({ width: 0, height: 0 });

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1600, height: 900 }, 'agent-1');

    expect(outcome.mechanism).toBe('window-resize');
    expect(popOutWindowFor).toHaveBeenCalledWith('browser', { projectId: 'project-1', taskId: 'task-1' });
    expect(setContentSize).toHaveBeenCalledWith(1600, 900);
    expect(setDeviceMetrics).not.toHaveBeenCalled();
    expect(laneWindow).not.toHaveBeenCalled();
  });

  it('sends a DOCKED pane to emulation and never to a window resize', async () => {
    metricsAlways(1920, 1080);

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1920, height: 1080 }, 'agent-1');

    expect(outcome.mechanism).toBe('device-emulation');
    expect(setDeviceMetrics).toHaveBeenCalledTimes(1);
    expect(setContentSize).not.toHaveBeenCalled();
    expect(laneWindow).not.toHaveBeenCalled();
    expect(popOutWindowFor).not.toHaveBeenCalled();
  });

  it('resolveMechanism is the whole decision, and reads the pop-out registry', () => {
    expect(resolveMechanism(entryOf({ kind: 'lane' }))).toBe('lane-resize');
    popOutHas.mockReturnValue(false);
    expect(resolveMechanism(entryOf())).toBe('device-emulation');
    popOutHas.mockReturnValue(true);
    expect(resolveMechanism(entryOf())).toBe('window-resize');
  });
});

describe('the reported viewport is measured, not echoed', () => {
  it('reports the page viewport and exact:false when the surface gave something else', async () => {
    // A window resize loses the frame and the pane chrome; a lane can be
    // clamped. Either way the agent must be told what it GOT.
    vi.useFakeTimers();
    laneWindow.mockReturnValue(windowStub());
    metricsAlways(1264, 761);

    const pending = applyViewport(
      guestOf(),
      entryOf({ kind: 'lane', sessionId: 'lane_deadbeef' }),
      { width: 1280, height: 800 },
      'agent-1',
    );
    // Enough for every convergence pass (each waits up to RESIZE_SETTLE_TIMEOUT_MS).
    await vi.advanceTimersByTimeAsync(10000);
    const outcome = await pending;

    expect(outcome.requested).toEqual({ width: 1280, height: 800 });
    expect(outcome.viewport).toEqual({ width: 1264, height: 761 });
    expect(outcome.exact).toBe(false);
    expect(outcome.note).toContain('1264x761');
  });

  it('corrects for chrome the window subtracted, instead of reporting it as a clamp', async () => {
    // First measure comes back short by the title bar plus the pane toolbar;
    // the second setContentSize has to add that back, or every single call is
    // wrong by a fixed amount.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowContent = { width: 1600, height: 900 };
    // Four reads in order: the pre-dispatch read that fills in an omitted
    // axis, the PRE-RESIZE read the correction measures against, the settled
    // read after the resize (short by the chrome), then the read after the
    // correction. The second one is what stops the delta being computed
    // against a stale value, which is what sent a 1280 request to 464.
    metricsSequence(
      { width: 740, height: 749 },
      { width: 740, height: 749 },
      { width: 1600, height: 830 },
      { width: 1600, height: 900 },
    );

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1600, height: 900 }, 'agent-1');

    expect(setContentSize).toHaveBeenNthCalledWith(1, 1600, 900);
    // 900 asked for, 830 delivered, so the window needs 70 more.
    expect(setContentSize).toHaveBeenNthCalledWith(2, 1600, 970);
    expect(outcome.viewport).toEqual({ width: 1600, height: 900 });
    expect(outcome.exact).toBe(true);
  });

  it('does not correct against a STALE reading and overshoot', async () => {
    // Reported live: shrinking a 2096-wide window to 1280x720 produced
    // 464x232, and 900x700 grew to 1136x1048. The correction was measuring a
    // pre-resize frame, so its "chrome delta" was the whole size difference:
    // 1280 + (1280 - 2096) = 464. The wait now requires a reading that is at
    // the target or different from the pre-resize one.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    // A wide window, shrinking to 1280x720, with the page serving one stale
    // frame after the resize - which is what the correction used to measure.
    windowContent = { width: 2096, height: 1200 };
    windowBounds = { x: 0, y: 0, width: 2096, height: 1200 };
    metricsFromContent({ width: 0, height: 78 }, { lagFirstRead: true });

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1280, height: 720 }, 'agent-1');

    // Never a wild undershoot: 1280 + (1280 - 2096) = 464 was the old answer.
    for (const call of setContentSize.mock.calls as unknown as [number, number][]) {
      expect(call[0]).toBeGreaterThan(600);
      expect(call[1]).toBeGreaterThan(400);
    }
    expect(outcome.viewport).toEqual({ width: 1280, height: 720 });
    expect(outcome.exact).toBe(true);
  });

  it('never sizes a window past the display, so it cannot span two monitors', async () => {
    // A multi-monitor desktop is one coordinate space, so an oversized
    // setContentSize does not clamp - the window spills onto the next screen.
    // Reported live after a maximized pop-out. The display here is 2560 wide.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    metricsAlways(2560, 1392);

    await applyViewport(guestOf(), entryOf(), { width: 5000, height: 3000 }, 'agent-1');

    for (const call of setContentSize.mock.calls as unknown as [number, number][]) {
      expect(call[0]).toBeLessThanOrEqual(2560);
      expect(call[1]).toBeLessThanOrEqual(1392);
    }
  });

  it('keeps trying when the window ignores the first resize outright', async () => {
    // Measured live: a 1280x720 request came back 1203x601, and a following
    // 1280x601 request came back 1203x601 AGAIN - identical numbers for two
    // different asks, so the window had not moved at all. `unmaximize()`
    // animates on Windows and discards a same-tick `setContentSize`. A single
    // correction has no answer for that; a convergence loop does, because it
    // never needs to know why the last attempt fell short.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowContent = { width: 1280, height: 720 };
    metricsSequence(
      { width: 2483, height: 1273 }, // pre-dispatch
      { width: 2483, height: 1273 }, // first resize IGNORED: nothing moved
      { width: 1203, height: 601 },  // second attempt lands, short by chrome
      { width: 1280, height: 720 },  // third pays the chrome and hits it
    );

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1280, height: 720 }, 'agent-1');

    expect(setContentSize.mock.calls.length).toBeGreaterThan(1);
    expect(outcome.viewport).toEqual({ width: 1280, height: 720 });
    expect(outcome.exact).toBe(true);
  });

  it('pulls a window back onto its display instead of letting it overhang', async () => {
    // `setContentSize` keeps the top-left and grows right and down, so a
    // window part-way across the desktop sized to the full work area runs off
    // the edge onto the next monitor. Sizing it right is only half of "full
    // screen on THIS monitor"; a full-work-area window has exactly one
    // position that fits, which is the origin.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowBounds = { x: 925, y: 40, width: 2560, height: 1392 };
    metricsAlways(2560, 1392);

    await applyViewport(guestOf(), entryOf(), { width: 2560, height: 1392 }, 'agent-1');

    expect(setPosition).toHaveBeenCalledWith(0, 0);
  });

  it('leaves a window that still fits where the user put it', async () => {
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowBounds = { x: 300, y: 100, width: 800, height: 600 };
    metricsAlways(800, 600);

    await applyViewport(guestOf(), entryOf(), { width: 800, height: 600 }, 'agent-1');

    expect(setPosition).not.toHaveBeenCalled();
  });

  it('places a window at a requested anchor, so "dock it left" has an answer', async () => {
    // Sizing without placing was the gap: a 1280x1392 window on a 2560 display
    // is exactly half the screen and still sits wherever it happened to be, so
    // "dock it to the left of the monitor" had no way to be expressed and the
    // agent correctly said it could not do it.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowBounds = { x: 900, y: 200, width: 1280, height: 1392 };
    metricsAlways(1280, 1392);

    await applyViewport(
      guestOf(),
      entryOf(),
      { width: 1280, height: 1392, position: 'left' },
      'agent-1',
    );

    expect(setPosition).toHaveBeenLastCalledWith(0, 0);
  });

  it('never places a window where its own title bar is off the screen', async () => {
    // `left` resolves vertically to MIDDLE, and a full-height window is its
    // content plus the frame, so centring computed y = (1392 - 1432) / 2 =
    // -20 and put the pop-out's title bar above the top of the display. An
    // anchor is clamped into the work area for exactly this.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    // Outer bounds TALLER than the 1392 work area: content plus a 40px frame.
    windowBounds = { x: 600, y: 0, width: 1280, height: 1432 };
    metricsAlways(1280, 1392);

    await applyViewport(
      guestOf(),
      entryOf(),
      { width: 1280, height: 1392, position: 'left' },
      'agent-1',
    );

    for (const call of setPosition.mock.calls as unknown as [number, number][]) {
      expect(call[0]).toBeGreaterThanOrEqual(0);
      expect(call[1]).toBeGreaterThanOrEqual(0);
    }
  });

  it('shrinks a window whose FRAME pushes it past the display', async () => {
    // The size clamp caps the requested VIEWPORT, which is the content box.
    // The frame is added on top, so a viewport the height of the work area
    // makes a window taller than the screen, and the clamp cannot see it
    // because the frame is not known until the window is laid out.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    // A framed window, unlike the frameless pop-out: 40px of OS frame on top
    // of whatever content it is given.
    windowFrame = { width: 0, height: 40 };
    windowContent = { width: 1280, height: 1392 };
    windowBounds = { x: 0, y: 0, width: 1280, height: 1432 };
    metricsFromContent({ width: 0, height: 78 });

    await applyViewport(guestOf(), entryOf(), { width: 1280, height: 1392 }, 'agent-1');

    // Whatever it settles on, the OUTER bounds never exceed the 1392 work
    // area - which is the property, rather than any one intermediate call.
    expect(windowBounds.height).toBeLessThanOrEqual(1392);
  });

  it('anchors right and bottom against the work area, not the origin', async () => {
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowBounds = { x: 0, y: 0, width: 1000, height: 800 };
    metricsAlways(1000, 800);

    await applyViewport(
      guestOf(),
      entryOf(),
      { width: 1000, height: 800, position: 'bottom-right' },
      'agent-1',
    );

    // 2560 - 1000, 1392 - 800
    expect(setPosition).toHaveBeenLastCalledWith(1560, 592);
  });

  it('says a position was ignored on a docked pane instead of dropping it', async () => {
    // The agent asked for a position and was told positioning is not
    // supported. It IS, on a window - so the refusal has to name the step that
    // makes it possible rather than leaving the caller to guess.
    metricsAlways(1920, 1080);

    const outcome = await applyViewport(
      guestOf(),
      entryOf(),
      { width: 1920, height: 1080, position: 'top-left' },
      'agent-1',
    );

    expect(setPosition).not.toHaveBeenCalled();
    expect(outcome.note).toContain('kangentic_browser_pop_out');
  });

  it('does NOT clamp a lane to the display, which is the point of a lane', async () => {
    // An offscreen lane is bound by no monitor: measured accepting 5000x4000
    // on a 2560-wide screen. The clamp is shared with the window path, so this
    // is the guard against it leaking onto a surface nobody is looking at.
    laneWindow.mockReturnValue(windowStub());
    metricsFromContent({ width: 0, height: 0 });

    const outcome = await applyViewport(
      guestOf(),
      entryOf({ kind: 'lane', sessionId: 'lane_deadbeef' }),
      { width: 5000, height: 4000 },
      'agent-1',
    );

    expect(setContentSize).toHaveBeenCalledWith(5000, 4000);
    expect(outcome.viewport).toEqual({ width: 5000, height: 4000 });
    expect(outcome.exact).toBe(true);
  });

  it('stops at the reachable ceiling instead of fighting the display cap', async () => {
    // The jitter this removes: the same 1280x1392 request measured 1272 one
    // run and 1274 the next. The loop kept asking for a shortfall a window
    // can never be given (the frame and toolbars come out of the work area
    // first), `shrinkToFitDisplay` took the growth straight back, and the
    // result landed wherever the tug-of-war happened to stop. Knowing the
    // reachable maximum ends it in one pass, deterministically.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowBounds = { x: 0, y: 0, width: 1280, height: 1392 };
    windowContent = { width: 1280, height: 1352 };
    metricsAlways(1280, 1274);

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1280, height: 1392 }, 'agent-1');

    expect(outcome.viewport).toEqual({ width: 1280, height: 1274 });
    // One resize, not three: the ceiling is known after the first measurement.
    expect(setContentSize.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('does not shrink a window that already shows the requested viewport', async () => {
    // Reported live, and the bug that survived the first stale-read fix.
    //
    // `setContentSize` takes a CONTENT size, so asking for the viewport the
    // window already shows sets the content to a number short by the chrome.
    // The window really did end up ~78px short; the first poll still read the
    // pre-resize value, which equalled the goal, so the call reported
    // `exact: true` on a reading taken before the page moved, and
    // `reachableViewport` then saw content minus viewport as zero and gave
    // the maximum as the whole 1392 work area.
    //
    // The assertions are the three things the user could see, not a call
    // count: the window kept its size, the number reported is the real one,
    // and the maximum is not the bare work area.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowContent = { width: 2560, height: 1352 };
    windowBounds = { x: 0, y: 0, width: 2560, height: 1352 };
    metricsFromContent({ width: 0, height: 78 }, { lagFirstRead: true });

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 2560, height: 1274 }, 'agent-1');

    expect(windowContent).toEqual({ width: 2560, height: 1352 });
    expect(outcome.viewport).toEqual({ width: 2560, height: 1274 });
    expect(outcome.maxWindowViewport?.height).toBeLessThan(1392);
    // Not just "ends up right": it never shrank on the way. The end state is
    // the same either way once the correction passes run, so only this catches
    // the flinch the user sees, and the settle timeouts it burns.
    for (const [, height] of setContentSize.mock.calls as unknown as [number, number][]) {
      expect(height).toBeGreaterThanOrEqual(1352);
    }
  });

  it('repositions without resizing when the request names no size', async () => {
    // Same shape as the `maximized` bug the user reported: a parameter that is
    // not about size fell into the resize path, where an absent width/height
    // defaults to the CURRENT viewport and is then set as the CONTENT. The
    // window shrank by the chrome and climbed back, for a call that asked only
    // for it to be moved.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowBounds = { x: 900, y: 200, width: 1280, height: 1392 };
    windowContent = { width: 1280, height: 1352 };
    metricsFromContent({ width: 0, height: 78 });

    const outcome = await applyViewport(guestOf(), entryOf(), { position: 'top-left' }, 'agent-1');

    expect(setPosition).toHaveBeenLastCalledWith(0, 0);
    // The resize is not merely undone afterwards - it never happens. The
    // correction passes put the size back either way, so a check on the end
    // state alone passes against the bug.
    expect(setContentSize).not.toHaveBeenCalled();
    expect(windowContent).toEqual({ width: 1280, height: 1352 });
    expect(outcome.viewport).toEqual({ width: 1280, height: 1274 });
  });

  it('does not wait out the settle timeout when the clamp undoes the resize', async () => {
    // An over-cap request DOES differ from the current size, so comparing what
    // was asked for called it a change and then polled for a relayout that was
    // never coming: `shrinkToFitDisplay` had already put the content back.
    // Reading the content size back AFTER the clamp is what tells the two
    // apart.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowFrame = { width: 0, height: 40 };
    windowContent = { width: 2560, height: 1352 };
    windowBounds = { x: 0, y: 0, width: 2560, height: 1392 };
    metricsFromContent({ width: 0, height: 78 });

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 6000, height: 4000 }, 'agent-1');

    expect(outcome.exact).toBe(false);
    expect(outcome.viewport).toEqual({ width: 2560, height: 1274 });
    // A burnt settle timeout is 800ms of polling at 40ms, so ~20 reads per
    // pass. A handful means it never waited.
    expect(runtimeEvaluate.mock.calls.length).toBeLessThan(10);
  });

  it('reports the same maximum whether the request succeeded or was capped', async () => {
    // Observed live: three calls refused a 1392-tall viewport and reported the
    // maximum as 1274, then the NEXT call succeeded and reported it as 1392.
    // Two chrome sums - the loop's counted the frame and the toolbars, the
    // response's counted only the toolbars - so they agreed only while the
    // resize was failing. One source of truth.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowContent = { width: 2560, height: 1352 };
    windowBounds = { x: 0, y: 0, width: 2560, height: 1352 };
    metricsFromContent({ width: 0, height: 78 });

    const succeeded = await applyViewport(guestOf(), entryOf(), { width: 2560, height: 1274 }, 'agent-1');
    expect(succeeded.exact).toBe(true);
    const maxOnSuccess = succeeded.maxWindowViewport;

    const capped = await applyViewport(guestOf(), entryOf(), { width: 2560, height: 1392 }, 'agent-1');
    expect(capped.exact).toBe(false);

    // The same window on the same display has one maximum, whichever way the
    // call went, and it is never the full work area.
    expect(maxOnSuccess).toEqual(capped.maxWindowViewport);
    expect(maxOnSuccess?.height).toBeLessThan(1392);
  });

  it('explains a chrome shortfall against the WINDOW maximum, not the display', async () => {
    // Live: an agent was handed `display: 1392`, asked for 1392 of height, and
    // got 1274 with a bare "clamped to 2560x1274" - arbitrary-looking, one
    // line after being told the screen was taller. 1274 IS the maximum, since
    // the frame and the pane's toolbars come out of the work area, and the
    // note has to say that. Comparing against the display missed it entirely,
    // because 1392 is not GREATER than 1392.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    windowBounds = { x: 0, y: 0, width: 2560, height: 1392 };
    windowContent = { width: 2560, height: 1392 };
    metricsAlways(2560, 1274);

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 2560, height: 1392 }, 'agent-1');

    expect(outcome.exact).toBe(false);
    expect(outcome.maxWindowViewport).toEqual({ width: 2560, height: 1274 });
    expect(outcome.note).toContain('maxWindowViewport');
    expect(outcome.note).toContain('2560x1274');
  });

  it('says WHY when a window request exceeds the display, and where to go instead', async () => {
    // Ultrawides, dual monitors and laptop-plus-external all differ, so the
    // bound is the matched display rather than any fixed number, and the note
    // names it rather than leaving the agent to infer a cap.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    metricsAlways(2560, 1392);

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 5000, height: 3000 }, 'agent-1');

    expect(outcome.exact).toBe(false);
    expect(outcome.note).toContain('2560x1392');
    // The way past a monitor is device emulation on the docked pane. It is no
    // longer "or an isolated lane": that argument came out with the one-surface
    // rule, and naming a tool parameter that does not exist sends the agent to
    // a schema error.
    expect(outcome.note).toContain('kangentic_browser_dock');
    expect(outcome.note).not.toContain('isolated');
  });

  it('reports the display work area so an agent can size against the screen', async () => {
    // An agent asked for "full height, half width" and had to infer the
    // screen from whatever the maximized window happened to be. It got it
    // wrong, so the number is reported rather than guessed.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    metricsAlways(1600, 900);

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1600, height: 900 }, 'agent-1');

    expect(outcome.display).toEqual({ width: 2560, height: 1392 });
    expect(outcome.maxWindowViewport).not.toBeNull();
  });

  it('records the measured viewport, not the request, for the pane chip', async () => {
    vi.useFakeTimers();
    laneWindow.mockReturnValue(windowStub());
    metricsAlways(1264, 761);

    const pending = applyViewport(
      guestOf(),
      entryOf({ kind: 'lane', sessionId: 'lane_deadbeef' }),
      { width: 1280, height: 800 },
      'agent-1',
    );
    // Enough for every convergence pass (each waits up to RESIZE_SETTLE_TIMEOUT_MS).
    await vi.advanceTimersByTimeAsync(10000);
    await pending;

    expect(getViewportOverride(42)?.measured).toEqual({ width: 1264, height: 761 });
  });
});

describe('an emulated pane says when it is showing a crop', () => {
  it('names pop_out when an explicit zoom re-creates the crop', async () => {
    // With the default fit there IS no crop, so this is the case an agent opts
    // into by pinning zoom to 1 for a 1:1 capture: the pane is 740 wide (see
    // the electron mock), 1920 does not fit, and the user sees a third of it.
    metricsAlways(1920, 1080);

    const outcome = await applyViewport(
      guestOf(),
      entryOf(),
      { width: 1920, height: 1080, zoom: 1 },
      'agent-1',
    );

    expect(outcome.visibleFraction).toBeLessThan(0.5);
    expect(outcome.note).toContain('kangentic_browser_pop_out');
    // And does NOT offer an offscreen surface as the way out of a crop: the
    // user would see none of it at all, which is worse than a third of it.
    expect(outcome.note).not.toContain('lane');
  });

  it('reports the whole viewport visible on a real window resize', async () => {
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    metricsAlways(1600, 900);

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1600, height: 900 }, 'agent-1');

    expect(outcome.visibleFraction).toBe(1);
    expect(outcome.note).toBeNull();
  });
});

describe('a maximized window can still be resized', () => {
  it('un-maximizes first, because setContentSize is ignored while maximized', async () => {
    // Reported live: an agent popped out maximized, asked for half the size,
    // got the same 2545x1272 back, and concluded the display was clamping it.
    // It was not - a maximized window silently ignores setContentSize.
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    isMaximized.mockReturnValue(true);
    // Maximized at 2560x1352 and asked for half, so the resize is real.
    windowContent = { width: 2560, height: 1352 };
    windowBounds = { x: 0, y: 0, width: 2560, height: 1352 };
    metricsFromContent({ width: 0, height: 0 });

    await applyViewport(guestOf(), entryOf(), { width: 1280, height: 720 }, 'agent-1');

    expect(unmaximize).toHaveBeenCalledTimes(1);
    expect(setContentSize).toHaveBeenCalledWith(1280, 720);
  });

  it('leaves full screen too, for the same reason', async () => {
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    isFullScreen.mockReturnValue(true);
    metricsAlways(1280, 720);

    await applyViewport(guestOf(), entryOf(), { width: 1280, height: 720 }, 'agent-1');

    expect(setFullScreen).toHaveBeenCalledWith(false);
  });

  it('does not un-maximize a window it is not resizing', async () => {
    metricsAlways(1920, 1080);

    await applyViewport(guestOf(), entryOf(), { width: 1920, height: 1080 }, 'agent-1');

    expect(unmaximize).not.toHaveBeenCalled();
  });
});

describe('an agent-driven window resize is not the user saved size', () => {
  it('brackets the resize in suppressBoundsSave and releases it', async () => {
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    metricsAlways(1600, 900);

    await applyViewport(guestOf(), entryOf(), { width: 1600, height: 900 }, 'agent-1');

    expect(suppressBoundsSave).toHaveBeenCalledWith('browser', { projectId: 'project-1', taskId: 'task-1' });
    expect(releaseBoundsSave).toHaveBeenCalledTimes(1);
  });

  it('releases the suppression even when the resize throws', async () => {
    popOutHas.mockReturnValue(true);
    popOutWindowFor.mockReturnValue(windowStub());
    metricsFromContent({ width: 0, height: 0 });
    setContentSize.mockImplementationOnce(() => { throw new Error('window gone'); });

    await expect(
      applyViewport(guestOf(), entryOf(), { width: 1600, height: 900 }, 'agent-1'),
    ).rejects.toThrow('window gone');
    expect(releaseBoundsSave).toHaveBeenCalledTimes(1);
  });
});

describe('asking for a size fits it into the pane', () => {
  it('zooms out so the whole requested layout is visible, not cropped', async () => {
    // The reported case: a 1920 layout in a 740px pane rendered its left third
    // under a chip claiming 1920, so the number and the picture disagreed.
    metricsAlways(1920, 1080);
    const guest = guestOf();

    const outcome = await applyViewport(guest, entryOf(), { width: 1920, height: 1080 }, 'agent-1');

    const fit = expectedFitZoom(1920, 1080);
    expect(guest.setZoomFactor).toHaveBeenCalledWith(fit);
    expect(outcome.visibleFraction).toBeCloseTo(1, 2);
  });

  it('scales the override BY the fit zoom, so the page still lays out at the request', async () => {
    // Measured on Electron 41: a page lays out at override / zoom, so the
    // override has to be pre-multiplied or a fitted 1920 request would produce
    // a 4983px layout. The live probe of this exact arithmetic measured
    // innerWidth 1920 from a 740x416 override at zoom 0.385.
    metricsAlways(1920, 1080);
    const fit = expectedFitZoom(1920, 1080);

    await applyViewport(guestOf(), entryOf(), { width: 1920, height: 1080 }, 'agent-1');

    const [, metrics] = setDeviceMetrics.mock.calls[0] as unknown as [unknown, { width: number; height: number; deviceScaleFactor: number }];
    expect(metrics.width).toBe(Math.round(1920 * fit));
    expect(metrics.height).toBe(Math.round(1080 * fit));
  });

  it('raises deviceScaleFactor by 1/zoom so the capture keeps its resolution', async () => {
    // Without this the capture shrinks with the zoom (measured 740x416 for a
    // 1920 request), which hands the agent an unreadable screenshot. 1/zoom
    // restores it AND lands devicePixelRatio back on 1.0, since dpr is
    // dsf x zoom - so the page does not think it is on a hidpi display.
    metricsAlways(1920, 1080);
    const fit = expectedFitZoom(1920, 1080);

    await applyViewport(guestOf(), entryOf(), { width: 1920, height: 1080 }, 'agent-1');

    const [, metrics] = setDeviceMetrics.mock.calls[0] as unknown as [unknown, { deviceScaleFactor: number }];
    expect(metrics.deviceScaleFactor).toBeCloseTo(1 / fit, 4);
  });

  it('reports the deviceScaleFactor it SENT, not the one that was asked for', async () => {
    // Observed live: the response said `deviceScaleFactor: 0` for a call that
    // sent 2.59. A number the tool did not use has no business in a response
    // whose whole contract is "this is what actually happened".
    metricsAlways(1920, 1080);
    const fit = expectedFitZoom(1920, 1080);

    const outcome = await applyViewport(guestOf(), entryOf(), { width: 1920, height: 1080 }, 'agent-1');

    expect(outcome.deviceScaleFactor).toBeCloseTo(1 / fit, 4);
  });

  it('fits against the PANE, not the window main can see', async () => {
    // The reported bug: main's only measurable box is the host window (2545
    // wide in the mock above), so fitting 1920 against it needed no zoom and
    // the page stayed cropped at 100%. The renderer's report is the source.
    metricsAlways(1920, 1080);
    const guest = guestOf();

    await applyViewport(guest, entryOf(), { width: 1920, height: 1080 }, 'agent-1');

    const applied = vi.mocked(guest.setZoomFactor).mock.lastCall?.[0] as number;
    expect(applied).toBeCloseTo(PANE_WIDGET.width / 1920, 4);
    expect(applied).toBeLessThan(1);
  });

  it('falls back to the window only when the pane has not reported yet', async () => {
    metricsAlways(1920, 1080);
    const guest = guestOf();

    await applyViewport(guest, entryOf({ widgetSize: null }), { width: 1920, height: 1080 }, 'agent-1');

    // 2545 wide fits 1920, so no zoom - a worse answer, and precisely why the
    // renderer reports. It is a fallback, not the path.
    expect(guest.setZoomFactor).toHaveBeenCalledWith(1);
  });

  it('does not zoom at all when the request already fits', async () => {
    metricsAlways(600, 400);
    const guest = guestOf();

    await applyViewport(guest, entryOf(), { width: 600, height: 400 }, 'agent-1');

    expect(guest.setZoomFactor).toHaveBeenCalledWith(1);
    const [, metrics] = setDeviceMetrics.mock.calls[0] as unknown as [unknown, { width: number; deviceScaleFactor: number }];
    expect(metrics.width).toBe(600);
    expect(metrics.deviceScaleFactor).toBeCloseTo(1, 4);
  });

  it('an explicit zoom wins over the fit, so a 1:1 crop is still reachable', async () => {
    metricsAlways(1920, 1080);
    const guest = guestOf();

    await applyViewport(guest, entryOf(), { width: 1920, height: 1080, zoom: 1 }, 'agent-1');

    expect(guest.setZoomFactor).toHaveBeenCalledWith(1);
    const [, metrics] = setDeviceMetrics.mock.calls[0] as unknown as [unknown, { width: number; height: number }];
    expect(metrics).toMatchObject({ width: 1920, height: 1080 });
  });

  it('clamps an absurd explicit zoom to the bounds Ctrl+wheel obeys', async () => {
    metricsAlways(1920, 1080);
    const guest = guestOf();

    await applyViewport(guest, entryOf(), { width: 1920, zoom: 99 }, 'agent-1');

    expect(vi.mocked(guest.setZoomFactor).mock.lastCall?.[0]).toBeLessThan(99);
  });

  it('putting the zoom back does NOT shrink the viewport to the scaled override', async () => {
    // The re-entrancy this guards: the override is stored pre-multiplied, so a
    // following {zoom: 1} that defaulted its width from the LIVE measurement
    // would adopt the scaled number and collapse the viewport. An omitted axis
    // falls back to the size last asked for, which no zoom change moves.
    const guest = guestOf();
    metricsAlways(1920, 1080);
    await applyViewport(guest, entryOf(), { width: 1920, height: 1080 }, 'agent-1');

    metricsAlways(740, 416);
    await applyViewport(guest, entryOf(), { zoom: 1 }, 'agent-1');

    const [, metrics] = setDeviceMetrics.mock.lastCall as unknown as [unknown, { width: number; height: number }];
    expect(metrics).toMatchObject({ width: 1920, height: 1080 });
  });

  it('reset restores the zoom the fit changed, not whatever it happens to be', async () => {
    // Setting a size now changes the zoom, so the zoom is the agent's change
    // and a reset owes it back. `zoomBefore` is captured on the FIRST override
    // so repeated calls cannot overwrite the user's original value.
    metricsAlways(1920, 1080);
    const guest = guestOf();
    guest.setZoomFactor(0.9); // the user's own zoom, before any agent call
    await applyViewport(guest, entryOf(), { width: 1920, height: 1080 }, 'agent-1');
    await applyViewport(guest, entryOf(), { width: 1600, height: 900 }, 'agent-1');

    await clearViewport(guest, entryOf());

    expect(clearDeviceMetrics).toHaveBeenCalled();
    expect(vi.mocked(guest.setZoomFactor).mock.lastCall?.[0]).toBeCloseTo(0.9, 5);
    expect(getViewportOverride(42)).toBeNull();
  });

  it('reset on a pane that was never overridden leaves the zoom alone', async () => {
    metricsAlways(740, 749);
    const guest = guestOf();

    await clearViewport(guest, entryOf());

    expect(guest.setZoomFactor).not.toHaveBeenCalled();
  });

  it('reset on a DETACHED window says nothing was resized rather than implying it was', async () => {
    popOutHas.mockReturnValue(true);
    metricsAlways(1600, 900);

    const outcome = await clearViewport(guestOf(), entryOf());

    expect(outcome.mechanism).toBe('window-resize');
    expect(setContentSize).not.toHaveBeenCalled();
    expect(outcome.note).toContain('nothing was resized');
    expect(outcome.note).toContain('1600x900');
  });

  it('reset restores a lane to the documented default rather than clearing emulation', async () => {
    laneWindow.mockReturnValue(windowStub());
    // Grown away from the default, so restoring it is a real resize.
    windowContent = { width: 1920, height: 1080 };
    windowBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    metricsFromContent({ width: 0, height: 0 });

    await clearViewport(guestOf(), entryOf({ kind: 'lane', sessionId: 'lane_deadbeef' }));

    expect(setContentSize).toHaveBeenCalledWith(1280, 800);
    expect(clearDeviceMetrics).not.toHaveBeenCalled();
  });
});

describe('a surface whose window has gone refuses rather than resizing nothing', () => {
  it('throws a directed error when the offscreen surface window is gone', async () => {
    metricsAlways(1280, 800);
    laneWindow.mockReturnValue(null);

    // Directed at something the agent can DO. `open_pane` is the only way back
    // to a browser from here, and it is the whole recovery: with one surface
    // per task there is no second handle to try.
    await expect(
      applyViewport(guestOf(), entryOf({ kind: 'lane', sessionId: 'lane_deadbeef' }), { width: 1920 }, 'a'),
    ).rejects.toThrow(/kangentic_browser_open_pane/);
  });

  it('throws when Chromium refuses the emulation override', async () => {
    metricsAlways(740, 749);
    setDeviceMetrics.mockResolvedValue(false);

    await expect(
      applyViewport(guestOf(), entryOf(), { width: 1920, height: 1080 }, 'agent-1'),
    ).rejects.toThrow(/refused/);
  });
});

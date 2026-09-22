import { BrowserWindow, screen, webContents as electronWebContents, type WebContents } from 'electron';
import type { BrowserPaneEntry } from './browser-pane-registry';
import {
  clearDeviceMetrics,
  getDeviceMetrics,
  getLayoutMetrics,
  runtimeEvaluate,
  setDeviceMetrics,
} from './cdp/cdp';
import {
  DEFAULT_LANE_HEIGHT,
  DEFAULT_LANE_WIDTH,
  laneWindow,
} from './browser-lane-manager';
import { popOutWindowManager } from '../pop-out/pop-out-window-manager';
import { MAX_ZOOM, MIN_ZOOM } from '../../shared/zoom-steps';
import {
  forgetViewportOverride,
  getViewportOverride,
  pushViewportOverride,
  rememberViewportOverride,
  webContentsIdsWithOverrideForSession,
  type ViewportMechanism,
  type ViewportOverrideRecord,
  type ViewportSize,
} from './viewport-override-store';

export type { ViewportMechanism, ViewportOverrideRecord, ViewportSize };

/**
 * Who decides what viewport a Browser surface renders at, and remembers it.
 *
 * ## Why three mechanisms and not one
 *
 * The three surfaces an agent can drive look alike through `withGuest` and are
 * nothing alike underneath, so "set the viewport" means a different operation
 * for each. Picking the wrong one is not a performance question; two of the
 * three choices are silently wrong:
 *
 *   - A LANE is an offscreen `BrowserWindow` nobody is looking at, so resizing
 *     it for real is free and exact, and it can exceed the physical display.
 *     Still three mechanisms after `isolated` came out, and that is not an
 *     oversight: the POLICY collapsed to one surface per task, but the
 *     SUBSTRATES did not - an offscreen window is still a window, and a task
 *     whose project is backgrounded still has one.
 *   - A POPPED-OUT pane is a `<webview>` alone in its own OS window. The
 *     registry still calls it `kind: 'pane'`, so dispatching on `entry.kind`
 *     alone sends it down the emulation path while a real resize sits right
 *     there. Real pixels beat emulation whenever they are available.
 *   - A DOCKED pane is a `<webview>` inside the task-detail split row, sized by
 *     CSS with no bounds API, and its element cannot move or be re-parented
 *     without killing the guest. Emulation is the only lever, and it is also
 *     the only mechanism that preserves the page: no reload, `sessionStorage`
 *     and in-memory state intact, same surface handle.
 *
 * ## Why every result is measured
 *
 * None of the three reliably gives back the number it was asked for. A window
 * loses its frame and the pane's own chrome to the viewport, and is capped by
 * the display; a lane can be clamped; and an override composes with whatever
 * zoom factor the user or the agent set, so the CSS viewport is a product of
 * both. Echoing the request back would hand an agent a measurement taken at a
 * width the page never had, which is the failure this whole feature exists to
 * remove. So every path ends in `Page.getLayoutMetrics` and reports that.
 *
 * ## Why ownership is captured here rather than read from the registry
 *
 * An override outlives the call that set it, and a docked pane outlives the
 * agent session that owns it, so something has to clear it or the user is left
 * with a 1920px layout crammed into a 740px pane and no idea why. The registry
 * cannot answer "whose override is this": `register()` updates `ownerSessionId`
 * IN PLACE when a `/clear` rotates the session, so a registry-keyed clear would
 * let the departing session wipe the incoming one's override. The owner is
 * therefore stamped at set time and never re-read.
 */

/** Both axes, in CSS pixels. Past this an emulated compositor surface is large
 *  enough to be a memory problem rather than a test. */
export const MAX_VIEWPORT_DIMENSION = 8192;
export const MIN_VIEWPORT_DIMENSION = 128;

/**
 * How long a resize may take to show up in the page's own layout metrics.
 *
 * A lane renders at `LANE_FRAME_RATE`, so a read taken immediately after
 * `setContentSize` can still describe the pre-resize frame. That is the same
 * silently-wrong-answer class the lane manager already documents for scroll,
 * and it matters more here because the number read back is the number the agent
 * will trust.
 */
const RESIZE_SETTLE_TIMEOUT_MS = 800;
const RESIZE_POLL_INTERVAL_MS = 40;

/**
 * How many times a window resize may measure and try again.
 *
 * Three is enough for every cause seen: one pass to ask, one to pay for the
 * chrome, one spare for a window that ignored the first ask (an un-maximize
 * animation swallows it). More would be a loop fighting a constraint it
 * cannot win, and the honest answer then is the size it actually reached.
 */
const RESIZE_MAX_PASSES = 3;

/**
 * Where on its display a detached window should sit.
 *
 * A nine-point grid rather than raw coordinates: the asks are "half width on
 * the left", "top left", "fill the screen", and an anchor says those directly
 * while raw x/y would make an agent do display arithmetic it already gets
 * wrong. Sizing without placing was the gap - a 1280x1392 window on a 2560
 * display is exactly half the screen and still sits wherever it happened to
 * be, so "dock it left" had no answer.
 */
export const WINDOW_ANCHORS = [
  'top-left', 'top', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
] as const;
export type WindowAnchor = (typeof WINDOW_ANCHORS)[number];

export interface ViewportRequest {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  zoom?: number;
  position?: WindowAnchor;
}

function clampDimension(value: number): number {
  return Math.round(Math.min(MAX_VIEWPORT_DIMENSION, Math.max(MIN_VIEWPORT_DIMENSION, value)));
}

/**
 * Which mechanism this surface gets. Exported because the dispatch IS the
 * design decision here, and a unit test that cannot see it can only assert that
 * some resize happened, not that the right one did.
 */
export function resolveMechanism(entry: BrowserPaneEntry): ViewportMechanism {
  if (entry.kind === 'lane') return 'lane-resize';
  if (entry.projectId && popOutWindowManager.has('browser', {
    projectId: entry.projectId,
    taskId: entry.taskId,
  })) {
    return 'window-resize';
  }
  return 'device-emulation';
}

/**
 * The viewport as the PAGE sees it: `innerWidth` / `innerHeight`.
 *
 * Deliberately not `Page.getLayoutMetrics`, which reports `clientWidth` - the
 * content box with the scrollbar already taken out. Measured: a 1920 request
 * on a page tall enough to scroll reported 1905 there, so the chip said
 * "1905 x 1080" for a viewport the page calls 1920 and every `min-width`
 * media query evaluates as 1920. Reporting the content box made `exact` false
 * on any scrolling page, which is the honesty signal crying wolf.
 *
 * Falls back to the layout metrics when the evaluate fails, so a guest that
 * refuses script still reports something rather than nothing.
 */
async function readViewport(webContents: WebContents): Promise<ViewportSize | null> {
  const evaluated = await runtimeEvaluate<{ width: number; height: number }>(
    webContents,
    '({ width: window.innerWidth, height: window.innerHeight })',
  );
  if (evaluated?.value && typeof evaluated.value.width === 'number') {
    return { width: evaluated.value.width, height: evaluated.value.height };
  }
  const metrics = await getLayoutMetrics(webContents);
  if (!metrics) return null;
  return { width: metrics.viewportWidth, height: metrics.viewportHeight };
}

/**
 * The zoom factor that makes a requested viewport fit the widget it is being
 * rendered into, and 1 when it already fits.
 *
 * Both axes, because fitting the width alone still leaves the bottom of the
 * layout off-screen. Clamped to the same floor the user's own Ctrl+wheel
 * obeys: past that the page is unreadable and a scroll is the better answer.
 */
/**
 * The size of the real widget a pane is rendered into, in CSS pixels.
 *
 * Takes the renderer's report (`entry.widgetSize`) and falls back to the host
 * window only when there is none yet. The fallback is deliberately a poor
 * approximation and must not be mistaken for the real thing: the host window
 * is the whole Kangentic window, and the pane is one side of a split inside a
 * task-detail window inside it, so the number is several times too large.
 * Fitting against it computes a zoom of 1 and leaves the page cropped, which
 * is exactly the bug the reported size exists to fix. It survives here only so
 * a pane that has not reported yet still gets a sane cap rather than none.
 */
function paneWidgetSize(webContents: WebContents, entry: BrowserPaneEntry): ViewportSize | null {
  if (entry.widgetSize) return entry.widgetSize;
  const host = BrowserWindow.fromWebContents(webContents.hostWebContents ?? webContents);
  if (!host || host.isDestroyed()) return null;
  const [width, height] = host.getContentSize();
  return { width, height };
}

function fitZoomFor(target: ViewportSize, widget: ViewportSize): number {
  const byWidth = widget.width / target.width;
  const byHeight = widget.height / target.height;
  return Math.max(MIN_ZOOM, Math.min(1, byWidth, byHeight));
}

/** Poll until the page's own metrics stop describing the pre-resize frame. */
async function waitForViewport(
  webContents: WebContents,
  matches: (size: ViewportSize) => boolean,
): Promise<ViewportSize | null> {
  const deadline = Date.now() + RESIZE_SETTLE_TIMEOUT_MS;
  for (;;) {
    const last = await readViewport(webContents);
    if (last && matches(last)) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, RESIZE_POLL_INTERVAL_MS));
  }
}

/**
 * Resize an OS window so the PAGE ends up at the requested size.
 *
 * `setContentSize` sizes the window's content area, which for a pop-out is the
 * whole renderer document: the 40px pop-out title bar and the Browser pane's
 * own URL bar and toolbar all come out of it before the `<webview>` gets any.
 * So a single naive call is short by the chrome every single time, which is
 * worse than the display clamp it would otherwise be confused with, because a
 * clamp is rare and this is certain. One correction pass closes it: measure the
 * shortfall the page reports and give the window that much more.
 *
 * A LANE goes through here too and simply measures a zero delta, so it pays one
 * extra `getLayoutMetrics` and skips the second resize. Measured on Electron
 * 41: an offscreen window has no chrome, and `setContentSize(5000, 4000)`
 * reported exactly that rather than being clamped to the display.
 */
async function resizeWindowToViewport(
  window: BrowserWindow,
  webContents: WebContents,
  target: ViewportSize,
  options: { clampToDisplay: boolean },
): Promise<ViewportSize | null> {
  // A maximized or full-screen window IGNORES `setContentSize`, silently. An
  // agent that popped out maximized and then asked for half the size got the
  // same 2545x1272 back twice and concluded the display was clamping it, which
  // it was not. Asking for a specific size IS a request to leave that state,
  // so leave it: the alternative is a tool that reports a size it did not set.
  if (window.isFullScreen()) window.setFullScreen(false);
  if (window.isMaximized()) window.unmaximize();

  // Never grow a VISIBLE window past the display it is on.
  //
  // A multi-monitor desktop is one continuous coordinate space, so an
  // oversized `setContentSize` does not fail or clamp - the window simply
  // spills onto the next monitor, which is what "it spanned both screens"
  // was. The convergence loop below makes that easier to hit, since it asks
  // for MORE than the target to pay for the chrome.
  //
  // Per DISPLAY, never a fixed number: `getDisplayMatching` answers for the
  // screen this window is actually on, so an ultrawide legitimately allows a
  // 5120-wide window, a laptop beside an external is bounded by whichever one
  // holds the window, and dragging between two screens with different scale
  // factors is handled because the bound is re-read on every call. Work area
  // in DIP, which is the same unit as the page's CSS pixels.
  //
  // A LANE is exempt, and that is the point of a lane: it is offscreen, bound
  // by no display, and measured accepting 5000x4000 on a 2560-wide screen. An
  // agent that wants a viewport bigger than the user's monitor wants a lane or
  // emulation, and the response says so by reporting `display`.
  const area = options.clampToDisplay ? displayWorkArea(webContents) : null;
  const bounded: ViewportSize = area
    ? { width: Math.min(target.width, area.width), height: Math.min(target.height, area.height) }
    : target;

  // The pre-resize reading, and the reason this function has one.
  //
  // The correction below needs to measure the CHROME, which means it needs a
  // reading taken AFTER the window actually relaid out. Waiting for "any
  // non-zero size" is not that: the page reports its old size for a frame or
  // two, the wait is satisfied immediately by the stale value, and the delta
  // is then the whole difference between the old and new sizes rather than
  // the chrome. Measured live: a 1280x720 request against a 2096-wide window
  // corrected to 1280 + (1280 - 2096) = 464, and a 900x700 request grew to
  // 1136x1048. So the wait is for a reading that is either at the target or
  // DIFFERENT FROM BEFORE, and `before` is what makes the second half sayable.
  // CONVERGE rather than correct once.
  //
  // A single measure-and-correct assumes exactly one known cause (the chrome)
  // and gets everything else wrong. Measured live against a popped-out pane:
  // a 1280x720 request came back 1203x601 and a following 1280x601 request
  // came back 1203x601 again - the same numbers for two different asks, which
  // means the window had not moved at all. `unmaximize()` on Windows animates,
  // and a `setContentSize` issued in the same tick is discarded when the
  // animation finishes, so the one correction was computed against a window
  // that never accepted the first resize.
  //
  // A loop needs no theory of WHY the last attempt fell short: it measures,
  // asks for the shortfall, and measures again. Bounded, because a window that
  // cannot reach the target (a min size, a display cap) must stop rather than
  // oscillate, and whatever it did reach is reported honestly.
  let measured = await readViewport(webContents);

  // A window already showing the requested viewport is not resized at all.
  //
  // Not an optimization. `setContentSize` takes a CONTENT size, so asking for
  // the viewport the window already has sets the content to a number short by
  // the chrome: the window visibly shrinks, then climbs back over the
  // correction passes. Worse, a request that names NO size falls back to the
  // current measurement, so a bare `position` did that for a call that asked
  // only for the window to be moved. Same shape as the `maximized` bug, in
  // the adjacent parameter.
  //
  // The display clamp still runs, because a window can be the right size and
  // still hang off an edge. If fitting costs it content there IS a resize
  // after all, so it falls through and the loop measures what it got.
  if (measured && isSame(measured, bounded)) {
    const [beforeWidth, beforeHeight] = window.getContentSize();
    if (options.clampToDisplay) {
      shrinkToFitDisplay(window);
      keepWithinDisplay(window);
    }
    const [afterWidth, afterHeight] = window.getContentSize();
    if (afterWidth === beforeWidth && afterHeight === beforeHeight) return measured;
  }

  // What the loop is actually chasing. It starts as the request and SHRINKS
  // once the chrome is known, because a viewport the height of the work area
  // is not reachable in a window: the frame and the pane's own toolbars come
  // out of it first. Without this the loop asks for a shortfall it can never
  // be given, `shrinkToFitDisplay` takes the growth straight back, and the
  // result lands wherever the tug-of-war stopped - which is why the same
  // 1280x1392 request measured 1272 one run and 1274 the next.
  let goal = bounded;
  for (let pass = 0; pass < RESIZE_MAX_PASSES; pass += 1) {
    const [contentWidth, contentHeight] = window.getContentSize();
    // Pass 0 asks for the goal outright; later passes add the shortfall the
    // previous measurement revealed, which is the chrome plus anything the OS
    // did that we did not predict.
    //
    // Pass 0 deliberately does NOT try to predict the chrome from the
    // pre-loop reading. `content - viewport` is the chrome only while the
    // page's CSS pixel is the window's content pixel, and an explicit `zoom`
    // breaks that: at zoom 0.5 the CSS viewport is about twice the content,
    // so the "chrome" computes negative and pass 0 asks for a size smaller
    // than the window it is growing. Measuring and correcting needs no such
    // assumption, and the early exit above already covers the case the
    // prediction was reaching for.
    const nextWidth = pass === 0
      ? goal.width
      : Math.max(MIN_VIEWPORT_DIMENSION, contentWidth + (goal.width - (measured?.width ?? goal.width)));
    const nextHeight = pass === 0
      ? goal.height
      : Math.max(MIN_VIEWPORT_DIMENSION, contentHeight + (goal.height - (measured?.height ?? goal.height)));
    if (pass > 0 && nextWidth === contentWidth && nextHeight === contentHeight) break;

    const priorReading = measured;
    window.setContentSize(nextWidth, nextHeight);
    // Two separate ways a resize can leave the display, both fixed before the
    // measurement so the number reported is the one on screen: the window can
    // be BIGGER than the work area (the frame is added on top of the content
    // size, which the viewport clamp cannot see), and it can be the right size
    // but positioned so it overhangs (growing keeps the top-left).
    if (options.clampToDisplay) {
      shrinkToFitDisplay(window);
      keepWithinDisplay(window);
    }
    // Whether this pass actually moved the window, read back AFTER the clamp
    // rather than from what was asked for. If it moved, the page MUST relayout,
    // so a reading equal to the pre-resize one is stale by definition and
    // accepting it is a lie. But an over-cap request DOES differ from the
    // current size and then has the clamp put it straight back, and comparing
    // the ask would call that a change and wait the full settle timeout for a
    // relayout that is never coming.
    const [settledWidth, settledHeight] = window.getContentSize();
    const contentChanged = settledWidth !== contentWidth || settledHeight !== contentHeight;
    // "At the goal" is NOT an acceptable exit while a resize is in flight.
    //
    // It looks like the obvious short-circuit and it is the bug that survived
    // the first stale-read fix. Setting the viewport to the value the window
    // ALREADY had sets the CONTENT to that number, which makes the viewport
    // smaller by the chrome - but the first poll still reads the old value,
    // which equals the goal, so `isWithin` fired and returned a reading taken
    // before the page had moved. Measured live: a 2560x1274 request against a
    // window already showing 1274 returned `exact: true` while the window was
    // left visibly short, and `reachableViewport` then saw content minus
    // viewport as zero and reported the maximum as the whole 1392 work area.
    //
    // So when this pass changed the content size, only a CHANGED reading
    // counts; when it changed nothing, there is nothing to wait for.
    measured = await waitForViewport(
      webContents,
      (size) => (contentChanged ? !!priorReading && !isSame(size, priorReading) : true),
    );
    if (!measured) return null;

    // Now that a real measurement exists, the chrome is knowable, and with it
    // the largest viewport this window can actually have on this display.
    if (options.clampToDisplay) {
      const reachable = reachableViewport(window, measured);
      if (reachable) {
        goal = {
          width: Math.min(bounded.width, reachable.width),
          height: Math.min(bounded.height, reachable.height),
        };
      }
    }
    if (isWithin(measured, goal)) return measured;
  }
  return measured;
}

/** Equal within a couple of pixels of rounding. */
function isWithin(size: ViewportSize, target: ViewportSize): boolean {
  return Math.abs(size.width - target.width) <= 2 && Math.abs(size.height - target.height) <= 2;
}

function isSame(a: ViewportSize, b: ViewportSize): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * The work area of the display a surface is on, in CSS pixels.
 *
 * Work area rather than full bounds, since the taskbar is not usable. For a
 * lane (no window on any display) this is the primary display, which is the
 * right answer for "how big is the user's screen" even though a lane is not
 * bound by it.
 */
/**
 * The work area of the display a given window is on.
 *
 * Exported for the detach tools, which report it on their own responses: an
 * agent that pops out and then wants half the screen was otherwise making an
 * extra `set_viewport` call purely to discover the display size, and said so
 * in its own transcript.
 */
export function displayForWindow(window: BrowserWindow): ViewportSize | null {
  try {
    if (window.isDestroyed()) return null;
    const area = screen.getDisplayMatching(window.getBounds()).workAreaSize;
    return { width: area.width, height: area.height };
  } catch {
    return null;
  }
}

function displayWorkArea(webContents: WebContents): ViewportSize | null {
  try {
    const host = BrowserWindow.fromWebContents(webContents.hostWebContents ?? webContents);
    const area = host && !host.isDestroyed()
      ? screen.getDisplayMatching(host.getBounds()).workAreaSize
      : screen.getPrimaryDisplay().workAreaSize;
    return { width: area.width, height: area.height };
  } catch {
    return null;
  }
}

/**
 * Move a window back inside the display it is on, after a resize.
 *
 * `setContentSize` keeps the window's TOP-LEFT and grows right and down, so a
 * window sitting part-way across the desktop and sized to the full work area
 * runs off the edge of its monitor and onto the next. Sizing it correctly is
 * only half of "make it full screen on this monitor"; the other half is where
 * it starts.
 *
 * Clamping rather than always snapping to the origin: a window that still fits
 * where the user put it stays put, and only one that would overhang is pulled
 * back. A window as large as the work area has exactly one position that fits,
 * which is the origin, so "full screen" lands top-left without that being a
 * special case.
 */
/**
 * Place a window at an anchor on its display's work area.
 *
 * Work area, so "top" is under the taskbar rather than behind it, and the
 * anchor resolves against the display the window is currently on, which is
 * what makes "the top left of my monitor" mean the monitor the user is
 * looking at rather than the primary one.
 */
function positionWindowAt(window: BrowserWindow, anchor: WindowAnchor): void {
  try {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const horizontal = anchor.endsWith('left') ? 'start' : anchor.endsWith('right') ? 'end' : 'middle';
    const vertical = anchor.startsWith('top') ? 'start' : anchor.startsWith('bottom') ? 'end' : 'middle';
    const rawX = horizontal === 'start'
      ? area.x
      : horizontal === 'end'
        ? area.x + area.width - bounds.width
        : area.x + (area.width - bounds.width) / 2;
    const rawY = vertical === 'start'
      ? area.y
      : vertical === 'end'
        ? area.y + area.height - bounds.height
        : area.y + (area.height - bounds.height) / 2;
    // Clamped, because a centring anchor goes NEGATIVE for a window taller or
    // wider than the work area: `left` resolves vertically to middle, and a
    // full-height window is its content plus the frame, so centring computed
    // y = (1392 - 1432) / 2 = -20 and put the title bar off the top of the
    // screen. Never place a window where its own chrome is unreachable.
    window.setPosition(
      Math.round(Math.max(area.x, Math.min(rawX, area.x + area.width - bounds.width))),
      Math.round(Math.max(area.y, Math.min(rawY, area.y + area.height - bounds.height))),
    );
  } catch {
    // Placement is a nicety; never fail a resize over it.
  }
}

/**
 * Shrink a window whose OUTER bounds overflow its display.
 *
 * The size clamp upstream caps the requested VIEWPORT, which is the content
 * box: the frame is added on top of it, so asking for a viewport the height of
 * the work area produces a window taller than the screen. Clamping the
 * viewport cannot see that, because the frame is not known until the window
 * has been laid out. Measured after the fact and taken off the content.
 */
/**
 * The largest viewport this window can have on its current display.
 *
 * The work area minus everything between it and the page: the window frame
 * (outer bounds minus content) and the pane's own URL bar and toolbar
 * (content minus the measured viewport). Both are measured from the window
 * that just resized rather than assumed, because they differ per platform and
 * per surface.
 *
 * This is the number `maxWindowViewport` reports, and the ceiling the resize
 * loop stops at - a viewport as tall as the screen is simply not a thing a
 * window can have.
 */
function reachableViewport(window: BrowserWindow, measured: ViewportSize): ViewportSize | null {
  try {
    if (window.isDestroyed()) return null;
    const bounds = window.getBounds();
    const [contentWidth, contentHeight] = window.getContentSize();
    const area = screen.getDisplayMatching(bounds).workArea;
    const chromeWidth = (bounds.width - contentWidth) + (contentWidth - measured.width);
    const chromeHeight = (bounds.height - contentHeight) + (contentHeight - measured.height);
    return {
      width: Math.max(MIN_VIEWPORT_DIMENSION, area.width - Math.max(0, chromeWidth)),
      height: Math.max(MIN_VIEWPORT_DIMENSION, area.height - Math.max(0, chromeHeight)),
    };
  } catch {
    return null;
  }
}

function shrinkToFitDisplay(window: BrowserWindow): void {
  try {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const overflowWidth = Math.max(0, bounds.width - area.width);
    const overflowHeight = Math.max(0, bounds.height - area.height);
    if (overflowWidth === 0 && overflowHeight === 0) return;
    const [contentWidth, contentHeight] = window.getContentSize();
    window.setContentSize(
      Math.max(MIN_VIEWPORT_DIMENSION, contentWidth - overflowWidth),
      Math.max(MIN_VIEWPORT_DIMENSION, contentHeight - overflowHeight),
    );
  } catch {
    // Best effort, same as the placement above.
  }
}

function keepWithinDisplay(window: BrowserWindow): void {
  try {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const x = Math.min(Math.max(bounds.x, area.x), Math.max(area.x, area.x + area.width - bounds.width));
    const y = Math.min(Math.max(bounds.y, area.y), Math.max(area.y, area.y + area.height - bounds.height));
    if (x !== bounds.x || y !== bounds.y) window.setPosition(Math.round(x), Math.round(y));
  } catch {
    // Positioning is a nicety; never fail a resize over it.
  }
}

export interface ApplyViewportOutcome {
  mechanism: ViewportMechanism;
  requested: ViewportSize;
  viewport: ViewportSize;
  deviceScaleFactor: number;
  zoom: number;
  /**
   * The usable area of the display this surface is on, and the largest
   * viewport a real window on it can reach.
   *
   * Reported because an agent asked for "full height, half width" and had to
   * guess the screen from whatever the maximized window happened to be, which
   * it got wrong. A window cannot exceed `display`, and its `maxWindowViewport`
   * is smaller again by the frame and the pane's own chrome; emulation and
   * lanes are bound by neither.
   */
  display: ViewportSize | null;
  maxWindowViewport: ViewportSize | null;
  /**
   * False when the surface could not give the requested size: a display clamp,
   * or a guest that reported nothing back.
   *
   * Tolerant to 2px, which is why `viewport` can read 1079 for a requested
   * 1080 and still be `exact: true`. The fit divides the override by the zoom
   * and rounds to whole pixels, so a fitted request lands a pixel short
   * roughly half the time. Reporting that as a clamp would make `exact` false
   * on most calls and turn the honesty signal into noise - the same reasoning
   * that keeps `readViewport` off `clientWidth`.
   *
   * A live agent run read the 1px gap as a defect and reported it twice, so
   * the tolerance is stated in the tool description too. If that keeps
   * happening, say the tolerance in the response rather than widening it.
   */
  exact: boolean;
  /** 1 when the whole emulated viewport is visible in the real widget, less
   *  when the agent is looking at a crop of it. */
  visibleFraction: number;
  note: string | null;
}

/**
 * Apply a viewport request to one resolved surface and report what it got.
 *
 * `zoom` is handled first and independently of the size, because it is the
 * user's control as much as the agent's: it is the same factor the toolbar pill
 * shows and Ctrl+wheel drives, so it is clamped to the same bounds and left
 * alone by every path that does not name it.
 */
export async function applyViewport(
  webContents: WebContents,
  entry: BrowserPaneEntry,
  request: ViewportRequest,
  ownerSessionId: string | null,
): Promise<ApplyViewportOutcome> {
  // Read BEFORE anything below touches it, so a reset can put the user's own
  // zoom back rather than whatever fit this call chose.
  const existing = getViewportOverride(webContents.id);
  const zoomBeforeThisCall = webContents.getZoomFactor() || 1;

  if (typeof request.zoom === 'number') {
    webContents.setZoomFactor(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, request.zoom)));
  }

  const mechanism = resolveMechanism(entry);
  const current = await readViewport(webContents);
  // An omitted axis falls back to the size last ASKED FOR, not to the size
  // measured a moment ago.
  //
  // The live measurement looks like the obvious default and is wrong as soon
  // as zoom is involved, because the zoom above has already taken effect by
  // the time it is read. Concretely: a 1920 request at zoom 0.4 is held as a
  // 768x432 override, so a following `{ zoom: 1 }` (an agent putting the zoom
  // back) would measure 768, adopt it as the target, and silently collapse the
  // viewport from 1920 to 768. The recorded request is the stable intent and
  // survives any number of zoom changes.
  const fallback = existing?.requested ?? current;
  const target: ViewportSize = {
    width: clampDimension(request.width ?? fallback?.width ?? DEFAULT_LANE_WIDTH),
    height: clampDimension(request.height ?? fallback?.height ?? DEFAULT_LANE_HEIGHT),
  };
  // What the response reports. The emulation branch REPLACES this with the
  // value it actually sent, which is scaled by the fit: reporting the request
  // here would have said `deviceScaleFactor: 0` for a call that sent 2.59, and
  // a number the tool did not use is exactly what the measured-not-echoed rule
  // exists to keep out of the response.
  let deviceScaleFactor = request.deviceScaleFactor ?? 0;

  let measured: ViewportSize | null;
  let note: string | null = null;
  /** The largest viewport this window can reach, on the window path only. */
  let windowMax: ViewportSize | null = null;

  if (mechanism === 'lane-resize') {
    const window = laneWindow(entry.sessionId);
    if (!window) {
      throw new Error(
        'This offscreen surface no longer has a window, so its viewport cannot be set. Call kangentic_browser_open_pane with a url to bring your task\'s browser back.',
      );
    }
    // No display clamp: a lane is offscreen and may exceed the monitor.
    measured = await resizeWindowToViewport(window, webContents, target, { clampToDisplay: false });
  } else if (mechanism === 'window-resize') {
    const window =
      entry.projectId === null
        ? null
        : popOutWindowManager.windowFor('browser', {
            projectId: entry.projectId,
            taskId: entry.taskId,
          });
    if (!window) {
      throw new Error(
        'The popped-out Browser window closed while its viewport was being set. Retry, and the docked pane will be used instead.',
      );
    }
    // A real window renders 1:1, which is the entire reason to use one instead
    // of emulation - so a leftover zoom has to go. Electron persists the zoom
    // factor PER ORIGIN within a session partition, so the fit applied to the
    // docked pane followed the page into its fresh pop-out guest: observed
    // 0.3854 on a window that had never been zoomed, which makes every
    // measurement against it a different number from the one on screen. An
    // explicit `zoom` still wins, for an agent that wants one.
    if (typeof request.zoom !== 'number') webContents.setZoomFactor(1);

    const release = popOutWindowManager.suppressBoundsSave('browser', {
      projectId: entry.projectId as string,
      taskId: entry.taskId,
    });
    try {
      // Clamped: this is a window the user can see, on a real display.
      measured = await resizeWindowToViewport(window, webContents, target, { clampToDisplay: true });
      // Placed AFTER the resize, because an anchor depends on the final size:
      // "right" means a different x for a 900-wide window than a 1280-wide
      // one, and the size is not settled until the convergence loop is done.
      if (request.position) positionWindowAt(window, request.position);
      // The window maximum, from the SAME function the resize loop stops at.
      //
      // It used to be derived here from its own chrome sum, `content -
      // viewport`, which counts the pane's toolbars and forgets the window
      // frame. The two then disagreed exactly when the resize succeeded: three
      // calls refused a 1392-tall viewport, and the next one reported the
      // maximum as 1392. One source of truth or the response contradicts
      // itself.
      if (measured) windowMax = reachableViewport(window, measured);
    } finally {
      release();
    }
  } else {
    // Compensate for the zoom factor, because an override is NOT independent
    // of it. Measured on Electron 41 against a live guest: with a 1920x1080
    // override and the zoom at 0.4, `innerWidth` reported 4800, not 1920 - the
    // ASKING FOR A SIZE SETS THE ZOOM TO FIT IT. Emulation changes the layout
    // without changing the widget, so a 1920 layout in a 740px pane shows its
    // left third and the user is looking at a cropped page with a chip over it
    // claiming 1920. Zooming out to fit is what makes the number on the chip
    // and the thing on screen the same fact.
    //
    // Three measured facts make this work, none of them obvious:
    //   1. Zoom MULTIPLIES an override: the page lays out at override / zoom,
    //      so a 1920 override at zoom 0.4 measured 4800. The override is
    //      therefore scaled BY the zoom to put 1920 back in `innerWidth`.
    //   2. That alone shrinks the capture to the override's own size (740x416
    //      measured), which would hand the agent an unreadable screenshot.
    //      Setting `deviceScaleFactor` to 1/zoom restores it: the capture came
    //      back 1920x1079.
    //   3. `devicePixelRatio` is dsf x zoom, so 1/zoom x zoom lands the page on
    //      a normal 1.0 display (measured 0.99999993). The page does not
    //      believe it is on a hidpi screen and picks no different assets.
    //
    // An explicit `zoom` wins, so an agent that wants the crisp 1:1 crop can
    // ask for `zoom: 1` and get exactly the old behavior.
    const widget = paneWidgetSize(webContents, entry);
    const zoomFactor =
      typeof request.zoom === 'number'
        ? webContents.getZoomFactor() || 1
        : fitZoomFor(target, widget ?? target);
    if (typeof request.zoom !== 'number') webContents.setZoomFactor(zoomFactor);

    const applied = await setDeviceMetrics(webContents, {
      width: Math.max(1, Math.round(target.width * zoomFactor)),
      height: Math.max(1, Math.round(target.height * zoomFactor)),
      // 1/zoom keeps the capture at the requested resolution. An explicitly
      // requested factor is multiplied through rather than replaced, so
      // `deviceScaleFactor: 2` still means "twice the pixels" after the fit.
      deviceScaleFactor: (deviceScaleFactor = (request.deviceScaleFactor ?? 1) / zoomFactor),
    });
    if (!applied) {
      throw new Error(
        'Chromium refused the viewport override for this pane. The debugger may have been detached (opening DevTools on the pane does that).',
      );
    }
    // Within a pixel, not exactly: the override is rounded to whole pixels
    // before being divided by the zoom again, so a fitted 1080 lands on 1079.
    measured = await waitForViewport(webContents, (size) => Math.abs(size.width - target.width) <= 2);
  }

  const viewport = measured ?? target;
  // A couple of pixels of rounding from the fit is not a clamp, and reporting
  // it as one would make `exact` false on every fitted call.
  const exact =
    Math.abs(viewport.width - target.width) <= 2 && Math.abs(viewport.height - target.height) <= 2;
  const zoom = webContents.getZoomFactor();
  // Computed once: the note below explains a shortfall in terms of it, and the
  // response reports it.
  const limits = displayLimits(webContents, mechanism, windowMax);

  // How much of the emulated layout the USER's pane can actually show. Only
  // emulation can produce a partial view: the other two mechanisms move the
  // real surface, so what is laid out is what is rendered.
  //
  // This is a note about the user's screen, NOT about what the agent gets.
  // Measured on Electron 41: `Page.captureScreenshot` against an emulated
  // guest returns the FULL emulated surface (1920x1080 out of a 740px-wide
  // widget), so a screenshot is complete even while the pane shows a third of
  // it. Saying otherwise would send agents chasing a problem they do not have.
  let visibleFraction = 1;
  if (mechanism === 'device-emulation') {
    // The PANE's width, not the window's, for the same reason the fit uses it.
    const paneWidth = paneWidgetSize(webContents, entry)?.width ?? viewport.width;
    visibleFraction = Math.min(1, (paneWidth / zoom) / viewport.width);
    if (visibleFraction < 0.999) {
      note =
        `Your screenshots and measurements are complete at ${viewport.width}x${viewport.height}, but the USER's pane ` +
        `only shows about ${Math.round(visibleFraction * 100)}% of that layout. If they need to watch, ` +
        'kangentic_browser_pop_out gives a real window at this size.';
    }
  }
  // A position on a surface with no window of its own is not a thing that can
  // happen, and saying so beats dropping it: the agent asked for something,
  // and silence would let it report success for a window that never moved.
  if (request.position && mechanism !== 'window-resize' && note === null) {
    note = mechanism === 'device-emulation'
      ? `\`position\` was ignored: this pane is docked inside the task window, so it has no position on the display of its own. Call kangentic_browser_pop_out first, then set_viewport { position: "${request.position}" }.`
      : `\`position\` was ignored: a lane is offscreen, so it has nowhere to be placed.`;
  }
  if (!exact && note === null) {
    // Compared against the WINDOW's maximum, not the display's.
    //
    // A window's viewport is the work area minus its frame and the pane's own
    // toolbars, so on a 1392-tall screen the largest a window viewport can be
    // is about 1274. An agent handed `display: 1392` asks for 1392, gets 1274,
    // and a bare "clamped to 1274" reads as arbitrary - it was told the screen
    // was taller than that one line earlier. Comparing against the display
    // missed this entirely, because 1392 is not GREATER than 1392.
    const beyondWindow =
      limits.maxWindowViewport !== null &&
      (target.width > limits.maxWindowViewport.width || target.height > limits.maxWindowViewport.height);
    note = beyondWindow && limits.display
      ? `A window's viewport is its display's work area (${limits.display.width}x${limits.display.height}) minus the window frame and ` +
        `this pane's own toolbars, so the largest viewport a window on this display can have is ` +
        `${limits.maxWindowViewport?.width}x${limits.maxWindowViewport?.height} - which is what you got. That is `
        + '`maxWindowViewport` in this response. For anything larger, kangentic_browser_dock and set_viewport on the docked pane: '
        + 'device emulation is not bounded by a monitor.'
      : `The surface clamped this request to ${viewport.width}x${viewport.height}. Measurements are against that, not the request.`;
  }

  const record: ViewportOverrideRecord = {
    sessionId: ownerSessionId,
    mechanism,
    requested: target,
    measured: viewport,
    deviceScaleFactor,
    // Carried forward from the existing override rather than re-read, so the
    // zoom a reset restores is the user's, never a fit this feature applied.
    zoomBefore: existing?.zoomBefore ?? zoomBeforeThisCall,
    appliedAt: new Date().toISOString(),
  };
  rememberViewportOverride(webContents.id, record);
  pushViewportOverride(webContents, record);

  return {
    mechanism,
    requested: target,
    viewport,
    deviceScaleFactor,
    zoom,
    ...limits,
    exact,
    visibleFraction,
    note,
  };
}

/**
 * What a real window on this display can reach, so an agent sizing relative to
 * the screen ("half the width", "full height") does not have to infer it from
 * whatever a maximized window happened to be.
 *
 * `maxWindowViewport` is the work area minus what the window keeps: measured
 * on the call that just ran, when there is one, rather than assumed, since the
 * frame plus the pane's toolbars differ per platform and per surface.
 */
function displayLimits(
  webContents: WebContents,
  mechanism: ViewportMechanism,
  windowMax: ViewportSize | null,
): { display: ViewportSize | null; maxWindowViewport: ViewportSize | null } {
  const display = displayWorkArea(webContents);
  if (!display) return { display: null, maxWindowViewport: null };
  // Emulation and lanes are not bound by the display at all, so there is no
  // window maximum to report for them.
  return { display, maxWindowViewport: mechanism === 'window-resize' ? windowMax : null };
}

/**
 * Put a surface back the way it was, including the zoom.
 *
 * Restoring the zoom is the right call now and would NOT have been before.
 * Zoom is the user's control as much as the agent's, so the rule is "put back
 * what the agent changed, leave alone what it did not" - and setting a size
 * now also sets the zoom, to fit the requested layout into the pane. So the
 * fit is the agent's change and a reset owes the user its reversal. The value
 * comes from `zoomBefore`, recorded on the FIRST override, so a pane the agent
 * never fitted has nothing restored and a user who re-zoomed mid-drive is not
 * silently overridden by a stale reading.
 */
export async function clearViewport(
  webContents: WebContents,
  entry: BrowserPaneEntry,
): Promise<ApplyViewportOutcome> {
  const existing = getViewportOverride(webContents.id);
  const mechanism = resolveMechanism(entry);
  let measured: ViewportSize | null = null;
  let note: string | null = null;

  if (mechanism === 'lane-resize') {
    const window = laneWindow(entry.sessionId);
    if (window) {
      measured = await resizeWindowToViewport(
        window,
        webContents,
        { width: DEFAULT_LANE_WIDTH, height: DEFAULT_LANE_HEIGHT },
        { clampToDisplay: false },
      );
    }
  } else if (mechanism === 'device-emulation') {
    await clearDeviceMetrics(webContents);
    if (existing) webContents.setZoomFactor(existing.zoomBefore);
    measured = await readViewport(webContents);
  } else {
    // A pop-out window keeps whatever size it is at: the window is the user's
    // to place, and snapping it back would be a second unrequested resize.
    //
    // Which makes this reset a bookkeeping change rather than a visible one,
    // so it has to SAY so: reporting a bare success while the window sits
    // exactly where the agent put it is the kind of quiet half-truth the
    // measured-not-echoed rule exists to prevent.
    measured = await readViewport(webContents);
    note =
      'This surface is a detached window, so nothing was resized: the window is the user\'s to place and is still at ' +
      `${measured?.width ?? '?'}x${measured?.height ?? '?'}. The override is no longer tracked. Pass a width and height to resize it, or kangentic_browser_dock to put it back in the task.`;
  }

  forgetViewportOverride(webContents.id);
  pushViewportOverride(webContents, null);

  const viewport = measured ?? { width: 0, height: 0 };
  return {
    mechanism,
    requested: viewport,
    viewport,
    deviceScaleFactor: 0,
    zoom: webContents.getZoomFactor(),
    display: displayWorkArea(webContents),
    maxWindowViewport: null,
    exact: true,
    visibleFraction: 1,
    note,
  };
}

/**
 * Put back every viewport an agent session overrode, when that session ends.
 *
 * The one path that matters for a PANE. A lane dies with its window, but a pane
 * belongs to the user and outlives the agent, so without this the user is left
 * looking at a desktop layout squeezed into a narrow pane by an agent that no
 * longer exists.
 */
export async function releaseViewportOverridesForSession(sessionId: string): Promise<void> {
  for (const webContentsId of webContentsIdsWithOverrideForSession(sessionId)) {
    const guest = electronWebContents.fromId(webContentsId);
    if (!guest) {
      forgetViewportOverride(webContentsId);
      continue;
    }
    await releaseViewportOverride(guest);
  }
}

/**
 * Drop any override this guest still carries, from a teardown path that has the
 * guest but no resolved registry entry.
 *
 * Best-effort and never throws: every caller is on a lifecycle path where
 * failing to restore a viewport must not stop a session ending or a pane
 * closing. The `getDeviceMetrics` check keeps a blanket sweep to one map lookup
 * per surface rather than a CDP roundtrip.
 */
export async function releaseViewportOverride(webContents: WebContents): Promise<void> {
  try {
    if (webContents.isDestroyed()) {
      forgetViewportOverride(webContents.id);
      return;
    }
    if (getDeviceMetrics(webContents)) await clearDeviceMetrics(webContents);
    if (forgetViewportOverride(webContents.id)) pushViewportOverride(webContents, null);
  } catch {
    forgetViewportOverride(webContents.id);
  }
}

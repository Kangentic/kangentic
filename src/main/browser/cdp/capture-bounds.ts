/**
 * How a screenshot of a `<webview>` guest is asked for, so Chromium never
 * hands back a tiled image.
 *
 * ## The mechanism this exists to stay inside
 *
 * `Page.captureScreenshot` works out a `requested_image_size` and then tries
 * to grow the view to it (`content/browser/devtools/protocol/page_handler.cc`):
 *
 *   - no clip, device-metrics override active: `emulatedView x widgetDSF x dpfactor`
 *   - a clip: `clip x widgetDSF x dpfactor x clip.scale`
 *   - no clip, no override: nothing; the surface comes back as it is
 *
 * where `dpfactor` is the emulated scale factor over the widget's, or 1 when
 * the override leaves it at 0. On a normal tab the view grows. A guest's view
 * cannot, so the bitmap stays the size of the pane's real widget, and
 * `ScreenshotCaptured` "crops" it to the requested size with
 * `SkBitmapOperations::CreateTiledBitmap`. When the request is larger than the
 * bitmap, that call repeats the bitmap: the page, tiled in a grid of
 * pane-sized strips.
 *
 * So the one invariant: a guest capture never asks for more pixels than the
 * widget holds, `widget (DIP) x displayScale`. Measured on Electron 41 against
 * a live guest at display scales 1, 1.25, 1.5, 1.75 and 2 and pane sizes from
 * 400x600 to 1200x800: every request inside the bound came back clean, every
 * one past it came back tiled, and the formula above predicted the decoded size
 * to within the clip's own rounding.
 *
 * ## Units, all measured
 *
 *   - A clip is in DIP, which is CSS pixels times the page zoom, and it is
 *     DOCUMENT-relative: scroll offset included.
 *   - `DOM.getBoxModel` reports CSS pixels relative to the VIEWPORT. Passing a
 *     box straight through as a clip captured the wrong region as soon as the
 *     page was zoomed or scrolled.
 *   - With a clip, an image pixel covers `clip.scale / devicePixelRatio` CSS
 *     pixels' worth: at `clip.scale` 1 the capture comes back at the page's own
 *     `devicePixelRatio`, whatever mix of zoom, display scale and emulation
 *     produced it. So a density is turned into a clip scale by dividing by it.
 *   - Anything outside the viewport is only painted with
 *     `captureBeyondViewport`. Without it the clip's off-screen part came back
 *     blank.
 *   - A clip scale above 1 re-rasterizes: an element captured at 1:1 out of a
 *     page zoomed to 0.46 was sharp, not an upscaled blur.
 *
 * Pure on purpose: every input is a number the caller measured, so the unit
 * test can hold the planner against its own statement of Chromium's rule.
 */

export interface Size {
  width: number;
  height: number;
}

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The pane a guest renders into. Null for anything that is not a guest. */
export interface GuestCaptureSurface {
  /** The `<webview>` element's size in DIP. */
  widget: Size;
  /** Scale factor of the display the pane is on, which Chromium uses for the widget. */
  displayScale: number;
}

/** What the page reports about itself, read just before the capture. */
export interface PageCaptureState {
  /** The guest's zoom factor: the ratio of DIP to CSS pixels. */
  zoom: number;
  /** `window.devicePixelRatio`: image pixels per CSS pixel of a clip-free capture. */
  devicePixelRatio: number;
  /** `innerWidth` / `innerHeight`, CSS pixels. */
  viewport: Size;
  /** `scrollX` / `scrollY`, CSS pixels. */
  scroll: { x: number; y: number };
  /** The document's full size, CSS pixels. */
  content: Size;
  /** A device-metrics override is active, so a clip-free capture asks for a size. */
  emulated: boolean;
}

export type CaptureTarget =
  | { kind: 'viewport' }
  | { kind: 'fullPage' }
  /** A box as `DOM.getBoxModel` reports it: CSS pixels, viewport-relative. */
  | { kind: 'element'; box: CssRect };

export interface CaptureClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface CapturePlan {
  clip: CaptureClip | null;
  captureBeyondViewport: boolean;
  /** Image pixels per CSS pixel. Divide an image coordinate by it for a CSS one. */
  pixelsPerCssPixel: number;
  /**
   * True when the pane's pixels, not the page's own density, set the size: the
   * capture would have been larger on a surface that could hold it.
   */
  limitedByPane: boolean;
}

/**
 * The density below which a capture counts as less than 1:1 and is worth
 * explaining to the agent. Just under 1, so float rounding at 1:1 stays quiet.
 */
export const BELOW_ONE_TO_ONE = 0.995;

/** The most pixels a guest capture can hold on each axis. */
export function surfacePixelBound(surface: GuestCaptureSurface): Size {
  // Floor, not round: the widget is measured with getBoundingClientRect and can
  // be fractional, and a bound one pixel past the real surface tiles a
  // one-pixel strip along that edge.
  return {
    width: Math.max(1, Math.floor(surface.widget.width * surface.displayScale)),
    height: Math.max(1, Math.floor(surface.widget.height * surface.displayScale)),
  };
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The density at which `region` fills the surface's pixels on its tighter axis. */
function densityToFill(region: Size, bound: Size | null): number {
  if (!bound) return Number.POSITIVE_INFINITY;
  return Math.min(
    bound.width / Math.max(1, region.width),
    bound.height / Math.max(1, region.height),
  );
}

function clipFor(region: CssRect, density: number, state: PageCaptureState): CaptureClip {
  const zoom = positiveOr(state.zoom, 1);
  const naturalDensity = positiveOr(state.devicePixelRatio, 1);
  return {
    x: region.x * zoom,
    y: region.y * zoom,
    width: Math.max(1, region.width) * zoom,
    height: Math.max(1, region.height) * zoom,
    scale: density / naturalDensity,
  };
}

function within(region: CssRect, viewportDocument: CssRect): boolean {
  return (
    region.x >= viewportDocument.x &&
    region.y >= viewportDocument.y &&
    region.x + region.width <= viewportDocument.x + viewportDocument.width &&
    region.y + region.height <= viewportDocument.y + viewportDocument.height
  );
}

/**
 * Plan one capture.
 *
 * `densityScale` is the byte-budget retry's downscale (1 on a first attempt);
 * it multiplies whatever density the plan would otherwise use, and forces a
 * clip, because a clip is the only lever that changes a capture's size.
 *
 * A null `surface` is anything that is not a guest (a lane's own window,
 * Kangentic's window under the dev bridge). Nothing bounds those, so they keep
 * the page's own density and Chromium's own full-page path, which grows a real
 * view correctly.
 */
export function planCapture(
  state: PageCaptureState,
  target: CaptureTarget,
  surface: GuestCaptureSurface | null,
  options: { densityScale?: number } = {},
): CapturePlan {
  const densityScale = Math.min(1, positiveOr(options.densityScale ?? 1, 1));
  const naturalDensity = positiveOr(state.devicePixelRatio, 1);
  const bound = surface ? surfacePixelBound(surface) : null;
  const viewportDocument: CssRect = {
    x: state.scroll.x,
    y: state.scroll.y,
    width: state.viewport.width,
    height: state.viewport.height,
  };

  if (target.kind === 'viewport') {
    const fill = densityToFill(state.viewport, bound);
    // A clip-free capture asks Chromium for `viewport x devicePixelRatio`
    // under an override and for nothing without one, so it is safe exactly
    // when that request fits.
    const naturalRequest: Size = {
      width: Math.round(state.viewport.width * naturalDensity),
      height: Math.round(state.viewport.height * naturalDensity),
    };
    const naturalFits =
      !bound ||
      !state.emulated ||
      (naturalRequest.width <= bound.width && naturalRequest.height <= bound.height);
    if (naturalFits && densityScale >= 1) {
      return { clip: null, captureBeyondViewport: false, pixelsPerCssPixel: naturalDensity, limitedByPane: false };
    }
    // Never above the page's own density: a viewport shot is the page as it
    // renders, and inventing pixels it does not have buys nothing.
    const density = Math.min(naturalDensity, fill) * densityScale;
    return {
      clip: clipFor(viewportDocument, density, state),
      captureBeyondViewport: false,
      pixelsPerCssPixel: density,
      limitedByPane: fill < naturalDensity,
    };
  }

  if (target.kind === 'fullPage') {
    if (!bound && densityScale >= 1) {
      return { clip: null, captureBeyondViewport: true, pixelsPerCssPixel: naturalDensity, limitedByPane: false };
    }
    const region: CssRect = { x: 0, y: 0, width: state.content.width, height: state.content.height };
    const wanted = bound ? Math.max(1, naturalDensity) : naturalDensity;
    const fill = densityToFill(region, bound);
    const density = Math.min(wanted, fill) * densityScale;
    return {
      clip: clipFor(region, density, state),
      captureBeyondViewport: !within(region, viewportDocument),
      pixelsPerCssPixel: density,
      limitedByPane: fill < wanted,
    };
  }

  // An element: the box arrives viewport-relative, the clip is document-relative.
  const region: CssRect = {
    x: target.box.x + state.scroll.x,
    y: target.box.y + state.scroll.y,
    width: target.box.width,
    height: target.box.height,
  };
  // On a pane, up to 1:1 even when the page itself is zoomed out below that, so
  // an element on a fitted desktop layout is still readable.
  const wanted = bound ? Math.max(1, naturalDensity) : naturalDensity;
  const fill = densityToFill(region, bound);
  const density = Math.min(wanted, fill) * densityScale;
  return {
    clip: clipFor(region, density, state),
    // Only when the element leaves the viewport: the flag also hides the
    // scrollbars for the capture, a relayout with nothing to gain otherwise.
    captureBeyondViewport: !within(region, viewportDocument),
    pixelsPerCssPixel: density,
    limitedByPane: fill < wanted,
  };
}

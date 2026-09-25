/**
 * A screenshot of a `<webview>` guest must never ask Chromium for more pixels
 * than the guest's pane holds, or Chromium fills the difference by repeating
 * the pane and hands back a tiled image.
 *
 * The planner is checked against this file's OWN statement of Chromium's
 * sizing rule, not against its own arithmetic. `planCapture` reasons in the
 * page's `devicePixelRatio`; the model below reasons in what Chromium actually
 * multiplies (the emulated view, the emulated scale factor over the widget's,
 * the clip scale), restated from `PageHandler::CaptureScreenshot` in
 * `content/browser/devtools/protocol/page_handler.cc`. The two agree only if
 * the planner's shortcut is right, which is the point.
 *
 * The model is itself checked: fed the configuration that shipped the bug (a
 * fitted pane sent `deviceScaleFactor = 1 / zoom`), it must predict a request
 * past the pane. A model that could not see the bug would pass every planner.
 *
 * Every scenario is built from physical inputs the way the app builds them
 * (pane size, display scale, requested viewport, zoom, explicit ratio), then
 * the page state the page would report is derived from those, as measured on
 * Electron 41: the page lays out at `override / zoom`, and `devicePixelRatio`
 * is the emulated factor (the display's own when 0) times the zoom.
 */
import { describe, it, expect } from 'vitest';
import {
  planCapture,
  surfacePixelBound,
  type CaptureClip,
  type CaptureTarget,
  type GuestCaptureSurface,
  type PageCaptureState,
  type Size,
} from '../../src/main/browser/cdp/capture-bounds';

const MIN_ZOOM = 0.25;

interface Setup {
  widget: Size;
  displayScale: number;
  /** The device-metrics override sent to Chromium, or null for none. */
  override: { width: number; height: number; deviceScaleFactor: number } | null;
  zoom: number;
  scroll: { x: number; y: number };
  content: Size;
}

/** How `applyViewport` sets up a docked pane for a requested viewport. */
function docked(
  widget: Size,
  displayScale: number,
  request: Size,
  options: { zoom?: number; devicePixelRatio?: number; scrollY?: number } = {},
): Setup {
  const fit = Math.max(MIN_ZOOM, Math.min(1, widget.width / request.width, widget.height / request.height));
  const zoom = options.zoom ?? fit;
  return {
    widget,
    displayScale,
    override: {
      width: Math.max(1, Math.round(request.width * zoom)),
      height: Math.max(1, Math.round(request.height * zoom)),
      deviceScaleFactor: options.devicePixelRatio ? options.devicePixelRatio / zoom : 0,
    },
    zoom,
    scroll: { x: 0, y: options.scrollY ?? 0 },
    content: { width: 3893, height: 3000 },
  };
}

/** A pane with no override at all: the page is the widget. */
function plain(widget: Size, displayScale: number, options: { zoom?: number; scrollY?: number } = {}): Setup {
  return {
    widget,
    displayScale,
    override: null,
    zoom: options.zoom ?? 1,
    scroll: { x: 0, y: options.scrollY ?? 0 },
    content: { width: 3893, height: 3000 },
  };
}

/** What the page reports about itself in that setup. */
function pageState(setup: Setup): PageCaptureState {
  const layoutDip = setup.override ?? setup.widget;
  const emulatedScale = setup.override && setup.override.deviceScaleFactor > 0
    ? setup.override.deviceScaleFactor
    : setup.displayScale;
  return {
    zoom: setup.zoom,
    devicePixelRatio: emulatedScale * setup.zoom,
    viewport: {
      width: Math.round(layoutDip.width / setup.zoom),
      height: Math.round(layoutDip.height / setup.zoom),
    },
    scroll: setup.scroll,
    content: setup.content,
    emulated: setup.override !== null,
  };
}

function surfaceOf(setup: Setup): GuestCaptureSurface {
  return { widget: setup.widget, displayScale: setup.displayScale };
}

/**
 * Chromium's `requested_image_size`, restated. Null means Chromium asks for no
 * size and returns the surface exactly as it is, which cannot tile.
 */
function chromiumRequest(setup: Setup, clip: CaptureClip | null): Size | null {
  const widgetScale = setup.displayScale;
  const emulated = setup.override !== null;
  const dpfactor = emulated && setup.override!.deviceScaleFactor > 0
    ? setup.override!.deviceScaleFactor / widgetScale
    : 1;
  if (clip) {
    const scale = widgetScale * dpfactor * clip.scale;
    return {
      width: Math.max(1, Math.round(clip.width * scale)),
      height: Math.max(1, Math.round(clip.height * scale)),
    };
  }
  if (emulated) {
    const scale = widgetScale * dpfactor;
    return { width: Math.round(setup.override!.width * scale), height: Math.round(setup.override!.height * scale) };
  }
  return null;
}

function fitsSurface(request: Size | null, setup: Setup): boolean {
  if (!request) return true;
  const bound = surfacePixelBound(surfaceOf(setup));
  return request.width <= bound.width && request.height <= bound.height;
}

// Boxes as `DOM.getBoxModel` reports them for the probe page: viewport-relative
// CSS pixels, content box. The tall one is taller than every pane below.
const TALL = { x: 54, y: 304, width: 392, height: 1992 };
const WIDE = { x: 22, y: 152, width: 1496, height: 116 };
const CARD = { x: 612, y: 412, width: 296, height: 156 };
const TINY = { x: 10, y: 10, width: 60, height: 14 };

const PANES: Size[] = [
  { width: 740, height: 749 },
  { width: 400, height: 600 },
  { width: 520, height: 900 },
  { width: 1200, height: 800 },
];
const DISPLAY_SCALES = [1, 1.25, 1.5, 1.75, 2];
const REQUESTS: Size[] = [
  { width: 1600, height: 1000 },
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
  { width: 1280, height: 720 },
  { width: 375, height: 667 },
];

function everySetup(): { label: string; setup: Setup }[] {
  const setups: { label: string; setup: Setup }[] = [];
  for (const pane of PANES) {
    for (const displayScale of DISPLAY_SCALES) {
      const at = `${pane.width}x${pane.height}@${displayScale}`;
      setups.push({ label: `${at} no override`, setup: plain(pane, displayScale) });
      setups.push({ label: `${at} no override, user zoom 0.8, scrolled`, setup: plain(pane, displayScale, { zoom: 0.8, scrollY: 500 }) });
      for (const request of REQUESTS) {
        const wanted = `${request.width}x${request.height}`;
        setups.push({ label: `${at} fit ${wanted}`, setup: docked(pane, displayScale, request) });
        setups.push({ label: `${at} fit ${wanted} scrolled`, setup: docked(pane, displayScale, request, { scrollY: 300 }) });
        setups.push({ label: `${at} zoom 1 ${wanted}`, setup: docked(pane, displayScale, request, { zoom: 1 }) });
        for (const devicePixelRatio of [1, 2, 3]) {
          setups.push({
            label: `${at} fit ${wanted} dpr ${devicePixelRatio}`,
            setup: docked(pane, displayScale, request, { devicePixelRatio }),
          });
        }
      }
    }
  }
  return setups;
}

const TARGETS: { label: string; target: CaptureTarget }[] = [
  { label: 'viewport', target: { kind: 'viewport' } },
  { label: 'full page', target: { kind: 'fullPage' } },
  { label: 'tall element', target: { kind: 'element', box: TALL } },
  { label: 'wide element', target: { kind: 'element', box: WIDE } },
  { label: 'card', target: { kind: 'element', box: CARD } },
  { label: 'tiny element', target: { kind: 'element', box: TINY } },
];

describe('the Chromium model this file checks against', () => {
  it('predicts the reported bug: a fitted pane sent 1/zoom asks for more than the pane holds', () => {
    // The repro: a 740x749 pane at display scale 1, 1600x1000 requested, fit
    // zoom 0.4625, `deviceScaleFactor` sent as 1/zoom = 2.16. Measured: the
    // capture came back 1600x1001, tiled in 740x749 blocks.
    const setup = docked({ width: 740, height: 749 }, 1, { width: 1600, height: 1000 }, { devicePixelRatio: 1 });
    const request = chromiumRequest(setup, null);
    expect(request).toEqual({ width: 1600, height: 1001 });
    expect(fitsSurface(request, setup)).toBe(false);
  });

  it('predicts the no-override tiling too: a clip taller than the pane at scale 1', () => {
    // Measured before this fix, with no viewport override at all: a 392x1992
    // element on a 740x749 pane came back 392x1992, repeating every 749 rows.
    const setup = plain({ width: 740, height: 749 }, 1);
    const request = chromiumRequest(setup, { ...TALL, scale: 1 });
    expect(request).toEqual({ width: 392, height: 1992 });
    expect(fitsSurface(request, setup)).toBe(false);
  });

  it('matches the decoded sizes the Electron 41 probe measured', () => {
    // Pixel-checked captures from the probe, one per mechanism.
    const fitDefault = docked({ width: 740, height: 749 }, 1.25, { width: 1600, height: 1000 });
    expect(chromiumRequest(fitDefault, null)).toEqual({ width: 925, height: 579 });
    const mobile = docked({ width: 740, height: 749 }, 2, { width: 375, height: 667 }, { devicePixelRatio: 3 });
    expect(chromiumRequest(mobile, null)).toEqual({ width: 1125, height: 2001 });
  });
});

describe('a planned capture never asks for more than the pane holds', () => {
  const setups = everySetup();

  it('covers the whole matrix, so a filter bug cannot pass it vacuously', () => {
    expect(setups.length).toBe(PANES.length * DISPLAY_SCALES.length * (2 + REQUESTS.length * 6));
  });

  for (const { label: targetLabel, target } of TARGETS) {
    it(`${targetLabel}: at every pane size, display scale, viewport, zoom and ratio`, () => {
      const failures: string[] = [];
      for (const { label, setup } of setups) {
        const plan = planCapture(pageState(setup), target, surfaceOf(setup));
        const request = chromiumRequest(setup, plan.clip);
        if (!fitsSurface(request, setup)) {
          const bound = surfacePixelBound(surfaceOf(setup));
          failures.push(`${label}: asked ${request!.width}x${request!.height}, pane holds ${bound.width}x${bound.height}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${targetLabel}: pixelsPerCssPixel is the density Chromium actually produces`, () => {
      const failures: string[] = [];
      for (const { label, setup } of setups) {
        const state = pageState(setup);
        const plan = planCapture(state, target, surfaceOf(setup));
        const request = chromiumRequest(setup, plan.clip);
        if (!request) {
          // No size asked: the surface comes back as-is, at the page's ratio.
          if (Math.abs(plan.pixelsPerCssPixel - state.devicePixelRatio) > 1e-9) {
            failures.push(`${label}: surface capture reported ${plan.pixelsPerCssPixel}, page ratio ${state.devicePixelRatio}`);
          }
          continue;
        }
        const cssWidth = plan.clip ? plan.clip.width / state.zoom : state.viewport.width;
        const expectedWidth = cssWidth * plan.pixelsPerCssPixel;
        if (Math.abs(request.width - expectedWidth) > 2) {
          failures.push(`${label}: Chromium makes ${request.width} wide, density says ${expectedWidth.toFixed(1)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe('the default fitted capture needs no clip', () => {
  it('asks for nothing Chromium would re-emulate for, so the user pane never flashes', () => {
    for (const displayScale of DISPLAY_SCALES) {
      for (const pane of PANES) {
        const setup = docked(pane, displayScale, { width: 1600, height: 1000 });
        const plan = planCapture(pageState(setup), { kind: 'viewport' }, surfaceOf(setup));
        // A fit above the minimum zoom keeps the view inside the pane; only a
        // clamped fit (a request more than 4x the pane) needs a clip.
        const fit = Math.min(1, pane.width / 1600, pane.height / 1000);
        if (fit >= MIN_ZOOM) expect(plan.clip, `${pane.width}x${pane.height}@${displayScale}`).toBeNull();
      }
    }
  });

  it('reports the fitted density: a 1600 layout in a 740 pane at scale 1 is 0.46', () => {
    const setup = docked({ width: 740, height: 749 }, 1, { width: 1600, height: 1000 });
    const plan = planCapture(pageState(setup), { kind: 'viewport' }, surfaceOf(setup));
    expect(plan.pixelsPerCssPixel).toBeCloseTo(0.4625, 4);
    expect(plan.limitedByPane).toBe(false);
  });

  it('leaves a pane with no override alone', () => {
    const setup = plain({ width: 740, height: 749 }, 1.5);
    const plan = planCapture(pageState(setup), { kind: 'viewport' }, surfaceOf(setup));
    expect(plan.clip).toBeNull();
    expect(plan.pixelsPerCssPixel).toBeCloseTo(1.5, 6);
  });
});

describe('a viewport the pane cannot show whole is still captured whole', () => {
  it('zoom 1 on a 1600 layout clips the whole viewport and scales it down', () => {
    const setup = docked({ width: 740, height: 749 }, 1, { width: 1600, height: 1000 }, { zoom: 1 });
    const plan = planCapture(pageState(setup), { kind: 'viewport' }, surfaceOf(setup));
    // The whole 1600 viewport, never the 740px crop the user sees: a crop
    // drops the half of a desktop layout the agent thinks it is looking at.
    expect(plan.clip).toEqual({ x: 0, y: 0, width: 1600, height: 1000, scale: expect.closeTo(0.4625, 4) });
    expect(plan.limitedByPane).toBe(true);
  });

  it('a scrolled viewport clips from the scroll position, in DIP', () => {
    const setup = docked({ width: 740, height: 749 }, 1, { width: 1600, height: 1000 }, { devicePixelRatio: 2, scrollY: 300 });
    const plan = planCapture(pageState(setup), { kind: 'viewport' }, surfaceOf(setup));
    expect(plan.clip?.y).toBeCloseTo(300 * setup.zoom, 6);
    expect(plan.clip?.width).toBeCloseTo(pageState(setup).viewport.width * setup.zoom, 6);
  });
});

describe('an element clip is document-relative DIP', () => {
  it('converts the viewport-relative CSS box, measured on a zoomed and scrolled page', () => {
    // The probe's card: box (612, 412) CSS on a page zoomed to 0.4625. Passing
    // the box straight through as a clip captured the "1400,900" label instead.
    const setup = docked({ width: 740, height: 749 }, 1, { width: 1600, height: 1000 }, { scrollY: 100 });
    const plan = planCapture(pageState(setup), { kind: 'element', box: CARD }, surfaceOf(setup));
    expect(plan.clip?.x).toBeCloseTo(612 * 0.4625, 6);
    expect(plan.clip?.y).toBeCloseTo((412 + 100) * 0.4625, 6);
    expect(plan.clip?.width).toBeCloseTo(296 * 0.4625, 6);
  });

  it('captures an element at 1:1 on a pane zoomed out to fit, since the re-raster is sharp', () => {
    const setup = docked({ width: 740, height: 749 }, 1, { width: 1600, height: 1000 });
    const plan = planCapture(pageState(setup), { kind: 'element', box: CARD }, surfaceOf(setup));
    expect(plan.pixelsPerCssPixel).toBeCloseTo(1, 6);
    expect(plan.limitedByPane).toBe(false);
  });

  it('keeps the page ratio on a hidpi display rather than capping at 1', () => {
    const setup = plain({ width: 740, height: 749 }, 2);
    const plan = planCapture(pageState(setup), { kind: 'element', box: CARD }, surfaceOf(setup));
    expect(plan.pixelsPerCssPixel).toBeCloseTo(2, 6);
  });

  it('scales a tall element to fit and says the pane limited it', () => {
    const setup = plain({ width: 740, height: 749 }, 1);
    const plan = planCapture(pageState(setup), { kind: 'element', box: TALL }, surfaceOf(setup));
    expect(plan.pixelsPerCssPixel).toBeCloseTo(749 / 1992, 6);
    expect(plan.limitedByPane).toBe(true);
  });

  it('paints outside the viewport only when the element leaves it', () => {
    const setup = plain({ width: 740, height: 749 }, 1);
    const inside = planCapture(pageState(setup), { kind: 'element', box: TINY }, surfaceOf(setup));
    const outside = planCapture(pageState(setup), { kind: 'element', box: TALL }, surfaceOf(setup));
    expect(inside.captureBeyondViewport).toBe(false);
    expect(outside.captureBeyondViewport).toBe(true);
  });
});

describe('a surface that is not a guest keeps its old requests', () => {
  it('a real window keeps Chromium\'s own full-page path, which grows its view', () => {
    const setup = plain({ width: 1280, height: 800 }, 1);
    const plan = planCapture(pageState(setup), { kind: 'fullPage' }, null);
    expect(plan.clip).toBeNull();
    expect(plan.captureBeyondViewport).toBe(true);
  });

  it('a real window captures an element at the page ratio, with the coordinates fixed', () => {
    const setup = plain({ width: 1280, height: 800 }, 1, { scrollY: 200 });
    const plan = planCapture(pageState(setup), { kind: 'element', box: CARD }, null);
    expect(plan.clip).toEqual({ x: 612, y: 612, width: 296, height: 156, scale: 1 });
  });
});

describe('a byte-budget retry shrinks the capture it names', () => {
  it('forces a clip on a viewport capture, so the downscale is real rather than reported', () => {
    const setup = plain({ width: 740, height: 749 }, 1);
    const plan = planCapture(pageState(setup), { kind: 'viewport' }, surfaceOf(setup), { densityScale: 0.6 });
    expect(plan.clip?.scale).toBeCloseTo(0.6, 6);
    expect(plan.pixelsPerCssPixel).toBeCloseTo(0.6, 6);
  });

  it('never scales up', () => {
    const setup = plain({ width: 740, height: 749 }, 1);
    const plan = planCapture(pageState(setup), { kind: 'viewport' }, surfaceOf(setup), { densityScale: 3 });
    expect(plan.clip).toBeNull();
  });
});

describe('surfacePixelBound floors a fractional widget size', () => {
  it('floors rather than rounds, since a bound one pixel too tall tiles a strip', () => {
    // 740.6 * 1.25 = 925.75 (floor 925, round 926); 500.5 * 1.25 = 625.625
    // (floor 625, round 626). Both axes round up, so a round-based bound would
    // hand Chromium a size the pane cannot actually hold on either axis.
    const bound = surfacePixelBound({ widget: { width: 740.6, height: 500.5 }, displayScale: 1.25 });
    expect(bound).toEqual({ width: 925, height: 625 });
  });
});

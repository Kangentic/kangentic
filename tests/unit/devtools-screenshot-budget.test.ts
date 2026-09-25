/**
 * Unit tests for `captureScreenshotWithBudget` in
 * src/devtools/main/screenshot.ts.
 *
 * The function is a retry orchestrator that wraps the bare CDP capture with:
 *   1. A maxBytes / inlineCeiling budget gate
 *   2. A progressive quality/scale retry loop
 *      (png -> jpeg q70 -> step-down quality -> step-down scale)
 *   3. A file-persistence fallback when the budget cannot be met or the
 *      inline ceiling is exceeded
 *
 * Strategy: mock the CDP helpers listed in the `vi.mock` block below, from
 * `../../src/main/browser/cdp/cdp`, at the top of the file (Vitest hoists it
 * regardless of where it appears, so we declare it first for clarity). Each test
 * configures `captureScreenshot` to return base64-encoded buffers of a
 * controlled byte size so the budget arithmetic is deterministic.
 *
 * `configureScreenshotProjectRoot` is called in `beforeEach` to point
 * screenshot file persistence at a temp directory so the file-mode path
 * can be exercised without touching production storage.
 *
 * Mocks `electron` because screenshot.ts / cdp.ts import BrowserWindow
 * types from there. The module body for captureScreenshotWithBudget does
 * not call Electron APIs directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0') },
}));

// ---------------------------------------------------------------------------
// CDP mock - hoisted. Every helper screenshot.ts calls is replaced with
// vi.fn() so each test can configure it independently via
// .mockResolvedValue / .mockReturnValue.
// ---------------------------------------------------------------------------
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  captureScreenshot: vi.fn(),
  getLayoutMetrics: vi.fn(),
  decodeImageDimensions: vi.fn(),
  getBoundingBox: vi.fn(),
  getDeviceMetrics: vi.fn(() => null),
  runtimeEvaluate: vi.fn(),
}));

import {
  captureElementClip,
  captureScreenshotWithBudget,
  CaptureExceedsSurface,
  configureScreenshotProjectRoot,
  DEFAULT_INLINE_BYTE_CEILING,
  readPageCaptureState,
} from '../../src/main/browser/cdp/screenshot';
import {
  captureScreenshot as mockCaptureScreenshot,
  getLayoutMetrics as mockGetLayoutMetrics,
  decodeImageDimensions as mockDecodeImageDimensions,
  getBoundingBox as mockGetBoundingBox,
  runtimeEvaluate as mockRuntimeEvaluate,
} from '../../src/main/browser/cdp/cdp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Buffer of an exact decoded byte size and return its base64
 * encoding. `captureOnce` decodes the base64 to measure `byteLength`.
 */
function base64OfSize(byteLength: number): string {
  return Buffer.alloc(byteLength).toString('base64');
}

// Fake layout metrics returned by our getLayoutMetrics mock.
const FAKE_LAYOUT = {
  viewportWidth: 1280,
  viewportHeight: 720,
  deviceScaleFactor: 2,
  contentWidth: 1280,
  contentHeight: 2000,
};

// Fake image dimensions returned by our decodeImageDimensions mock.
const FAKE_DIMS = { width: 1280, height: 720 };

// What the page reports about itself, read before every capture so the
// capture can be planned. Ratio 1, so a clip scale reads directly as the
// density a retry asked for.
const FAKE_PAGE = {
  width: 1280,
  height: 720,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
  contentWidth: 1280,
  contentHeight: 2000,
};

// A fake WebContents - captureScreenshotWithBudget passes it through to
// the mocked CDP functions and reads the zoom from it.
const fakeWebContents = { getZoomFactor: () => 1 } as unknown as import('electron').WebContents;

/** Kangentic's own window under the dev bridge: not a guest, so unbounded. */
const NOT_A_GUEST = { surface: null } as const;

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-budget-test-'));

  // Reset all mocks between tests so call counts / values don't bleed over.
  vi.mocked(mockCaptureScreenshot).mockReset();
  vi.mocked(mockGetLayoutMetrics).mockReset();
  vi.mocked(mockDecodeImageDimensions).mockReset();
  vi.mocked(mockGetBoundingBox).mockReset();
  vi.mocked(mockRuntimeEvaluate).mockReset();

  // Establish sensible defaults. Individual tests override as needed.
  vi.mocked(mockGetLayoutMetrics).mockResolvedValue(FAKE_LAYOUT);
  vi.mocked(mockDecodeImageDimensions).mockReturnValue(FAKE_DIMS);
  vi.mocked(mockRuntimeEvaluate).mockResolvedValue({ value: FAKE_PAGE, error: null });

  configureScreenshotProjectRoot(() => tempDirectory);
});

afterEach(() => {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// (a) Under-budget first attempt -> inline, retries: 0
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - under-budget first attempt', () => {
  it('returns mode:inline with retries:0 when first attempt is under budget', async () => {
    const budget = 1_000_000;
    const captureSize = 500_000; // well under budget
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(captureSize));

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST, maxBytes: budget });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('inline');
    expect(result!.retries).toBe(0);
    expect(result!.byteLength).toBe(captureSize);
    expect(result!.viewportWidth).toBe(FAKE_LAYOUT.viewportWidth);
    expect(result!.deviceScaleFactor).toBe(FAKE_LAYOUT.deviceScaleFactor);
    expect(result!.width).toBe(FAKE_DIMS.width);
    expect(result!.height).toBe(FAKE_DIMS.height);
    // captureScreenshot called exactly once (no retries)
    expect(vi.mocked(mockCaptureScreenshot)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (b) Over-budget PNG-first attempt switches to jpeg q70 on retry 1
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - PNG -> jpeg q70 on first retry', () => {
  it('switches to jpeg q70 on retry 1 and returns inline when that fits', async () => {
    const budget = 600_000;
    // First attempt (PNG) is over budget; second attempt (jpeg q70) fits.
    vi.mocked(mockCaptureScreenshot)
      .mockResolvedValueOnce(base64OfSize(800_000))
      .mockResolvedValueOnce(base64OfSize(400_000));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: budget,
    });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('inline');
    expect(result!.retries).toBe(1);
    expect(result!.format).toBe('jpeg');
    expect(vi.mocked(mockCaptureScreenshot)).toHaveBeenCalledTimes(2);

    // The second call must have used format:jpeg and quality:70
    const secondCallOptions = vi.mocked(mockCaptureScreenshot).mock.calls[1][1] as {
      format: string;
      quality: number;
    };
    expect(secondCallOptions.format).toBe('jpeg');
    expect(secondCallOptions.quality).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// (c) Quality step-down by 15 per retry, clamped at 35
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - quality step-down', () => {
  it('steps quality from 70 -> 55 -> 40 -> 35 across retries', async () => {
    const budget = 200_000;
    const overSize = 500_000;
    const underSize = 150_000;

    // Calls in order:
    //   1: png (initial) -> over budget -> switch to jpeg q70 (retry 1)
    //   2: jpeg q70      -> over budget -> step to q55 (retry 2)
    //   3: jpeg q55      -> over budget -> step to q40 (retry 3)
    //   4: jpeg q40      -> over budget -> step to q35 (retry 4)
    //   5: jpeg q35      -> under budget -> return inline
    vi.mocked(mockCaptureScreenshot)
      .mockResolvedValueOnce(base64OfSize(overSize))
      .mockResolvedValueOnce(base64OfSize(overSize))
      .mockResolvedValueOnce(base64OfSize(overSize))
      .mockResolvedValueOnce(base64OfSize(overSize))
      .mockResolvedValueOnce(base64OfSize(underSize));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: budget,
    });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('inline');
    expect(result!.retries).toBe(4);
    expect(result!.format).toBe('jpeg');

    // Verify quality values on retry calls (indices 1..4, skip initial call)
    const retryCalls = vi.mocked(mockCaptureScreenshot).mock.calls.slice(1);
    const qualityValues = retryCalls.map(
      (callArgs) => (callArgs[1] as { quality?: number }).quality,
    );
    expect(qualityValues).toEqual([70, 55, 40, 35]);
  });

  it('clamps quality at MIN_RETRY_QUALITY (35), never goes below', async () => {
    const budget = 200_000;
    const overSize = 500_000;
    const underSize = 150_000;

    vi.mocked(mockCaptureScreenshot)
      .mockResolvedValueOnce(base64OfSize(overSize))
      .mockResolvedValueOnce(base64OfSize(overSize))
      .mockResolvedValueOnce(base64OfSize(overSize))
      .mockResolvedValueOnce(base64OfSize(overSize))
      .mockResolvedValueOnce(base64OfSize(underSize));

    await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST, format: 'png', maxBytes: budget });

    const retryCalls = vi.mocked(mockCaptureScreenshot).mock.calls.slice(1);
    const qualityValues = retryCalls.map(
      (callArgs) => (callArgs[1] as { quality?: number }).quality,
    );
    // No quality value produced in the retry ladder should be below 35
    for (const qualityValue of qualityValues) {
      if (qualityValue !== undefined) {
        expect(qualityValue).toBeGreaterThanOrEqual(35);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Scale step-down by 0.2 per retry, clamped at 0.5
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - scale step-down', () => {
  it('steps scale down after quality is exhausted, clamped at 0.5, then falls to file mode', async () => {
    // All attempts are over budget so we exhaust the entire retry tree:
    //   initial (png) -> jpeg q70 -> q55 -> q40 -> q35 -> scale 0.8 -> scale 0.6 -> scale 0.5 -> break
    // After the break, the attempt is still over budget -> file mode.
    const budget = 200_000;
    const overSize = 500_000;
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(overSize));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: budget,
    });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('file');
    expect(result!.scale).toBeCloseTo(0.5, 5);

    // Calls 0..4 are: initial + q70 + q55 + q40 + q35. Scale retries start at
    // call index 5: 0.8, 0.6, 0.5. Total calls: 1 initial + 4 quality + 3 scale = 8
    const allCalls = vi.mocked(mockCaptureScreenshot).mock.calls;
    expect(allCalls.length).toBe(8);

    // The quality retries ask for the viewport as it is, with no clip.
    for (const callArgs of allCalls.slice(0, 5)) {
      expect((callArgs[1] as { clip?: unknown }).clip).toBeUndefined();
    }

    // A viewport capture has no clip of its own, so a scale retry has to make
    // one: before planning existed the retry reported a scale it never
    // applied. The page ratio is 1, so the clip scale IS the density asked for.
    const scaleCalls = allCalls.slice(5);
    const clips = scaleCalls.map(
      (callArgs) => (callArgs[1] as { clip?: { width: number; scale?: number } }).clip,
    );
    expect(clips[0]?.width).toBe(FAKE_PAGE.width);
    expect(clips[0]?.scale).toBeCloseTo(0.8, 5);
    expect(clips[1]?.scale).toBeCloseTo(0.6, 5);
    expect(clips[2]?.scale).toBeCloseTo(0.5, 5);
  });

  it('keeps the old no-clip request when the page cannot describe itself', async () => {
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({ value: null, error: 'renderer blocked' });
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(500_000));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: 200_000,
    });

    expect(result).not.toBeNull();
    for (const callArgs of vi.mocked(mockCaptureScreenshot).mock.calls) {
      expect((callArgs[1] as { clip?: unknown }).clip).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// (e) Over-budget after exhausting all retries -> file mode, reason: 'over-max-bytes'
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - exhausted retries -> file mode', () => {
  it('falls back to file mode with reason:over-max-bytes when all retries are over budget', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(500_000));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: 200_000,
    });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('file');
    if (result!.mode === 'file') {
      expect(result!.reason).toBe('over-max-bytes');
      expect(typeof result!.filePath).toBe('string');
      expect(typeof result!.fileUri).toBe('string');
      expect(result!.fileUri).toMatch(/^file:\/\//);
    }
  });

  it('writes the screenshot file to the configured project shots directory', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(500_000));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: 200_000,
    });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('file');
    if (result!.mode === 'file') {
      expect(fs.existsSync(result!.filePath)).toBe(true);
      // The shots dir must be inside the configured project root.
      // Normalize slashes for cross-platform comparison.
      const normalizedFilePath = result!.filePath.replace(/\\/g, '/');
      const normalizedTempDir = tempDirectory.replace(/\\/g, '/');
      expect(normalizedFilePath.startsWith(normalizedTempDir)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (f) Over-inlineCeiling goes straight to file mode, reason: 'over-inline-ceiling'
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - over inline ceiling', () => {
  it('persists to file with reason:over-inline-ceiling when image exceeds the default ceiling', async () => {
    const overCeilingSize = DEFAULT_INLINE_BYTE_CEILING + 100_000;
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(overCeilingSize));

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('file');
    if (result!.mode === 'file') {
      expect(result!.reason).toBe('over-inline-ceiling');
    }
  });

  it('uses the inlineCeiling override when provided', async () => {
    const customCeiling = 100_000;
    // Over the custom ceiling but under the default ceiling.
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(200_000));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      inlineCeiling: customCeiling,
    });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('file');
    if (result!.mode === 'file') {
      expect(result!.reason).toBe('over-inline-ceiling');
    }
  });
});

// ---------------------------------------------------------------------------
// (g) captureScreenshot returning null propagates null
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - null propagation', () => {
  it('returns null when captureScreenshot returns null on the first attempt', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(null);

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST, maxBytes: 1_000_000 });
    expect(result).toBeNull();
  });

  it('stops retrying and falls to file mode when captureScreenshot returns null mid-retry', async () => {
    const budget = 200_000;
    // Initial PNG attempt is over budget; first retry (jpeg) returns null.
    // The function breaks out of the retry loop and uses the last successful
    // attempt (the PNG one, which is over budget) -> file mode.
    vi.mocked(mockCaptureScreenshot)
      .mockResolvedValueOnce(base64OfSize(500_000)) // initial: over budget
      .mockResolvedValueOnce(null); // retry 1: null -> break

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: budget,
    });

    // Must not throw. Falls through with the last successful attempt.
    expect(result).not.toBeNull();
    // Last successful attempt was 500_000 bytes, over budget -> file mode.
    expect(result!.mode).toBe('file');
  });
});

// ---------------------------------------------------------------------------
// Metadata fields
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - metadata fields', () => {
  it('sets metricsAvailable:true when getLayoutMetrics succeeds', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST });
    expect(result).not.toBeNull();
    expect(result!.metricsAvailable).toBe(true);
  });

  it('sets metricsAvailable:false and falls back to zero viewport when getLayoutMetrics returns null', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockGetLayoutMetrics).mockResolvedValue(null);

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST });
    expect(result).not.toBeNull();
    expect(result!.metricsAvailable).toBe(false);
    expect(result!.viewportWidth).toBe(0);
    expect(result!.viewportHeight).toBe(0);
    expect(result!.deviceScaleFactor).toBe(1);
  });

  it('passes fullPage flag through to the response', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST, fullPage: true });
    expect(result).not.toBeNull();
    expect(result!.fullPage).toBe(true);
  });

  it('sets elementClip from the element an element capture was taken of', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockGetBoundingBox).mockResolvedValue({
      content: [10, 20, 90, 20, 90, 60, 10, 60],
    } as never);

    const result = await captureElementClip(fakeWebContents, 'button.primary', { ...NOT_A_GUEST });
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    expect((result as { elementClip: unknown }).elementClip).toEqual({
      selector: 'button.primary',
      box: { x: 10, y: 20, width: 80, height: 40 },
    });
  });

  it('sets elementClip to null for a viewport capture', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST });
    expect(result).not.toBeNull();
    expect(result!.elementClip).toBeNull();
  });

  it('reports pixelsPerCssPixel, the density to map image coordinates with', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({ value: { ...FAKE_PAGE, devicePixelRatio: 1.5 }, error: null });

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST });
    expect(result!.pixelsPerCssPixel).toBeCloseTo(1.5, 6);
  });
});

// ---------------------------------------------------------------------------
// A <webview> guest: the capture is bounded by the pane
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - a pane capture', () => {
  // A 740x749 pane at display scale 1, holding a 1600x1001 layout fitted at
  // zoom 0.4625: the reported repro.
  const PANE = { surface: { widget: { width: 740, height: 749 }, displayScale: 1 } } as const;
  const FITTED_PAGE = {
    width: 1600,
    height: 1001,
    devicePixelRatio: 0.4625,
    scrollX: 0,
    scrollY: 0,
    contentWidth: 3894,
    contentHeight: 3001,
  };

  it('refuses a capture that came back larger than the pane, instead of returning the tiles', async () => {
    // Whatever asked for it, an image larger than the pane was filled in by
    // Chromium repeating the pane. Returning it would hand the agent a grid.
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 1600, height: 1001 });

    await expect(captureScreenshotWithBudget(fakeWebContents, { ...PANE })).rejects.toBeInstanceOf(CaptureExceedsSurface);
  });

  it('names the pane size in the refusal, so the agent knows what it hit', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 1600, height: 1001 });

    await expect(captureScreenshotWithBudget(fakeWebContents, { ...PANE })).rejects.toThrow(/740x749 pixels this pane can render/);
  });

  it('accepts an image within a couple of pixels of the pane, since the pane edge can land between pixels', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 742, height: 463 });

    await expect(captureScreenshotWithBudget(fakeWebContents, { ...PANE })).resolves.not.toBeNull();
  });

  it('never bounds a surface that is not a guest', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 5000, height: 4000 });

    await expect(captureScreenshotWithBudget(fakeWebContents, { ...NOT_A_GUEST })).resolves.not.toBeNull();
  });

  it('reads a caller that left the surface out as not a guest, rather than crashing', async () => {
    // tests/ and anything outside the type system can omit the required field.
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 5000, height: 4000 });

    const options = {} as Parameters<typeof captureScreenshotWithBudget>[1];
    await expect(captureScreenshotWithBudget(fakeWebContents, options)).resolves.not.toBeNull();
  });

  it('says why a fitted viewport comes back small, and where to go for detail', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 740, height: 463 });
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({ value: FITTED_PAGE, error: null });
    const { getDeviceMetrics } = await import('../../src/main/browser/cdp/cdp');
    vi.mocked(getDeviceMetrics).mockReturnValueOnce({ width: 740, height: 463, deviceScaleFactor: 0 });

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...PANE });
    expect(result!.pixelsPerCssPixel).toBeCloseTo(0.4625, 4);
    expect(result!.note).toMatch(/1600x1001 viewport came back at 740x463/);
    expect(result!.note).toMatch(/kangentic_browser_screenshot_element/);
    // The fitted default is safe as it stands, so Chromium is asked for the
    // viewport with no clip and never re-renders the user's pane for it.
    expect((vi.mocked(mockCaptureScreenshot).mock.calls[0][1] as { clip?: unknown }).clip).toBeUndefined();
  });

  it('stays quiet about a page the user zoomed out themselves', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 740, height: 749 });
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({
      value: { ...FAKE_PAGE, width: 925, height: 936, devicePixelRatio: 0.8 },
      error: null,
    });

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...PANE });
    expect(result!.note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// captureNote: the element branch, driven through captureElementClip
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - captureNote for an element capture', () => {
  const PANE = { surface: { widget: { width: 740, height: 749 }, displayScale: 1 } } as const;

  it('says an oversized element is larger than the pane, naming the pane and the returned image size', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    // A 2000x3000 CSS-pixel element cannot fit a 740x749 pane at 1:1, so the
    // plan scales it down and reports limitedByPane. The decoded size below is
    // picked to land inside the pane's bound (the surface-exceeded check would
    // otherwise throw before the note is ever built).
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 499, height: 749 });
    vi.mocked(mockGetBoundingBox).mockResolvedValue({
      content: [0, 0, 2000, 0, 2000, 3000, 0, 3000],
    } as never);

    const result = await captureElementClip(fakeWebContents, '.huge-panel', { ...PANE });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    const note = (result as { note: string | null }).note;
    expect(note).toContain('This element is larger than');
    expect(note).toContain('740x749');
    expect(note).toContain('499x749');
  });

  it('says nothing about an element that already fits inside the pane', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 80, height: 40 });
    vi.mocked(mockGetBoundingBox).mockResolvedValue({
      content: [10, 20, 90, 20, 90, 60, 10, 60],
    } as never);

    const result = await captureElementClip(fakeWebContents, '.small-button', { ...PANE });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    expect((result as { note: string | null }).note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// captureNote: the fullPage branch
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - captureNote for a full-page capture', () => {
  const PANE = { surface: { widget: { width: 740, height: 749 }, displayScale: 1 } } as const;

  it('says the page came back smaller than its content, naming the content and image size', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    // The 1280x3000 document cannot fit the 740x749 pane, so the fullPage
    // capture is scaled down. The decoded size is picked inside the pane's
    // bound for the same reason as the element case above.
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 320, height: 749 });
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({
      value: {
        width: 1280,
        height: 720,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
        contentWidth: 1280,
        contentHeight: 3000,
      },
      error: null,
    });

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...PANE, fullPage: true });

    expect(result).not.toBeNull();
    expect(result!.note).toContain('page came back at');
    expect(result!.note).toContain('1280x3000');
    expect(result!.note).toContain('320x749');
  });

  it('says nothing about a page whose content already fits the pane', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockDecodeImageDimensions).mockReturnValue({ width: 700, height: 700 });
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({
      value: {
        width: 700,
        height: 700,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
        contentWidth: 700,
        contentHeight: 700,
      },
      error: null,
    });

    const result = await captureScreenshotWithBudget(fakeWebContents, { ...PANE, fullPage: true });

    expect(result).not.toBeNull();
    expect(result!.note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readPageCaptureState: the finite guard. Before the fix, `typeof NaN ===
// 'number'` (and `typeof Infinity === 'number'`) passed the guard, so a page
// reporting a non-finite metric produced a NaN-laden clip instead of falling
// back to the pre-planning request.
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - non-finite page metrics fall back to the old request', () => {
  it('keeps the old no-clip request when the page reports a NaN width', async () => {
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({
      value: { ...FAKE_PAGE, width: Number.NaN },
      error: null,
    });
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(500_000));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: 200_000,
    });

    expect(result).not.toBeNull();
    // The retry ladder must run all the way to the scale-retry calls: the
    // quality retries stay clip-free even with a NaN pageState, because with
    // no bounding surface densityScale >= 1 short-circuits to clip:null on
    // its own. Only the scale-retry calls (index 5+) expose a NaN clip if the
    // finite guard regresses, so pin the call count that reaches them.
    expect(vi.mocked(mockCaptureScreenshot).mock.calls.length).toBe(8);
    for (const callArgs of vi.mocked(mockCaptureScreenshot).mock.calls) {
      expect((callArgs[1] as { clip?: unknown }).clip).toBeUndefined();
    }
  });

  it('keeps the old no-clip request when the page reports an infinite devicePixelRatio', async () => {
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({
      value: { ...FAKE_PAGE, devicePixelRatio: Number.POSITIVE_INFINITY },
      error: null,
    });
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(500_000));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      ...NOT_A_GUEST,
      format: 'png',
      maxBytes: 200_000,
    });

    expect(result).not.toBeNull();
    // Same reasoning as the NaN-width case above: the scale-retry calls are
    // where an infinite devicePixelRatio would otherwise surface as a clip.
    expect(vi.mocked(mockCaptureScreenshot).mock.calls.length).toBe(8);
    for (const callArgs of vi.mocked(mockCaptureScreenshot).mock.calls) {
      expect((callArgs[1] as { clip?: unknown }).clip).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// readPageCaptureState: scroll and content fallbacks
// ---------------------------------------------------------------------------
describe('readPageCaptureState - fallbacks for scroll and content', () => {
  it('reads a missing or non-finite scroll position as 0', async () => {
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({
      value: {
        width: 1280,
        height: 720,
        devicePixelRatio: 1,
        scrollX: Number.NaN,
        scrollY: undefined,
        contentWidth: 1280,
        contentHeight: 720,
      },
      error: null,
    });

    const state = await readPageCaptureState(fakeWebContents);

    expect(state).not.toBeNull();
    expect(state!.scroll).toEqual({ x: 0, y: 0 });
  });

  it('clamps a content size smaller than the viewport up to the viewport', async () => {
    vi.mocked(mockRuntimeEvaluate).mockResolvedValue({
      value: {
        width: 800,
        height: 600,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
        contentWidth: 500,
        contentHeight: 400,
      },
      error: null,
    });

    const state = await readPageCaptureState(fakeWebContents);

    expect(state).not.toBeNull();
    expect(state!.content).toEqual({ width: 800, height: 600 });
  });
});

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
 * Strategy: mock `captureScreenshot`, `getLayoutMetrics`, and
 * `decodeImageDimensions` from `../../src/devtools/main/cdp` via
 * `vi.mock(...)` at the top of the file (Vitest hoists it regardless of
 * where it appears, so we declare it first for clarity). Each test
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
// CDP mock - hoisted. `captureScreenshot`, `getLayoutMetrics`, and
// `decodeImageDimensions` are replaced with vi.fn() so each test can
// configure them independently via .mockResolvedValue / .mockReturnValue.
// ---------------------------------------------------------------------------
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  captureScreenshot: vi.fn(),
  getLayoutMetrics: vi.fn(),
  decodeImageDimensions: vi.fn(),
  getBoundingBox: vi.fn(),
}));

import {
  captureScreenshotWithBudget,
  configureScreenshotProjectRoot,
  DEFAULT_INLINE_BYTE_CEILING,
} from '../../src/main/browser/cdp/screenshot';
import {
  captureScreenshot as mockCaptureScreenshot,
  getLayoutMetrics as mockGetLayoutMetrics,
  decodeImageDimensions as mockDecodeImageDimensions,
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

// A fake WebContents - captureScreenshotWithBudget passes it through to
// the mocked CDP functions, so we only need a truthy object.
const fakeWebContents = {} as import('electron').WebContents;

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-budget-test-'));

  // Reset all mocks between tests so call counts / values don't bleed over.
  vi.mocked(mockCaptureScreenshot).mockReset();
  vi.mocked(mockGetLayoutMetrics).mockReset();
  vi.mocked(mockDecodeImageDimensions).mockReset();

  // Establish sensible defaults. Individual tests override as needed.
  vi.mocked(mockGetLayoutMetrics).mockResolvedValue(FAKE_LAYOUT);
  vi.mocked(mockDecodeImageDimensions).mockReturnValue(FAKE_DIMS);

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

    const result = await captureScreenshotWithBudget(fakeWebContents, { maxBytes: budget });

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

    await captureScreenshotWithBudget(fakeWebContents, { format: 'png', maxBytes: budget });

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
      format: 'png',
      maxBytes: budget,
      clip: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
    });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('file');

    // After 4 quality retries (calls 1-4 are png + q70 + q55 + q40, wait -
    // actually calls 1..5 are: initial + q70 + q55 + q40 + q35).
    // Scale retries start at call index 5 (0-based). There should be
    // 3 scale retries: 0.8, 0.6, 0.5.
    // Total calls: 1 initial + 4 quality + 3 scale = 8
    const allCalls = vi.mocked(mockCaptureScreenshot).mock.calls;
    expect(allCalls.length).toBe(8);

    // Scale values on the last 3 calls (indices 5, 6, 7)
    const scaleCalls = allCalls.slice(5);
    const scaleValues = scaleCalls.map(
      (callArgs) =>
        (callArgs[1] as { clip?: { scale?: number } }).clip?.scale,
    );
    expect(scaleValues[0]).toBeCloseTo(0.8, 5);
    expect(scaleValues[1]).toBeCloseTo(0.6, 5);
    expect(scaleValues[2]).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// (e) Over-budget after exhausting all retries -> file mode, reason: 'over-max-bytes'
// ---------------------------------------------------------------------------
describe('captureScreenshotWithBudget - exhausted retries -> file mode', () => {
  it('falls back to file mode with reason:over-max-bytes when all retries are over budget', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(500_000));

    const result = await captureScreenshotWithBudget(fakeWebContents, {
      format: 'png',
      maxBytes: 200_000,
      clip: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
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
      format: 'png',
      maxBytes: 200_000,
      clip: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
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

    const result = await captureScreenshotWithBudget(fakeWebContents, {});

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

    const result = await captureScreenshotWithBudget(fakeWebContents, { maxBytes: 1_000_000 });
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

    const result = await captureScreenshotWithBudget(fakeWebContents, {});
    expect(result).not.toBeNull();
    expect(result!.metricsAvailable).toBe(true);
  });

  it('sets metricsAvailable:false and falls back to zero viewport when getLayoutMetrics returns null', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));
    vi.mocked(mockGetLayoutMetrics).mockResolvedValue(null);

    const result = await captureScreenshotWithBudget(fakeWebContents, {});
    expect(result).not.toBeNull();
    expect(result!.metricsAvailable).toBe(false);
    expect(result!.viewportWidth).toBe(0);
    expect(result!.viewportHeight).toBe(0);
    expect(result!.deviceScaleFactor).toBe(1);
  });

  it('passes fullPage flag through to the response', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));

    const result = await captureScreenshotWithBudget(fakeWebContents, { fullPage: true });
    expect(result).not.toBeNull();
    expect(result!.fullPage).toBe(true);
  });

  it('sets elementClip from clipMeta when provided', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));

    const clipMeta = {
      selector: 'button.primary',
      box: { x: 10, y: 20, width: 80, height: 40 },
    };

    const result = await captureScreenshotWithBudget(fakeWebContents, { clipMeta });
    expect(result).not.toBeNull();
    expect(result!.elementClip).toEqual(clipMeta);
  });

  it('sets elementClip to null when clipMeta is not provided', async () => {
    vi.mocked(mockCaptureScreenshot).mockResolvedValue(base64OfSize(100));

    const result = await captureScreenshotWithBudget(fakeWebContents, {});
    expect(result).not.toBeNull();
    expect(result!.elementClip).toBeNull();
  });
});

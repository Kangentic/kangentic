/**
 * Unit tests for `compressClipboardImage` skip rules and failure path.
 *
 * Covers four gaps identified in the audit:
 *   1. Failure path - createImageBitmap rejects -> toast + original file returned.
 *   2. GIF passthrough - SKIP_RECOMPRESS_MEDIA_TYPES short-circuits before bitmap decode.
 *   3. PNG-already-fits skip - resolveResizeTarget returns null && mediaType ===
 *      'image/png' -> early return.
 *   4. Long-edge cap - the size the pipeline actually draws at, read back off the
 *      canvas the encoder was handed.
 *
 * The <500KB skip (MIN_COMPRESS_BYTES) is already covered transitively by the UI
 * tier "small PNG paste is left untouched" test in image-compression.spec.ts.
 *
 * Strategy: mock createImageBitmap, OffscreenCanvas, and the toast+config stores.
 * jsdom lacks both OffscreenCanvas.convertToBlob and createImageBitmap, so we
 * install globals before the module loads via vi.hoisted + beforeEach assignments.
 * The cap tests DO run the encoding pipeline, so the stub records every canvas it
 * constructs; only the drawn dimensions are asserted, never blob contents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted store mocks - must be declared before any import that transitively
// loads a Zustand store, so vi.hoisted runs at module-evaluation time.
// ---------------------------------------------------------------------------

const storeMocks = vi.hoisted(() => ({
  useToastStore: { getState: vi.fn() },
  useConfigStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: storeMocks.useToastStore,
}));

vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: storeMocks.useConfigStore,
}));

// ---------------------------------------------------------------------------
// Browser global stubs - createImageBitmap and OffscreenCanvas must exist
// before the module under test is imported. We assign them in beforeEach so
// individual tests can override createImageBitmap to reject.
// ---------------------------------------------------------------------------

/** Minimal ImageBitmap stub. close() is a no-op. */
function makeImageBitmap(width: number, height: number): ImageBitmap {
  return {
    width,
    height,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

/**
 * Every canvas the pipeline constructs, in order, so a test can assert the size
 * the image was actually drawn at.
 */
const constructedCanvases: StubOffscreenCanvas[] = [];

/** The subset of CanvasRenderingContext2D the stub retains and a test can read back. */
interface StubCanvasContext {
  drawImage: ReturnType<typeof vi.fn>;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
}

/** Minimal OffscreenCanvas stub. */
class StubOffscreenCanvas {
  /**
   * Retained (not recreated per getContext() call) so a test can read back
   * what renderToCanvas assigned onto it. Seeded with the browser's actual
   * destructive defaults - smoothing off, 'low' quality - so an assertion
   * that these were overridden is meaningful rather than vacuously true.
   */
  readonly context: StubCanvasContext = {
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
  };

  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {
    constructedCanvases.push(this);
  }

  getContext(): CanvasRenderingContext2D {
    return this.context as unknown as CanvasRenderingContext2D;
  }

  convertToBlob(): Promise<Blob> {
    return Promise.resolve(new Blob([], { type: 'image/webp' }));
  }
}

/** Pristine encoder, restored after every test so a per-test override cannot leak. */
const originalConvertToBlob = StubOffscreenCanvas.prototype.convertToBlob;

/** Size of the canvas the pipeline encoded from. */
function renderedSize(): { width: number; height: number } {
  const target = constructedCanvases[constructedCanvases.length - 1];
  return { width: target.width, height: target.height };
}

/** The stub 2d context of the last canvas the pipeline constructed. */
function renderedContext(): StubCanvasContext {
  const target = constructedCanvases[constructedCanvases.length - 1];
  return target.context;
}

// ---------------------------------------------------------------------------
// Imports after mocks are hoisted.
// ---------------------------------------------------------------------------

import { compressClipboardImage, MIN_COMPRESS_BYTES } from '../../src/renderer/components/dialogs/image-compress';
import { IMAGE_LONG_EDGE_CAP } from '../../src/shared/image-fidelity';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOAST_CONFIG = {
  config: {
    notifications: {
      toasts: {
        durationSeconds: 4,
        maxCount: 5,
      },
    },
  },
};

/** Build a File large enough to pass the MIN_COMPRESS_BYTES guard. */
function makeLargeFile(mediaType: string, name: string): File {
  // One byte over the threshold so MIN_COMPRESS_BYTES is not the skip trigger.
  const bytes = new Uint8Array(MIN_COMPRESS_BYTES + 1);
  return new File([bytes], name, { type: mediaType });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compressClipboardImage', () => {
  let addToastMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset the toast spy between tests.
    addToastMock = vi.fn();
    constructedCanvases.length = 0;
    storeMocks.useToastStore.getState.mockReturnValue({ addToast: addToastMock });
    storeMocks.useConfigStore.getState.mockReturnValue(TOAST_CONFIG);

    // Install browser globals. Individual tests may override createImageBitmap.
    globalThis.createImageBitmap = vi
      .fn()
      .mockResolvedValue(makeImageBitmap(1000, 800));

    // Cast via `unknown` to satisfy TypeScript without the full constructor signature.
    globalThis.OffscreenCanvas = StubOffscreenCanvas as unknown as typeof OffscreenCanvas;
  });

  afterEach(() => {
    // One test swaps convertToBlob on the shared prototype to force a specific
    // blob size. Without this restore that override leaks into every test
    // declared after it, which is how a later assertion silently starts reading
    // the wrong encoder output.
    StubOffscreenCanvas.prototype.convertToBlob = originalConvertToBlob;
  });

  describe('GIF passthrough (SKIP_RECOMPRESS_MEDIA_TYPES)', () => {
    it('returns the original GIF file without compression', async () => {
      const gifFile = makeLargeFile('image/gif', 'animation.gif');

      const result = await compressClipboardImage(gifFile);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(gifFile);
      // createImageBitmap must NOT have been called - skip happens before bitmap decode.
      expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    });

    it('returns the original SVG file without compression', async () => {
      const svgFile = makeLargeFile('image/svg+xml', 'diagram.svg');

      const result = await compressClipboardImage(svgFile);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(svgFile);
      expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    });
  });

  describe('PNG-already-fits skip (resolveResizeTarget returns null && mediaType === image/png)', () => {
    it('returns the original PNG when the long edge is inside IMAGE_LONG_EDGE_CAP', async () => {
      // Bitmap dimensions 1000x800 -> long edge 1000 <= 2000 -> resolveResizeTarget
      // returns null. mediaType === 'image/png' -> early return without encoding.
      const pngFile = makeLargeFile('image/png', 'screenshot.png');

      const result = await compressClipboardImage(pngFile);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(pngFile);
      expect(addToastMock).not.toHaveBeenCalled();
    });

    it('does NOT skip a JPEG that fits the long-edge target', async () => {
      // JPEG with 1000x800 still gets encoded (no PNG exception for JPEG).
      // We make convertToBlob return a tiny blob so the function succeeds.
      const jpegFile = makeLargeFile('image/jpeg', 'photo.jpg');

      // Override convertToBlob to return a blob small enough to satisfy TARGET_BYTES.
      const tinyBlob = new Blob([new Uint8Array(1000)], { type: 'image/webp' });
      StubOffscreenCanvas.prototype.convertToBlob = vi
        .fn()
        .mockResolvedValue(tinyBlob);

      const result = await compressClipboardImage(jpegFile);

      // The JPEG should have gone through the encoding pipeline.
      expect(result.compressed).toBe(true);
      expect(result.file.type).toBe('image/webp');
    });
  });

  describe('long-edge cap', () => {
    /** Point createImageBitmap at a source of the given size. */
    function sourceSize(width: number, height: number): void {
      globalThis.createImageBitmap = vi.fn().mockResolvedValue(makeImageBitmap(width, height));
    }

    it('caps an oversized image at IMAGE_LONG_EDGE_CAP', async () => {
      sourceSize(4000, 2000);

      const result = await compressClipboardImage(makeLargeFile('image/jpeg', 'wide.jpg'));

      expect(result.compressed).toBe(true);
      expect(renderedSize()).toEqual({ width: IMAGE_LONG_EDGE_CAP, height: 1000 });
    });

    it('sets high-quality image smoothing before drawing the resized image onto the canvas', async () => {
      // Oversized so the resize path (renderToCanvas) actually runs - a
      // PNG that already fits the cap returns before ever reaching a canvas.
      sourceSize(4000, 2000);

      await compressClipboardImage(makeLargeFile('image/jpeg', 'wide.jpg'));

      const context = renderedContext();
      // The browser default ('low' quality, smoothing untouched) is visibly
      // destructive on a downscale of small UI text, which is the case this
      // whole pipeline exists to preserve. The stub is seeded with that
      // default, so this assertion is meaningful rather than vacuous.
      expect(context.imageSmoothingEnabled).toBe(true);
      expect(context.imageSmoothingQuality).toBe('high');
      // Proves the retained context is the SAME object renderToCanvas drew
      // onto, not an unrelated sibling.
      expect(context.drawImage).toHaveBeenCalled();
    });

    it('caps by the long edge on a portrait image', async () => {
      sourceSize(1500, 4000);

      await compressClipboardImage(makeLargeFile('image/jpeg', 'tall.jpg'));

      expect(renderedSize()).toEqual({ width: 750, height: IMAGE_LONG_EDGE_CAP });
    });

    it('leaves a PNG that is already inside the cap exactly as pasted', async () => {
      // At the old 1568 cap this image was re-encoded to lossy WebP. It is now
      // passed through untouched: no lossy round trip, alpha intact. That is the
      // fidelity regression the cap change fixes, expressed as behaviour.
      sourceSize(1800, 900);
      const png = makeLargeFile('image/png', 'screenshot.png');

      const result = await compressClipboardImage(png);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(png);
    });
  });

  describe('failure path (createImageBitmap rejects)', () => {
    it('returns the original file and emits the warning toast', async () => {
      const decodeError = new Error('GPU process crashed');
      (globalThis.createImageBitmap as ReturnType<typeof vi.fn>).mockRejectedValue(
        decodeError,
      );

      const pngFile = makeLargeFile('image/png', 'corrupt.png');
      // createImageBitmap rejects before any dimension is read, so the decode
      // failure is reached ahead of the PNG-already-fits skip and the bitmap
      // size never matters here.

      const result = await compressClipboardImage(pngFile);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(pngFile);

      // Toast must have been called exactly once with the canonical message.
      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock).toHaveBeenCalledWith({
        message: 'Could not compress image - using original.',
        variant: 'warning',
      });
    });

    it('does not re-throw the error', async () => {
      (globalThis.createImageBitmap as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Out of memory'),
      );

      const file = makeLargeFile('image/png', 'big.png');
      // Confirm the function resolves rather than rejects.
      await expect(compressClipboardImage(file)).resolves.toBeDefined();
    });
  });
});

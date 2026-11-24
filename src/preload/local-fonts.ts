/**
 * The Terminal Font Family picker's list, read through Chromium's Local Font
 * Access API (`window.queryLocalFonts()`), so listing fonts starts no process.
 *
 * The list used to come from the `font-list` package in main, which runs an OS
 * command per platform. On Windows that was `exec` of cmd, then PowerShell, and
 * the CreateProcess runs on the calling thread: opened right after launch, it
 * held main for 3,850 ms. Chromium enumerates on its own thread pool, and the
 * answer never crosses main at all.
 *
 * The API reports every face and says nothing about pitch, so a family counts
 * as monospace when a narrow string, a wide one and a run of spaces measure the
 * same width in it. A family the page cannot draw Latin text in falls back to a
 * proportional face and so reads as not monospace. Measured in the built app on
 * Windows with 190 families installed, the first ask took about 0.6 s in the
 * window, in slices, with main never involved.
 *
 * Web APIs only: this module runs in the sandboxed preload
 * (tests/unit/preload-web-apis-only.test.ts).
 */

/** The part of a `FontData` entry read here. One entry per face, so a family repeats. */
export interface LocalFontFace {
  readonly family: string;
}

export interface LocalFontDependencies {
  /** `window.queryLocalFonts()`. Rejects when the permission is denied or the API is missing. */
  queryLocalFonts: () => Promise<readonly LocalFontFace[]>;
  /** Width in pixels of `text` drawn in `fontFamilyList`, a CSS `font-family` value. */
  measureTextWidth: (text: string, fontFamilyList: string) => number;
  /** Hands the thread back between slices of measuring. */
  yieldToEventLoop: () => Promise<void>;
  /** A monotonic clock in milliseconds. */
  now: () => number;
}

/**
 * Ten of the narrowest Latin glyph, ten of the widest, and ten spaces: all
 * three measure the same only in a fixed-pitch text face. The spaces are what
 * keep a symbol font out. Measured in the built app on Windows, Webdings draws
 * every letter 32px wide and its space 16px, where Consolas, MS Gothic and
 * OCR A give all three samples one width.
 */
const NARROW_SAMPLE = 'iiiiiiiiii';
const WIDE_SAMPLE = 'MMMMMMMMMM';
const SPACE_SAMPLE = '          ';

/** Two samples in one fixed-pitch face differ by rounding at most. A proportional face differs by tens of pixels. */
const SAME_WIDTH_TOLERANCE_PX = 0.5;

/** The generic families tried as the proportional fallback, in order. */
const PROPORTIONAL_FALLBACKS: readonly string[] = ['serif', 'sans-serif'];

/**
 * How long one slice of measuring may hold the window's thread before it
 * yields. The first measure in a family makes Chromium load that face, a
 * millisecond or so each, and a machine holds a few hundred families.
 */
const MEASURE_SLICE_BUDGET_MS = 6;

function quoteFontFamily(family: string): string {
  return `"${family.replace(/["\\]/g, '\\$&')}"`;
}

function measuresFixedWidth(dependencies: LocalFontDependencies, fontFamilyList: string): boolean {
  const narrowWidth = dependencies.measureTextWidth(NARROW_SAMPLE, fontFamilyList);
  if (narrowWidth <= 0) return false;
  const wideWidth = dependencies.measureTextWidth(WIDE_SAMPLE, fontFamilyList);
  if (Math.abs(narrowWidth - wideWidth) >= SAME_WIDTH_TOLERANCE_PX) return false;
  const spaceWidth = dependencies.measureTextWidth(SPACE_SAMPLE, fontFamilyList);
  return Math.abs(narrowWidth - spaceWidth) < SAME_WIDTH_TOLERANCE_PX;
}

function dedupedSorted(families: readonly string[]): string[] {
  return Array.from(new Set(families.filter((family) => family.trim().length > 0))).sort((first, second) =>
    first.localeCompare(second),
  );
}

/**
 * The installed monospace families, deduped and sorted. Every installed family
 * when none measures fixed width, or when the page has no proportional fallback
 * to tell them apart with, so the picker is never left empty by the check.
 * Rejects when the fonts cannot be listed.
 */
export async function listMonospaceFontFamilies(dependencies: LocalFontDependencies): Promise<string[]> {
  const faces = await dependencies.queryLocalFonts();
  const families = dedupedSorted(faces.map((face) => face.family));
  const proportionalFallback = PROPORTIONAL_FALLBACKS.find((fallback) => !measuresFixedWidth(dependencies, fallback));
  if (proportionalFallback === undefined) return families;

  const monospaceFamilies: string[] = [];
  let sliceStartedAt = dependencies.now();
  for (const family of families) {
    if (dependencies.now() - sliceStartedAt >= MEASURE_SLICE_BUDGET_MS) {
      await dependencies.yieldToEventLoop();
      sliceStartedAt = dependencies.now();
    }
    if (measuresFixedWidth(dependencies, `${quoteFontFamily(family)}, ${proportionalFallback}`)) {
      monospaceFamilies.push(family);
    }
  }
  return monospaceFamilies.length > 0 ? monospaceFamilies : families;
}

/** Pixel size the samples are measured at. Large enough that a proportional face's two widths are far apart. */
const MEASURE_FONT_SIZE_PX = 32;

function browserDependencies(): LocalFontDependencies {
  let context: CanvasRenderingContext2D | null = null;
  return {
    queryLocalFonts: () => {
      const query = (window as unknown as { queryLocalFonts?: () => Promise<readonly LocalFontFace[]> }).queryLocalFonts;
      if (typeof query !== 'function') return Promise.reject(new Error('This window cannot list local fonts'));
      return query.call(window);
    },
    measureTextWidth: (text, fontFamilyList) => {
      context ??= document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('This window has no 2D canvas to measure text with');
      context.font = `${MEASURE_FONT_SIZE_PX}px ${fontFamilyList}`;
      return context.measureText(text).width;
    },
    yieldToEventLoop: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
    now: () => performance.now(),
  };
}

/**
 * The picker's list for this window: asked once and kept, since installed
 * fonts do not change while a window is open. A failed or empty answer is not
 * kept, so the next ask tries again, and resolves `[]`, which the picker shows
 * as a plain text field.
 */
export function createLocalFontList(dependencies: LocalFontDependencies = browserDependencies()): () => Promise<string[]> {
  let kept: Promise<string[]> | null = null;
  return () => {
    kept ??= listMonospaceFontFamilies(dependencies).then(
      (families) => {
        if (families.length === 0) kept = null;
        return families;
      },
      () => {
        kept = null;
        return [];
      },
    );
    return kept;
  };
}

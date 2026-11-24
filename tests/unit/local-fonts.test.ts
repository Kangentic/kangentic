/**
 * The Terminal Font Family picker's list (src/preload/local-fonts.ts).
 *
 * The list is Chromium's own font enumeration filtered to fixed-pitch
 * families by measured width, read in the window so it starts no process. A
 * user loses the picker's suggestions if the filter lets nothing through, and
 * gets a list of unusable faces if it lets symbol or proportional fonts in.
 * The query and the text measure are injected: the E2E spec
 * (tests/e2e/local-font-list.spec.ts) is what proves the real ones answer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createLocalFontList,
  listMonospaceFontFamilies,
  type LocalFontDependencies,
  type LocalFontFace,
} from '../../src/preload/local-fonts';

/** Per-character advance of a family: letters and the space. */
interface FaceMetrics {
  narrow: number;
  wide: number;
  space: number;
}

const FIXED: FaceMetrics = { narrow: 10, wide: 10, space: 10 };
const PROPORTIONAL: FaceMetrics = { narrow: 4, wide: 16, space: 5 };
/** Webdings, as measured in the built app: every letter one width, the space half of it. */
const SYMBOL: FaceMetrics = { narrow: 32, wide: 32, space: 16 };

interface Harness {
  dependencies: LocalFontDependencies;
  queryLocalFonts: ReturnType<typeof vi.fn>;
  yieldToEventLoop: ReturnType<typeof vi.fn>;
  measuredFamilyLists: string[];
}

function createHarness(options: {
  faces?: LocalFontFace[];
  metrics?: Record<string, FaceMetrics>;
  /** Milliseconds the clock advances on every read. */
  clockStepMs?: number;
}): Harness {
  const metrics: Record<string, FaceMetrics> = { serif: PROPORTIONAL, 'sans-serif': PROPORTIONAL, ...options.metrics };
  const measuredFamilyLists: string[] = [];
  let clock = 0;
  const queryLocalFonts = vi.fn(async () => options.faces ?? []);
  const yieldToEventLoop = vi.fn(async () => undefined);
  const dependencies: LocalFontDependencies = {
    queryLocalFonts,
    measureTextWidth: (text, fontFamilyList) => {
      measuredFamilyLists.push(fontFamilyList);
      // The first family in the list the page can draw, as a browser picks one:
      // a quoted family followed by a generic one, or a generic one alone.
      const quoted = /^"((?:[^"\\]|\\.)*)",\s*(.+)$/.exec(fontFamilyList);
      const families = quoted ? [quoted[1].replace(/\\(.)/g, '$1'), quoted[2]] : [fontFamilyList];
      const drawn = families.find((family) => metrics[family] !== undefined) ?? 'serif';
      const face = metrics[drawn];
      const advance = text.startsWith('i') ? face.narrow : text.startsWith('M') ? face.wide : face.space;
      return advance * text.length;
    },
    yieldToEventLoop,
    now: () => {
      clock += options.clockStepMs ?? 0;
      return clock;
    },
  };
  return { dependencies, queryLocalFonts, yieldToEventLoop, measuredFamilyLists };
}

function facesOf(...families: string[]): LocalFontFace[] {
  return families.map((family) => ({ family }));
}

describe('listMonospaceFontFamilies', () => {
  it('keeps the families that measure one width, deduped across faces and sorted', async () => {
    const harness = createHarness({
      faces: facesOf('Menlo', 'Arial', 'Consolas', 'Consolas', 'Menlo'),
      metrics: { Menlo: FIXED, Consolas: FIXED, Arial: PROPORTIONAL },
    });

    expect(await listMonospaceFontFamilies(harness.dependencies)).toEqual(['Consolas', 'Menlo']);
  });

  it('leaves out a symbol font whose letters share a width its space does not', async () => {
    const harness = createHarness({
      faces: facesOf('Webdings', 'Consolas'),
      metrics: { Webdings: SYMBOL, Consolas: FIXED },
    });

    expect(await listMonospaceFontFamilies(harness.dependencies)).toEqual(['Consolas']);
  });

  it('leaves out a family the page cannot draw, which measures as the proportional fallback', async () => {
    const harness = createHarness({
      faces: facesOf('No Latin Glyphs', 'Consolas'),
      metrics: { Consolas: FIXED },
    });

    expect(await listMonospaceFontFamilies(harness.dependencies)).toEqual(['Consolas']);
  });

  it('returns every family when none measures fixed width', async () => {
    const harness = createHarness({
      faces: facesOf('Georgia', 'Arial'),
      metrics: { Georgia: PROPORTIONAL, Arial: PROPORTIONAL },
    });

    expect(await listMonospaceFontFamilies(harness.dependencies)).toEqual(['Arial', 'Georgia']);
  });

  it('returns every family when the page has no proportional fallback to tell them apart with', async () => {
    const harness = createHarness({
      faces: facesOf('Arial', 'Consolas'),
      metrics: { serif: FIXED, 'sans-serif': FIXED, Arial: PROPORTIONAL, Consolas: FIXED },
    });

    expect(await listMonospaceFontFamilies(harness.dependencies)).toEqual(['Arial', 'Consolas']);
  });

  it('falls back to sans-serif when serif itself is fixed width', async () => {
    const harness = createHarness({
      faces: facesOf('No Latin Glyphs', 'Consolas'),
      metrics: { serif: FIXED, Consolas: FIXED },
    });

    expect(await listMonospaceFontFamilies(harness.dependencies)).toEqual(['Consolas']);
    expect(harness.measuredFamilyLists).toContain('"Consolas", sans-serif');
  });

  it('quotes a family name, so one holding a quote or a comma stays one family', async () => {
    const harness = createHarness({
      faces: facesOf('Odd "Mono", Regular'),
      metrics: { 'Odd "Mono", Regular': FIXED },
    });

    expect(await listMonospaceFontFamilies(harness.dependencies)).toEqual(['Odd "Mono", Regular']);
    expect(harness.measuredFamilyLists).toContain('"Odd \\"Mono\\", Regular", serif');
  });

  it('drops blank family names', async () => {
    const harness = createHarness({
      faces: facesOf('', '   ', 'Consolas'),
      metrics: { Consolas: FIXED },
    });

    expect(await listMonospaceFontFamilies(harness.dependencies)).toEqual(['Consolas']);
  });

  it('hands the thread back once a slice of measuring has run its budget', async () => {
    const families = Array.from({ length: 40 }, (_, index) => `Family ${String(index).padStart(2, '0')}`);
    const harness = createHarness({
      faces: facesOf(...families),
      metrics: Object.fromEntries(families.map((family) => [family, FIXED])),
      clockStepMs: 4,
    });

    const listed = await listMonospaceFontFamilies(harness.dependencies);

    expect(listed).toEqual(families);
    // The clock moves 4 ms a read, so every second family passes the 6 ms budget.
    expect(harness.yieldToEventLoop.mock.calls.length).toBeGreaterThan(10);
  });

  it('never yields when the measuring fits one slice', async () => {
    const harness = createHarness({
      faces: facesOf('Consolas', 'Menlo'),
      metrics: { Consolas: FIXED, Menlo: FIXED },
    });

    await listMonospaceFontFamilies(harness.dependencies);

    expect(harness.yieldToEventLoop).not.toHaveBeenCalled();
  });
});

describe('createLocalFontList', () => {
  it('asks once and keeps the answer for the window', async () => {
    const harness = createHarness({ faces: facesOf('Consolas'), metrics: { Consolas: FIXED } });
    const listLocalFonts = createLocalFontList(harness.dependencies);

    expect(await listLocalFonts()).toEqual(['Consolas']);
    expect(await listLocalFonts()).toEqual(['Consolas']);

    expect(harness.queryLocalFonts).toHaveBeenCalledTimes(1);
  });

  it('shares one ask between callers that arrive together', async () => {
    const harness = createHarness({ faces: facesOf('Consolas'), metrics: { Consolas: FIXED } });
    const listLocalFonts = createLocalFontList(harness.dependencies);

    await Promise.all([listLocalFonts(), listLocalFonts()]);

    expect(harness.queryLocalFonts).toHaveBeenCalledTimes(1);
  });

  it('answers an empty list when the fonts cannot be listed, and asks again next time', async () => {
    const harness = createHarness({ faces: facesOf('Consolas'), metrics: { Consolas: FIXED } });
    harness.queryLocalFonts.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const listLocalFonts = createLocalFontList(harness.dependencies);

    expect(await listLocalFonts()).toEqual([]);
    expect(await listLocalFonts()).toEqual(['Consolas']);

    expect(harness.queryLocalFonts).toHaveBeenCalledTimes(2);
  });

  it('does not keep an empty answer', async () => {
    const harness = createHarness({ faces: [] });
    const listLocalFonts = createLocalFontList(harness.dependencies);

    expect(await listLocalFonts()).toEqual([]);
    expect(await listLocalFonts()).toEqual([]);

    expect(harness.queryLocalFonts).toHaveBeenCalledTimes(2);
  });
});

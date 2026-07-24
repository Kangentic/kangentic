/**
 * Unit tests for FontResolver (src/main/font-resolver.ts).
 *
 * getAvailableFonts() shells out to the font-list package's getFonts2(), which
 * can fail on a stripped-down machine (e.g. Linux without fontconfig). These
 * tests verify the monospace-preferred filtering, the empty-list fallback so
 * the renderer never blocks on a font picker with no options, and the cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('font-list', () => ({
  getFonts2: vi.fn(),
}));

import { getFonts2 } from 'font-list';
import { FontResolver, resetFontResolverCacheForTests } from '../../src/main/font-resolver';

const getFonts2Mock = getFonts2 as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetFontResolverCacheForTests();
  getFonts2Mock.mockReset();
});

describe('FontResolver', () => {
  it('returns only monospace-flagged families, deduped and sorted', async () => {
    getFonts2Mock.mockResolvedValue([
      { familyName: 'Consolas', monospace: true },
      { familyName: 'Arial', monospace: false },
      { familyName: 'Consolas', monospace: true },
      { familyName: 'Menlo', monospace: true },
    ]);

    const fonts = await new FontResolver().getAvailableFonts();

    expect(fonts).toEqual(['Consolas', 'Menlo']);
  });

  it('falls back to every installed family when none are flagged monospace', async () => {
    getFonts2Mock.mockResolvedValue([
      { familyName: 'Arial', monospace: false },
      { familyName: 'Georgia', monospace: false },
    ]);

    const fonts = await new FontResolver().getAvailableFonts();

    expect(fonts).toEqual(['Arial', 'Georgia']);
  });

  it('returns an empty array when enumeration fails, so the picker degrades to free text', async () => {
    getFonts2Mock.mockRejectedValue(new Error('fc-list not found'));

    const fonts = await new FontResolver().getAvailableFonts();

    expect(fonts).toEqual([]);
  });

  it('caches the result across calls and instances', async () => {
    getFonts2Mock.mockResolvedValue([{ familyName: 'Menlo', monospace: true }]);

    await new FontResolver().getAvailableFonts();
    await new FontResolver().getAvailableFonts();

    expect(getFonts2Mock).toHaveBeenCalledTimes(1);
  });

  it('re-probes after resetFontResolverCacheForTests', async () => {
    getFonts2Mock.mockResolvedValue([{ familyName: 'Menlo', monospace: true }]);
    const resolver = new FontResolver();

    await resolver.getAvailableFonts();
    resetFontResolverCacheForTests();
    await resolver.getAvailableFonts();

    expect(getFonts2Mock).toHaveBeenCalledTimes(2);
  });
});

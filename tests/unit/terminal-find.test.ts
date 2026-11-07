import { describe, expect, it } from 'vitest';
import { blendToOpaqueHex, summarizeFindResults } from '../../src/renderer/utils/terminal-find';

describe('summarizeFindResults', () => {
  it('counts from the newest match, so the first hit reads 1 and older ones count up', () => {
    expect(summarizeFindResults({ resultIndex: 13, resultCount: 14 }, 1000)).toEqual({ kind: 'position', position: 1, total: 14 });
    expect(summarizeFindResults({ resultIndex: 0, resultCount: 14 }, 1000)).toEqual({ kind: 'position', position: 14, total: 14 });
  });

  it('reads no matches as none', () => {
    expect(summarizeFindResults({ resultIndex: -1, resultCount: 0 }, 1000)).toEqual({ kind: 'none' });
  });

  it('says past the limit at the limit, because the addon stops collecting there', () => {
    expect(summarizeFindResults({ resultIndex: 999, resultCount: 1000 }, 1000)).toEqual({ kind: 'past-limit', limit: 1000 });
    expect(summarizeFindResults({ resultIndex: -1, resultCount: 1000 }, 1000)).toEqual({ kind: 'past-limit', limit: 1000 });
    expect(summarizeFindResults({ resultIndex: 0, resultCount: 999 }, 1000).kind).toBe('position');
  });

  it('shows the total alone when no match is active', () => {
    expect(summarizeFindResults({ resultIndex: -1, resultCount: 3 }, 1000)).toEqual({ kind: 'total', total: 3 });
  });
});

describe('blendToOpaqueHex', () => {
  it('mixes a token over the background into an opaque color', () => {
    expect(blendToOpaqueHex('#d9b83f', '#0c0c0c', 0.35)).toBe('#54481e');
    expect(blendToOpaqueHex('#ffffff', '#000000', 0.5)).toBe('#808080');
  });

  it('keeps each end of the range', () => {
    expect(blendToOpaqueHex('#d9b83f', '#0c0c0c', 1)).toBe('#d9b83f');
    expect(blendToOpaqueHex('#d9b83f', '#0c0c0c', 0)).toBe('#0c0c0c');
  });

  it('refuses anything that is not #RRGGBB, since xterm would reject it', () => {
    expect(blendToOpaqueHex('rgba(1, 2, 3, 0.5)', '#0c0c0c', 0.5)).toBeNull();
    expect(blendToOpaqueHex('#d9b83f', 'black', 0.5)).toBeNull();
  });
});

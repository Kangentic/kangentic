/**
 * The seed's frame applier counts cells with a range table the build derives from the app's own
 * Unicode 11 width table (buildCellWidthTable in tests/captures/helpers/demo-scrollback.ts), so a
 * clipped row ends where the terminal will end it (.claude/rules/xterm-unicode11-parity.md). This
 * pins the table against `wcwidthV11` itself, across a sweep of the whole code space and the
 * glyphs the recordings carry, and pins the shape the applier binary-searches.
 */
import { describe, expect, it } from 'vitest';
import { buildCellWidthTable } from '../captures/helpers/demo-scrollback';
import { wcwidthV11 } from '../../src/shared/xterm-unicode11';

function inRanges(ranges: number[], codepoint: number): boolean {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (codepoint < ranges[middle * 2]) high = middle - 1;
    else if (codepoint > ranges[middle * 2 + 1]) low = middle + 1;
    else return true;
  }
  return false;
}

describe('buildCellWidthTable', () => {
  const table = buildCellWidthTable();
  const widthOf = (codepoint: number): number => (inRanges(table.zero, codepoint) ? 0 : inRanges(table.wide, codepoint) ? 2 : 1);

  it('is a sorted list of disjoint [lo, hi] pairs', () => {
    for (const ranges of [table.wide, table.zero]) {
      expect(ranges.length % 2).toBe(0);
      expect(ranges.length).toBeGreaterThan(0);
      for (let index = 0; index < ranges.length; index += 2) {
        expect(ranges[index]).toBeLessThanOrEqual(ranges[index + 1]);
        if (index > 0) expect(ranges[index]).toBeGreaterThan(ranges[index - 1]);
      }
    }
  });

  it('agrees with wcwidthV11 on a sweep of the code space', () => {
    for (let codepoint = 0; codepoint <= 0x10ffff; codepoint += 97) {
      expect(widthOf(codepoint), `U+${codepoint.toString(16)}`).toBe(wcwidthV11(codepoint));
    }
  });

  it('agrees with wcwidthV11 on the glyphs the recordings draw with', () => {
    const glyphs = ['a', ' ', '─', '┃', '▄', '●', '❯', '⎿', '✅', '❌', '中', '\u{1f600}', '́', '​'];
    for (const glyph of glyphs) {
      const codepoint = glyph.codePointAt(0) as number;
      expect(widthOf(codepoint), glyph).toBe(wcwidthV11(codepoint));
    }
  });
});

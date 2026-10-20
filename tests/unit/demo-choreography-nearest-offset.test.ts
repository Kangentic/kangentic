/**
 * The choreography's `scroll` step moves a horizontal scroller the least distance that shows its
 * target, as CSSOM `scrollIntoView` with `inline: 'nearest'` does (demo/choreography.ts,
 * `nearestOffset`). The demo tier only reaches the "fits" branches, and only implicitly, so this
 * pins every branch with concrete numbers. The box in each case is [100, 300], 200 wide. A
 * negative result scrolls toward the start, a positive one toward the end.
 */
import { describe, expect, it } from 'vitest';
import { nearestOffset } from '../../demo/choreography';

const BOX_START = 100;
const BOX_END = 300;

interface OffsetCase {
  name: string;
  start: number;
  end: number;
  expected: number;
}

const CASES: OffsetCase[] = [
  // Nothing to scroll.
  { name: 'a span inside the box needs no scroll', start: 150, end: 250, expected: 0 },
  { name: 'a span exactly filling the box needs no scroll', start: 100, end: 300, expected: 0 },
  { name: 'a span covering the box on both sides needs no scroll', start: 50, end: 400, expected: 0 },
  // The span fits the box: bring in the edge that is out.
  { name: 'a span that fits and sits before the box aligns its start edge', start: 40, end: 140, expected: -60 },
  { name: 'a span that fits and sits past the box aligns its end edge', start: 260, end: 360, expected: 60 },
  { name: 'a span that fits and sits wholly before the box aligns its start edge', start: -50, end: 0, expected: -150 },
  { name: 'a span that fits and sits wholly past the box aligns its end edge', start: 400, end: 450, expected: 150 },
  // A span as wide as the box counts as fitting.
  { name: 'a span as wide as the box and out at the start aligns its start edge', start: 50, end: 250, expected: -50 },
  { name: 'a span as wide as the box and out at the end aligns its end edge', start: 150, end: 350, expected: 50 },
  // The span is wider than the box: bring in the edge that is not out, so the box stays covered.
  { name: 'a span wider than the box and out at the start only aligns its end edge', start: 40, end: 280, expected: -20 },
  { name: 'a span wider than the box and out at the end only aligns its start edge', start: 120, end: 340, expected: 20 },
  { name: 'a wider span ending on the box end edge needs no scroll', start: 50, end: 300, expected: 0 },
  { name: 'a wider span starting on the box start edge needs no scroll', start: 100, end: 350, expected: 0 },
];

describe('nearestOffset', () => {
  it.each(CASES)('$name', ({ start, end, expected }) => {
    expect(nearestOffset(start, end, BOX_START, BOX_END)).toBe(expected);
  });

  it('measures against the box edges, not the origin', () => {
    // The same span and box shifted by -1000 gives the same offset: only the gap to the edge counts.
    expect(nearestOffset(-960, -860, -900, -700)).toBe(-60);
    expect(nearestOffset(-740, -640, -900, -700)).toBe(60);
  });
});

import { describe, it, expect } from 'vitest';
import { computeSettleScrollTop, estimatedOffsetForIndex, ESTIMATED_ROW_HEIGHT, type SettleVirtualItem } from '../../src/renderer/components/conversation/settle-scroll';
import type { DisplayRow } from '../../src/renderer/components/conversation/display-rows';

/**
 * Pure scrollTop math behind ConversationView's open-at-position settle
 * loop. The load-bearing behavior under test: `computeSettleScrollTop`
 * PREFERS a real, measured `virtualItem` (the virtualizer's own rendered
 * item for the target index) over the static per-row `estimatedHeight`
 * heuristic, no matter how far the two diverge - this is the exact
 * regression fix for the open-at-position centering bug (see
 * settle-scroll.ts's doc comment: without this, a settle loop that only
 * ever trusted the static estimate would recompute the identical wrong
 * value every tick and falsely report "stable").
 */

function fakeRow(uuid: string, estimatedHeight: number): DisplayRow {
  return {
    uuid,
    entry: { kind: 'user', uuid, ts: 0, text: '' },
    results: new Map(),
    estimatedHeight,
    searchText: '',
    searchSegments: [],
    signature: uuid,
  };
}

describe('estimatedOffsetForIndex', () => {
  it('sums the estimated heights of every row BEFORE the given index (exclusive)', () => {
    const rows = [fakeRow('r0', 100), fakeRow('r1', 200), fakeRow('r2', 300)];
    expect(estimatedOffsetForIndex(rows, 2)).toBe(300); // 100 + 200
  });

  it('returns 0 for index 0 (nothing before the first row)', () => {
    const rows = [fakeRow('r0', 100)];
    expect(estimatedOffsetForIndex(rows, 0)).toBe(0);
  });

  it('sums all rows when index is past the end of the array', () => {
    const rows = [fakeRow('r0', 100), fakeRow('r1', 200)];
    expect(estimatedOffsetForIndex(rows, 10)).toBe(300);
  });

  it('falls back to ESTIMATED_ROW_HEIGHT for a row missing its own estimate', () => {
    const rows = [{ ...fakeRow('r0', 100), estimatedHeight: undefined as unknown as number }];
    expect(estimatedOffsetForIndex(rows, 1)).toBe(ESTIMATED_ROW_HEIGHT);
  });
});

describe('computeSettleScrollTop', () => {
  it('falls back to the static per-row estimate sum when no virtualItem is rendered yet', () => {
    const rows = [fakeRow('r0', 100), fakeRow('r1', 200), fakeRow('r2', 300), fakeRow('r3', 400)];
    const result = computeSettleScrollTop({
      align: 'start',
      index: 3,
      rows,
      virtualItem: undefined,
      clientHeight: 600,
    });
    // estimatedOffsetForIndex(rows, 3) = 100 + 200 + 300 = 600.
    expect(result).toBe(600);
  });

  it('PREFERS the real, measured virtualItem over the static estimate, even when they wildly diverge (the regression fix)', () => {
    // Mirrors display-rows.ts's MAX_HEIGHT clamp: every row's STATIC estimate
    // is small, but the virtualizer's OWN measurement of the target row
    // reports a real position thousands of px further down (simulating an
    // earlier row - e.g. a huge markdown block - whose real rendered height
    // was clamped to a much smaller static estimate).
    const rows = [fakeRow('r0', 100), fakeRow('r1', 100), fakeRow('r2', 100), fakeRow('r3', 100)];
    const staticEstimate = estimatedOffsetForIndex(rows, 3); // 300 - what a static-only loop would compute
    const virtualItem: SettleVirtualItem = { index: 3, start: 9000, size: 120 };

    const result = computeSettleScrollTop({
      align: 'start',
      index: 3,
      rows,
      virtualItem,
      clientHeight: 600,
    });

    expect(result).toBe(9000); // virtualItem.start, not the static estimate
    expect(result).not.toBe(staticEstimate);
  });

  it('align: "center" subtracts half the (clientHeight - rowHeight) gap from the row offset', () => {
    const rows = [fakeRow('r0', 100), fakeRow('r1', 100)];
    const virtualItem: SettleVirtualItem = { index: 1, start: 1000, size: 80 };
    const result = computeSettleScrollTop({
      align: 'center',
      index: 1,
      rows,
      virtualItem,
      clientHeight: 600,
    });
    // 1000 - max(0, (600 - 80) / 2) = 1000 - 260 = 740.
    expect(result).toBe(740);
  });

  it('align: "center" never subtracts a NEGATIVE gap when the row is taller than the viewport', () => {
    const rows = [fakeRow('r0', 100)];
    const virtualItem: SettleVirtualItem = { index: 0, start: 500, size: 900 };
    const result = computeSettleScrollTop({
      align: 'center',
      index: 0,
      rows,
      virtualItem,
      clientHeight: 300, // rowHeight (900) > clientHeight (300)
    });
    // max(0, (300 - 900) / 2) clamps to 0, so the result is just the raw offset.
    expect(result).toBe(500);
  });

  it('clamps the final result to a minimum of 0', () => {
    const rows = [fakeRow('r0', 100)];
    const virtualItem: SettleVirtualItem = { index: 0, start: 10, size: 50 };
    const result = computeSettleScrollTop({
      align: 'center',
      index: 0,
      rows,
      virtualItem,
      clientHeight: 600, // a large centering subtraction would otherwise go negative
    });
    expect(result).toBe(0);
  });

  it('rounds the result to the nearest integer pixel', () => {
    const rows = [fakeRow('r0', 100)];
    const virtualItem: SettleVirtualItem = { index: 0, start: 100, size: 51 };
    const result = computeSettleScrollTop({
      align: 'center',
      index: 0,
      rows,
      virtualItem,
      clientHeight: 200,
    });
    // 100 - (200 - 51) / 2 = 100 - 74.5 = 25.5 -> rounds to 26.
    expect(result).toBe(26);
    expect(Number.isInteger(result)).toBe(true);
  });
});

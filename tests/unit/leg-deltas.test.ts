import { describe, it, expect } from 'vitest';
import { legDeltas, type LegReading } from '../../src/shared/leg-deltas';

function leg(recordId: string, lineageId: string | null, startedAt: string, cost: number | null, durationMs: number | null = null): LegReading {
  return { recordId, lineageId, startedAt, cumulativeCostUsd: cost, cumulativeDurationMs: durationMs };
}

describe('legDeltas', () => {
  it('splits a resumed conversation into per-leg shares that add up to its final reading', () => {
    const shares = legDeltas([
      leg('leg-1', 'main', '2026-10-12T09:00:00.000Z', 1.85, 722_000),
      leg('leg-2', 'main', '2026-10-12T10:00:00.000Z', 26.04, 4_622_000),
      leg('leg-3', 'main', '2026-10-12T12:00:00.000Z', 30.84, 5_629_000),
    ]);

    expect(shares.get('leg-1')?.costUsd).toBeCloseTo(1.85, 10);
    expect(shares.get('leg-2')?.costUsd).toBeCloseTo(24.19, 10);
    expect(shares.get('leg-3')?.costUsd).toBeCloseTo(4.80, 10);
    expect(shares.get('leg-3')?.durationMs).toBe(1_007_000);
    const total = [...shares.values()].reduce((sum, value) => sum + (value.costUsd ?? 0), 0);
    expect(total).toBeCloseTo(30.84, 10);
  });

  it('keeps separate conversations apart', () => {
    const shares = legDeltas([
      leg('main-1', 'main', '2026-10-12T09:00:00.000Z', 5),
      leg('review', 'review', '2026-10-12T09:30:00.000Z', 3),
      leg('main-2', 'main', '2026-10-12T10:00:00.000Z', 8),
    ]);

    expect(shares.get('review')?.costUsd).toBe(3);
    expect(shares.get('main-2')?.costUsd).toBe(3);
  });

  it('orders legs by start time, not by array order', () => {
    const shares = legDeltas([
      leg('later', 'main', '2026-10-12T10:00:00.000Z', 10),
      leg('earlier', 'main', '2026-10-12T09:00:00.000Z', 4),
    ]);

    expect(shares.get('earlier')?.costUsd).toBe(4);
    expect(shares.get('later')?.costUsd).toBe(6);
  });

  it('breaks a start-time tie by record id, so two legs never share a baseline', () => {
    const shares = legDeltas([
      leg('record-b', 'main', '2026-10-12T09:00:00.000Z', 7),
      leg('record-a', 'main', '2026-10-12T09:00:00.000Z', 5),
    ]);

    expect(shares.get('record-a')?.costUsd).toBe(5);
    expect(shares.get('record-b')?.costUsd).toBe(2);
  });

  it('treats a record with no lineage as its own conversation', () => {
    const shares = legDeltas([
      leg('solo-1', null, '2026-10-12T09:00:00.000Z', 2),
      leg('solo-2', null, '2026-10-12T10:00:00.000Z', 3),
    ]);

    expect(shares.get('solo-1')?.costUsd).toBe(2);
    expect(shares.get('solo-2')?.costUsd).toBe(3);
  });

  it('clamps a reading that dropped (a reset counter) to zero instead of a negative', () => {
    const shares = legDeltas([
      leg('before-reset', 'main', '2026-10-12T09:00:00.000Z', 12),
      leg('after-reset', 'main', '2026-10-12T10:00:00.000Z', 3),
    ]);

    expect(shares.get('after-reset')?.costUsd).toBe(0);
  });

  it('skips a leg with no usage, so it never becomes the next leg\'s baseline', () => {
    // #732: a session that reported nothing sat between two legs. A plain
    // previous-row subtraction booked the next leg's whole cumulative as its cost.
    const shares = legDeltas([
      leg('leg-3', 'main', '2026-09-29T13:53:34.767Z', 403.43, 420_465_487),
      leg('empty', 'main', '2026-10-02T21:05:30.916Z', null, null),
      leg('leg-5', 'main', '2026-10-02T21:05:46.804Z', 418.31, 437_298_543),
    ]);

    expect(shares.get('empty')).toEqual({ costUsd: null, durationMs: null });
    expect(shares.get('leg-5')?.costUsd).toBeCloseTo(14.88, 10);
    expect(shares.get('leg-5')?.durationMs).toBe(16_833_056);
  });

  it('gives a record with a runtime but no cost no share, and no baseline, as the summary skips it', () => {
    const shares = legDeltas([
      leg('leg-1', 'main', '2026-10-12T09:00:00.000Z', 2, 600_000),
      leg('no-cost', 'main', '2026-10-12T10:00:00.000Z', null, 900_000),
      leg('leg-2', 'main', '2026-10-12T11:00:00.000Z', 5, 1_000_000),
    ]);

    expect(shares.get('no-cost')).toEqual({ costUsd: null, durationMs: null });
    expect(shares.get('leg-2')?.durationMs).toBe(400_000);
  });
});

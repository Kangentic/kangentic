import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../src/main/diagnostics/event-loop-lag', () => ({
  timeSyncWork: <T>(_label: string, work: () => T): T => work(),
}));

import { SLICE_BUDGET_MS, writeInTimedSlices } from '../../src/main/retrieval/timed-slices';
import { passThroughTransaction } from './helpers/transaction-double';

/** A database whose transactions record which items each one wrote. */
function fakeDb(): { db: Database.Database; transactions: number[][]; current: number[] } {
  const state = { transactions: [] as number[][], current: [] as number[] };
  const db = {
    transaction: (work: (from: number) => number) => passThroughTransaction((from: number) => {
      state.current = [];
      state.transactions.push(state.current);
      return work(from);
    }),
  } as unknown as Database.Database;
  return { db, get transactions() { return state.transactions; }, get current() { return state.current; } };
}

describe('writeInTimedSlices', () => {
  it('writes everything in one transaction while the budget holds', async () => {
    const fake = fakeDb();
    const yields = vi.fn(async () => undefined);

    const finished = await writeInTimedSlices(fake.db, [1, 2, 3, 4], (item) => fake.current.push(item), 'test', () => true, {
      clock: () => 0,
      yieldToEventLoop: yields,
    });

    expect(finished).toBe(true);
    expect(fake.transactions).toEqual([[1, 2, 3, 4]]);
    expect(yields).toHaveBeenCalledTimes(1);
  });

  it('commits and yields once a slice has used its budget, whatever the item count', async () => {
    const fake = fakeDb();
    let nowMs = 0;
    const yields = vi.fn(async () => undefined);
    // Each item costs just over a third of the budget, so a slice holds three.
    const itemCostMs = Math.ceil(SLICE_BUDGET_MS / 3);

    const finished = await writeInTimedSlices(
      fake.db,
      [1, 2, 3, 4, 5, 6, 7],
      (item) => {
        nowMs += itemCostMs;
        fake.current.push(item);
      },
      'test',
      () => true,
      { clock: () => nowMs, yieldToEventLoop: yields },
    );

    expect(finished).toBe(true);
    expect(fake.transactions).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(yields).toHaveBeenCalledTimes(3);
  });

  it('still writes an item larger than the whole budget, alone in its slice', async () => {
    const fake = fakeDb();
    let nowMs = 0;

    await writeInTimedSlices(
      fake.db,
      ['large', 'small'],
      (item) => {
        nowMs += item === 'large' ? SLICE_BUDGET_MS * 4 : 1;
        fake.current.push(item === 'large' ? 1 : 2);
      },
      'test',
      () => true,
      { clock: () => nowMs, yieldToEventLoop: async () => undefined },
    );

    expect(fake.transactions).toEqual([[1], [2]]);
  });

  it('stops between slices when asked, leaving the rest unwritten', async () => {
    const fake = fakeDb();
    let nowMs = 0;
    let slicesAllowed = 1;

    const finished = await writeInTimedSlices(
      fake.db,
      [1, 2, 3],
      (item) => {
        nowMs += SLICE_BUDGET_MS;
        fake.current.push(item);
      },
      'test',
      () => slicesAllowed-- > 0,
      { clock: () => nowMs, yieldToEventLoop: async () => undefined },
    );

    expect(finished).toBe(false);
    expect(fake.transactions).toEqual([[1]]);
  });

  it('ends the run when a slice fails to commit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Restored whatever the assertions do, so a failure here cannot leave
    // console.warn silenced for the tests after it.
    try {
      const db = {
        transaction: () => passThroughTransaction(() => {
          throw new Error('disk I/O error');
        }),
      } as unknown as Database.Database;
      const writeOne = vi.fn();

      const finished = await writeInTimedSlices(db, [1, 2], writeOne, 'test', () => true, {
        clock: () => 0,
        yieldToEventLoop: async () => undefined,
      });

      expect(finished).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

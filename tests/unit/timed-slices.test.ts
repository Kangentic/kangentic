import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../src/main/diagnostics/event-loop-lag', () => ({
  timeSyncWork: <T>(_label: string, work: () => T): T => work(),
  isTimingSyncWork: () => false,
  recordSyncSpan: () => undefined,
}));

import {
  PREPARE_BUDGET_MS,
  SLICE_BYTES,
  SLICE_ROWS,
  writeInSlices,
  type PreparedWrite,
} from '../../src/main/retrieval/timed-slices';
import { passThroughTransaction } from './helpers/transaction-double';

/** A database that records which items each transaction wrote, and which were
 *  written with no transaction around them. */
function fakeDb() {
  const state = {
    inTransaction: false,
    transactions: [] as string[][],
    alone: [] as string[],
    preparedInTransaction: 0,
  };
  const db = {
    transaction: (body: () => unknown) => passThroughTransaction(() => {
      state.inTransaction = true;
      state.transactions.push([]);
      try {
        return body();
      } finally {
        state.inTransaction = false;
      }
    }),
  } as unknown as Database.Database;
  const record = (item: string): void => {
    if (state.inTransaction) state.transactions[state.transactions.length - 1].push(item);
    else state.alone.push(item);
  };
  /** A prepare that writes `item` with the given size, and notes whether it ran
   *  inside a transaction. */
  const prepareSized = (size: (item: string) => { rows: number; bytes: number }) => (item: string): PreparedWrite => {
    if (state.inTransaction) state.preparedInTransaction += 1;
    return { ...size(item), write: () => record(item) };
  };
  return { db, state, prepareSized };
}

const neverSpent = { clock: () => 0, yieldToEventLoop: async () => undefined };

describe('writeInSlices', () => {
  it('writes small items in one transaction, prepared outside it', async () => {
    const fake = fakeDb();
    const yields = vi.fn(async () => undefined);

    const finished = await writeInSlices(
      fake.db,
      ['a', 'b', 'c', 'd'],
      fake.prepareSized(() => ({ rows: 2, bytes: 100 })),
      'test',
      () => true,
      { clock: () => 0, yieldToEventLoop: yields },
    );

    expect(finished).toBe(true);
    expect(fake.state.transactions).toEqual([['a', 'b', 'c', 'd']]);
    expect(fake.state.preparedInTransaction).toBe(0);
    expect(yields).toHaveBeenCalledTimes(1);
  });

  it('starts a new transaction before the rows would pass the cap', async () => {
    const fake = fakeDb();
    // Three items fit under the row cap; a fourth would pass it.
    const rows = Math.floor(SLICE_ROWS / 3);

    await writeInSlices(
      fake.db,
      ['1', '2', '3', '4', '5', '6', '7'],
      fake.prepareSized(() => ({ rows, bytes: 0 })),
      'test',
      () => true,
      neverSpent,
    );

    expect(fake.state.transactions).toEqual([['1', '2', '3'], ['4', '5', '6'], ['7']]);
    expect(fake.state.alone).toEqual([]);
  });

  it('starts a new transaction before the text would pass the cap', async () => {
    const fake = fakeDb();

    await writeInSlices(
      fake.db,
      ['1', '2', '3', '4', '5'],
      fake.prepareSized(() => ({ rows: 1, bytes: SLICE_BYTES / 2 })),
      'test',
      () => true,
      neverSpent,
    );

    expect(fake.state.transactions).toEqual([['1', '2'], ['3', '4'], ['5']]);
  });

  it('writes an item over a cap alone, with no transaction around it', async () => {
    const fake = fakeDb();

    await writeInSlices(
      fake.db,
      ['small', 'large', 'last'],
      fake.prepareSized((item) => ({ rows: item === 'large' ? SLICE_ROWS * 10 : 2, bytes: 0 })),
      'test',
      () => true,
      neverSpent,
    );

    // The store splits an oversized write into bounded transactions itself;
    // wrapped in one here, those would nest into a single long one.
    expect(fake.state.alone).toEqual(['large']);
    expect(fake.state.transactions).toEqual([['small'], ['last']]);
  });

  it('writes and yields once a slice has spent its preparing budget', async () => {
    const fake = fakeDb();
    let nowMs = 0;
    const yields = vi.fn(async () => undefined);
    const prepareSmall = fake.prepareSized(() => ({ rows: 1, bytes: 0 }));

    await writeInSlices(
      fake.db,
      ['1', '2', '3', '4', '5', '6', '7'],
      (item) => {
        // Each item takes just over a third of the budget to prepare.
        nowMs += Math.ceil(PREPARE_BUDGET_MS / 3);
        return prepareSmall(item);
      },
      'test',
      () => true,
      { clock: () => nowMs, yieldToEventLoop: yields },
    );

    expect(fake.state.transactions).toEqual([['1', '2', '3'], ['4', '5', '6'], ['7']]);
    expect(yields).toHaveBeenCalledTimes(3);
  });

  it('skips an item whose prepare throws or returns nothing, and writes the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fake = fakeDb();
      const prepareSmall = fake.prepareSized(() => ({ rows: 1, bytes: 0 }));

      const finished = await writeInSlices(
        fake.db,
        ['1', 'bad', 'skip', '4'],
        (item) => {
          if (item === 'bad') throw new Error('unreadable');
          if (item === 'skip') return null;
          return prepareSmall(item);
        },
        'test',
        () => true,
        neverSpent,
      );

      expect(finished).toBe(true);
      expect(fake.state.transactions).toEqual([['1', '4']]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops between slices when asked, leaving the rest unwritten', async () => {
    const fake = fakeDb();
    let slicesAllowed = 1;

    const finished = await writeInSlices(
      fake.db,
      ['1', '2', '3'],
      fake.prepareSized(() => ({ rows: SLICE_ROWS, bytes: 0 })),
      'test',
      () => slicesAllowed-- > 0,
      neverSpent,
    );

    expect(finished).toBe(false);
    expect(fake.state.transactions).toEqual([['1']]);
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
      const write = vi.fn();

      const finished = await writeInSlices(db, [1, 2], () => ({ rows: SLICE_ROWS, bytes: 0, write }), 'test', () => true, neverSpent);

      expect(finished).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

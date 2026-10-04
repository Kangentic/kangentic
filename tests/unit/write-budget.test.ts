/**
 * The retrieval worker's background writes share one turn of each project
 * database's write lock (`src/main/retrieval/write-budget.ts`). On the upgrade
 * dry run, jobs paced one by one still made main's board writes wait three and
 * four timer ticks where several wrote at once, so the budget is per
 * connection, and it tightens while another connection writes.
 *
 * `data_version` is faked: it moves when "main" commits. The clock and the
 * sleeps are a small scheduler, so concurrent loops share one timeline.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import {
  awaitWriteTurn,
  BUSY_COMMIT_GAP_MS,
  BUSY_LOCK_DUTY,
  IDLE_LOCK_DUTY,
  recordWriteHold,
  type WriteBudgetClock,
} from '../../src/main/retrieval/write-budget';
import { QUIET_MS } from '../../src/main/retrieval/index-builds';
import { setWriteHoldObserver, writeTransaction } from '../../src/main/db/transaction';
import { openTestDatabase } from './helpers/test-database';

/** A stand-in connection whose `data_version` is whatever `version()` says. */
function fakeDb(version: () => number): DatabaseType.Database {
  return { prepare: () => ({ get: () => ({ data_version: version() }) }) } as unknown as DatabaseType.Database;
}

/** Timers on one virtual timeline, run in order. */
function scheduler() {
  let now = 0;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  const clock: WriteBudgetClock = {
    now: () => now,
    sleep: (ms) => new Promise<void>((resolve) => { timers.push({ at: now + ms, resolve }); }),
    yieldTurn: () => Promise.resolve(),
  };
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  return {
    clock,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    /** Fire timers in time order until `done` or none are left. */
    async run(done: () => boolean): Promise<void> {
      for (let step = 0; step < 100_000; step += 1) {
        await settle();
        if (done() || timers.length === 0) return;
        timers.sort((first, second) => first.at - second.at);
        const next = timers.shift()!;
        now = Math.max(now, next.at);
        next.resolve();
      }
    },
  };
}

afterEach(() => setWriteHoldObserver(null));

describe('the worker write budget', () => {
  it('owes four times a hold as rest while no other connection writes', async () => {
    const timeline = scheduler();
    const db = fakeDb(() => 1);
    recordWriteHold(db, 4, timeline.clock);
    let woke = false;
    void awaitWriteTurn(db, timeline.clock).then(() => { woke = true; });
    await timeline.run(() => woke);
    expect(timeline.now()).toBeCloseTo(4 * (1 / IDLE_LOCK_DUTY - 1));
  });

  it('owes nineteen times a hold, and at least the commit gap, while another connection writes', async () => {
    const timeline = scheduler();
    let version = 1;
    const db = fakeDb(() => version);
    recordWriteHold(db, 4, timeline.clock);
    // Main commits; the next hold sees it.
    version = 2;
    timeline.advance(16);
    recordWriteHold(db, 4, timeline.clock);
    let woke = false;
    void awaitWriteTurn(db, timeline.clock).then(() => { woke = true; });
    await timeline.run(() => woke);
    expect(timeline.now()).toBeCloseTo(16 + 4 * (1 / BUSY_LOCK_DUTY - 1));

    // A tiny hold still waits the gap.
    version = 3;
    const before = timeline.now();
    recordWriteHold(db, 0.5, timeline.clock);
    woke = false;
    void awaitWriteTurn(db, timeline.clock).then(() => { woke = true; });
    await timeline.run(() => woke);
    expect(timeline.now() - before).toBeCloseTo(BUSY_COMMIT_GAP_MS);
  });

  it('goes back to the idle share once no other connection has committed for the quiet window', async () => {
    const timeline = scheduler();
    let version = 1;
    const db = fakeDb(() => version);
    recordWriteHold(db, 4, timeline.clock);
    version = 2;
    recordWriteHold(db, 4, timeline.clock);
    timeline.advance(QUIET_MS + 500);
    const before = timeline.now();
    recordWriteHold(db, 4, timeline.clock);
    let woke = false;
    void awaitWriteTurn(db, timeline.clock).then(() => { woke = true; });
    await timeline.run(() => woke);
    expect(timeline.now() - before).toBeCloseTo(4 * (1 / IDLE_LOCK_DUTY - 1));
  });

  it('takes one turn of the loop when no rest is owed', async () => {
    const timeline = scheduler();
    const db = fakeDb(() => 1);
    await awaitWriteTurn(db, timeline.clock);
    expect(timeline.now()).toBe(0);
  });

  it('keeps two jobs writing at once to one busy share between them', async () => {
    const timeline = scheduler();
    // Main commits every 250 ms throughout, and has already been seen to.
    const db = fakeDb(() => Math.floor(timeline.now() / 250));
    recordWriteHold(db, 0, timeline.clock);
    timeline.advance(250);
    const startedAt = timeline.now();
    const HOLD_MS = 2;
    const COMMITS_EACH = 60;
    let held = 0;
    let finished = 0;
    const job = async (): Promise<void> => {
      for (let commit = 0; commit < COMMITS_EACH; commit += 1) {
        await awaitWriteTurn(db, timeline.clock);
        timeline.advance(HOLD_MS);
        held += HOLD_MS;
        recordWriteHold(db, HOLD_MS, timeline.clock);
      }
      finished += 1;
    };
    void job();
    void job();
    await timeline.run(() => finished === 2);
    expect(finished).toBe(2);
    const elapsedMs = timeline.now() - startedAt;
    expect(held / elapsedMs).toBeLessThanOrEqual(BUSY_LOCK_DUTY);
    expect((2 * COMMITS_EACH) / (elapsedMs / 1000)).toBeLessThanOrEqual(1000 / BUSY_COMMIT_GAP_MS + 1);
  });
});

describe('the worker write budget, taking turns', () => {
  it('hands turns out in order, so one write is never starved by a loop that keeps writing', async () => {
    // The dry run's failure: the transcript conversion re-armed its timer
    // first every time, and the embedding writeback timed out waiting.
    const timeline = scheduler();
    const db = fakeDb(() => Math.floor(timeline.now() / 250));
    recordWriteHold(db, 0, timeline.clock);
    timeline.advance(250);
    let stop = false;
    let loopCommits = 0;
    void (async () => {
      while (!stop && loopCommits < 1_000) {
        await awaitWriteTurn(db, timeline.clock);
        timeline.advance(1);
        recordWriteHold(db, 1, timeline.clock);
        loopCommits += 1;
      }
    })();
    await timeline.run(() => loopCommits >= 10);

    const askedAt = timeline.now();
    let grantedAt: number | null = null;
    void awaitWriteTurn(db, timeline.clock).then(() => {
      grantedAt = timeline.now();
      recordWriteHold(db, 1, timeline.clock);
    });
    await timeline.run(() => grantedAt !== null);
    stop = true;
    expect(grantedAt).not.toBeNull();
    // Behind at most the loop's own pending turn.
    expect(grantedAt! - askedAt).toBeLessThanOrEqual(2 * BUSY_COMMIT_GAP_MS + 2);
  });
});

describe('the transaction hold observer', () => {
  it('hears each outermost write transaction once, after it commits, and never a savepoint', () => {
    const db = openTestDatabase();
    try {
      db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY)');
      const heard: Array<{ held: number; inTransaction: boolean }> = [];
      setWriteHoldObserver((connection, heldMs) => heard.push({ held: heldMs, inTransaction: connection.inTransaction }));
      const insert = writeTransaction(db, () => { db.prepare('INSERT INTO rows DEFAULT VALUES').run(); });
      const outer = writeTransaction(db, () => {
        insert();
        insert();
      });
      outer();
      insert();
      expect(heard).toHaveLength(2);
      for (const entry of heard) {
        expect(entry.held).toBeGreaterThanOrEqual(0);
        expect(entry.inTransaction).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});

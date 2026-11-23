/**
 * The retrieval worker checkpoints its own connection after a write, at most
 * once a second per connection (`worker/checkpoint-pacing.ts`). No connection
 * auto-checkpoints while the worker is up, so without this a long job's pages
 * waited for main's 5 s request, which waits behind the job itself.
 */

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createCheckpointPacer, WRITE_CHECKPOINT_INTERVAL_MS } from '../../src/main/retrieval/worker/checkpoint-pacing';
import { CHECKPOINT_AFTER_WRITE_LABEL } from '../../src/main/retrieval/worker/checkpoint-labels';
import { setSyncSpanLabelSink } from '../../src/main/diagnostics/event-loop-lag';

function fakeConnection(): Database.Database {
  return {} as Database.Database;
}

describe('worker checkpoint pacing', () => {
  it('checkpoints on the first commit, then at most once per interval', () => {
    let now = 1_000;
    const checkpointed: Database.Database[] = [];
    const pace = createCheckpointPacer({ now: () => now, checkpoint: (db) => { checkpointed.push(db); } });
    const db = fakeConnection();

    pace(db);
    expect(checkpointed).toHaveLength(1);

    now += WRITE_CHECKPOINT_INTERVAL_MS - 1;
    pace(db);
    expect(checkpointed).toHaveLength(1);

    now += 1;
    pace(db);
    expect(checkpointed).toHaveLength(2);
  });

  it('paces each connection on its own clock', () => {
    let now = 0;
    const checkpointed: Database.Database[] = [];
    const pace = createCheckpointPacer({ now: () => now, checkpoint: (db) => { checkpointed.push(db); } });
    const first = fakeConnection();
    const second = fakeConnection();

    pace(first);
    now += 10;
    pace(second);
    pace(first);
    expect(checkpointed).toEqual([first, second]);
  });

  // With no checkpoint thread the default checkpoint runs on the loop, under the pacer's own
  // label, so a watchdog line tells it from main's 5 s request (Sentry DESKTOP-4P).
  it('runs the default checkpoint on the loop under its own label when there is no thread', () => {
    const labels: string[] = [];
    setSyncSpanLabelSink((label) => { if (label) labels.push(label); });
    try {
      const pragma = vi.fn(() => [{ busy: 0, log: 2, checkpointed: 2 }]);
      const db = { name: 'unused.db', pragma } as unknown as Database.Database;
      createCheckpointPacer()(db);
      expect(pragma).toHaveBeenCalledWith('wal_checkpoint(PASSIVE)');
      expect(labels).toContain(CHECKPOINT_AFTER_WRITE_LABEL);
    } finally {
      setSyncSpanLabelSink(null);
    }
  });

  it('a failed checkpoint still starts the interval, so a failing one is not retried on every commit', () => {
    let now = 0;
    let attempts = 0;
    const pace = createCheckpointPacer({ now: () => now, checkpoint: () => { attempts += 1; throw new Error('SQLITE_BUSY'); } });
    const db = fakeConnection();

    expect(() => pace(db)).toThrow('SQLITE_BUSY');
    now += 10;
    pace(db);
    expect(attempts).toBe(1);
  });
});

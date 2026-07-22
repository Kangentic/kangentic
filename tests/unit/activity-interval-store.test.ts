import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { ActivityIntervalStore, type OpenIntervalInput } from '../../src/main/activity-engine/activity-interval-store';

/**
 * `session_activity_intervals` modeled by a hand-rolled fake `Database`,
 * mirroring `conversation-usage-store.test.ts` (better-sqlite3's native
 * module in this worktree is rebuilt for Electron's ABI and cannot load
 * under the plain-Node test runner - see
 * session-repository-summaries.test.ts's probe comment). The fake
 * INSERT/UPDATE/SELECT dispatch on SQL substrings, matching the store's
 * real statements exactly.
 */

interface FakeRow {
  id: number;
  session_id: string;
  task_id: string | null;
  disposition: string;
  state: string;
  previous_state: string;
  enter_trigger: string;
  started_ms: number;
  started_at: string;
  ended_ms: number | null;
  ended_at: string | null;
  duration_ms: number | null;
  exit_trigger: string | null;
  recorded_at: string;
}

function makeIntervalDb(): { db: Database.Database; table: Map<number, FakeRow> } {
  const table = new Map<number, FakeRow>();
  let nextId = 1;
  const prepare = (sql: string) => ({
    run: (...args: unknown[]) => {
      if (sql.includes('INSERT INTO session_activity_intervals')) {
        const [sessionId, taskId, disposition, state, previousState, enterTrigger, startedMs, startedAt, recordedAt] = args;
        const id = nextId++;
        table.set(id, {
          id,
          session_id: String(sessionId),
          task_id: (taskId as string | null) ?? null,
          disposition: String(disposition),
          state: String(state),
          previous_state: String(previousState),
          enter_trigger: String(enterTrigger),
          started_ms: Number(startedMs),
          started_at: String(startedAt),
          ended_ms: null,
          ended_at: null,
          duration_ms: null,
          exit_trigger: null,
          recorded_at: String(recordedAt),
        });
        return { changes: 1, lastInsertRowid: id };
      }
      if (sql.includes('UPDATE session_activity_intervals')) {
        const [endedMs, endedAt, endedMsAgain, exitTrigger, sessionId] = args;
        let changes = 0;
        for (const row of table.values()) {
          if (row.session_id !== sessionId || row.ended_ms !== null) continue;
          row.ended_ms = Number(endedMs);
          row.ended_at = String(endedAt);
          row.duration_ms = Number(endedMsAgain) - row.started_ms;
          row.exit_trigger = String(exitTrigger);
          changes++;
        }
        return { changes, lastInsertRowid: 0 };
      }
      throw new Error(`unexpected run SQL: ${sql}`);
    },
    all: (...args: unknown[]) => {
      const rows = [...table.values()];
      if (sql.includes('WHERE task_id = ?')) {
        return rows.filter((row) => row.task_id === args[0]).sort((a, b) => a.started_ms - b.started_ms);
      }
      if (sql.includes('WHERE session_id = ?')) {
        return rows.filter((row) => row.session_id === args[0]).sort((a, b) => a.started_ms - b.started_ms);
      }
      throw new Error(`unexpected all SQL: ${sql}`);
    },
  });
  const db = { prepare } as unknown as Database.Database;
  return { db, table };
}

function idleInput(overrides: Partial<OpenIntervalInput> = {}): OpenIntervalInput {
  return {
    sessionId: 'session-1',
    taskId: 'task-1',
    disposition: 'idle',
    state: 'idle',
    previousState: 'thinking',
    enterTrigger: 'event:idle',
    startedMs: 1000,
    ...overrides,
  };
}

function activeInput(overrides: Partial<OpenIntervalInput> = {}): OpenIntervalInput {
  return {
    sessionId: 'session-1',
    taskId: 'task-1',
    disposition: 'active',
    state: 'thinking',
    previousState: 'idle',
    enterTrigger: 'event:prompt',
    startedMs: 1000,
    ...overrides,
  };
}

describe('ActivityIntervalStore', () => {
  it('openInterval inserts a row with no end, then closeOpenInterval fills in ended/duration/exit', () => {
    const { db } = makeIntervalDb();
    const store = new ActivityIntervalStore(db);

    store.openInterval(idleInput(), '2026-07-01T00:00:00Z');
    let rows = store.getForSession('session-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].disposition).toBe('idle');
    expect(rows[0].endedMs).toBeNull();
    expect(rows[0].endedAt).toBeNull();
    expect(rows[0].durationMs).toBeNull();
    expect(rows[0].exitTrigger).toBeNull();
    expect(rows[0].enterTrigger).toBe('event:idle');
    expect(rows[0].previousState).toBe('thinking');
    expect(rows[0].startedMs).toBe(1000);
    // startedAt is derived from startedMs inside the store, not passed in -
    // OpenIntervalInput carries no ISO field of its own.
    expect(rows[0].startedAt).toBe(new Date(1000).toISOString());

    store.closeOpenInterval('session-1', 4500, 'event:prompt');
    rows = store.getForSession('session-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].endedMs).toBe(4500);
    expect(rows[0].endedAt).toBe(new Date(4500).toISOString());
    expect(rows[0].durationMs).toBe(3500);
    expect(rows[0].exitTrigger).toBe('event:prompt');
  });

  it('an alternating active/idle sequence for one session produces two independent, correctly-typed rows', () => {
    const { db } = makeIntervalDb();
    const store = new ActivityIntervalStore(db);

    // Session parks (thinking -> idle): open an 'idle' interval.
    store.openInterval(idleInput({ startedMs: 1000 }), '2026-07-01T00:00:00Z');
    // Session resumes (idle -> thinking): close the 'idle' interval, open an 'active' one.
    store.closeOpenInterval('session-1', 5000, 'event:prompt');
    store.openInterval(activeInput({ startedMs: 5000 }), '2026-07-01T00:00:00Z');

    const rows = store.getForSession('session-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ disposition: 'idle', startedMs: 1000, endedMs: 5000, durationMs: 4000, exitTrigger: 'event:prompt' });
    expect(rows[1]).toMatchObject({ disposition: 'active', startedMs: 5000, endedMs: null, durationMs: null });
  });

  it('closeOpenInterval is a no-op when no interval is open', () => {
    const { db } = makeIntervalDb();
    const store = new ActivityIntervalStore(db);

    // No prior openInterval call for this session.
    expect(() => store.closeOpenInterval('session-1', 4500, 'event:prompt')).not.toThrow();
    expect(store.getForSession('session-1')).toEqual([]);
  });

  it('closeOpenInterval only matches the session it is closing, leaving other open rows untouched', () => {
    const { db } = makeIntervalDb();
    const store = new ActivityIntervalStore(db);

    store.openInterval(idleInput({ sessionId: 'session-1' }), '2026-07-01T00:00:00Z');
    store.openInterval(idleInput({ sessionId: 'session-2' }), '2026-07-01T00:00:00Z');

    store.closeOpenInterval('session-1', 2000, 'event:prompt');

    expect(store.getForSession('session-1')[0].endedMs).toBe(2000);
    expect(store.getForSession('session-2')[0].endedMs).toBeNull();
  });

  it('getForTask returns every session\'s intervals for that task, oldest first, both dispositions', () => {
    const { db } = makeIntervalDb();
    const store = new ActivityIntervalStore(db);

    store.openInterval(idleInput({ sessionId: 'session-2', taskId: 'task-1', startedMs: 2000 }), '2026-07-01T00:00:00Z');
    store.openInterval(activeInput({ sessionId: 'session-1', taskId: 'task-1', startedMs: 1000 }), '2026-07-01T00:00:00Z');
    store.openInterval(idleInput({ sessionId: 'session-3', taskId: 'task-other', startedMs: 500 }), '2026-07-01T00:00:00Z');

    const rows = store.getForTask('task-1');
    expect(rows.map((row) => row.sessionId)).toEqual(['session-1', 'session-2']);
    expect(rows.map((row) => row.disposition)).toEqual(['active', 'idle']);
  });
});

/**
 * The activity intervals a quit or a crash left open, closed on the first open
 * of their project in a launch (task #952,
 * `ActivityIntervalStore.closeIntervalsLeftOpen`). Overnight, rows left open by
 * quits read as agents still waiting hours after their sessions had ended.
 * Real SQLite, migrated by runProjectMigrations: the join to the sessions table
 * is the behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { ActivityIntervalStore } from '../../src/main/activity-engine/activity-interval-store';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { insertTask, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

const STARTED_MS = Date.parse('2026-10-31T01:00:00.000Z');

describe('closing the activity intervals a quit left open (real DB)', () => {
  let db: Database.Database;
  let store: ActivityIntervalStore;

  function session(id: string, ends: { suspendedAt?: string; exitedAt?: string }): void {
    new SessionRepository(db).insert({
      id,
      task_id: 'task-a',
      session_type: 'claude_agent',
      isolated_swimlane_id: null,
      agent_session_id: `agent-${id}`,
      command: 'claude',
      cwd: '/mock/worktree',
      permission_mode: null,
      prompt: null,
      status: ends.suspendedAt ? 'suspended' : (ends.exitedAt ? 'exited' : 'running'),
      exit_code: null,
      started_at: '2026-10-31T00:59:00.000Z',
      suspended_at: ends.suspendedAt ?? null,
      exited_at: ends.exitedAt ?? null,
      suspended_by: null,
    });
  }

  function openInterval(sessionId: string, startedMs = STARTED_MS): void {
    store.openInterval({
      sessionId,
      taskId: 'task-a',
      disposition: 'idle',
      state: 'idle',
      previousState: 'thinking',
      enterTrigger: 'hook:Stop',
      startedMs,
    }, new Date(startedMs).toISOString());
  }

  function intervalOf(sessionId: string) {
    return store.getForSession(sessionId)[0];
  }

  beforeEach(() => {
    db = openMigratedProjectDatabase();
    insertTask(db, 'task-a');
    store = new ActivityIntervalStore(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('closes an interval at its session\'s suspend time, as a quit', () => {
    session('quit', { suspendedAt: '2026-10-31T03:00:00.000Z' });
    openInterval('quit');

    expect(store.closeIntervalsLeftOpen(new Set())).toBe(1);

    expect(intervalOf('quit')).toMatchObject({
      endedAt: '2026-10-31T03:00:00.000Z',
      durationMs: 2 * 60 * 60_000,
      exitTrigger: 'app-quit',
    });
  });

  it('closes at the exit time when the session exited instead', () => {
    session('exited', { exitedAt: '2026-10-31T02:00:00.000Z' });
    openInterval('exited');
    store.closeIntervalsLeftOpen(new Set());
    expect(intervalOf('exited')).toMatchObject({ durationMs: 60 * 60_000, exitTrigger: 'app-quit' });
  });

  it('closes at the interval\'s own start, inventing no time, when the session recorded no end', () => {
    session('crashed', {});
    openInterval('crashed');
    openInterval('no-session-row');

    expect(store.closeIntervalsLeftOpen(new Set())).toBe(2);

    expect(intervalOf('crashed')).toMatchObject({ durationMs: 0, exitTrigger: 'app-crash' });
    expect(intervalOf('no-session-row')).toMatchObject({ durationMs: 0, exitTrigger: 'app-crash' });
  });

  it('leaves a session this launch still runs alone, and never touches a closed interval', () => {
    session('live', {});
    openInterval('live');
    session('done', { suspendedAt: '2026-10-31T03:00:00.000Z' });
    openInterval('done');
    store.closeOpenInterval('done', STARTED_MS + 1_000, 'hook:Prompt');

    expect(store.closeIntervalsLeftOpen(new Set(['live']))).toBe(0);

    expect(intervalOf('live').endedMs).toBeNull();
    expect(intervalOf('done')).toMatchObject({ durationMs: 1_000, exitTrigger: 'hook:Prompt' });
  });

  it('never closes before the interval began, whatever the session row says', () => {
    session('clock-skew', { suspendedAt: '2026-10-31T00:30:00.000Z' });
    openInterval('clock-skew');
    store.closeIntervalsLeftOpen(new Set());
    expect(intervalOf('clock-skew')).toMatchObject({ durationMs: 0, exitTrigger: 'app-quit' });
  });
});

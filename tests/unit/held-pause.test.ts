/**
 * A held pause is a suspend that waits for the user to resume it: the user's
 * own Pause, or one Kangentic made while the agent waited on the user (low
 * memory, the idle timeout). A 'system' suspend (a quit, a move, a settings
 * restart) holds nothing. `isHeldPause` and the repository query that the
 * auto-spawn paths read must agree on that, so both are pinned here, the
 * query on real, migrated SQLite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { isHeldPause, HELD_PAUSE_SOURCES } from '../../src/shared/held-pause';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { openTestDatabase } from './helpers/test-database';
import { makeSessionRecord } from './helpers/session-record-fixture';
import type { SessionRecord, SuspendedBy } from '../../src/shared/types';

describe('isHeldPause', () => {
  it.each(['user', 'auto'] as const)('holds a %s pause', (suspendedBy) => {
    expect(isHeldPause(makeSessionRecord({ status: 'suspended', suspended_by: suspendedBy }))).toBe(true);
  });

  it('does not hold a system suspend', () => {
    expect(isHeldPause(makeSessionRecord({ status: 'suspended', suspended_by: 'system' }))).toBe(false);
  });

  it('does not hold a suspend with no source', () => {
    expect(isHeldPause(makeSessionRecord({ status: 'suspended', suspended_by: null }))).toBe(false);
  });

  it('does not hold a record that is no longer suspended', () => {
    // A resumed task retires its paused record; a stale marker on an exited
    // row must not keep the next move from starting the task.
    expect(isHeldPause(makeSessionRecord({ status: 'exited', suspended_by: 'auto' }))).toBe(false);
    expect(isHeldPause(makeSessionRecord({ status: 'running', suspended_by: 'user' }))).toBe(false);
  });

  it('holds nothing for a missing record', () => {
    expect(isHeldPause(undefined)).toBe(false);
    expect(isHeldPause(null)).toBe(false);
  });

  it('lists exactly the user, idle-timeout and low-memory sources', () => {
    expect([...HELD_PAUSE_SOURCES].sort()).toEqual(['auto', 'low_memory', 'user']);
  });
});

describe('SessionRepository.getHeldPausedTaskIds', () => {
  let database: Database.Database;
  let repository: SessionRepository;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    // The query reads the sessions table alone, so the rows need no task
    // behind them.
    database.pragma('foreign_keys = OFF');
    repository = new SessionRepository(database);
  });

  function insertRecord(overrides: Partial<SessionRecord>): void {
    const record = makeSessionRecord(overrides);
    repository.insert({
      id: record.id,
      task_id: record.task_id,
      session_type: record.session_type,
      isolated_swimlane_id: record.isolated_swimlane_id,
      agent_session_id: record.agent_session_id,
      command: record.command,
      cwd: record.cwd,
      permission_mode: record.permission_mode,
      prompt: record.prompt,
      status: record.status,
      exit_code: record.exit_code,
      started_at: record.started_at,
      suspended_at: record.suspended_at,
      exited_at: record.exited_at,
      suspended_by: record.suspended_by,
    });
  }

  function pausedRecord(taskId: string, suspendedBy: SuspendedBy, startedAt = '2026-10-21T10:00:00.000Z'): Partial<SessionRecord> {
    return {
      id: `rec-${taskId}-${startedAt}`,
      task_id: taskId,
      status: 'suspended',
      suspended_by: suspendedBy,
      suspended_at: startedAt,
      started_at: startedAt,
    };
  }

  it('returns tasks whose latest session is a user or auto pause, and not a system suspend', () => {
    insertRecord(pausedRecord('task-user', 'user'));
    insertRecord(pausedRecord('task-auto', 'auto'));
    insertRecord(pausedRecord('task-system', 'system'));

    expect([...repository.getHeldPausedTaskIds()].sort()).toEqual(['task-auto', 'task-user']);
  });

  it('reads only each task\'s latest session', () => {
    // An older auto pause followed by a newer running session: the task was
    // resumed, so nothing holds it any more.
    insertRecord(pausedRecord('task-resumed', 'auto', '2026-10-21T09:00:00.000Z'));
    insertRecord({ id: 'rec-live', task_id: 'task-resumed', status: 'running', started_at: '2026-10-21T10:00:00.000Z' });

    expect(repository.getHeldPausedTaskIds().has('task-resumed')).toBe(false);
  });
});

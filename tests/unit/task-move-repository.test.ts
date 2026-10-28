/**
 * `TaskMoveRepository.currentVisit` and `visitStartedAt`, the reads behind the
 * turn-end runner's visit gate (src/main/automations/turn-end/turn-end-runner.ts).
 *
 * The runner asks when the task entered the column and who moved it there: a
 * turn that began before that instant is skipped unless the move was an
 * `auto-move` (a plan approval, which lands mid-turn). A wrong pick between two
 * moves makes the runner exempt or skip the wrong turn, so the choice among
 * several rows is pinned here directly, with rows whose `at` values collide.
 *
 * Real better-sqlite3 on a real migrated schema, the way production reads it.
 * Rows go in with raw SQL so each test owns the exact `at`, `origin` and
 * insertion order it asserts on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import type { TaskMoveRecordOrigin } from '../../src/shared/types';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { openTestDatabase } from './helpers/test-database';

const FIRST_INSTANT = '2026-09-01T09:00:00.000Z';
const SECOND_INSTANT = '2026-09-01T09:05:00.000Z';
const THIRD_INSTANT = '2026-09-01T09:10:00.000Z';

describe('TaskMoveRepository.currentVisit and visitStartedAt', () => {
  let database: DatabaseType.Database;
  let moves: TaskMoveRepository;
  let columnId: string;
  let otherColumnId: string;
  const taskId = 'task-1';
  const otherTaskId = 'task-2';

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    const lanes = new SwimlaneRepository(database).list();
    columnId = lanes[0].id;
    otherColumnId = lanes[1].id;
    for (const id of [taskId, otherTaskId]) {
      database
        .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'A task', '', columnId, 0, FIRST_INSTANT, FIRST_INSTANT);
    }
    moves = new TaskMoveRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  /** Record a move straight into `task_moves`; insertion order is the rowid order. */
  function recordMove(
    moveId: string,
    toSwimlaneId: string,
    origin: TaskMoveRecordOrigin,
    at: string,
    forTaskId: string = taskId,
    fromSwimlaneId: string | null = null,
  ): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(moveId, forTaskId, fromSwimlaneId, toSwimlaneId, origin, null, at);
  }

  it('returns null from both reads when no move into the column was recorded', () => {
    expect(moves.currentVisit(taskId, columnId)).toBeNull();
    expect(moves.visitStartedAt(taskId, columnId)).toBeNull();
  });

  it('does not count a move into a different column', () => {
    recordMove('move-other-column', otherColumnId, 'renderer', SECOND_INSTANT);

    expect(moves.currentVisit(taskId, columnId)).toBeNull();
    expect(moves.visitStartedAt(taskId, columnId)).toBeNull();
    // The same row answers for the column it did enter.
    expect(moves.currentVisit(taskId, otherColumnId)).toEqual({ at: SECOND_INSTANT, origin: 'renderer', from_swimlane_id: null });
  });

  it('does not count another task\'s move into the same column', () => {
    recordMove('move-other-task', columnId, 'agent', SECOND_INSTANT, otherTaskId);

    expect(moves.currentVisit(taskId, columnId)).toBeNull();
    expect(moves.visitStartedAt(taskId, columnId)).toBeNull();
  });

  it('returns the newest move by time, with its origin, not the last one inserted', () => {
    // The newest entry is inserted FIRST and the oldest LAST, so neither
    // insertion order nor id order can produce the right answer by accident.
    recordMove('move-b-newest', columnId, 'renderer', THIRD_INSTANT);
    recordMove('move-c-middle', columnId, 'agent', SECOND_INSTANT);
    recordMove('move-a-oldest', columnId, 'auto-move', FIRST_INSTANT);

    expect(moves.currentVisit(taskId, columnId)).toEqual({ at: THIRD_INSTANT, origin: 'renderer', from_swimlane_id: null });
  });

  it('returns a newer renderer move over an older auto-move', () => {
    recordMove('move-auto', columnId, 'auto-move', FIRST_INSTANT);
    recordMove('move-renderer', columnId, 'renderer', SECOND_INSTANT);

    expect(moves.currentVisit(taskId, columnId)?.origin).toBe('renderer');
  });

  it('returns a newer auto-move over an older renderer move', () => {
    recordMove('move-renderer', columnId, 'renderer', FIRST_INSTANT);
    recordMove('move-auto', columnId, 'auto-move', SECOND_INSTANT);

    expect(moves.currentVisit(taskId, columnId)?.origin).toBe('auto-move');
  });

  it('breaks a same-millisecond tie toward the later-inserted move, origin included', () => {
    // Ids sort the opposite way to insertion order, so an id tie-break would
    // pick the first row; only the rowid tie-break picks the second.
    recordMove('move-z-first-inserted', columnId, 'auto-move', SECOND_INSTANT);
    recordMove('move-a-second-inserted', columnId, 'renderer', SECOND_INSTANT);

    expect(moves.currentVisit(taskId, columnId)).toEqual({ at: SECOND_INSTANT, origin: 'renderer', from_swimlane_id: null });
  });

  it('breaks a same-millisecond tie toward the later-inserted move when that one is an auto-move', () => {
    recordMove('move-z-first-inserted', columnId, 'renderer', SECOND_INSTANT);
    recordMove('move-a-second-inserted', columnId, 'auto-move', SECOND_INSTANT);

    expect(moves.currentVisit(taskId, columnId)).toEqual({ at: SECOND_INSTANT, origin: 'auto-move', from_swimlane_id: null });
  });

  it('keeps the tie-break inside a column, ignoring a later-inserted move into another column', () => {
    recordMove('move-this-column', columnId, 'renderer', SECOND_INSTANT);
    recordMove('move-other-column', otherColumnId, 'auto-move', SECOND_INSTANT);

    expect(moves.currentVisit(taskId, columnId)).toEqual({ at: SECOND_INSTANT, origin: 'renderer', from_swimlane_id: null });
  });

  it('round-trips an auto-move origin unchanged', () => {
    recordMove('move-auto', columnId, 'auto-move', SECOND_INSTANT);

    expect(moves.currentVisit(taskId, columnId)).toStrictEqual({ at: SECOND_INSTANT, origin: 'auto-move', from_swimlane_id: null });
  });

  // The runner reads the column the move came from to tell a drag into that
  // column's plan exit target from any other move.
  it('returns the column the newest move came from', () => {
    recordMove('move-older', columnId, 'renderer', FIRST_INSTANT, taskId, null);
    recordMove('move-newer', columnId, 'renderer', SECOND_INSTANT, taskId, otherColumnId);

    expect(moves.currentVisit(taskId, columnId)).toStrictEqual({ at: SECOND_INSTANT, origin: 'renderer', from_swimlane_id: otherColumnId });
  });

  it('answers visitStartedAt with the same instant currentVisit returns', () => {
    const cases: Array<{ name: string; expectedInstant: string | null; setup: () => void }> = [
      { name: 'no move recorded', expectedInstant: null, setup: () => undefined },
      {
        name: 'one move',
        expectedInstant: FIRST_INSTANT,
        setup: () => recordMove('move-one', columnId, 'renderer', FIRST_INSTANT),
      },
      {
        name: 'older and newer moves',
        expectedInstant: THIRD_INSTANT,
        setup: () => {
          recordMove('move-newer', columnId, 'agent', THIRD_INSTANT);
          recordMove('move-older', columnId, 'renderer', FIRST_INSTANT);
        },
      },
      {
        name: 'a tie',
        expectedInstant: SECOND_INSTANT,
        setup: () => {
          recordMove('move-z-tie-first', columnId, 'auto-move', SECOND_INSTANT);
          recordMove('move-a-tie-second', columnId, 'workflow', SECOND_INSTANT);
        },
      },
    ];
    for (const { name, expectedInstant, setup } of cases) {
      database.exec('DELETE FROM task_moves');
      setup();
      expect(moves.visitStartedAt(taskId, columnId), name).toBe(expectedInstant);
      expect(moves.visitStartedAt(taskId, columnId), name).toBe(moves.currentVisit(taskId, columnId)?.at ?? null);
    }
  });

  // kangentic_move_task asks which column the task was in when its agent's turn
  // began, to refuse a "next" the task has since moved past (#929).
  describe('columnAt', () => {
    it('is null when no move was recorded at or before the instant', () => {
      recordMove('move-later', columnId, 'renderer', SECOND_INSTANT);

      expect(moves.columnAt(taskId, FIRST_INSTANT)).toBeNull();
    });

    it('is the column the last move at or before the instant took the task to, never a later one', () => {
      recordMove('move-first', columnId, 'create', FIRST_INSTANT);
      recordMove('move-third', columnId, 'agent', THIRD_INSTANT, taskId, otherColumnId);
      recordMove('move-second', otherColumnId, 'auto-move', SECOND_INSTANT, taskId, columnId);

      expect(moves.columnAt(taskId, FIRST_INSTANT)).toBe(columnId);
      expect(moves.columnAt(taskId, SECOND_INSTANT)).toBe(otherColumnId);
      expect(moves.columnAt(taskId, '2026-09-01T09:07:00.000Z')).toBe(otherColumnId);
      expect(moves.columnAt(taskId, THIRD_INSTANT)).toBe(columnId);
    });

    it('breaks a same-millisecond tie toward the later-inserted move', () => {
      recordMove('move-z-first-inserted', columnId, 'renderer', SECOND_INSTANT);
      recordMove('move-a-second-inserted', otherColumnId, 'auto-move', SECOND_INSTANT, taskId, columnId);

      expect(moves.columnAt(taskId, SECOND_INSTANT)).toBe(otherColumnId);
    });

    it('does not read another task\'s moves', () => {
      recordMove('move-other-task', columnId, 'renderer', FIRST_INSTANT, otherTaskId);

      expect(moves.columnAt(taskId, SECOND_INSTANT)).toBeNull();
    });
  });
});

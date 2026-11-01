/**
 * A column's place in line, read from the real schema: a task's place is its
 * latest entry into its column. Also the two helpers that plan around a limit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { columnRoom, orderByColumnEntry } from '../../src/main/transition-engine/column-capacity';
import type { Swimlane } from '../../src/shared/types';

describe('listCappedColumnTasks', () => {
  let database: DatabaseType.Database;
  let tasks: TaskRepository;
  let moves: TaskMoveRepository;
  let limited: Swimlane;
  let other: Swimlane;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    moves = new TaskMoveRepository(database);
    const swimlanes = new SwimlaneRepository(database);
    [limited, other] = swimlanes.list().filter((lane) => lane.role === null);
    swimlanes.update({ id: limited.id, max_agents: 1 });
  });

  afterEach(() => database.close());

  function taskIn(lane: Swimlane, id: string, at: string): void {
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(id, id, '', lane.id, at, at);
  }

  function enter(taskId: string, lane: Swimlane, at: string, origin = 'renderer'): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, NULL, ?, ?, NULL, ?)')
      .run(`${taskId}-${at}`, taskId, lane.id, origin, at);
    database.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(lane.id, taskId);
  }

  const enteredAt = (taskId: string) => moves.listCappedColumnTasks().find((task) => task.taskId === taskId)?.enteredAt;

  it('lists only tasks in a column with a limit, with that limit', () => {
    taskIn(limited, 'in-limited', '2026-01-01T00:00:00.000Z');
    taskIn(other, 'elsewhere', '2026-01-01T00:00:00.000Z');

    expect(moves.listCappedColumnTasks()).toEqual([expect.objectContaining({
      taskId: 'in-limited', swimlaneId: limited.id, swimlaneName: limited.name, maxAgents: 1,
    })]);
  });

  it('falls back to creation for a task placed before moves were recorded', () => {
    taskIn(limited, 'old-task', '2026-01-01T00:00:00.000Z');
    expect(enteredAt('old-task')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('keeps a task\'s place when it is dragged within the column', () => {
    taskIn(other, 'dragged', '2026-01-01T00:00:00.000Z');
    enter('dragged', limited, '2026-01-02T00:00:00.000Z');

    tasks.move({ taskId: 'dragged', targetSwimlaneId: limited.id, targetPosition: 0 }, { origin: 'renderer' });

    expect(enteredAt('dragged')).toBe('2026-01-02T00:00:00.000Z');
  });

  it('sends a task that left and came back to the end of the line', () => {
    taskIn(other, 'returned', '2026-01-01T00:00:00.000Z');
    enter('returned', limited, '2026-01-02T00:00:00.000Z');
    enter('returned', other, '2026-01-03T00:00:00.000Z');
    enter('returned', limited, '2026-01-04T00:00:00.000Z');

    expect(enteredAt('returned')).toBe('2026-01-04T00:00:00.000Z');
  });

  it('keeps a task\'s place through a move that failed and rolled back', () => {
    taskIn(other, 'rolled-back', '2026-01-01T00:00:00.000Z');
    enter('rolled-back', limited, '2026-01-02T00:00:00.000Z');
    enter('rolled-back', other, '2026-01-03T00:00:00.000Z');
    enter('rolled-back', limited, '2026-01-04T00:00:00.000Z', 'rollback');

    expect(enteredAt('rolled-back')).toBe('2026-01-02T00:00:00.000Z');
  });

  it('leaves out an archived task', () => {
    taskIn(limited, 'archived', '2026-01-01T00:00:00.000Z');
    database.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', 'archived');

    expect(moves.listCappedColumnTasks()).toEqual([]);
  });
});

describe('orderByColumnEntry', () => {
  const capped = (taskId: string, enteredAt: string) => ({ taskId, swimlaneId: 'merge', swimlaneName: 'merge', maxAgents: 1, enteredAt });
  const input = (id: string) => ({ task: { id } });

  it('puts the earliest-entered task in a limited column first', () => {
    const ordered = orderByColumnEntry([input('later'), input('earlier')], [capped('later', '2026-01-02'), capped('earlier', '2026-01-01')]);
    expect(ordered.map((entry) => entry.task.id)).toEqual(['earlier', 'later']);
  });

  it('keeps tasks in no limited column in their order', () => {
    const ordered = orderByColumnEntry([input('b'), input('a')], []);
    expect(ordered.map((entry) => entry.task.id)).toEqual(['b', 'a']);
  });
});

describe('columnRoom', () => {
  const capped = (taskId: string, swimlaneId = 'merge') => ({ taskId, swimlaneId, swimlaneName: swimlaneId, maxAgents: 1, enteredAt: '2026-01-01' });

  it('is unlimited with no limit', () => {
    expect(columnRoom({ id: 'merge', max_agents: null }, [], new Set())).toBe(Number.POSITIVE_INFINITY);
  });

  it('is the limit less the tasks claiming the column', () => {
    expect(columnRoom({ id: 'merge', max_agents: 1 }, [capped('running')], new Set())).toBe(1);
    expect(columnRoom({ id: 'merge', max_agents: 1 }, [capped('running')], new Set(['running']))).toBe(0);
  });

  it('counts only this column, and never goes below none', () => {
    expect(columnRoom({ id: 'merge', max_agents: 1 }, [capped('elsewhere', 'testing')], new Set(['elsewhere']))).toBe(1);
    expect(columnRoom({ id: 'merge', max_agents: 1 }, [capped('one'), capped('two')], new Set(['one', 'two']))).toBe(0);
  });
});

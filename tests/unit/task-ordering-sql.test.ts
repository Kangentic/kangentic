/**
 * EMPIRICAL tests for task placement against a REAL SQLite engine: the dense
 * rewrite (`TaskRepository.reorderWithinSwimlane`) and the ordinal-to-raw
 * translation `handleMoveTask` performs before handing a position to
 * `TaskRepository.move`.
 *
 * These cover the two things the mocked handler tests structurally cannot:
 *
 *   1. The dense rewrite issues its UPDATEs one at a time, so mid-transaction it
 *      passes through states where two rows in the column share a position. That
 *      is only safe because `idx_tasks_swimlane_position` is a plain index, not
 *      a unique one. A future unique index would break the rewrite, and nothing
 *      but a real engine would notice.
 *   2. That an ordinal slot actually lands where it claims to on a GAPPED
 *      column. Gaps are the normal state (archiving leaves `position`
 *      untouched), and the arithmetic is only convincing when a real engine
 *      applies `move()`'s neighbour shifts on top of it.
 *
 * node:sqlite rather than better-sqlite3 on purpose, and the adapter mirrors
 * worktree-folder-migration.test.ts: better-sqlite3 is compiled for Electron's
 * Node ABI, so every suite gated on it SKIPS everywhere, CI included. A skipped
 * test is not coverage.
 */

import { describe, it, expect, vi } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { handleMoveTask, handleReorderTasks } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type DatabaseType from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

/** See worktree-folder-migration.test.ts - same adapter, same non-nesting caveat. */
function adaptDatabase(database: InstanceType<SqliteModule['DatabaseSync']>): DatabaseType.Database {
  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => database.prepare(sql),
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction: <Args extends unknown[], Result>(body: (...args: Args) => Result) =>
      (...args: Args): Result => {
        database.exec('BEGIN');
        try {
          const result = body(...args);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
  };
  return adapter as unknown as DatabaseType.Database;
}

interface Board {
  db: DatabaseType.Database;
  tasks: TaskRepository;
  todoLaneId: string;
  todoLaneName: string;
  reviewLaneId: string;
  reviewLaneName: string;
  context: CommandContext;
}

function makeBoard(): Board {
  const db = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
  runProjectMigrations(db);
  const tasks = new TaskRepository(db);

  const lanes = new SwimlaneRepository(db).list().filter((lane) => !lane.is_archived);
  const todo = lanes.find((lane) => lane.role === 'todo');
  const review = lanes.find((lane) => lane.role !== 'todo');
  if (!todo || !review) throw new Error('Migrations did not seed two usable lanes');

  const context = {
    getProjectDb: () => db,
    getProjectPath: () => '/mock/project',
    getBoardProfiles: () => [],
    setBoardProfiles: vi.fn(),
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    // The DB half of what handleTaskMove does. Applying it here is what makes
    // this an end-to-end check of the ordinal-to-raw translation rather than an
    // assertion about a dispatch payload.
    onTaskMove: vi.fn(async (input) => { tasks.move(input); }),
    onTasksReordered: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  } as unknown as CommandContext;

  return {
    db,
    tasks,
    todoLaneId: todo.id,
    todoLaneName: todo.name,
    reviewLaneId: review.id,
    reviewLaneName: review.name,
    context,
  };
}

/** Titles of a lane's live tasks, top to bottom. */
function orderOf(board: Board, laneId: string): string[] {
  return board.tasks.list(laneId).map((task) => task.title);
}

/** Raw stored positions of a lane's live tasks, top to bottom. */
function rawPositionsOf(board: Board, laneId: string): number[] {
  return board.tasks.list(laneId).map((task) => task.position);
}

function seed(board: Board, laneId: string, titles: string[]) {
  return titles.map((title) => board.tasks.create({ title, description: '', swimlane_id: laneId }));
}

/**
 * A lane whose live tasks sit at raw positions 0, 5, 9 - the shape archiving
 * produces, and the one where an ordinal is not its own raw value.
 */
function seedGappedLane(board: Board): string[] {
  const created = seed(board, board.todoLaneId, ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
  for (const index of [1, 2, 3, 4, 6, 7, 8]) {
    board.tasks.archive(created[index].id);
  }
  expect(rawPositionsOf(board, board.todoLaneId)).toEqual([0, 5, 9]);
  return created.map((task) => task.id);
}

describeWithSqlite('TaskRepository.reorderWithinSwimlane', () => {
  it('applies the requested order and renumbers densely', () => {
    const board = makeBoard();
    const created = seed(board, board.todoLaneId, ['a', 'b', 'c', 'd']);

    board.tasks.reorderWithinSwimlane(board.todoLaneId, [created[3].id, created[1].id, created[0].id, created[2].id]);

    expect(orderOf(board, board.todoLaneId)).toEqual(['d', 'b', 'a', 'c']);
    expect(rawPositionsOf(board, board.todoLaneId)).toEqual([0, 1, 2, 3]);
  });

  it('survives an adjacent swap, which transiently duplicates a position', () => {
    // Writing "b" to slot 0 leaves both rows at 0 until "a" is written to 1.
    // Safe only because idx_tasks_swimlane_position is not UNIQUE.
    const board = makeBoard();
    const created = seed(board, board.todoLaneId, ['a', 'b']);

    board.tasks.reorderWithinSwimlane(board.todoLaneId, [created[1].id, created[0].id]);

    expect(orderOf(board, board.todoLaneId)).toEqual(['b', 'a']);
    expect(rawPositionsOf(board, board.todoLaneId)).toEqual([0, 1]);
  });

  it('heals a gapped column', () => {
    const board = makeBoard();
    const ids = seedGappedLane(board);

    board.tasks.reorderWithinSwimlane(board.todoLaneId, [ids[0], ids[5], ids[9]]);

    expect(rawPositionsOf(board, board.todoLaneId)).toEqual([0, 1, 2]);
  });

  it('ignores an id belonging to another column', () => {
    const board = makeBoard();
    const todo = seed(board, board.todoLaneId, ['a', 'b']);
    const [review] = seed(board, board.reviewLaneId, ['r']);

    board.tasks.reorderWithinSwimlane(board.todoLaneId, [review.id, todo[1].id, todo[0].id]);

    // The stray id is a no-op, so the survivors take the slots they were given.
    expect(board.tasks.getById(review.id)!.swimlane_id).toBe(board.reviewLaneId);
    expect(orderOf(board, board.todoLaneId)).toEqual(['b', 'a']);
    // ...but the stray CONSUMED slot 0, so the result is gapped, not dense. The
    // "heals a gapped column" guarantee holds only when every id is a member of
    // the lane, which is what both callers validate before getting here.
    expect(rawPositionsOf(board, board.todoLaneId)).toEqual([1, 2]);
  });

  it('never stamps updated_at, so a shifted sibling cannot drop a lane pin', () => {
    // The load-bearing one. `lane-pins.ts` drops a pin as soon as a payload row
    // differs in {presence, lane, updated_at}, and rests that on move()'s
    // convention that a row merely SHIFTING position is not stamped. If a
    // reorder stamped its rows, an agent reordering the origin lane would drop
    // the pin under a card the user is mid-drag and snap it back. So assert on
    // the rows that MOVED, not just the one that stayed.
    const board = makeBoard();
    const created = seed(board, board.todoLaneId, ['a', 'b', 'c']);
    const before = created.map((task) => board.tasks.getById(task.id)!.updated_at);

    // "a" is already at slot 0; b and c swap, so both of those rows are written.
    board.tasks.reorderWithinSwimlane(board.todoLaneId, [created[0].id, created[2].id, created[1].id]);

    expect(orderOf(board, board.todoLaneId)).toEqual(['a', 'c', 'b']);
    expect(created.map((task) => board.tasks.getById(task.id)!.updated_at)).toEqual(before);
  });
});

describeWithSqlite('nextPositionInSwimlane', () => {
  it('counts archived rows, so an append cannot reuse an archived position', () => {
    const board = makeBoard();
    const created = seed(board, board.todoLaneId, ['a', 'b', 'c']);
    board.tasks.archive(created[2].id);

    // Live tasks are now 2, but the archived row still holds position 2.
    expect(board.tasks.list(board.todoLaneId)).toHaveLength(2);
    expect(board.tasks.nextPositionInSwimlane(board.todoLaneId)).toBe(3);
  });

  it('starts an empty lane at 0', () => {
    const board = makeBoard();

    expect(board.tasks.nextPositionInSwimlane(board.todoLaneId)).toBe(0);
  });
});

describeWithSqlite('handleMoveTask placement on a gapped column', () => {
  it('lands a cross-column move at the requested ordinal, not the raw value', () => {
    // Live raw positions are [0, 5, 9]. Passing the ordinal 2 straight through
    // as a raw position would sweep the task in ahead of raw 5 and land it at
    // ordinal 1 instead.
    const board = makeBoard();
    seedGappedLane(board);
    const [incoming] = seed(board, board.reviewLaneId, ['incoming']);

    const response = handleMoveTask(
      { taskId: incoming.id, column: board.todoLaneName, position: 2 },
      board.context,
    );

    expect(response.success).toBe(true);
    expect(orderOf(board, board.todoLaneId)).toEqual(['t0', 't5', 'incoming', 't9']);
  });

  it('puts a cross-column move at the top for slot 0', () => {
    const board = makeBoard();
    seedGappedLane(board);
    const [incoming] = seed(board, board.reviewLaneId, ['incoming']);

    handleMoveTask({ taskId: incoming.id, column: board.todoLaneName, position: 0 }, board.context);

    expect(orderOf(board, board.todoLaneId)).toEqual(['incoming', 't0', 't5', 't9']);
  });

  it('appends past the gapped tail when no position is given', () => {
    // The old default sent the column's LENGTH (3) as a raw position, which on
    // this column lands second rather than last.
    const board = makeBoard();
    seedGappedLane(board);
    const [incoming] = seed(board, board.reviewLaneId, ['incoming']);

    handleMoveTask({ taskId: incoming.id, column: board.todoLaneName }, board.context);

    expect(orderOf(board, board.todoLaneId)).toEqual(['t0', 't5', 't9', 'incoming']);
  });

  it('refuses to reposition an archived task, which holds no slot', () => {
    // `archive()` leaves swimlane_id alone, so the task still resolves to its
    // old column while `list()` no longer contains it. Renumbering the live
    // cards around it would report a position the card does not have.
    const board = makeBoard();
    const created = seed(board, board.todoLaneId, ['a', 'b', 'c']);
    board.tasks.archive(created[1].id);

    const response = handleMoveTask(
      { taskId: created[1].id, column: board.todoLaneName, position: 0 },
      board.context,
    );

    expect(response.success).toBe(false);
    expect(response.error).toContain('archived');
    expect(orderOf(board, board.todoLaneId)).toEqual(['a', 'c']);
    expect(rawPositionsOf(board, board.todoLaneId)).toEqual([0, 2]);
  });

  it('repositions within the column without leaving it', () => {
    const board = makeBoard();
    seedGappedLane(board);

    const response = handleMoveTask(
      { taskId: board.tasks.list(board.todoLaneId)[2].id, column: board.todoLaneName, position: 0 },
      board.context,
    );

    expect(response.success).toBe(true);
    expect(orderOf(board, board.todoLaneId)).toEqual(['t9', 't0', 't5']);
    expect(board.context.onTaskMove).not.toHaveBeenCalled();
  });
});

describeWithSqlite('handleReorderTasks against a real engine', () => {
  it('sets the full order of a column in one call', () => {
    const board = makeBoard();
    const created = seed(board, board.todoLaneId, ['a', 'b', 'c', 'd']);

    const response = handleReorderTasks(
      {
        column: board.todoLaneName,
        taskIds: [created[3].id, created[2].id, created[1].id, created[0].id],
      },
      board.context,
    );

    expect(response.success).toBe(true);
    expect(orderOf(board, board.todoLaneId)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('accepts display IDs and pins a subset to the top', () => {
    const board = makeBoard();
    const created = seed(board, board.todoLaneId, ['a', 'b', 'c', 'd']);

    handleReorderTasks(
      { column: board.todoLaneName, taskIds: [String(created[2].display_id)] },
      board.context,
    );

    expect(orderOf(board, board.todoLaneId)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('does not move, archive, or otherwise disturb the tasks it reorders', () => {
    const board = makeBoard();
    const created = seed(board, board.todoLaneId, ['a', 'b']);

    handleReorderTasks({ column: board.todoLaneName, taskIds: [created[1].id] }, board.context);

    const moved = board.tasks.getById(created[1].id)!;
    expect(moved.swimlane_id).toBe(board.todoLaneId);
    expect(moved.archived_at).toBeNull();
    expect(moved.session_id).toBeNull();
    expect(board.context.onTaskMove).not.toHaveBeenCalled();
  });
});

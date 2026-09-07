/**
 * EMPIRICAL tests for the `tasks.worktree_skip_reason` column, run against a
 * REAL SQLite engine (node:sqlite) rather than a mocked repository.
 *
 * Every existing spec that touches `setWorktreeSkipReason`
 * (task-move-git-churn-wiring.test.ts, task-move-complete-analytics.test.ts,
 * delete-task-worktree.test.ts, worktree-reuse-drift.test.ts,
 * task-git-remote-worktree-skip.test.ts) mocks the repository with `vi.fn()`,
 * so none of them prove the column actually round-trips through a real
 * database, that `recordWorktree` clears it inside its own transaction, or
 * that the write skips the `updated_at` bump its own doc comment promises.
 *
 * node:sqlite rather than better-sqlite3: better-sqlite3 is compiled for
 * Electron's Node ABI, so a suite gated on it currently SKIPS everywhere, CI
 * included (see the header of tasks-run-mode-migration.test.ts). This file
 * follows the node:sqlite harness already established in
 * worktree-folder-migration.test.ts rather than inventing a new one.
 *
 * node:sqlite is built-in on Node 22.5+; this suite skips where unavailable.
 */

import { describe, it, expect } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type DatabaseType from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

/**
 * Adapt node:sqlite's DatabaseSync to the slice of better-sqlite3's surface
 * the migrations and repositories use. Mirrors the adapter in
 * worktree-folder-migration.test.ts so both suites share one known-good
 * shape rather than drifting two implementations of the same shim.
 */
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

function migratedDatabase(): DatabaseType.Database {
  const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
  runProjectMigrations(database);
  return database;
}

/** The first seeded lane, so inserted tasks satisfy swimlane_id. */
function anyLaneId(database: DatabaseType.Database): string {
  return (database.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
}

function createTask(tasks: TaskRepository, database: DatabaseType.Database, title: string) {
  return tasks.create({ title, description: '', swimlane_id: anyLaneId(database) });
}

function updatedAtOf(database: DatabaseType.Database, taskId: string): string {
  return (database.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(taskId) as { updated_at: string }).updated_at;
}

function setUpdatedAt(database: DatabaseType.Database, taskId: string, updatedAt: string): void {
  database.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(updatedAt, taskId);
}

describeWithSqlite('worktree_skip_reason', () => {
  it('persists a reason and clears it back to null', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');

    tasks.setWorktreeSkipReason(task.id, 'not-a-repo');
    expect(tasks.getById(task.id)!.worktree_skip_reason).toBe('not-a-repo');

    tasks.setWorktreeSkipReason(task.id, null);
    expect(tasks.getById(task.id)!.worktree_skip_reason).toBeNull();
  });

  it('recordWorktree clears a stale reason inside its own transaction, so the path and the reason can never disagree', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.setWorktreeSkipReason(task.id, 'no-commits');

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/460', 'task-abcd1234', '460');

    const stored = tasks.getById(task.id)!;
    expect(stored.worktree_skip_reason).toBeNull();
    expect(stored.worktree_path).toBe('/project/.kangentic/worktrees/460');
    expect(stored.branch_name).toBe('task-abcd1234');
    expect(stored.worktree_folder).toBe('460');
  });

  it('does not bump updated_at, unlike a normal update()', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');

    // Seed a deliberately old updated_at so the contrast below does not rely
    // on wall-clock advance between two calls in the same millisecond, which
    // update()'s toISOString() (millisecond resolution) cannot guarantee.
    const staleTimestamp = '2020-01-01T00:00:00.000Z';
    setUpdatedAt(database, task.id, staleTimestamp);

    tasks.setWorktreeSkipReason(task.id, 'remote-agent');
    expect(updatedAtOf(database, task.id)).toBe(staleTimestamp);

    // Contrast: a real user-facing edit through update() DOES bump it. This
    // proves the assertion above is exercising the distinction the method's
    // doc comment claims, not just "a string equals itself".
    tasks.update({ id: task.id, title: 'Renamed' });
    expect(updatedAtOf(database, task.id)).not.toBe(staleTimestamp);
  });

  it('a normal update() never touches worktree_skip_reason', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.setWorktreeSkipReason(task.id, 'disabled');

    tasks.update({ id: task.id, title: 'Renamed' });

    expect(tasks.getById(task.id)!.worktree_skip_reason).toBe('disabled');
  });
});

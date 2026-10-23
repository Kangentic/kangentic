/**
 * EMPIRICAL tests for the `tasks.worktree_skip_reason`, `tasks.resolved_base_branch`,
 * and `tasks.pushed_branch` columns, run against a REAL SQLite engine
 * (better-sqlite3, the driver production uses) rather than a mocked repository.
 *
 * Every existing spec that touches `setWorktreeSkipReason`
 * (task-move-git-churn-wiring.test.ts, task-move-complete-analytics.test.ts,
 * delete-task-worktree.test.ts, worktree-reuse-drift.test.ts,
 * task-git-remote-worktree-skip.test.ts) mocks the repository with `vi.fn()`,
 * so none of them prove the column actually round-trips through a real
 * database, that `recordWorktree` clears it inside its own transaction, or
 * that the write skips the `updated_at` bump its own doc comment promises.
 *
 * `pushed_branch` gets the same treatment for the same reason: its only
 * production writer is `pr-linking.ts`, whose own test
 * (`pr-link-ladder.test.ts`) mocks `tasks.update` as a plain `Object.assign`,
 * so nothing exercises the real hand-maintained `UPDATE tasks SET ...`
 * statement for that column. That statement lists 24 columns as positional
 * `?` placeholders in one order and binds 24 values in a second, separately
 * maintained order (`task-repository.ts`'s `update()`); a forgotten column in
 * either list is a real, single-line mistake this file can catch and a mock
 * cannot, because a mock never touches the SQL text.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type DatabaseType from 'better-sqlite3';

import { openTestDatabase } from './helpers/test-database';

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function migratedDatabase(): DatabaseType.Database {
  const database = openTestDatabase();
  openDatabases.push(database);
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

describe('worktree_skip_reason', () => {
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

describe('pushed_branch (via the real update() UPDATE statement)', () => {
  it('writes pushed_branch, and its column-list neighbors, each to its own column - not a shifted one', () => {
    // head_sha, pushed_branch, base_branch, and resolved_base_branch sit
    // adjacent in update()'s hand-maintained `SET ... = ?` list and its
    // separately maintained `.run(...)` argument list. Four DISTINCT values in
    // one write, read back by COLUMN NAME, is what catches a forgotten or
    // shifted entry in either list: a mock (`vi.fn` on `update`, as
    // pr-link-ladder.test.ts uses) never touches the SQL text and cannot see
    // this class of bug at all.
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');

    tasks.update({
      id: task.id,
      head_sha: 'sha-head-value',
      pushed_branch: 'maint/pushed-name',
      base_branch: 'release/explicit-base',
      resolved_base_branch: 'develop',
    });

    const stored = tasks.getById(task.id)!;
    expect(stored.head_sha).toBe('sha-head-value');
    expect(stored.pushed_branch).toBe('maint/pushed-name');
    expect(stored.base_branch).toBe('release/explicit-base');
    expect(stored.resolved_base_branch).toBe('develop');
  });

  it('clears pushed_branch back to null through a real update(), like every other nullable column', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.update({ id: task.id, pushed_branch: 'maint/pushed-name' });
    expect(tasks.getById(task.id)!.pushed_branch).toBe('maint/pushed-name');

    tasks.update({ id: task.id, pushed_branch: null });

    expect(tasks.getById(task.id)!.pushed_branch).toBeNull();
  });
});

describe('resolved_base_branch', () => {
  it('records the resolved base branch on a real creation', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/612', 'task-abcd1234', '612', 'develop');

    expect(tasks.getById(task.id)!.resolved_base_branch).toBe('develop');
  });

  it('keeps the base an earlier real creation recorded when a later reattach omits it', () => {
    // A reattach to a branch that already existed passes no start point, so
    // `WorktreeManager.createWorktree` has no observed base and calls
    // `recordWorktree` with the 5th argument omitted. That call must not erase
    // the base an earlier real creation recorded, or the PR linker loses a
    // known base it once had.
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/612', 'task-abcd1234', '612', 'develop');
    expect(tasks.getById(task.id)!.resolved_base_branch).toBe('develop');

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/612', 'task-abcd1234', '612');

    expect(tasks.getById(task.id)!.resolved_base_branch).toBe('develop');
  });
});

describe('fork_point_sha (main-only)', () => {
  const FORK_POINT = 'f4657fd6cf9f208ad2fe4e4bc9fae99f0edfca55';

  it('records the fork point on a real creation, and keeps it off the shared Task', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881', 'main', FORK_POINT);

    expect(tasks.getForkPointSha(task.id)).toBe(FORK_POINT);
    // rowToTask spreads every column, so this is the line that keeps it from
    // riding every Task over IPC.
    expect(Object.keys(tasks.getById(task.id)!)).not.toContain('fork_point_sha');
    expect(Object.keys(tasks.list(task.swimlane_id)[0])).not.toContain('fork_point_sha');
  });

  it('keeps the fork point an earlier creation recorded when a reattach reads none', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881', 'main', FORK_POINT);

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881', null, null);

    expect(tasks.getForkPointSha(task.id)).toBe(FORK_POINT);
  });

  it('keeps the fork point when a reattach to the same branch omits the argument entirely', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881', 'main', FORK_POINT);

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881');

    expect(tasks.getForkPointSha(task.id)).toBe(FORK_POINT);
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
  ])('drops the stored fork point when an attach to a DIFFERENT branch reads none (%s)', (_label, noForkPoint) => {
    // The stored point was cut for the first branch. An attach to another
    // branch has no fork point of its own to record, and leaving the old one
    // would make the Changes view diff the new branch from a commit it never
    // forked at.
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881', 'main', FORK_POINT);
    expect(tasks.getForkPointSha(task.id)).toBe(FORK_POINT);

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-other5678', '881', null, noForkPoint);

    expect(tasks.getById(task.id)!.branch_name).toBe('task-other5678');
    expect(tasks.getForkPointSha(task.id)).toBeNull();
  });

  it('replaces the stored fork point when an attach to a different branch does read one', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    const otherForkPoint = '0123456789abcdef0123456789abcdef01234567';
    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881', 'main', FORK_POINT);

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-other5678', '881', 'main', otherForkPoint);

    expect(tasks.getForkPointSha(task.id)).toBe(otherForkPoint);
  });

  it('an update() that never mentions branch_name keeps the fork point', () => {
    // update() clears the fork point in the same statement only when the caller
    // writes branch_name to null. The gate is `=== null`, not `== null`, so an
    // edit that leaves branch_name out (or passes it as undefined) must not
    // forget the branch's fork point.
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881', 'main', FORK_POINT);

    tasks.update({ id: task.id, title: 'Renamed' });
    expect(tasks.getForkPointSha(task.id)).toBe(FORK_POINT);

    tasks.update({ id: task.id, title: 'Renamed again', branch_name: undefined });
    expect(tasks.getForkPointSha(task.id)).toBe(FORK_POINT);

    tasks.update({ id: task.id, worktree_path: null });
    expect(tasks.getForkPointSha(task.id)).toBe(FORK_POINT);
    expect(tasks.getById(task.id)!.branch_name).toBe('task-abcd1234');
  });

  it('is forgotten with the branch, kept through a rename and an unrelated edit', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/881', 'task-abcd1234', '881', 'main', FORK_POINT);

    tasks.update({ id: task.id, title: 'Renamed' });
    tasks.update({ id: task.id, branch_name: 'feat/renamed-branch' });
    expect(tasks.getForkPointSha(task.id)).toBe(FORK_POINT);

    tasks.update({ id: task.id, worktree_path: null, branch_name: null, resolved_base_branch: null });
    expect(tasks.getForkPointSha(task.id)).toBeNull();
  });

  it('reads null for a task that never had a worktree', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    expect(tasks.getForkPointSha(task.id)).toBeNull();
    expect(tasks.getForkPointSha('no-such-task')).toBeNull();
  });
});

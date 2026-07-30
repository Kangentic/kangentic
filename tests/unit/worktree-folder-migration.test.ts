/**
 * EMPIRICAL tests for the write-once `tasks.worktree_folder` column, its
 * migration backfill, the monotonic `display_id` allocator, and the legacy
 * folder recovery, run against a REAL SQLite engine (node:sqlite).
 *
 * node:sqlite rather than better-sqlite3 on purpose: better-sqlite3 is compiled
 * for Electron's Node ABI, so every suite gated on it currently SKIPS
 * everywhere, CI included (see the header of tasks-run-mode-migration.test.ts).
 * A skipped migration test is not coverage, and the invariant here is one that
 * silently corrupts data if it breaks: `worktree_folder` is written once and
 * never rewritten, so a wrong value is permanent.
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
 * Adapt node:sqlite's DatabaseSync to the slice of better-sqlite3's surface the
 * migrations and repositories use. `prepare` is already identical; only `pragma`
 * and `transaction` need translating.
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

describeWithSqlite('worktree_folder column and migration', () => {
  it('adds the column and leaves it null for a task with no worktree', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Fresh task');

    expect(tasks.getById(task.id)!.worktree_folder).toBeNull();
  });

  it('backfills from worktree_path, and only from worktree_path', () => {
    const database = migratedDatabase();
    const laneId = anyLaneId(database);

    // Rebuild the pre-migration shape so the backfill actually runs.
    database.exec('ALTER TABLE tasks DROP COLUMN worktree_folder');
    const insertTask = database.prepare(`INSERT INTO tasks
      (id, display_id, title, description, swimlane_id, position, worktree_path, labels, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, 0, ?, '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')`);
    insertTask.run('task-with-path', 1, 'Has worktree', laneId, '/project/.kangentic/worktrees/dns-setup-4e41b16b');
    insertTask.run('task-windows-path', 2, 'Windows path', laneId, 'C:\\project\\.kangentic\\worktrees\\460');
    insertTask.run('task-no-path', 3, 'Cleaned by Done', laneId, null);

    // A session row exists for the path-less task. The migration must NOT use
    // it: without the project path it cannot tell a task's own worktree cwd
    // apart from a project that is itself checked out at a worktree path.
    database.prepare(`INSERT INTO sessions
      (id, task_id, session_type, command, cwd, status, started_at)
      VALUES ('s1', 'task-no-path', 'claude', 'c', '/project/.kangentic/worktrees/old-folder-aaaabbbb', 'exited', '2026-07-30T00:00:00.000Z')`).run();

    runProjectMigrations(database);

    const folderOf = (id: string) => (database
      .prepare('SELECT worktree_folder FROM tasks WHERE id = ?')
      .get(id) as { worktree_folder: string | null }).worktree_folder;

    expect(folderOf('task-with-path')).toBe('dns-setup-4e41b16b');
    expect(folderOf('task-windows-path')).toBe('460');
    expect(folderOf('task-no-path')).toBeNull();
  });

  it('is idempotent across repeated runs (the app migrates on every project open)', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    tasks.setWorktreeFolder(task.id, '460');

    expect(() => runProjectMigrations(database)).not.toThrow();
    expect(tasks.getById(task.id)!.worktree_folder).toBe('460');
  });
});

describeWithSqlite('setWorktreeFolder is write-once', () => {
  it('ignores a second write with a different value', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');

    tasks.setWorktreeFolder(task.id, 'dns-setup-4e41b16b');
    tasks.setWorktreeFolder(task.id, '460');

    expect(tasks.getById(task.id)!.worktree_folder).toBe('dns-setup-4e41b16b');
  });

  it('recordWorktree writes the path, branch and folder together', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');

    tasks.recordWorktree(task.id, '/project/.kangentic/worktrees/460', 'task-abcd1234', '460');

    const stored = tasks.getById(task.id)!;
    expect(stored.worktree_path).toBe('/project/.kangentic/worktrees/460');
    expect(stored.branch_name).toBe('task-abcd1234');
    expect(stored.worktree_folder).toBe('460');
  });
});

describeWithSqlite('display_id allocation is monotonic', () => {
  it('does not reuse the number of a deleted task', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);

    const first = createTask(tasks, database, 'First');
    const second = createTask(tasks, database, 'Second');
    expect(second.display_id).toBe(first.display_id + 1);

    // Deleting the HIGHEST-numbered task used to free its number for the next
    // create, which could then adopt the deleted task's leftover directory.
    tasks.delete(second.id);
    const third = createTask(tasks, database, 'Third');

    expect(third.display_id).toBe(second.display_id + 1);
  });

  it('self-heals above MAX(display_id) when the counter row is missing', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const existing = createTask(tasks, database, 'Existing');

    // A database restored from a copy that predates the counter.
    database.prepare("DELETE FROM project_meta WHERE key = 'display_id_high_water'").run();

    expect(createTask(tasks, database, 'Next').display_id).toBe(existing.display_id + 1);
  });
});

describeWithSqlite('recoverLegacyWorktreeFolder', () => {
  const worktreesRoot = '/project/.kangentic/worktrees';

  function seedSession(database: DatabaseType.Database, taskId: string, cwd: string, startedAt: string) {
    database.prepare(`INSERT INTO sessions
      (id, task_id, session_type, command, cwd, status, started_at)
      VALUES (?, ?, 'claude', 'c', ?, 'exited', ?)`)
      .run(`session-${taskId}-${startedAt}`, taskId, cwd, startedAt);
  }

  it('recovers and persists the folder from the task session history', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'DNS Setup');
    seedSession(database, task.id, `${worktreesRoot}/dns-setup-4e41b16b`, '2026-07-30T00:00:00.000Z');

    expect(tasks.recoverLegacyWorktreeFolder(task.id, worktreesRoot)).toBe('dns-setup-4e41b16b');
    // Persisted, so the next creation does not have to look again.
    expect(tasks.getById(task.id)!.worktree_folder).toBe('dns-setup-4e41b16b');
  });

  it('prefers the most recent session when a task ran in more than one place', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Task');
    seedSession(database, task.id, `${worktreesRoot}/older-folder-11112222`, '2026-07-01T00:00:00.000Z');
    seedSession(database, task.id, `${worktreesRoot}/newer-folder-33334444`, '2026-07-30T00:00:00.000Z');

    expect(tasks.recoverLegacyWorktreeFolder(task.id, worktreesRoot)).toBe('newer-folder-33334444');
  });

  it('recovers nothing for a task that never ran an agent', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Never spawned');

    expect(tasks.recoverLegacyWorktreeFolder(task.id, worktreesRoot)).toBeNull();
    expect(tasks.getById(task.id)!.worktree_folder).toBeNull();
  });

  it('recovers nothing when the session ran in the project root, not a worktree', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const task = createTask(tasks, database, 'Ran unisolated');
    seedSession(database, task.id, '/project', '2026-07-30T00:00:00.000Z');

    expect(tasks.recoverLegacyWorktreeFolder(task.id, worktreesRoot)).toBeNull();
  });

  /**
   * The case that makes the anchor load-bearing. Kangentic dogfoods from inside
   * a worktree, so a registered project's own path can contain
   * `.kangentic/worktrees/`. A task there that never had a worktree has a
   * session cwd equal to the project root - which a bare marker search would
   * read as owning the ENCLOSING worktree's folder, permanently.
   */
  it('does not claim the enclosing worktree when the project is itself a worktree', () => {
    const database = migratedDatabase();
    const tasks = new TaskRepository(database);
    const nestedProjectRoot = '/outer/.kangentic/worktrees/some-branch-a1b2c3d4';
    const nestedWorktreesRoot = `${nestedProjectRoot}/.kangentic/worktrees`;

    const unisolated = createTask(tasks, database, 'Ran in the project root');
    seedSession(database, unisolated.id, nestedProjectRoot, '2026-07-30T00:00:00.000Z');
    expect(tasks.recoverLegacyWorktreeFolder(unisolated.id, nestedWorktreesRoot)).toBeNull();

    const isolated = createTask(tasks, database, 'Had its own worktree');
    seedSession(database, isolated.id, `${nestedWorktreesRoot}/460`, '2026-07-30T00:00:00.000Z');
    expect(tasks.recoverLegacyWorktreeFolder(isolated.id, nestedWorktreesRoot)).toBe('460');
  });
});

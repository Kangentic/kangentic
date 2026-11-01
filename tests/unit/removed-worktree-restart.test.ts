/**
 * A Done task's worktree is removed in the end, even when the app quits in the
 * middle of it.
 *
 * Two quits matter. One lands after the Done move set the worktree aside and
 * before the deleter finished: the copy waits in `.kangentic/removed-worktrees/`
 * and nothing in the database names it. The other lands before the move ran
 * at all: the Done row still names its worktree. Each project open then runs
 * `cleanupStaleResourcesAsync`, whose Done retry moves the second kind aside
 * and whose sweep deletes both.
 *
 * Real git, a real temp repo, and a file-backed database run through the real
 * migrations, closed and reopened between the "quit" and the "launch". The
 * deleter's in-memory state is reset there too, as a new process starts with
 * none.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';
import {
  removedWorktreesRootFor,
  _removedWorktreeDeletionStateForTests,
  _resetRemovedWorktreeDeletionForTests,
  _setRemovedWorktreeBatchHookForTests,
  _whenRemovedWorktreeDeletionIdleForTests,
} from '../../src/main/git/removed-worktrees';
import { cleanupStaleResourcesAsync } from '../../src/main/transition-engine/resource-cleanup';
import { deleteTaskWorktree } from '../../src/main/ipc/helpers/task-cleanup';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task } from '../../src/shared/types';

vi.setConfig({ testTimeout: 60_000 });

let workspace: string;
let projectPath: string;
let databasePath: string;
let database: Database.Database | null = null;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

beforeAll(() => {
  // The real path: git records one, and os.tmpdir() can be an alias of it (a
  // /var symlink on macOS, an 8.3 short name on Windows), which would make the
  // worktree-list checks below pass without checking anything.
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-removed-restart-')));
  projectPath = path.join(workspace, 'project');
  databasePath = path.join(workspace, 'project.db');
  fs.mkdirSync(projectPath);
  run(projectPath, ['init', '-b', 'main']);
  run(projectPath, ['config', 'user.email', 'dev@example.com']);
  run(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\nnode_modules/\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  run(projectPath, ['add', '-A']);
  run(projectPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  clearFetchCache();
});

afterEach(async () => {
  _setRemovedWorktreeBatchHookForTests(null);
  await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
  database?.close();
  database = null;
});

afterAll(async () => {
  _resetRemovedWorktreeDeletionForTests();
  clearFetchCache();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Open the project database, as a launch does. Migrations are idempotent on reopen. */
function openProjectDatabase(): { tasks: TaskRepository; swimlanes: SwimlaneRepository; db: Database.Database } {
  const db = openTestDatabase(databasePath);
  runProjectMigrations(db);
  database = db;
  return { tasks: new TaskRepository(db), swimlanes: new SwimlaneRepository(db), db };
}

/** Quit: the database closes, and the deleter's in-memory state goes with the process. */
function quit(): void {
  _resetRemovedWorktreeDeletionForTests();
  database?.close();
  database = null;
}

/** A launch's project open, the sweep that does the cleanup. */
async function openProject(): Promise<TaskRepository> {
  const { tasks, swimlanes, db } = openProjectDatabase();
  const sessionManager = {
    listSessions: () => [],
    remove: () => undefined,
    reapTaskProcesses: async () => [],
  };
  await cleanupStaleResourcesAsync(
    projectPath,
    tasks,
    new TaskMoveRepository(db),
    swimlanes,
    new SessionRepository(db),
    sessionManager as never,
    new AutomationRunRepository(db),
    () => undefined,
    { stoppingEnabled: () => false, onReport: () => undefined },
  );
  await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
  return tasks;
}

/** A task in Done, archived as a Done move leaves it, with a worktree holding a real node_modules. */
async function createDoneTaskWithWorktree(tasks: TaskRepository, swimlanes: SwimlaneRepository, title: string): Promise<Task> {
  const doneLane = swimlanes.list().find((lane) => lane.role === 'done');
  if (!doneLane) throw new Error('Seeded Done swimlane not found');
  const created = tasks.create({ title, description: '', swimlane_id: doneLane.id });
  const manager = new WorktreeManager(projectPath);
  const worktree = await manager.withLock(() => manager.createWorktree(created, 'main'));
  tasks.recordWorktree(created.id, worktree.worktreePath, worktree.branchName, worktree.worktreeFolder);
  tasks.archive(created.id);
  const packageDirectory = path.join(worktree.worktreePath, 'node_modules', 'pkg-a');
  fs.mkdirSync(packageDirectory, { recursive: true });
  for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) {
    fs.writeFileSync(path.join(packageDirectory, `file-${fileIndex}.js`), '\n');
  }
  const row = tasks.getById(created.id);
  if (!row) throw new Error('task row missing');
  return row;
}

function removedCopies(): string[] {
  try {
    return fs.readdirSync(removedWorktreesRootFor(projectPath));
  } catch {
    return [];
  }
}

function gitWorktreePaths(): string[] {
  return run(projectPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

describe('a Done worktree is removed in the end, across a restart', () => {
  it('a quit after the move aside: the next project open deletes the copy', async () => {
    const { tasks, swimlanes } = openProjectDatabase();
    const doneTask = await createDoneTaskWithWorktree(tasks, swimlanes, 'Quit mid delete');
    const worktreePath = doneTask.worktree_path as string;

    // Hold the deleter at its first batch, then quit while it is held.
    let markHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { markHeld = resolve; });
    let releaseHold: () => void = () => undefined;
    const holdReleased = new Promise<void>((resolve) => { releaseHold = resolve; });
    _setRemovedWorktreeBatchHookForTests(async () => {
      markHeld();
      await holdReleased;
    });
    expect(await deleteTaskWorktree({} as IpcContext, doneTask, tasks, projectPath)).toBe(true);
    await held;
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(tasks.getById(doneTask.id)?.worktree_path).toBeNull();
    expect(removedCopies()).toHaveLength(1);

    quit();
    // The old process's deleter never runs again; let its held batch see the stop.
    releaseHold();
    expect(removedCopies()).toHaveLength(1);
    expect(_removedWorktreeDeletionStateForTests(projectPath).phase).toBe('idle');

    await openProject();
    expect(removedCopies()).toEqual([]);
    expect(gitWorktreePaths()).not.toContain(path.resolve(worktreePath));
  });

  it('a quit before the move ran: the next project open moves the worktree aside, deletes it and clears the row', async () => {
    const { tasks, swimlanes } = openProjectDatabase();
    const doneTask = await createDoneTaskWithWorktree(tasks, swimlanes, 'Quit before cleanup');
    const worktreePath = doneTask.worktree_path as string;
    // The move committed and archived the task, then the app quit before the
    // Done branch reached its removal.
    quit();
    expect(fs.existsSync(path.join(worktreePath, 'node_modules', 'pkg-a'))).toBe(true);

    const reopenedTasks = await openProject();
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(reopenedTasks.getById(doneTask.id)?.worktree_path).toBeNull();
    // The branch, and so the work, stays for a move back out of Done.
    expect(reopenedTasks.getById(doneTask.id)?.branch_name).toBe(doneTask.branch_name);
    expect(run(projectPath, ['branch', '--list', doneTask.branch_name ?? '']).trim()).not.toBe('');
    expect(removedCopies()).toEqual([]);
    expect(gitWorktreePaths()).not.toContain(path.resolve(worktreePath));
  });
});

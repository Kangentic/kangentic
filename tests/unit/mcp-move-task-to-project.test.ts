/**
 * Unit tests for handleMoveTaskToProject (the kangentic_move_task_to_project
 * MCP tool's core logic), which relocates a To Do task from one project's
 * per-project SQLite DB to another's.
 *
 * Uses two real in-memory better-sqlite3 DBs (':memory:') run through the
 * actual project migrations, so INSERT/UPDATE column alignment and the
 * to-do-role guard are exercised against real SQL, not mocks. Mirrors the
 * ABI-probe pattern from swimlane-repository.test.ts so the suite skips
 * cleanly if better-sqlite3 cannot load under the test runner's Node ABI.
 *
 * Covers:
 *   - happy path: source task removed, target gets a new To Do task with
 *     preserved title/description/labels/priority/created_at, and a seeded
 *     attachment file is copied to the target project's attachments dir
 *   - optional `column` lands in a named target column
 *   - unknown target column -> error, nothing mutated
 *   - source task not in a `role: 'todo'` column -> error, nothing mutated
 *   - task not found -> error
 *   - task with an active session -> error, nothing mutated
 *   - task with a live worktree on disk -> error; a stale worktree_path
 *     (directory already deleted) does NOT block the move
 *   - an attachment that fails to copy -> the newly-created target task is
 *     rolled back and the source task/attachment are left intact
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors swimlane-repository.test.ts.
// ---------------------------------------------------------------------------

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { AttachmentRepository } from '../../src/main/db/repositories/attachment-repository';
import { handleMoveTaskToProject } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { Task } from '../../src/shared/types';

function makeContext(db: InstanceType<typeof DatabaseType>, projectPath: string): CommandContext & {
  onTaskCreated: ReturnType<typeof vi.fn>;
  onTaskDeleted: ReturnType<typeof vi.fn>;
} {
  return {
    getProjectDb: () => db as unknown as ReturnType<CommandContext['getProjectDb']>,
    getProjectPath: () => projectPath,
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(async () => {}),
    onSwimlaneUpdated: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

describe.runIf(CAN_RUN)('handleMoveTaskToProject', () => {
  let sourceDb: InstanceType<typeof DatabaseType>;
  let targetDb: InstanceType<typeof DatabaseType>;
  let sourcePath: string;
  let targetPath: string;
  let source: ReturnType<typeof makeContext>;
  let target: ReturnType<typeof makeContext>;
  let sourceTodo: { id: string; name: string };
  let targetTodo: { id: string; name: string };

  beforeEach(() => {
    if (!Database) return;
    sourceDb = new Database(':memory:');
    targetDb = new Database(':memory:');
    runProjectMigrations(sourceDb);
    runProjectMigrations(targetDb);

    sourcePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-move-src-'));
    targetPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-move-dst-'));

    // runProjectMigrations seeds the default swimlane set (including a To Do
    // column with role 'todo') when the swimlanes table is empty - use those
    // rather than creating a second 'todo'-role lane, which would make
    // resolveColumn's role lookup ambiguous.
    const findTodo = (db: InstanceType<typeof DatabaseType>) => {
      const todo = new SwimlaneRepository(db).list().find((lane) => lane.role === 'todo');
      if (!todo) throw new Error('Seeded To Do swimlane not found');
      return todo;
    };
    sourceTodo = findTodo(sourceDb);
    targetTodo = findTodo(targetDb);

    source = makeContext(sourceDb, sourcePath);
    target = makeContext(targetDb, targetPath);
  });

  afterEach(() => {
    sourceDb?.close();
    targetDb?.close();
    fs.rmSync(sourcePath, { recursive: true, force: true });
    fs.rmSync(targetPath, { recursive: true, force: true });
  });

  it('moves a To Do task to the target project, preserving fields and copying attachments', () => {
    const sourceTaskRepo = new TaskRepository(sourceDb);
    const created = sourceTaskRepo.create({
      title: 'Retrack core submodule',
      description: 'Point the core submodule at main.',
      swimlane_id: sourceTodo.id,
      labels: ['infra', 'urgent'],
      priority: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const sourceAttachmentRepo = new AttachmentRepository(sourceDb);
    sourceAttachmentRepo.add(sourcePath, created.id, 'handoff.txt', Buffer.from('hello').toString('base64'), 'text/plain');

    const response = handleMoveTaskToProject({ taskId: created.id }, source, target);

    expect(response.success).toBe(true);

    // Source task is gone.
    expect(sourceTaskRepo.getById(created.id)).toBeUndefined();
    expect(source.onTaskDeleted).toHaveBeenCalledTimes(1);

    // Target has a new task with preserved fields.
    const targetTaskRepo = new TaskRepository(targetDb);
    const targetTasks = targetTaskRepo.list(targetTodo.id);
    expect(targetTasks).toHaveLength(1);
    const newTask: Task = targetTasks[0];
    expect(newTask.id).not.toBe(created.id);
    expect(newTask.title).toBe('Retrack core submodule');
    expect(newTask.description).toBe('Point the core submodule at main.');
    expect(newTask.labels).toEqual(['infra', 'urgent']);
    expect(newTask.priority).toBe(3);
    expect(newTask.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(target.onTaskCreated).toHaveBeenCalledTimes(1);

    // Attachment file was copied under the target project path.
    const targetAttachmentRepo = new AttachmentRepository(targetDb);
    const copiedAttachments = targetAttachmentRepo.list(newTask.id);
    expect(copiedAttachments).toHaveLength(1);
    expect(copiedAttachments[0].filename).toBe('handoff.txt');
    expect(fs.readFileSync(copiedAttachments[0].file_path, 'utf8')).toBe('hello');
  });

  it('lands in an explicit target column when `column` is provided', () => {
    const targetSwimlanes = new SwimlaneRepository(targetDb);
    const review = targetSwimlanes.create({ name: 'Review', auto_spawn: false });

    const sourceTaskRepo = new TaskRepository(sourceDb);
    const created = sourceTaskRepo.create({ title: 'Task to review', description: '', swimlane_id: sourceTodo.id });

    const response = handleMoveTaskToProject({ taskId: created.id, column: 'review' }, source, target);

    expect(response.success).toBe(true);
    const targetTaskRepo = new TaskRepository(targetDb);
    const reviewTasks = targetTaskRepo.list(review.id);
    expect(reviewTasks).toHaveLength(1);
    expect(reviewTasks[0].title).toBe('Task to review');
  });

  it('errors on an unknown target column and mutates nothing', () => {
    const sourceTaskRepo = new TaskRepository(sourceDb);
    const created = sourceTaskRepo.create({ title: 'Task', description: '', swimlane_id: sourceTodo.id });

    const response = handleMoveTaskToProject({ taskId: created.id, column: 'Nonexistent' }, source, target);

    expect(response.success).toBe(false);
    expect(sourceTaskRepo.getById(created.id)).toBeDefined();
    expect(new TaskRepository(targetDb).list()).toHaveLength(0);
    expect(source.onTaskDeleted).not.toHaveBeenCalled();
    expect(target.onTaskCreated).not.toHaveBeenCalled();
  });

  it('rejects a task that is not in a To Do column', () => {
    const sourceSwimlanes = new SwimlaneRepository(sourceDb);
    const executing = sourceSwimlanes.create({ name: 'Executing', auto_spawn: true });
    const sourceTaskRepo = new TaskRepository(sourceDb);
    const created = sourceTaskRepo.create({ title: 'In progress task', description: '', swimlane_id: executing.id });

    const response = handleMoveTaskToProject({ taskId: created.id }, source, target);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('To Do');
    }
    expect(sourceTaskRepo.getById(created.id)).toBeDefined();
    expect(new TaskRepository(targetDb).list()).toHaveLength(0);
  });

  it('errors when the task is not found', () => {
    const response = handleMoveTaskToProject({ taskId: 'does-not-exist' }, source, target);

    expect(response.success).toBe(false);
    expect(target.onTaskCreated).not.toHaveBeenCalled();
  });

  it('rejects a task with an active session and mutates nothing', () => {
    const sourceTaskRepo = new TaskRepository(sourceDb);
    const created = sourceTaskRepo.create({ title: 'Task with a session', description: '', swimlane_id: sourceTodo.id });
    sourceTaskRepo.update({ id: created.id, session_id: 'some-session-id' });

    const response = handleMoveTaskToProject({ taskId: created.id }, source, target);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('active session');
    }
    expect(sourceTaskRepo.getById(created.id)).toBeDefined();
    expect(new TaskRepository(targetDb).list()).toHaveLength(0);
    expect(source.onTaskDeleted).not.toHaveBeenCalled();
    expect(target.onTaskCreated).not.toHaveBeenCalled();
  });

  it('rejects a task whose worktree still exists on disk, but allows a stale worktree_path', () => {
    const sourceTaskRepo = new TaskRepository(sourceDb);

    // (a) A worktree_path pointing at a directory that is actually still on
    // disk must block the move.
    const liveTask = sourceTaskRepo.create({ title: 'Task with a live worktree', description: '', swimlane_id: sourceTodo.id });
    const liveWorktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-move-wt-'));
    sourceTaskRepo.update({ id: liveTask.id, worktree_path: liveWorktreePath });

    try {
      const liveResponse = handleMoveTaskToProject({ taskId: liveTask.id }, source, target);

      expect(liveResponse.success).toBe(false);
      if (!liveResponse.success) {
        expect(liveResponse.error).toContain('worktree');
      }
      expect(sourceTaskRepo.getById(liveTask.id)).toBeDefined();
      expect(new TaskRepository(targetDb).list()).toHaveLength(0);
      expect(source.onTaskDeleted).not.toHaveBeenCalled();
      expect(target.onTaskCreated).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(liveWorktreePath, { recursive: true, force: true });
    }

    // (b) A stale worktree_path (directory no longer on disk) must NOT block
    // the move - the guard is `worktree_path && fs.existsSync(worktree_path)`.
    const staleTask = sourceTaskRepo.create({ title: 'Task with a stale worktree path', description: '', swimlane_id: sourceTodo.id });
    const staleWorktreePath = path.join(os.tmpdir(), `kangentic-move-wt-gone-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sourceTaskRepo.update({ id: staleTask.id, worktree_path: staleWorktreePath });

    const staleResponse = handleMoveTaskToProject({ taskId: staleTask.id }, source, target);

    expect(staleResponse.success).toBe(true);
    expect(sourceTaskRepo.getById(staleTask.id)).toBeUndefined();
    expect(new TaskRepository(targetDb).list()).toHaveLength(1);
  });

  it('rolls back the target task and leaves the source intact when an attachment fails to copy', () => {
    const sourceTaskRepo = new TaskRepository(sourceDb);
    const created = sourceTaskRepo.create({ title: 'Task with a vanished attachment', description: '', swimlane_id: sourceTodo.id });

    const sourceAttachmentRepo = new AttachmentRepository(sourceDb);
    sourceAttachmentRepo.add(sourcePath, created.id, 'gone.txt', Buffer.from('data').toString('base64'), 'text/plain');
    const [attachmentRow] = sourceAttachmentRepo.list(created.id);
    // Delete the underlying file so the copy loop's fs.readFileSync throws.
    fs.rmSync(attachmentRow.file_path, { force: true });

    const response = handleMoveTaskToProject({ taskId: created.id }, source, target);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('gone.txt');
    }

    // Source task and its attachment row survive the aborted move.
    expect(sourceTaskRepo.getById(created.id)).toBeDefined();
    expect(sourceAttachmentRepo.list(created.id)).toHaveLength(1);

    // The just-created target task must be rolled back, not left dangling.
    expect(new TaskRepository(targetDb).list()).toHaveLength(0);

    expect(source.onTaskDeleted).not.toHaveBeenCalled();
    expect(target.onTaskCreated).not.toHaveBeenCalled();
  });
});

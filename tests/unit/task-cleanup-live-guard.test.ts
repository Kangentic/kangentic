/**
 * Unit tests for cleanupTaskSession's live-session guard.
 *
 * cleanupTaskSession (TASK_MOVE -> Backlog, TASK_DELETE) deletes every session
 * directory it finds by task_id. Without a guard it can wipe the on-disk
 * directory of a session a concurrent spawn just brought to life for the same
 * task - severing its events.jsonl feed mid-write, which makes the card falsely
 * read idle. These tests assert the guard spares any session still live in the
 * manager while still removing the genuinely-dead ones.
 *
 * Uses real temp directories (real fs.promises.rm) so the assertion is about
 * what actually survives on disk, not about mock call shapes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared mock state, hoisted so the vi.mock factories below can reference it.
const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string }>,
  deleteByTaskId: vi.fn(),
}));

// Import-time safety for unrelated deps pulled in by task-cleanup.ts.
vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class {} }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));

// SessionRepository lists the task's session records, and none once its spied
// deleteByTaskId has run, so ids read after the delete remove nothing here.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    listIdsForTask = () => (h.deleteByTaskId.mock.calls.length > 0 ? [] : h.rows.map((row) => row.id));
    deleteByTaskId = h.deleteByTaskId;
  },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));

import { cleanupTaskSession } from '../../src/main/ipc/helpers/task-cleanup';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';

interface LiveSession {
  id: string;
  status: 'running' | 'queued' | 'suspended' | 'exited';
}

function makeContext(projectPath: string, liveSessions: LiveSession[]): IpcContext {
  const sessionManager = {
    kill: vi.fn(),
    awaitExit: vi.fn(() => Promise.resolve()),
    remove: vi.fn(),
    removeByTaskId: vi.fn(),
    listSessions: vi.fn(() => liveSessions),
  };
  return {
    sessionManager,
    currentProjectId: 'proj',
    currentProjectPath: projectPath,
  } as unknown as IpcContext;
}

const TASK = { id: 'task-1', session_id: null, worktree_path: null, branch_name: null };
const TASKS = { getById: vi.fn(() => null), update: vi.fn() } as unknown as TaskRepository;

describe('cleanupTaskSession - live-session guard', () => {
  let projectPath: string;
  let sessionsDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cleanup-guard-'));
    sessionsDir = path.join(projectPath, '.kangentic', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  function makeSessionDir(id: string): string {
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"ts":1,"type":"prompt"}\n');
    return dir;
  }

  it('removes a dead session dir but spares the dir of a session still running', async () => {
    const deadDir = makeSessionDir('dead-session');
    const liveDir = makeSessionDir('live-session');
    h.rows = [{ id: 'dead-session' }, { id: 'live-session' }];

    const context = makeContext(projectPath, [{ id: 'live-session', status: 'running' }]);
    await cleanupTaskSession(context, TASK, TASKS, 'proj', projectPath);

    expect(fs.existsSync(deadDir)).toBe(false); // genuinely orphaned -> removed
    expect(fs.existsSync(liveDir)).toBe(true);  // live session -> spared
    expect(h.deleteByTaskId).toHaveBeenCalledWith('task-1'); // DB cleanup still runs
  });

  it('spares a session that is queued (not yet running)', async () => {
    const queuedDir = makeSessionDir('queued-session');
    h.rows = [{ id: 'queued-session' }];

    const context = makeContext(projectPath, [{ id: 'queued-session', status: 'queued' }]);
    await cleanupTaskSession(context, TASK, TASKS, 'proj', projectPath);

    expect(fs.existsSync(queuedDir)).toBe(true);
  });

  it('removes every session dir when none are live', async () => {
    const dirA = makeSessionDir('session-a');
    const dirB = makeSessionDir('session-b');
    h.rows = [{ id: 'session-a' }, { id: 'session-b' }];

    const context = makeContext(projectPath, []);
    await cleanupTaskSession(context, TASK, TASKS, 'proj', projectPath);

    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(false);
  });

  it('does not spare a session reported as suspended/exited', async () => {
    const suspendedDir = makeSessionDir('suspended-session');
    h.rows = [{ id: 'suspended-session' }];

    const context = makeContext(projectPath, [{ id: 'suspended-session', status: 'suspended' }]);
    await cleanupTaskSession(context, TASK, TASKS, 'proj', projectPath);

    // A suspended session has no live PTY writing to the dir, so the guard does
    // not apply and the dir is reclaimed normally.
    expect(fs.existsSync(suspendedDir)).toBe(false);
  });
});

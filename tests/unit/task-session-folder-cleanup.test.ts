/**
 * Every path that deletes a task's `sessions` rows also deletes the folders they
 * name (`.kangentic/sessions/<id>`). Once the rows are gone nothing else names
 * those folders, and the orphan sweep refuses to clear them when they are most of
 * the folder, at every project open (Sentry DESKTOP-50). Three paths left them:
 * the MCP delete, a move to another project, and the cold-open To Do pass. Only
 * the task's live session was in the registry, so a paused session's folder and
 * every earlier session's stayed.
 *
 * Real SQLite, real folders, the real handlers and the real teardown, and real git
 * in the To Do pass. The database lookup by project id, the reap, the task windows
 * and the session manager are stand-ins.
 *
 * Tier: Unit. Nothing Electron-specific is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const databases = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => databases.get(projectId),
  getExistingProjectDb: (projectId: string) => databases.get(projectId) ?? null,
}));
const reapTaskLeftovers = vi.hoisted(() => vi.fn(async () => ({ tasksLeftRunningInWorktree: new Set<string>() })));
vi.mock('../../src/main/ipc/helpers', () => ({ autoSpawnForTask: vi.fn(async () => undefined), reapTaskLeftovers }));
vi.mock('../../src/main/ipc/helpers/task-windows', () => ({ closeTaskWindows: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/git-diff', () => ({ readTaskChanges: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-runtime-override', () => ({ applyTaskSettingsToLiveSession: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/strategy-propagation', () => ({
  propagateBoardProfileChange: vi.fn(),
  propagateStrategyToLiveSessions: vi.fn(),
  buildColumnStrategyChanges: vi.fn(() => []),
}));
vi.mock('../../src/main/ipc/helpers/automation-run-again', () => ({ runAutomationAgain: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({ resolveEffectiveBaseBranch: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({ deliverMessageAfterMove: vi.fn() }));
vi.mock('../../src/main/automations/turn-end/owner-turn', () => ({ turnStartedByOwner: vi.fn() }));
vi.mock('../../src/main/git/removed-worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/git/removed-worktrees')>()),
  scheduleRemovedWorktreeDeletion: vi.fn(),
}));

// Runs the real link clearing, after a hook a case sets to claim the path as a creation would.
const linkClearing = vi.hoisted(() => ({ before: null as null | ((worktreePath: string) => void) }));
vi.mock('../../src/main/git/worktree-links', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/git/worktree-links')>();
  return {
    ...original,
    clearWorktreeLinks: (worktreePath: string) => {
      linkClearing.before?.(worktreePath);
      return original.clearWorktreeLinks(worktreePath);
    },
  };
});

import { runProjectMigrations } from '../../src/main/db/migrations';
import { removeSessionFolders } from '../../src/main/ipc/helpers/session-folders';
import { candidateWorktreePathsFor } from '../../src/main/git/task-worktree-folder';
import { runWorktreeCreation } from '../../src/main/git/worktree-creation-registry';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { handleDeleteTask, handleMoveTaskToProject } from '../../src/main/agent/commands/task-commands';
import { buildCommandContextForProject } from '../../src/main/agent/mcp-project-context';
import { cleanupStaleResourcesAsync } from '../../src/main/transition-engine/resource-cleanup';
import type { CommandContext, CommandResponse } from '../../src/main/agent/commands/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task } from '../../src/shared/types';
import { makeSessionRecord } from './helpers/session-record-fixture';
import { openTestDatabase } from './helpers/test-database';
import { ownershipOf } from './helpers/verified-ownership';

interface Board {
  projectPath: string;
  database: Database.Database;
  tasks: TaskRepository;
  sessions: SessionRepository;
  todoLaneId: string;
}

let workspace: string;
let board: Board;
let target: Board;
let liveSessions: Array<{ id: string; taskId: string; status: string }>;
let exited: Promise<void>;

function openBoard(projectId: string): Board {
  const projectPath = path.join(workspace, projectId);
  fs.mkdirSync(path.join(projectPath, '.kangentic', 'sessions'), { recursive: true });
  const database = openTestDatabase();
  runProjectMigrations(database);
  databases.set(projectId, database);
  const todoLane = new SwimlaneRepository(database).list().find((lane) => lane.role === 'todo');
  if (!todoLane) throw new Error('the seeded board has no To Do column');
  return { projectPath, database, tasks: new TaskRepository(database), sessions: new SessionRepository(database), todoLaneId: todoLane.id };
}

function folderOf(sessionId: string): string {
  return path.join(board.projectPath, '.kangentic', 'sessions', sessionId);
}

/** A session row of the task and the folder it names. */
function addSession(task: Task, id: string, status: 'suspended' | 'exited' | 'running', startedAt: string): string {
  board.sessions.insert(makeSessionRecord({
    id,
    task_id: task.id,
    agent_session_id: `agent-${id}`,
    cwd: board.projectPath,
    status,
    exit_code: status === 'exited' ? 0 : null,
    started_at: startedAt,
    suspended_at: status === 'suspended' ? startedAt : null,
    exited_at: status === 'exited' ? startedAt : null,
    suspended_by: status === 'suspended' ? 'user' : null,
  }));
  fs.mkdirSync(folderOf(id));
  fs.writeFileSync(path.join(folderOf(id), 'events.jsonl'), '{}\n');
  return id;
}

/** A To Do task with a paused session and an older one that ended. */
function taskWithTwoSessions(): { task: Task; paused: string; older: string } {
  const task = board.tasks.create({ title: 'Leaves folders', description: '', swimlane_id: board.todoLaneId });
  const older = addSession(task, 'older-session', 'exited', '2026-11-20T10:00:00.000Z');
  const paused = addSession(task, 'paused-session', 'suspended', '2026-11-21T10:00:00.000Z');
  return { task, paused, older };
}

const sessionManager = {
  kill: vi.fn(),
  awaitExit: vi.fn(() => exited),
  remove: vi.fn(),
  removeByTaskId: vi.fn(() => Promise.resolve()),
  listSessions: vi.fn(() => liveSessions),
};

function contextOf(projectId: string): CommandContext {
  const project = { id: projectId, name: projectId, path: path.join(workspace, projectId) };
  const context = buildCommandContextForProject({
    projectRepo: { getById: () => project, list: () => [project] },
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    boardConfigManager: { writeBackForProject: vi.fn() },
    boardEvents: { emitBoardChanged: vi.fn() },
    configManager: { getEffectiveConfig: () => ({ git: { autoCleanup: false } }) },
    sessionManager,
  } as unknown as IpcContext, projectId);
  if (!context) throw new Error('no command context');
  return context;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-session-folders-'));
  board = openBoard('project-1');
  target = openBoard('project-2');
  liveSessions = [];
  exited = Promise.resolve();
  linkClearing.before = null;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  linkClearing.before = null;
  vi.restoreAllMocks();
  databases.clear();
  board.database.close();
  target.database.close();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function expectGone(...sessionIds: string[]): Promise<void> {
  await vi.waitFor(() => {
    for (const sessionId of sessionIds) expect(fs.existsSync(folderOf(sessionId))).toBe(false);
  });
}

/** The two MCP paths share their teardown, so each case runs through both. */
const MCP_PATHS: Array<[string, (task: Task) => CommandResponse | Promise<CommandResponse>]> = [
  ['kangentic_delete_task', (task) => handleDeleteTask({ taskId: task.id }, contextOf('project-1')) as CommandResponse],
  ['kangentic_move_task_to_project', (task) => handleMoveTaskToProject({ taskId: task.id }, contextOf('project-1'), contextOf('project-2'))],
];

describe.each(MCP_PATHS)('%s', (_tool, run) => {
  it('removes the folders of the task\'s paused session and its older one', async () => {
    const { task, paused, older } = taskWithTwoSessions();

    expect((await run(task)).success).toBe(true);

    expect(board.sessions.listAllSessionIds()).toEqual([]);
    await expectGone(paused, older);
  });

  it('spares the folder of a session that is live, as a spawn that raced the delete leaves one', async () => {
    const { task, paused, older } = taskWithTwoSessions();
    const live = addSession(task, 'live-session', 'running', '2026-11-22T10:00:00.000Z');
    liveSessions = [{ id: live, taskId: task.id, status: 'running' }];

    await run(task);

    await expectGone(paused, older);
    expect(fs.existsSync(folderOf(live))).toBe(true);
  });

  it('leaves another task\'s session folder alone', async () => {
    const { task, paused, older } = taskWithTwoSessions();
    const other = board.tasks.create({ title: 'Other', description: '', swimlane_id: board.todoLaneId });
    const others = addSession(other, 'others-session', 'suspended', '2026-11-22T10:00:00.000Z');

    await run(task);

    await expectGone(paused, older);
    expect(fs.existsSync(folderOf(others))).toBe(true);
  });

  it('waits for the reap, which a process still writing there would lose its folder to', async () => {
    const { task, paused, older } = taskWithTwoSessions();
    let finishReap: () => void = () => undefined;
    reapTaskLeftovers.mockImplementationOnce(() => new Promise((resolve) => {
      finishReap = () => resolve({ tasksLeftRunningInWorktree: new Set<string>() });
    }));

    expect((await run(task)).success).toBe(true);
    await vi.waitFor(() => expect(reapTaskLeftovers).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fs.existsSync(folderOf(paused))).toBe(true);
    expect(fs.existsSync(folderOf(older))).toBe(true);

    finishReap();
    await expectGone(paused, older);
  });
});

describe('kangentic_delete_task on a task whose agent is still exiting', () => {
  it('keeps every folder until the session has exited', async () => {
    const { task, paused, older } = taskWithTwoSessions();
    board.tasks.update({ id: task.id, session_id: paused });
    let sessionExits: () => void = () => undefined;
    exited = new Promise((resolve) => { sessionExits = resolve; });

    handleDeleteTask({ taskId: task.id }, contextOf('project-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fs.existsSync(folderOf(paused))).toBe(true);
    expect(fs.existsSync(folderOf(older))).toBe(true);

    sessionExits();
    await expectGone(paused, older);
  });
});

describe('removeSessionFolders', () => {
  it('logs a folder that will not go, swallows it, and still removes the others', async () => {
    const { paused, older } = taskWithTwoSessions();
    const realRemove = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === folderOf(paused)) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      return realRemove(target, options);
    });

    await expect(removeSessionFolders({
      projectPath: board.projectPath,
      sessionIds: [paused, older],
      sessionManager,
    })).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[CLEANUP] Failed to remove session dir'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('resource busy or locked'));
    expect(fs.existsSync(folderOf(paused))).toBe(true);
    expect(fs.existsSync(folderOf(older))).toBe(false);
  });
});

describe('the cold-open To Do pass', () => {
  async function runPass(): Promise<void> {
    await cleanupStaleResourcesAsync(
      ownershipOf(board.projectPath),
      board.tasks,
      new TaskMoveRepository(board.database),
      new SwimlaneRepository(board.database),
      board.sessions,
      sessionManager as never,
      { markStaleRunsInterrupted: () => 0, workflowIdsKeepingRuns: () => [], pruneTo: () => undefined } as never,
      () => undefined,
      { stoppingEnabled: () => false, onReport: () => undefined },
    );
  }

  /** Fresh folders, inside the sweep's grace, so only the To Do pass can remove one here. */
  function staleTodoTask(): ReturnType<typeof taskWithTwoSessions> {
    const stale = taskWithTwoSessions();
    board.tasks.update({ id: stale.task.id, session_id: stale.paused });
    return stale;
  }

  it('removes the folders of a task it resets', async () => {
    const { paused, older } = staleTodoTask();

    await runPass();

    expect(board.sessions.listAllSessionIds()).toEqual([]);
    expect(fs.existsSync(folderOf(paused))).toBe(false);
    expect(fs.existsSync(folderOf(older))).toBe(false);
  });

  it('removes them for a task restored from Done too, whose session is all it resets', async () => {
    const { task, paused, older } = staleTodoTask();
    board.tasks.update({ id: task.id, branch_name: 'kept-branch' });
    // Later than the row the create wrote, so it is the visit the pass reads.
    board.database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, at, origin) VALUES (?, ?, NULL, ?, ?, ?)')
      .run('move-1', task.id, board.todoLaneId, new Date(Date.now() + 60_000).toISOString(), 'unarchive');

    await runPass();

    // The branch is what says the restore's own branch of the pass ran.
    expect(board.tasks.getById(task.id)).toMatchObject({ session_id: null, branch_name: 'kept-branch' });
    expect(fs.existsSync(folderOf(paused))).toBe(false);
    expect(fs.existsSync(folderOf(older))).toBe(false);
  });

  // An agent still in its exit writes there, so a folder removed ahead of it can come back.
  it.each([['a task it resets', 'user'], ['a task restored from Done', 'unarchive']])('keeps the folders until the session it ended has exited, for %s', async (_label, origin) => {
    const { task, paused, older } = staleTodoTask();
    board.database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, at, origin) VALUES (?, ?, NULL, ?, ?, ?)')
      .run('move-1', task.id, board.todoLaneId, new Date(Date.now() + 60_000).toISOString(), origin);
    let sessionExits: () => void = () => undefined;
    exited = new Promise((resolve) => { sessionExits = resolve; });

    const pass = runPass();
    await vi.waitFor(() => expect(sessionManager.awaitExit).toHaveBeenCalledWith(paused));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(folderOf(paused))).toBe(true);
    expect(fs.existsSync(folderOf(older))).toBe(true);
    // The wait is made while the row exists: after the remove it would resolve at once.
    expect(sessionManager.kill.mock.invocationCallOrder[0]).toBeLessThan(sessionManager.awaitExit.mock.invocationCallOrder[0]);
    expect(sessionManager.awaitExit.mock.invocationCallOrder[0]).toBeLessThan(sessionManager.remove.mock.invocationCallOrder[0]);

    sessionExits();
    await pass;
    expect(fs.existsSync(folderOf(paused))).toBe(false);
    expect(fs.existsSync(folderOf(older))).toBe(false);
  });

  it('spares the folder of a session that is live', async () => {
    const { task, paused, older } = staleTodoTask();
    const live = addSession(task, 'live-session', 'running', '2026-11-22T10:00:00.000Z');
    liveSessions = [{ id: live, taskId: task.id, status: 'running' }];

    await runPass();

    expect(fs.existsSync(folderOf(paused))).toBe(false);
    expect(fs.existsSync(folderOf(older))).toBe(false);
    expect(fs.existsSync(folderOf(live))).toBe(true);
  });

  /** A leftover checkout the task's candidate paths name, with a file in it. */
  function leftoverWorktreeOf(task: Task): string {
    const current = board.tasks.getById(task.id);
    if (!current) throw new Error('the task is gone');
    const worktreePath = candidateWorktreePathsFor(current, board.projectPath)[0];
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'work.txt'), 'x');
    return worktreePath;
  }

  /** Starts the pass and returns once it waits for the session's exit. */
  async function passWaitingForExit(): Promise<{ pass: Promise<void>; sessionExits: () => void }> {
    let sessionExits: () => void = () => undefined;
    exited = new Promise((resolve) => { sessionExits = resolve; });
    const pass = runPass();
    await vi.waitFor(() => expect(sessionManager.awaitExit).toHaveBeenCalled());
    return { pass, sessionExits };
  }

  it('keeps the worktree of a task it resets until the session it ended has exited', async () => {
    const { task } = staleTodoTask();
    const worktreePath = leftoverWorktreeOf(task);

    const { pass, sessionExits } = await passWaitingForExit();
    // A short real wait: a removal that does not wait for the exit lands in it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(worktreePath)).toBe(true);

    sessionExits();
    await pass;
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it('leaves the task whole when a creation starts setting up its worktree during the exit wait', async () => {
    const { task, paused, older } = staleTodoTask();
    const worktreePath = leftoverWorktreeOf(task);

    const { pass, sessionExits } = await passWaitingForExit();
    let finishCreation: () => void = () => undefined;
    const creation = runWorktreeCreation(worktreePath, undefined, () => new Promise<void>((resolve) => { finishCreation = resolve; }));
    sessionExits();
    try {
      await pass;

      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(board.sessions.listAllSessionIds().sort()).toEqual([older, paused].sort());
      expect(board.tasks.getById(task.id)?.session_id).toBe(paused);
      expect(fs.existsSync(folderOf(paused))).toBe(true);
      expect(fs.existsSync(folderOf(older))).toBe(true);
    } finally {
      finishCreation();
      await creation;
    }
  });

  it('removes the folders of a task it skipped after the rows went, when a creation claims its worktree late', async () => {
    const { task, paused, older } = staleTodoTask();
    const worktreePath = leftoverWorktreeOf(task);
    let creation: Promise<void> = Promise.resolve();
    let finishCreation: () => void = () => undefined;
    linkClearing.before = (clearedPath) => {
      creation = runWorktreeCreation(clearedPath, undefined, () => new Promise<void>((resolve) => { finishCreation = resolve; }));
    };

    try {
      await runPass();

      // The pass stopped at the worktree, so it left the checkout, and the rows had gone by then.
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(board.sessions.listAllSessionIds()).toEqual([]);
      expect(fs.existsSync(folderOf(paused))).toBe(false);
      expect(fs.existsSync(folderOf(older))).toBe(false);
    } finally {
      finishCreation();
      await creation;
    }
  });

  it('removes the folders and still throws when the cleanup fails after the rows went', async () => {
    const { task, paused, older } = staleTodoTask();
    const realUpdate = board.tasks.update.bind(board.tasks);
    vi.spyOn(board.tasks, 'update').mockImplementation((input) => {
      // Only the pass's own clearing of the row fails.
      if (input.id === task.id && input.session_id === null) throw new Error('disk full');
      return realUpdate(input);
    });

    await expect(runPass()).rejects.toThrow('disk full');

    expect(board.sessions.listAllSessionIds()).toEqual([]);
    expect(fs.existsSync(folderOf(paused))).toBe(false);
    expect(fs.existsSync(folderOf(older))).toBe(false);
  });
});

// The convention across files: nothing else makes a path read the ids first.
describe('every path that deletes a task\'s session rows reads their ids first', () => {
  const LOOKBACK_LINES = 12;
  const MAIN_ROOT = path.resolve(__dirname, '../../src/main');

  /** Lines (1-based) of a `<session receiver>.deleteByTaskId(` with no `<same receiver>.listIdsForTask(` just above it. */
  function unreadDeletes(source: string): { sites: number; unread: number[] } {
    const lines = source.split('\n');
    let sites = 0;
    const unread: number[] = [];
    lines.forEach((line, index) => {
      const match = /\b([A-Za-z_]\w*)\.deleteByTaskId\(/.exec(line);
      if (!match || !/session/i.test(match[1])) return;
      sites++;
      const above = lines.slice(Math.max(0, index - LOOKBACK_LINES), index).join('\n');
      if (!above.includes(`${match[1]}.listIdsForTask(`)) unread.push(index + 1);
    });
    return { sites, unread };
  }

  it('finds the sites and none reads too late', () => {
    let sites = 0;
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(MAIN_ROOT, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.ts')) continue;
      const found = unreadDeletes(fs.readFileSync(path.join(MAIN_ROOT, entry), 'utf8'));
      sites += found.sites;
      for (const line of found.unread) offenders.push(`src/main/${entry.replace(/\\/g, '/')}:${line}`);
    }

    expect(sites).toBeGreaterThanOrEqual(5);
    expect(
      offenders,
      `Read the task's session ids with listIdsForTask first and hand them to removeSessionFolders, or the folders of the deleted rows stay behind: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('flags a delete with no read of the same receiver above it', () => {
    const noRead = ['function remove() {', '  sessionRepo.deleteByTaskId(task.id);', '}'].join('\n');
    expect(unreadDeletes(noRead)).toEqual({ sites: 1, unread: [2] });

    const otherReceiver = ['const ids = otherSessionRepo.listIdsForTask(task.id);', 'sessionRepo.deleteByTaskId(task.id);'].join('\n');
    expect(unreadDeletes(otherReceiver).unread).toEqual([2]);

    const tooFarAbove = ['const ids = sessionRepo.listIdsForTask(task.id);', ...Array.from({ length: 12 }, () => '//'), 'sessionRepo.deleteByTaskId(task.id);'].join('\n');
    expect(unreadDeletes(tooFarAbove).unread).toEqual([14]);
  });

  it('passes a delete that reads first, and ignores a receiver that is not a session repo', () => {
    const read = ['const ids = this.sessionRepo.listIdsForTask(task.id);', 'this.sessionRepo.deleteByTaskId(task.id);'].join('\n');
    expect(unreadDeletes(read)).toEqual({ sites: 1, unread: [] });
    expect(unreadDeletes('attachments.deleteByTaskId(id);')).toEqual({ sites: 0, unread: [] });
  });
});

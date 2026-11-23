/**
 * Sentry DESKTOP-3P, end to end: a terminal transition whose leftover reap kept a
 * process working in the task's worktree, followed by a removal that fails on
 * the folder that process holds, sends no `worktree_removal` report and counts
 * it. The same failure with nothing kept there still reports, with its caller,
 * the part of the folder and the syscall.
 *
 * Real code from the reap to the report: `cleanupTaskResources`,
 * `reapTaskLeftovers` (only the host's reply is a stand-in) and `WorktreeManager`
 * (git is a spawn that fails `worktree remove`, and the manual delete fails the
 * way a held folder fails on Windows).
 *
 * What a user loses if this breaks: every kept dev server at a To Do reset or a
 * delete files a Sentry issue for an outcome the leftover-processes toast already
 * explained, and the real removal failures drown under them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LeftoverProcessEntry } from '../../src/main/pty/process-tag/tagged-reap';

const hoisted = vi.hoisted(() => ({
  reportHandledError: vi.fn(),
  trackEvent: vi.fn(),
  removeWithRetry: vi.fn(async (_target: string, _options?: unknown): Promise<void> => {}),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: vi.fn(() => '1.2.3') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  net: {},
}));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError: hoisted.reportHandledError }));
vi.mock('../../src/main/analytics/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/analytics')>()),
  trackEvent: hoisted.trackEvent,
}));

// git: every command succeeds but `worktree remove`, as git does on a held folder.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockSpawn = vi.fn((_command: string, commandArguments: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    const isRemove = commandArguments[0] === 'worktree' && commandArguments[1] === 'remove';
    queueMicrotask(() => {
      if (isRemove) child.stderr.emit('data', Buffer.from('fatal: unable to remove worktree', 'utf8'));
      child.emit('close', isRemove ? 1 : 0, null);
    });
    return child;
  });
  return { ...actual, default: { ...actual, spawn: mockSpawn }, spawn: mockSpawn };
});
vi.mock('../../src/main/git/git-client', () => ({ gitAt: vi.fn(() => ({ raw: vi.fn(async () => '') })) }));
vi.mock('../../src/main/git/git-checks', () => ({ isGitRepo: vi.fn(() => true), isInsideWorktree: vi.fn(() => false) }));
vi.mock('../../src/main/git/node-modules-link', () => ({ linkNodeModules: vi.fn(), removeNodeModulesPath: vi.fn() }));
vi.mock('../../src/main/git/rm-with-retry', () => ({
  removeWithRetry: (target: string, options?: unknown) => hoisted.removeWithRetry(target, options),
  isRemovalTimeoutError: (error: unknown) => error instanceof Error && error.name === 'WorktreeRemovalTimeoutError',
}));
vi.mock('../../src/main/git/zombie-reaper', () => ({
  reapProcessesForWorktree: vi.fn(async () => []),
  describeWorktreeHolders: vi.fn(async () => []),
  describeHolder: (holder: { pid: number; image: string }) => `${holder.image} (pid ${holder.pid})`,
}));
vi.mock('../../src/main/git/worktree-head', () => ({ readWorktreeHead: async () => ({ branch: null, sha: null }) }));
vi.mock('../../src/main/browser/annotation-drafts', () => ({ discardAnnotationDraft: vi.fn(async () => undefined) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(), getOpenProjectDb: vi.fn(() => null), getExistingProjectDb: vi.fn(() => null) }));
// The cold open's background drain of `removed-worktrees/` is not under test.
vi.mock('../../src/main/git/removed-worktrees', () => ({ scheduleRemovedWorktreeDeletion: vi.fn() }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));

let projectPath: string;
let worktreePath: string;

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-verdict-'));
  worktreePath = path.join(projectPath, '.kangentic', 'worktrees', 'task-held');
  fs.mkdirSync(worktreePath, { recursive: true });
  hoisted.reportHandledError.mockClear();
  hoisted.trackEvent.mockClear();
  // A fresh module graph per test, so the removal reporter's once-per-run latch
  // starts empty and one test's report never hides the next one's.
  vi.resetModules();
  // The folder itself is held: Windows refuses its rmdir while a process works in it.
  hoisted.removeWithRetry.mockReset();
  hoisted.removeWithRetry.mockRejectedValue(
    Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${worktreePath}'`), { code: 'EBUSY', syscall: 'rmdir', path: worktreePath }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A reset of the task with a worktree, whose reap answers with `entries`. */
async function resetTaskWhoseReapLeft(entries: LeftoverProcessEntry[]): Promise<void> {
  const context = {
    currentProjectId: null,
    currentProjectPath: projectPath,
    sessionManager: {
      removeByTaskId: vi.fn(async () => undefined),
      listSessions: vi.fn(() => []),
      probeTaskProcesses: vi.fn(async () => []),
      reapTaskProcesses: vi.fn(async () => entries),
    },
    configManager: {
      load: vi.fn(() => ({ stopLeftoverProcesses: true })),
      getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })),
    },
    boardConfigManager: { getStopScriptForPath: vi.fn(() => null) },
    projectRepo: { list: vi.fn(() => []) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  };
  const task = { id: 'task-held', session_id: null, worktree_path: worktreePath, branch_name: null, title: 'Fix login' };
  const tasks = { getById: vi.fn(() => task), update: vi.fn(), setWorktreeSkipReason: vi.fn() };
  const { cleanupTaskResources } = await import('../../src/main/ipc/helpers/task-cleanup');
  await cleanupTaskResources(context as never, task, tasks as never, null, projectPath);
}

/** A dev server the reap left working in the worktree, with this outcome. */
function devServer(outcome: LeftoverProcessEntry['outcome']): LeftoverProcessEntry {
  return { taskId: 'task-held', pid: 4242, startKey: 'start-4242', label: 'node (vite)', outcome, reason: outcome === 'kept' ? 'shared' : null, because: null, place: 'worktree' };
}

/** The `worktree_removal` reports sent to Sentry. */
function worktreeRemovalReports(): unknown[][] {
  return hoisted.reportHandledError.mock.calls.filter((call) => (call[1] as Record<string, string> | undefined)?.source === 'worktree_removal');
}

describe('a reset whose reap kept a process in the worktree', () => {
  it('counts the failed removal and reports nothing', async () => {
    await resetTaskWhoseReapLeft([devServer('kept')]);

    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(worktreeRemovalReports()).toEqual([]);
    expect(hoisted.trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'worktree_removal',
      reason: 'reap_left_running',
      caller: 'cleanup',
      errno: 'EBUSY',
    }));
  });

  it('counts it the same for a process the reap could not stop', async () => {
    await resetTaskWhoseReapLeft([devServer('failed')]);

    expect(worktreeRemovalReports()).toEqual([]);
    expect(hoisted.trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({ source: 'worktree_removal', reason: 'reap_left_running' }));
  });
});

/**
 * A cold open of a project whose Done task's removal failed on an earlier run:
 * the startup sweep reaps first, then the Done retry removes the worktree
 * (`cleanupStaleResourcesAsync`). The sweep's reap answers with `entries`, and
 * the move aside fails, so the retry removes in place. Every other pass finds
 * nothing to do (no To Do task, the worktree's row is there for the orphan pass).
 */
async function coldOpenWhoseSweepLeft(entries: LeftoverProcessEntry[], stoppingEnabled = true): Promise<void> {
  const { WorktreeManager } = await import('../../src/main/git/worktree-manager');
  vi.spyOn(WorktreeManager.prototype, 'moveWorktreeAside').mockResolvedValue(false);
  const { cleanupStaleResourcesAsync, _resetTerminalTaskSweepForTests } = await import('../../src/main/transition-engine/resource-cleanup');
  const { ownershipOf } = await import('./helpers/verified-ownership');
  _resetTerminalTaskSweepForTests();
  const doneTask = { id: 'task-held', title: 'Fix login', worktree_path: worktreePath, session_id: null, swimlane_id: 'lane-done' };
  const taskRepo = {
    listArchived: vi.fn(() => [doneTask]),
    list: vi.fn(() => []),
    listAllInSwimlane: vi.fn((laneId: string) => (laneId === 'lane-done' ? [doneTask] : [])),
    getById: vi.fn(() => doneTask),
    update: vi.fn(),
  };
  const swimlaneRepo = { list: vi.fn(() => [{ id: 'lane-todo', role: 'todo' }, { id: 'lane-done', role: 'done' }]) };
  const sessionRepo = { listAllSessionIds: vi.fn(() => []), deleteByTaskId: vi.fn() };
  const sessionManager = { reapTaskProcesses: vi.fn(async () => entries), listSessions: vi.fn(() => []) };
  const automationRunRepo = { markStaleRunsInterrupted: vi.fn(() => 0), pruneTo: vi.fn() };
  await cleanupStaleResourcesAsync(
    ownershipOf(projectPath),
    taskRepo as never,
    { currentVisit: vi.fn(() => null) },
    swimlaneRepo as never,
    sessionRepo as never,
    sessionManager as never,
    automationRunRepo as never,
    () => {},
    { stoppingEnabled: () => stoppingEnabled, onReport: vi.fn() },
  );
  expect(taskRepo.update, 'the held folder was not removed').not.toHaveBeenCalled();
}

describe('a cold open whose startup sweep kept a process in a Done task\'s worktree', () => {
  // Sentry DESKTOP-3P on 0.62.0: `caller=startup_retry`, `EBUSY` on `rmdir`, `holders=none`.
  it('counts the startup retry\'s failed removal and reports nothing', async () => {
    await coldOpenWhoseSweepLeft([devServer('kept')]);

    expect(worktreeRemovalReports()).toEqual([]);
    expect(hoisted.trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'worktree_removal',
      reason: 'reap_left_running',
      caller: 'startup_retry',
      errno: 'EBUSY',
    }));
  });

  it('still reports it when the sweep stopped everything it found', async () => {
    await coldOpenWhoseSweepLeft([devServer('stopped')]);

    const reports = worktreeRemovalReports();
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({ caller: 'startup_retry', syscall: 'rmdir', profile: 'fast' });
  });

  it('still reports it with stopping off, when the sweep scanned nothing', async () => {
    // The owner's choice: with nothing scanned nothing is known, as after a reap that failed.
    await coldOpenWhoseSweepLeft([devServer('kept')], false);

    expect(worktreeRemovalReports()).toHaveLength(1);
    expect(hoisted.trackEvent).not.toHaveBeenCalledWith('app_error', expect.objectContaining({ source: 'worktree_removal' }));
  });
});

describe('a reset whose reap left nothing in the worktree', () => {
  it('still reports the failed removal, with its caller, the part of the folder and the syscall', async () => {
    await resetTaskWhoseReapLeft([devServer('stopped')]);

    const reports = worktreeRemovalReports();
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({ caller: 'cleanup', path_class: 'root', syscall: 'rmdir', profile: 'moderate' });
    expect(hoisted.trackEvent).not.toHaveBeenCalledWith('app_error', expect.objectContaining({ source: 'worktree_removal' }));
  });
});

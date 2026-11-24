/**
 * `retryDoneWorktreeRemoval` (src/main/ipc/helpers/task-cleanup.ts): after the
 * user stops a leftover process from the list, a Done task's worktree that
 * process was holding is removed at once, rather than at the next project open.
 * A reap whose answer arrives after main stopped waiting retries it the same way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// A Done removal moves the worktree aside first (`moveWorktreeAside`) and
// removes it in place only when that fails (`removeWorktree`).
const { moveWorktreeAside, removeWorktree, taskRows, updates, getOpenProjectDb, getProjectDb, shutdown } = vi.hoisted(() => ({
  moveWorktreeAside: vi.fn(async (_worktreePath: string): Promise<boolean> => true),
  removeWorktree: vi.fn(async (): Promise<boolean> => true),
  taskRows: new Map<string, { id: string; swimlane_id: string; worktree_path: string | null; branch_name: string | null }>(),
  updates: [] as Array<Record<string, unknown>>,
  getOpenProjectDb: vi.fn((): object | null => ({})),
  getProjectDb: vi.fn(() => ({})),
  shutdown: { inProgress: false },
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: () => shutdown.inProgress }));
vi.mock('../../src/main/db/database', () => ({ getOpenProjectDb, getProjectDb }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: {
      getById: (id: string) => taskRows.get(id),
      // Applies the patch the way the real repository does, as a fresh row, so a
      // second retry that re-reads under the lock sees the first one's update
      // and a read taken before the lock holds a stale row.
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        const existing = taskRows.get(String(patch.id));
        if (existing) taskRows.set(existing.id, { ...existing, ...patch });
      },
    },
    swimlanes: { list: () => [{ id: 'lane-todo', role: 'todo' }, { id: 'lane-done', role: 'done' }] },
  })),
}));
vi.mock('../../src/main/git/worktree-head', () => ({ readWorktreeHead: vi.fn(async () => ({ branch: null, sha: null })) }));
vi.mock('../../src/main/git/worktree-manager', () => ({
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
  prepareWorktreeForRemoval: vi.fn(async () => {}),
  WorktreeManager: class {
    withLock = async (job: () => Promise<unknown>) => job();
    moveWorktreeAside = moveWorktreeAside;
    removeWorktree = removeWorktree;
  },
}));
vi.mock('../../src/main/git/removed-worktrees', () => ({ scheduleRemovedWorktreeDeletion: vi.fn() }));

import {
  DONE_REMOVAL_RETRY_DELAY_MS,
  leftoverSweepOptions,
  reapTaskLeftovers,
  retryDoneWorktreeRemoval,
  scheduleDoneWorktreeRemovalRetry,
} from '../../src/main/ipc/helpers/task-cleanup';
import { leftoverProcessReports } from '../../src/main/ipc/helpers/leftover-process-reports';
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';
import type { LeftoverProcessEntry } from '../../src/main/pty/process-tag/tagged-reap';

const PROJECT_PATH = '/mock/project';
const WORKTREE = '/mock/project/.kangentic/worktrees/task-1';
const STOP_RETRY = { caller: 'done_retry_stop' } as const;

/** What the pty host answers for the reported processes a retry asks about. */
const checkReportedProcesses = vi.fn(async (identities: Array<{ pid: number; startKey: string }>): Promise<Array<boolean | null>> => identities.map(() => true));

function context(): IpcContext {
  return {
    projectRepo: { list: () => [{ id: 'project-1', path: PROJECT_PATH }] },
    currentProjectPath: PROJECT_PATH,
    sessionManager: { checkReportedProcesses },
  } as unknown as IpcContext;
}

/** Report a process the way a reap does, so a retry can ask about it. The collector is shared by the file, so each test names its own task. */
function report(overrides: Partial<LeftoverProcessEntry> & { taskId: string }, projectPath = PROJECT_PATH): void {
  leftoverProcessReports.add(
    () => {},
    [{ pid: 5151, startKey: 'start-5151', label: 'chrome', outcome: 'kept', reason: 'window', because: null, place: 'worktree', ...overrides }],
    new Map(),
    true,
    projectPath,
  );
}

beforeEach(() => {
  shutdown.inProgress = false;
  taskRows.clear();
  updates.length = 0;
  moveWorktreeAside.mockClear();
  moveWorktreeAside.mockResolvedValue(true);
  removeWorktree.mockClear();
  removeWorktree.mockResolvedValue(true);
  getOpenProjectDb.mockReset();
  getOpenProjectDb.mockReturnValue({});
  getProjectDb.mockClear();
  checkReportedProcesses.mockClear();
});

describe('retryDoneWorktreeRemoval', () => {
  it('removes a Done task\'s worktree and clears it on the task', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: 'fix-login' });
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY)).toBe(true);
    expect(moveWorktreeAside).toHaveBeenCalledWith(WORKTREE);
    expect(updates).toContainEqual(expect.objectContaining({ id: 'task-1', worktree_path: null }));
  });

  it('leaves a task that is not in Done alone: its worktree is still in use', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-todo', worktree_path: WORKTREE, branch_name: null });
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY)).toBe(false);
    expect(moveWorktreeAside).not.toHaveBeenCalled();
  });

  it('does nothing for a task whose worktree is already gone, a deleted task, or an unknown project', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: null, branch_name: null });
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY)).toBe(false);
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-deleted', STOP_RETRY)).toBe(false);
    expect(await retryDoneWorktreeRemoval(context(), '/mock/other', 'task-1', STOP_RETRY)).toBe(false);
    expect(await retryDoneWorktreeRemoval(context(), null, 'task-1', STOP_RETRY)).toBe(false);
    expect(moveWorktreeAside).not.toHaveBeenCalled();
  });

  it('opens no database for a project being deleted: main closed it, and opening it would create a new empty file', async () => {
    // A late reap answer lands after PROJECT_DELETE closed the database and
    // before it removed the project's row, so the project is still listed.
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
    getOpenProjectDb.mockReturnValue(null);
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY)).toBe(false);
    expect(getOpenProjectDb).toHaveBeenCalledWith('project-1');
    expect(getProjectDb).not.toHaveBeenCalled();
    expect(moveWorktreeAside).not.toHaveBeenCalled();
  });

  it('keeps the worktree on the task when something else still holds it, for the startup retry', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
    moveWorktreeAside.mockResolvedValue(false);
    removeWorktree.mockResolvedValue(false);
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY)).toBe(false);
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(updates.filter((patch) => patch.worktree_path === null)).toEqual([]);
  });

  describe('the in-place removal it falls back to', () => {
    beforeEach(() => {
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      // The move aside fails, so the removal runs in place.
      moveWorktreeAside.mockResolvedValue(false);
    });

    it('names its caller and carries the reap verdict when the reap left a process in the worktree', async () => {
      await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', { caller: 'done_retry_delayed', reapLeftRunning: true });
      expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, { removalProfile: 'moderate', caller: 'done_retry_delayed', reapLeftRunning: true });
      // The verdict already says it, so there is nothing to ask.
      expect(checkReportedProcesses).not.toHaveBeenCalled();
    });

    it('asks the host nothing, and passes reapLeftRunning false, for a task no process was reported of', async () => {
      await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY);
      expect(checkReportedProcesses).not.toHaveBeenCalled();
      expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, { removalProfile: 'moderate', caller: 'done_retry_stop', reapLeftRunning: false });
    });

    // Sentry DESKTOP-3P on 0.62.0: the process a retry waited for is gone, and another one the
    // same reap kept in the worktree is not.
    describe('asked about what was reported in the worktree', () => {
      async function retryFor(taskId: string): Promise<void> {
        taskRows.set(taskId, { id: taskId, swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
        await retryDoneWorktreeRemoval(context(), PROJECT_PATH, taskId, STOP_RETRY);
      }

      it('passes reapLeftRunning when one of two still runs, asking by identity', async () => {
        report({ taskId: 'task-two-reported', pid: 6001, startKey: 'start-6001' });
        report({ taskId: 'task-two-reported', pid: 6002, startKey: 'start-6002', outcome: 'failed', reason: null });
        checkReportedProcesses.mockResolvedValueOnce([false, true]);

        await retryFor('task-two-reported');

        expect(checkReportedProcesses).toHaveBeenCalledWith([{ pid: 6001, startKey: 'start-6001' }, { pid: 6002, startKey: 'start-6002' }]);
        expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, expect.objectContaining({ caller: 'done_retry_stop', reapLeftRunning: true }));
      });

      it.each<[string, boolean | null]>([
        ['ended', false],
        ['unknown', null],
      ])('passes reapLeftRunning false when the host answers %s', async (name, answer) => {
        report({ taskId: `task-answer-${name}` });
        checkReportedProcesses.mockResolvedValueOnce([answer]);

        await retryFor(`task-answer-${name}`);

        expect(checkReportedProcesses).toHaveBeenCalledTimes(1);
        expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, expect.objectContaining({ reapLeftRunning: false }));
      });

      // None of these holds this task's worktree, so none is asked about.
      it.each<[string, Partial<LeftoverProcessEntry>, string]>([
        ['one working in the project folder', { place: 'project' }, PROJECT_PATH],
        ['one the reap stopped', { outcome: 'stopped', reason: null }, PROJECT_PATH],
        ['one of another task', { taskId: 'task-elsewhere' }, PROJECT_PATH],
        ['one of the same task id in another project', {}, '/mock/other'],
      ])('asks nothing about %s', async (name, overrides, projectPath) => {
        const taskId = `task-not-${name}`;
        report({ taskId, ...overrides }, projectPath);

        await retryFor(taskId);

        expect(checkReportedProcesses).not.toHaveBeenCalled();
        expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, expect.objectContaining({ reapLeftRunning: false }));
      });

      it('asks about what the startup sweep kept, which no report of this launch names', async () => {
        leftoverSweepOptions(context(), PROJECT_PATH).onKept?.([
          { taskId: 'task-swept', pid: 8001, startKey: 'start-8001', label: 'chrome', outcome: 'kept', reason: 'window', because: null, place: 'worktree' },
        ]);

        await retryFor('task-swept');

        expect(checkReportedProcesses).toHaveBeenCalledWith([{ pid: 8001, startKey: 'start-8001' }]);
        expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, expect.objectContaining({ reapLeftRunning: true }));
      });

      it('asks nothing for a task whose worktree is already gone', async () => {
        report({ taskId: 'task-worktree-gone' });
        taskRows.set('task-worktree-gone', { id: 'task-worktree-gone', swimlane_id: 'lane-done', worktree_path: null, branch_name: null });

        expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-worktree-gone', STOP_RETRY)).toBe(false);
        expect(checkReportedProcesses).not.toHaveBeenCalled();
      });
    });
  });

  // These two run against the real withTaskLock (nothing here mocks it): the
  // lock is what makes the re-read in retryDoneWorktreeRemoval current.
  describe('under the task lock', () => {
    it('removes the worktree once when two retries for the same task start together', async () => {
      // Two Stop clicks on a task's two leftover processes land together. The
      // second must queue, re-read the row the first one cleared, and find
      // nothing to remove.
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      const first = retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY);
      const second = retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY);
      expect(await Promise.all([first, second])).toEqual([true, false]);
      expect(moveWorktreeAside).toHaveBeenCalledTimes(1);
      expect(taskRows.get('task-1')?.worktree_path).toBeNull();
    });

    it('leaves the worktree alone when the task leaves Done while the retry waits for the lock', async () => {
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      let releaseLock!: () => void;
      const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
      // The user's move out of Done holds the task's lock while it works.
      const holder = withTaskLock('task-1', () => lockHeld);

      const retrying = retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1', STOP_RETRY);
      // The move lands: a fresh row, not a mutation of one the retry may hold.
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-todo', worktree_path: WORKTREE, branch_name: null });
      releaseLock();
      await holder;

      expect(await retrying).toBe(false);
      expect(moveWorktreeAside).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    });
  });
});

// A Done move's removal that failed on a holder already on its way out
// (measured: a /preview's cleanup helper still deleting inside the worktree
// for about 3 s) is tried once more a little later, instead of waiting for the
// next project open.
describe('scheduleDoneWorktreeRemovalRetry', () => {
  it('retries the removal once, after the delay and not before', async () => {
    vi.useFakeTimers();
    try {
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      scheduleDoneWorktreeRemovalRetry(context(), PROJECT_PATH, 'task-1');

      await vi.advanceTimersByTimeAsync(DONE_REMOVAL_RETRY_DELAY_MS - 1);
      expect(moveWorktreeAside).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(moveWorktreeAside).toHaveBeenCalledTimes(1));
      expect(updates).toContainEqual(expect.objectContaining({ id: 'task-1', worktree_path: null }));

      // One attempt only.
      await vi.advanceTimersByTimeAsync(DONE_REMOVAL_RETRY_DELAY_MS * 3);
      expect(moveWorktreeAside).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the reap verdict through to the in-place removal when the timer fires', async () => {
    vi.useFakeTimers();
    try {
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      moveWorktreeAside.mockResolvedValue(false);
      scheduleDoneWorktreeRemovalRetry(context(), PROJECT_PATH, 'task-1', DONE_REMOVAL_RETRY_DELAY_MS, { reapLeftRunning: true });

      await vi.advanceTimersByTimeAsync(DONE_REMOVAL_RETRY_DELAY_MS);
      await vi.waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));
      expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, { removalProfile: 'moderate', caller: 'done_retry_delayed', reapLeftRunning: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks about a process a late reap named since, when the Done move\'s verdict named none', async () => {
    vi.useFakeTimers();
    try {
      taskRows.set('task-late-named', { id: 'task-late-named', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      moveWorktreeAside.mockResolvedValue(false);
      scheduleDoneWorktreeRemovalRetry(context(), PROJECT_PATH, 'task-late-named', DONE_REMOVAL_RETRY_DELAY_MS, { reapLeftRunning: false });
      report({ taskId: 'task-late-named' });

      await vi.advanceTimersByTimeAsync(DONE_REMOVAL_RETRY_DELAY_MS);
      await vi.waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));
      expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, { removalProfile: 'moderate', caller: 'done_retry_delayed', reapLeftRunning: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries nothing during a quit, though the timer was armed', async () => {
    vi.useFakeTimers();
    try {
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      scheduleDoneWorktreeRemovalRetry(context(), PROJECT_PATH, 'task-1');
      // The Done row is still removable, so only the quit stops the attempt.
      expect(vi.getTimerCount()).toBe(1);
      shutdown.inProgress = true;

      await vi.advanceTimersByTimeAsync(DONE_REMOVAL_RETRY_DELAY_MS * 2);
      expect(moveWorktreeAside).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms no timer without a project path', async () => {
    vi.useFakeTimers();
    try {
      // No quit in progress: the timer count is what pins the guard in
      // scheduleDoneWorktreeRemovalRetry. Without it a timer would arm and its
      // retry would still find nothing to remove (retryDoneWorktreeRemoval
      // answers false for a null path itself), so the removal assertion alone
      // cannot tell the two apart.
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      scheduleDoneWorktreeRemovalRetry(context(), null, 'task-1');
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(DONE_REMOVAL_RETRY_DELAY_MS * 2);
      expect(moveWorktreeAside).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A Done move whose reap timed out goes on to remove the worktree while the
// host's reap still runs, so a server holding the worktree can fail that
// removal. When the reap's answer arrives later, the toast names what it
// stopped and the removal is tried again, as after a Stop from the list.
describe('reapTaskLeftovers, when the reap finishes after main stopped waiting', () => {
  const stopped: LeftoverProcessEntry = { taskId: 'task-1', pid: 4242, startKey: 'start-4242', label: 'node (vite)', outcome: 'stopped', reason: null, place: 'worktree' };

  function reapContext() {
    let deliverLate: ((entries: LeftoverProcessEntry[]) => void) | undefined;
    const reapTaskProcesses = vi.fn(async (_projectPath: string | null, _tasks: unknown, options: { stop: boolean; onLateEntries?: (entries: LeftoverProcessEntry[]) => void }) => {
      deliverLate = options.onLateEntries;
      return [];
    });
    const reapingContext = {
      ...context(),
      sessionManager: { reapTaskProcesses, checkReportedProcesses },
      configManager: { load: () => ({ stopLeftoverProcesses: true }) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    return { reapingContext, deliverLate: (entries: LeftoverProcessEntry[]) => deliverLate?.(entries) };
  }

  it('reports what the late answer stopped, under the task\'s title, and retries the Done worktree it was holding', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
    const add = vi.spyOn(leftoverProcessReports, 'add').mockImplementation(() => {});
    const { reapingContext, deliverLate } = reapContext();
    try {
      await reapTaskLeftovers(reapingContext, PROJECT_PATH, [{ id: 'task-1', worktree_path: WORKTREE, title: 'Fix login' }]);
      expect(moveWorktreeAside).not.toHaveBeenCalled();

      deliverLate([stopped]);

      expect(add).toHaveBeenLastCalledWith(expect.any(Function), [stopped], new Map([['task-1', 'Fix login']]), true, PROJECT_PATH);
      await vi.waitFor(() => expect(moveWorktreeAside).toHaveBeenCalledWith(WORKTREE));
      expect(updates).toContainEqual(expect.objectContaining({ id: 'task-1', worktree_path: null }));
    } finally {
      add.mockRestore();
    }
  });

  it('names itself done_retry_late_reap, and asks about a process the same answer kept in the worktree', async () => {
    taskRows.set('task-late-kept', { id: 'task-late-kept', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
    moveWorktreeAside.mockResolvedValue(false);
    const { reapingContext, deliverLate } = reapContext();
    await reapTaskLeftovers(reapingContext, PROJECT_PATH, [{ id: 'task-late-kept', worktree_path: WORKTREE, title: 'Fix login' }]);

    deliverLate([
      { ...stopped, taskId: 'task-late-kept' },
      { ...stopped, taskId: 'task-late-kept', pid: 7001, startKey: 'start-7001', outcome: 'kept', reason: 'window' },
    ]);

    await vi.waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));
    expect(checkReportedProcesses).toHaveBeenCalledWith([{ pid: 7001, startKey: 'start-7001' }]);
    expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, { removalProfile: 'moderate', caller: 'done_retry_late_reap', reapLeftRunning: true });
  });

  it('retries no removal when the late answer stopped nothing', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
    const add = vi.spyOn(leftoverProcessReports, 'add').mockImplementation(() => {});
    const { reapingContext, deliverLate } = reapContext();
    try {
      await reapTaskLeftovers(reapingContext, PROJECT_PATH, [{ id: 'task-1', worktree_path: WORKTREE, title: 'Fix login' }]);
      const kept: LeftoverProcessEntry = { ...stopped, outcome: 'kept', reason: 'window' };
      deliverLate([kept]);
      expect(add).toHaveBeenLastCalledWith(expect.any(Function), [kept], expect.anything(), true, PROJECT_PATH);
      // Wait out the task's lock queue: a retry would have joined it first, so it would have run by now.
      await withTaskLock('task-1', async () => undefined);
      expect(moveWorktreeAside).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });
});

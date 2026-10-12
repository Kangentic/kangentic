/**
 * `retryDoneWorktreeRemoval` (src/main/ipc/helpers/task-cleanup.ts): after the
 * user stops a leftover process from the list, a Done task's worktree that
 * process was holding is removed at once, rather than at the next project open.
 * A reap whose answer arrives after main stopped waiting retries it the same way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const { removeWorktree, taskRows, updates, getOpenProjectDb, getProjectDb } = vi.hoisted(() => ({
  removeWorktree: vi.fn(async (): Promise<boolean> => true),
  taskRows: new Map<string, { id: string; swimlane_id: string; worktree_path: string | null; branch_name: string | null }>(),
  updates: [] as Array<Record<string, unknown>>,
  getOpenProjectDb: vi.fn((): object | null => ({})),
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
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
    removeWorktree = removeWorktree;
  },
}));

import { reapTaskLeftovers, retryDoneWorktreeRemoval } from '../../src/main/ipc/helpers/task-cleanup';
import { leftoverProcessReports } from '../../src/main/ipc/helpers/leftover-process-reports';
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';
import type { LeftoverProcessEntry } from '../../src/main/pty/process-tag/tagged-reap';

const PROJECT_PATH = '/mock/project';
const WORKTREE = '/mock/project/.kangentic/worktrees/task-1';

function context(): IpcContext {
  return {
    projectRepo: { list: () => [{ id: 'project-1', path: PROJECT_PATH }] },
    currentProjectPath: PROJECT_PATH,
  } as unknown as IpcContext;
}

beforeEach(() => {
  taskRows.clear();
  updates.length = 0;
  removeWorktree.mockClear();
  removeWorktree.mockResolvedValue(true);
  getOpenProjectDb.mockReset();
  getOpenProjectDb.mockReturnValue({});
  getProjectDb.mockClear();
});

describe('retryDoneWorktreeRemoval', () => {
  it('removes a Done task\'s worktree and clears it on the task', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: 'fix-login' });
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1')).toBe(true);
    expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, expect.anything());
    expect(updates).toContainEqual(expect.objectContaining({ id: 'task-1', worktree_path: null }));
  });

  it('leaves a task that is not in Done alone: its worktree is still in use', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-todo', worktree_path: WORKTREE, branch_name: null });
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1')).toBe(false);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('does nothing for a task whose worktree is already gone, a deleted task, or an unknown project', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: null, branch_name: null });
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1')).toBe(false);
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-deleted')).toBe(false);
    expect(await retryDoneWorktreeRemoval(context(), '/mock/other', 'task-1')).toBe(false);
    expect(await retryDoneWorktreeRemoval(context(), null, 'task-1')).toBe(false);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('opens no database for a project being deleted: main closed it, and opening it would create a new empty file', async () => {
    // A late reap answer lands after PROJECT_DELETE closed the database and
    // before it removed the project's row, so the project is still listed.
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
    getOpenProjectDb.mockReturnValue(null);
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1')).toBe(false);
    expect(getOpenProjectDb).toHaveBeenCalledWith('project-1');
    expect(getProjectDb).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('keeps the worktree on the task when something else still holds it, for the startup retry', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
    removeWorktree.mockResolvedValue(false);
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1')).toBe(false);
    expect(updates.filter((patch) => patch.worktree_path === null)).toEqual([]);
  });

  // These two run against the real withTaskLock (nothing here mocks it): the
  // lock is what makes the re-read in retryDoneWorktreeRemoval current.
  describe('under the task lock', () => {
    it('removes the worktree once when two retries for the same task start together', async () => {
      // Two Stop clicks on a task's two leftover processes land together. The
      // second must queue, re-read the row the first one cleared, and find
      // nothing to remove.
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      const first = retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1');
      const second = retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1');
      expect(await Promise.all([first, second])).toEqual([true, false]);
      expect(removeWorktree).toHaveBeenCalledTimes(1);
      expect(taskRows.get('task-1')?.worktree_path).toBeNull();
    });

    it('leaves the worktree alone when the task leaves Done while the retry waits for the lock', async () => {
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
      let releaseLock!: () => void;
      const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
      // The user's move out of Done holds the task's lock while it works.
      const holder = withTaskLock('task-1', () => lockHeld);

      const retrying = retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1');
      // The move lands: a fresh row, not a mutation of one the retry may hold.
      taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-todo', worktree_path: WORKTREE, branch_name: null });
      releaseLock();
      await holder;

      expect(await retrying).toBe(false);
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    });
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
      sessionManager: { reapTaskProcesses },
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
      expect(removeWorktree).not.toHaveBeenCalled();

      deliverLate([stopped]);

      expect(add).toHaveBeenLastCalledWith(expect.any(Function), [stopped], new Map([['task-1', 'Fix login']]), true, PROJECT_PATH);
      await vi.waitFor(() => expect(removeWorktree).toHaveBeenCalledWith(WORKTREE, expect.anything()));
      expect(updates).toContainEqual(expect.objectContaining({ id: 'task-1', worktree_path: null }));
    } finally {
      add.mockRestore();
    }
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
      expect(removeWorktree).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });
});

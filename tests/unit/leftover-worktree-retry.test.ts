/**
 * `retryDoneWorktreeRemoval` (src/main/ipc/helpers/task-cleanup.ts): after the
 * user stops a leftover process from the list, a Done task's worktree that
 * process was holding is removed at once, rather than at the next project open.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const { removeWorktree, taskRows, updates } = vi.hoisted(() => ({
  removeWorktree: vi.fn(async (): Promise<boolean> => true),
  taskRows: new Map<string, { id: string; swimlane_id: string; worktree_path: string | null; branch_name: string | null }>(),
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: {
      getById: (id: string) => taskRows.get(id),
      update: (patch: Record<string, unknown>) => { updates.push(patch); },
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

import { retryDoneWorktreeRemoval } from '../../src/main/ipc/helpers/task-cleanup';

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

  it('keeps the worktree on the task when something else still holds it, for the startup retry', async () => {
    taskRows.set('task-1', { id: 'task-1', swimlane_id: 'lane-done', worktree_path: WORKTREE, branch_name: null });
    removeWorktree.mockResolvedValue(false);
    expect(await retryDoneWorktreeRemoval(context(), PROJECT_PATH, 'task-1')).toBe(false);
    expect(updates.filter((patch) => patch.worktree_path === null)).toEqual([]);
  });
});

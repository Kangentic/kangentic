/**
 * A task's unsent Browser pane annotations end with its session
 * (`cleanupTaskResources` in src/main/ipc/helpers/task-cleanup.ts): a reset, a
 * demote and a delete all end the review they belonged to. The discard is
 * retired, so the last save the pane flushes as it unmounts cannot bring the
 * draft back, and a failed discard never stops the worktree removal after it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { discardAnnotationDraft, removeWorktree, callOrder } = vi.hoisted(() => ({
  discardAnnotationDraft: vi.fn<(projectPath: string, ownerKey: string, options?: { retire?: boolean }) => Promise<void>>(),
  removeWorktree: vi.fn<(path: string, options?: unknown) => Promise<boolean>>(),
  callOrder: [] as string[],
}));

vi.mock('../../src/main/browser/annotation-drafts', () => ({
  discardAnnotationDraft: (...args: [string, string, { retire?: boolean }?]) => {
    callOrder.push('discard');
    return discardAnnotationDraft(...args);
  },
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
  prepareWorktreeForRemoval: async () => { callOrder.push('prepare'); },
  WorktreeManager: class {
    removeWorktree = (...args: [string, unknown?]) => {
      callOrder.push('removeWorktree');
      return removeWorktree(...args);
    };
    pruneWorktrees = vi.fn();
    removeBranch = vi.fn();
    withLock = async (operation: () => Promise<unknown>) => operation();
  },
}));
vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHead: async () => ({ branch: null, sha: null }),
}));
vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({ waitForChurnRead: async () => undefined }));
vi.mock('../../src/main/git/worktree-creation-registry', () => ({ waitForWorktreeCreation: async () => false }));
vi.mock('../../src/main/git/removed-worktrees', () => ({ scheduleRemovedWorktreeDeletion: vi.fn() }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));

import { cleanupTaskResources } from '../../src/main/ipc/helpers/task-cleanup';

const PROJECT_PATH = '/mock/project';

function makeContext() {
  return {
    currentProjectPath: PROJECT_PATH,
    sessionManager: { removeByTaskId: vi.fn() },
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
  };
}

function makeTasks() {
  return { update: vi.fn(), getById: vi.fn(() => ({ id: 'task-1' })), setWorktreeSkipReason: vi.fn() };
}

const TASK = {
  id: 'task-1',
  session_id: null,
  worktree_path: '/mock/project/.kangentic/worktrees/task-1-abcd',
  branch_name: 'feature-1',
};

describe('cleanupTaskResources annotation draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    removeWorktree.mockReset();
    removeWorktree.mockResolvedValue(true);
    discardAnnotationDraft.mockReset();
    discardAnnotationDraft.mockResolvedValue(undefined);
  });

  it('discards the task draft with the retirement flag, before the worktree goes', async () => {
    await cleanupTaskResources(makeContext() as never, TASK, makeTasks() as never, undefined, PROJECT_PATH);

    expect(discardAnnotationDraft).toHaveBeenCalledWith(PROJECT_PATH, 'task-1', { retire: true });
    expect(callOrder.indexOf('discard')).toBeLessThan(callOrder.indexOf('removeWorktree'));
  });

  it('still removes the worktree when the discard rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    discardAnnotationDraft.mockRejectedValue(new Error('EBUSY'));
    const tasks = makeTasks();

    await expect(cleanupTaskResources(makeContext() as never, TASK, tasks as never, undefined, PROJECT_PATH)).resolves.toBeUndefined();

    expect(removeWorktree).toHaveBeenCalledWith(TASK.worktree_path, { removalProfile: 'moderate' });
    expect(tasks.update).toHaveBeenCalledWith(expect.objectContaining({ worktree_path: null }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('annotation draft'));
    warn.mockRestore();
  });
});

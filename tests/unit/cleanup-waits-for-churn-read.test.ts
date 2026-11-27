/**
 * `cleanupTaskResources` (a task delete, a bulk delete, a To Do reset, a Backlog
 * demote) kills the task's agent and awaits its exit, and that exit fires a
 * churn capture into the worktree (`captureGitChurn` from the session exit
 * listener). The removal used to start at once, so the read ran against a
 * folder that was going or gone: Sentry DESKTOP-5R, 5Y and 5S, and the task's
 * churn since its last capture was lost. The removal now waits, bounded, for
 * that read, as a Done move's does.
 *
 * Real code from the capture to the removal: `captureGitChurn`,
 * `waitForChurnRead` and `cleanupTaskResources`. The read itself, the reap's
 * host reply and the worktree manager are stand-ins.
 *
 * What a user loses if this breaks: the Stats tiles undercount every task that
 * is deleted or reset, and each such read files a Sentry issue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Task } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  /** One pending read per DiffService call, settled by the test. */
  churnReads: [] as Array<{ directory: string; settle: () => void }>,
  prepareWorktreeForRemoval: vi.fn(async (_worktreePath: string, _profile: string): Promise<void> => {}),
  removeWorktree: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: vi.fn(() => '1.2.3') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  net: {},
}));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../src/main/git/diff-service', () => ({
  DiffService: class {
    constructor(private readonly directory: string) {}
    getChurnSummary(): Promise<{ linesAdded: number; linesRemoved: number; filesChanged: number }> {
      return new Promise((resolve) => {
        hoisted.churnReads.push({ directory: this.directory, settle: () => resolve({ linesAdded: 4, linesRemoved: 1, filesChanged: 1 }) });
      });
    }
  },
}));
vi.mock('../../src/main/git/git-read-queue', () => ({
  GitReadPriority: { USER: 0, BACKGROUND: 1 },
  viaGitRead: <Result,>(operation: () => Promise<Result>): Promise<Result> => operation(),
}));
vi.mock('../../src/main/git/worktree-manager', () => ({
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
  prepareWorktreeForRemoval: (worktreePath: string, profile: string) => hoisted.prepareWorktreeForRemoval(worktreePath, profile),
  WorktreeManager: class {
    removeWorktree = hoisted.removeWorktree;
    withLock = async (operation: () => Promise<unknown>) => operation();
  },
}));
vi.mock('../../src/main/git/worktree-head', () => ({ readWorktreeHead: async () => ({ branch: null, sha: null }) }));
vi.mock('../../src/main/browser/annotation-drafts', () => ({ discardAnnotationDraft: vi.fn(async () => undefined) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(), getOpenProjectDb: vi.fn(() => null), getExistingProjectDb: vi.fn(() => null) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));

import { captureGitChurn } from '../../src/main/ipc/handlers/git-stats-capture';
import { cleanupTaskResources } from '../../src/main/ipc/helpers/task-cleanup';

let projectPath: string;
let worktreePath: string;

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-churn-wait-'));
  worktreePath = path.join(projectPath, '.kangentic', 'worktrees', 'task-reset');
  fs.mkdirSync(worktreePath, { recursive: true });
  // A worktree's own `.git` file, so the capture reads this worktree and not the checkout above it.
  fs.writeFileSync(path.join(worktreePath, '.git'), 'gitdir: ../../../.git/worktrees/task-reset\n');
  hoisted.churnReads.length = 0;
  hoisted.prepareWorktreeForRemoval.mockClear();
  hoisted.removeWorktree.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const read of hoisted.churnReads) read.settle();
  vi.restoreAllMocks();
  fs.rmSync(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Let every promise continuation already queued run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function cleanupContext() {
  return {
    currentProjectId: null,
    currentProjectPath: projectPath,
    sessionManager: {
      removeByTaskId: vi.fn(async () => undefined),
      listSessions: vi.fn(() => []),
      probeTaskProcesses: vi.fn(async () => []),
      reapTaskProcesses: vi.fn(async () => []),
    },
    configManager: {
      load: vi.fn(() => ({ stopLeftoverProcesses: true })),
      getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })),
    },
    boardConfigManager: { getStopScriptForPath: vi.fn(() => null) },
    projectRepo: { list: vi.fn(() => []) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  };
}

/** The capture the agent's exit fires into the worktree. */
function captureFromAgentExit(sessionRepo: { listForTaskNewestFirst: () => unknown[]; setTaskGitStats: ReturnType<typeof vi.fn> }): void {
  const task = { id: 'task-reset', worktree_path: worktreePath, pr_state: null, archived_at: null, base_branch: null } as unknown as Task;
  captureGitChurn(task, sessionRepo as never, { setTaskGitStats: vi.fn() } as never, 'record-1', projectPath, 'main');
}

describe('cleanupTaskResources and the churn read in its worktree', () => {
  it('waits for the read to settle before it removes the worktree, so the capture is written', async () => {
    const sessionRepo = { listForTaskNewestFirst: () => [{ id: 'record-1', lines_added: 0, lines_removed: 0, files_changed: 0 }], setTaskGitStats: vi.fn() };
    captureFromAgentExit(sessionRepo);
    await vi.waitFor(() => expect(hoisted.churnReads).toHaveLength(1));

    const task = { id: 'task-reset', session_id: null, worktree_path: worktreePath, branch_name: null, title: 'Fix login' };
    const tasks = { getById: vi.fn(() => task), update: vi.fn(), setWorktreeSkipReason: vi.fn() };
    let cleanupDone = false;
    const cleanup = cleanupTaskResources(cleanupContext() as never, task, tasks as never, null, projectPath)
      .then(() => { cleanupDone = true; });

    // Everything ahead of the worktree block has run (the session teardown, the reap,
    // the skip-reason reset), and the removal is still held by the read.
    await vi.waitFor(() => expect(tasks.setWorktreeSkipReason).toHaveBeenCalled());
    await flush();
    expect(hoisted.prepareWorktreeForRemoval).not.toHaveBeenCalled();
    expect(hoisted.removeWorktree).not.toHaveBeenCalled();
    expect(cleanupDone).toBe(false);

    hoisted.churnReads[0].settle();
    await cleanup;

    expect(sessionRepo.setTaskGitStats).toHaveBeenCalledWith(['record-1'], 'record-1', { linesAdded: 4, linesRemoved: 1, filesChanged: 1 });
    expect(hoisted.prepareWorktreeForRemoval).toHaveBeenCalledWith(worktreePath, 'moderate');
    expect(hoisted.removeWorktree).toHaveBeenCalled();
  });

  it('removes at once when no read is in flight', async () => {
    const task = { id: 'task-reset', session_id: null, worktree_path: worktreePath, branch_name: null, title: 'Fix login' };
    const tasks = { getById: vi.fn(() => task), update: vi.fn(), setWorktreeSkipReason: vi.fn() };

    await cleanupTaskResources(cleanupContext() as never, task, tasks as never, null, projectPath);

    expect(hoisted.prepareWorktreeForRemoval).toHaveBeenCalledWith(worktreePath, 'moderate');
    expect(hoisted.removeWorktree).toHaveBeenCalled();
  });
});

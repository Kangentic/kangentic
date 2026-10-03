/**
 * Unit coverage for where TASK_SWITCH_BRANCH records a task's new base branch
 * (src/main/ipc/handlers/task-branch.ts).
 *
 * Both switch paths (A: the task already has a worktree, B: the switch enables
 * one) write `kangentic.baseBranch` through `writeWorktreeBaseBranch`, which runs
 * `git config --worktree` so the value lands in THAT worktree's own config. They
 * used to call `addConfig`, which writes the repo's SHARED config from a linked
 * worktree, so switching one task's base silently changed every other task's.
 *
 * Both write sites sit inside try/catch, so "the handler resolved" proves
 * nothing: a regression to `addConfig` (absent from the worktree git double's
 * `raw`) is swallowed. The assertions therefore read the exact git command the
 * worktree's git received. The helper's own behavior against real git, including
 * which config file the value lands in and the shared fallback, is pinned by
 * write-worktree-base-branch.test.ts.
 *
 * Pattern mirrors task-update-from-base.test.ts: capture the function registered
 * with ipcMain.handle and invoke it directly. The real writeWorktreeBaseBranch
 * runs (worktree-manager is NOT mocked); only simple-git is replaced.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

const {
  mockGetProjectRepos,
  mockResolveProjectContext,
  mockEnsureTaskWorktree,
  mockProjectGit,
  mockWorktreeGit,
  worktreeLocation,
} = vi.hoisted(() => ({
  mockGetProjectRepos: vi.fn(),
  mockResolveProjectContext: vi.fn(),
  mockEnsureTaskWorktree: vi.fn(),
  mockProjectGit: { status: vi.fn(), diff: vi.fn(), raw: vi.fn() },
  // `addConfig` is what the handler used to call. It exists here, as a spy, so a
  // regression shows up as a failed assertion rather than as a swallowed TypeError.
  mockWorktreeGit: { raw: vi.fn(), addConfig: vi.fn() },
  // Filled in beforeAll with a real directory: Path A checks it exists on disk.
  worktreeLocation: { path: '' },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '0.0.0'), isPackaged: false, getLocale: vi.fn(() => 'en') },
}));

vi.mock('simple-git', () => {
  const gitFactory = vi.fn((cwd: string) => (cwd === worktreeLocation.path ? mockWorktreeGit : mockProjectGit));
  return { simpleGit: gitFactory, default: gitFactory };
});

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask(): null { return null; }
    updateCwd(): void { /* no suspended record in these tests */ }
  },
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: (...args: unknown[]) => mockResolveProjectContext(...args),
}));

vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  resolveEffectiveBaseBranch: vi.fn(),
  findLiveSessionInDirectory: vi.fn(),
}));

import { registerTaskBranchHandlers } from '../../src/main/ipc/handlers/task-branch';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskSwitchBranchInput } from '../../src/shared/types';

interface MockTask {
  id: string;
  title: string;
  session_id: string | null;
  worktree_path: string | null;
  base_branch: string | null;
  branch_name: string | null;
}

const PROJECT_PATH = '/project';
const WORKTREE_CONFIG_WRITE = ['config', '--worktree', 'kangentic.baseBranch', 'develop'];

let worktreeDirectory: string;

beforeAll(() => {
  worktreeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-switch-branch-'));
  worktreeLocation.path = worktreeDirectory;
});

afterAll(() => {
  fs.rmSync(worktreeDirectory, { recursive: true, force: true });
});

function makeTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task-1',
    title: 'A task',
    session_id: null,
    worktree_path: null,
    base_branch: null,
    branch_name: null,
    ...overrides,
  };
}

function makeContext(): IpcContext {
  return {
    currentProjectId: 'ambient-project',
    currentProjectPath: PROJECT_PATH,
    sessionManager: { listSessions: () => [] },
  } as unknown as IpcContext;
}

async function switchBranch(input: TaskSwitchBranchInput): Promise<unknown> {
  capturedHandlers.clear();
  registerTaskBranchHandlers(makeContext());
  const handler = capturedHandlers.get(IPC.TASK_SWITCH_BRANCH);
  expect(handler).toBeDefined();
  return handler!(null, input, 'explicit-project');
}

describe('TASK_SWITCH_BRANCH records the base in the worktree\'s own git config', () => {
  let currentTask: MockTask;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProjectContext.mockImplementation((_context: IpcContext, projectId?: string | null) => ({
      projectId: projectId ?? 'ambient-project',
      projectPath: PROJECT_PATH,
    }));
    mockWorktreeGit.raw.mockResolvedValue('');
    // Nothing to carry: the project checkout is clean.
    mockProjectGit.status.mockResolvedValue({ files: [], not_added: [] });
  });

  it('Path A (the task already has a worktree) writes `config --worktree` through the worktree\'s git', async () => {
    currentTask = makeTask({ worktree_path: worktreeDirectory });
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => currentTask), update: vi.fn() } });

    await switchBranch({ taskId: 'task-1', newBaseBranch: 'develop' });

    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(WORKTREE_CONFIG_WRITE);
    expect(mockWorktreeGit.addConfig).not.toHaveBeenCalled();
    // And never through the project checkout's git, whose config is the shared one.
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });

  it('Path B (the switch enables a worktree) writes `config --worktree` through the new worktree\'s git', async () => {
    currentTask = makeTask();
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => currentTask), update: vi.fn() } });
    // ensureTaskWorktree is what stamps the created worktree's path on the task row.
    mockEnsureTaskWorktree.mockImplementation(async () => {
      currentTask.worktree_path = worktreeDirectory;
    });

    await switchBranch({ taskId: 'task-1', newBaseBranch: 'develop', enableWorktree: true });

    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(WORKTREE_CONFIG_WRITE);
    expect(mockWorktreeGit.addConfig).not.toHaveBeenCalled();
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });
});

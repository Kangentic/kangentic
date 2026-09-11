/**
 * Unit tests for `RequestResolver.resolveWorktreeBaseRef`, the hook
 * `kangentic_list_worktrees` hands `enumerateWorktrees` so each record's
 * ahead/behind is measured against the base its work is BASED ON rather than
 * the branch's own tracking ref.
 *
 * Lookup order under test: a task matched by `worktree_path` (compared as
 * resolved paths, so separator and `.` segment differences do not matter),
 * then by branch name; that task's own `base_branch`, else the base it was
 * actually cut from (`resolved_base_branch`), else the project default chain.
 * The main checkout skips the task lookup and takes the project default. Any
 * throw degrades to null (the caller then falls back to the upstream count).
 *
 * Mocking pattern follows tests/unit/mcp-project-resolver.test.ts, plus stubs
 * for the project DB and TaskRepository the new method reaches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../src/shared/types';

const { buildCommandContextForProject, taskFixtures, getProjectDbMock } = vi.hoisted(() => ({
  buildCommandContextForProject: vi.fn(),
  taskFixtures: [] as Task[],
  getProjectDbMock: vi.fn(() => ({ handle: 'project-db' })),
}));

vi.mock('../../src/main/agent/mcp-project-context', () => ({
  buildCommandContextForProject,
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: getProjectDbMock,
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list(): Task[] {
      return taskFixtures;
    }
    getByBranchName(branchName: string): Task | undefined {
      return taskFixtures.find((task) => task.branch_name === branchName);
    }
  },
}));

import { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_PATH = '/repo';
const TASK_WORKTREE = '/repo/.kangentic/worktrees/task-a';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-a',
    title: 'Task A',
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    resolved_base_branch: null,
    archived_at: null,
    ...overrides,
  } as unknown as Task;
}

function makeResolver(options?: { boardDefault?: string; configDefault?: string }): RequestResolver {
  const ipcContext = {
    projectRepo: { list: () => [] },
    boardConfigManager: { getDefaultBaseBranchForPath: vi.fn(() => options?.boardDefault) },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: options?.configDefault ?? 'main' } })),
    },
  } as unknown as IpcContext;
  return new RequestResolver({
    ipcContext,
    defaultContext: {} as CommandContext,
    defaultProjectId: PROJECT_ID,
    defaultProjectName: 'Example',
  });
}

function taskWorktreeInput(overrides?: { worktreePath?: string; branch?: string | null }) {
  return {
    projectId: PROJECT_ID,
    projectPath: PROJECT_PATH,
    worktreePath: overrides?.worktreePath ?? TASK_WORKTREE,
    branch: overrides?.branch === undefined ? 'feature/task-a' : overrides.branch,
    isMainCheckout: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  taskFixtures.length = 0;
});

describe('RequestResolver.resolveWorktreeBaseRef', () => {
  it("returns the task's own base when the worktree path matches, even with a differently spelled path", () => {
    taskFixtures.push(makeTask({ worktree_path: TASK_WORKTREE, branch_name: 'renamed/by-agent', base_branch: 'release/2.0' }));
    const resolver = makeResolver({ boardDefault: 'develop' });

    // A `.` segment the porcelain listing would never print; resolved paths still match.
    const base = resolver.resolveWorktreeBaseRef(taskWorktreeInput({ worktreePath: '/repo/.kangentic/./worktrees/task-a' }));

    expect(base).toBe('release/2.0');
    expect(getProjectDbMock).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('falls back to the base the worktree was actually cut from when the task names none', () => {
    taskFixtures.push(makeTask({ worktree_path: TASK_WORKTREE, base_branch: null, resolved_base_branch: 'develop' }));
    const resolver = makeResolver({ configDefault: 'main' });

    expect(resolver.resolveWorktreeBaseRef(taskWorktreeInput())).toBe('develop');
  });

  it('matches by branch name when no task owns the worktree path', () => {
    taskFixtures.push(makeTask({ worktree_path: '/repo/.kangentic/worktrees/elsewhere', branch_name: 'feature/task-a', base_branch: 'release/3.0' }));
    const resolver = makeResolver();

    expect(resolver.resolveWorktreeBaseRef(taskWorktreeInput())).toBe('release/3.0');
  });

  it('uses the project default chain (board default first) for an unmapped worktree', () => {
    const resolver = makeResolver({ boardDefault: 'develop', configDefault: 'main' });

    expect(resolver.resolveWorktreeBaseRef(taskWorktreeInput({ branch: null }))).toBe('develop');
  });

  it('gives the main checkout the project default without touching the task DB', () => {
    taskFixtures.push(makeTask({ worktree_path: PROJECT_PATH, base_branch: 'should-not-be-read' }));
    const resolver = makeResolver({ configDefault: 'trunk' });

    const base = resolver.resolveWorktreeBaseRef({
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      worktreePath: PROJECT_PATH,
      branch: 'feature/on-main-checkout',
      isMainCheckout: true,
    });

    // The provenance case: a Command Terminal on a feature branch of the main
    // checkout must read its distance from the base, not from its own remote.
    expect(base).toBe('trunk');
    expect(getProjectDbMock).not.toHaveBeenCalled();
  });

  it('returns null, never throws, when the project DB cannot be opened', () => {
    getProjectDbMock.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    const resolver = makeResolver();

    expect(resolver.resolveWorktreeBaseRef(taskWorktreeInput())).toBeNull();
  });
});

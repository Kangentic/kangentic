/**
 * Unit test for the remote-execution worktree skip added to
 * `ensureTaskWorktree` (task-git.ts): a task whose resolved agent is set to
 * 'remote' execution for the current project must not get a local worktree
 * created - the agent runs against the configured server directory instead.
 *
 * WorktreeManager is mocked entirely so this test never touches git or the
 * filesystem; it only asserts whether `ensureWorktree()` was called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureTaskWorktree } from '../../src/main/ipc/helpers/task-git';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task, AppConfig, Project } from '../../src/shared/types';
import { DEFAULT_CONFIG } from '../../src/shared/types';

const ensureWorktreeMock = vi.fn().mockResolvedValue({ worktreePath: '/local/worktree/feature-x-abcd1234', branchName: 'feature-x' });
const withLockMock = vi.fn((fn: () => unknown) => fn());

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: vi.fn().mockImplementation(function MockWorktreeManager(this: Record<string, unknown>) {
    this.withLock = withLockMock;
    this.ensureWorktree = ensureWorktreeMock;
  }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    title: 'Fix the bug',
    description: '',
    swimlane_id: 'lane-1',
    position: 0,
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    use_worktree: null,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    session_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    is_ghost: false,
    is_archived: false,
    priority: 0,
    display_id: 1,
    attachment_count: 0,
    labels: null,
    ...overrides,
  } as Task;
}

function makeConfig(overrides: Partial<AppConfig['agent']> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent, ...overrides },
  };
}

function makeContext(config: AppConfig, projects: Project[] = []): IpcContext {
  return {
    currentProjectPath: null,
    configManager: {
      getEffectiveConfig: vi.fn().mockReturnValue(config),
    },
    projectRepo: {
      list: vi.fn().mockReturnValue(projects),
    },
  } as unknown as IpcContext;
}

describe('ensureTaskWorktree - remote execution skip', () => {
  beforeEach(() => {
    ensureWorktreeMock.mockClear();
    withLockMock.mockClear();
  });

  it('creates a worktree normally when the resolved agent has no execution entry (local)', async () => {
    const context = makeContext(makeConfig());
    const task = makeTask({ agent_override: 'opencode' });

    await ensureTaskWorktree(context, task, { update: vi.fn(), getById: vi.fn().mockReturnValue(task) } as never, '/project');

    expect(ensureWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('skips worktree creation when the task-overridden agent is remote', async () => {
    const context = makeContext(makeConfig({ execution: { opencode: { mode: 'remote', workingDirectory: '/srv/project' } } }));
    const task = makeTask({ agent_override: 'opencode' });

    await ensureTaskWorktree(context, task, { update: vi.fn(), getById: vi.fn().mockReturnValue(task) } as never, '/project');

    expect(ensureWorktreeMock).not.toHaveBeenCalled();
  });

  it('falls back to the project default agent when the task has no override', async () => {
    const context = makeContext(
      makeConfig({ execution: { opencode: { mode: 'remote', workingDirectory: '/srv/project' } } }),
      [{ path: '/project', default_agent: 'opencode' } as Project],
    );
    const task = makeTask({ agent_override: null });

    await ensureTaskWorktree(context, task, { update: vi.fn(), getById: vi.fn().mockReturnValue(task) } as never, '/project');

    expect(ensureWorktreeMock).not.toHaveBeenCalled();
  });

  it('does not skip when a DIFFERENT agent is set to remote (task uses claude, opencode is remote)', async () => {
    const context = makeContext(makeConfig({ execution: { opencode: { mode: 'remote', workingDirectory: '/srv/project' } } }));
    const task = makeTask({ agent_override: 'claude' });

    await ensureTaskWorktree(context, task, { update: vi.fn(), getById: vi.fn().mockReturnValue(task) } as never, '/project');

    expect(ensureWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('creates a worktree when the resolved agent is explicitly local', async () => {
    const context = makeContext(makeConfig({ execution: { opencode: { mode: 'local', workingDirectory: null } } }));
    const task = makeTask({ agent_override: 'opencode' });

    await ensureTaskWorktree(context, task, { update: vi.fn(), getById: vi.fn().mockReturnValue(task) } as never, '/project');

    expect(ensureWorktreeMock).toHaveBeenCalledTimes(1);
  });
});

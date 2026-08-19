/**
 * `handleCreateTask` refuses a `branchName` that git already has checked out,
 * and creates nothing.
 *
 * Why this guard exists (task #538): a cross-project agent created a task with
 * `branchName: rework-notifications-desktop-push`, a branch it had committed to
 * and which was checked out in the main dogfooding checkout. Git allows a branch
 * in only ONE working tree at a time, so `git worktree add` failed 1.04s later -
 * long after the tool response had been sent, because `onTaskCreated` fires
 * auto-spawn fire-and-forget. What was left was a card with a null session and a
 * null worktree, indistinguishable from a healthy one, and the agent that made
 * the mistake never learned of it.
 *
 * The refusal message is the actual deliverable, not a side effect: it is the
 * only channel that reaches the calling agent. So the assertions below pin its
 * CONTENT (branch, holding path, "No task was created", and a terminal state),
 * not merely that some error came back. In particular it must not suggest
 * `useWorktree: false` - this same guard rejects that too, so suggesting it
 * would walk the caller into a retry loop.
 *
 * Red-green: every "no task was created" assertion reds against the pre-fix
 * handler, which created the row and returned success.
 *
 * Strategy mirrors mcp-create-task-labels.test.ts: mock the repositories and the
 * column resolver so no better-sqlite3 binary is needed, plus WorktreeManager so
 * no real git runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be registered before the import under test
// ---------------------------------------------------------------------------

const mockTaskRepoCreate = vi.fn();
const mockResolveColumn = vi.fn();
const mockBacklogRepoCreate = vi.fn();
const mockFindWorktreeHoldingBranch = vi.fn();
const mockIsGitRepo = vi.fn();

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    create = mockTaskRepoCreate;
    update = vi.fn();
    getById = vi.fn();
    getByDisplayId = vi.fn();
  },
}));

vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  resolveColumn: (...args: unknown[]) => mockResolveColumn(...args),
}));

// The git seam. `parseWorktreeBranches` is deliberately NOT stubbed - it is
// re-exported from the real module below and tested directly, because the
// porcelain record shape is where this feature is most likely to be silently
// wrong.
vi.mock('../../src/main/git/worktree-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/worktree-manager')>();
  return {
    ...actual,
    WorktreeManager: class {
      findWorktreeHoldingBranch = mockFindWorktreeHoldingBranch;
    },
  };
});

vi.mock('../../src/main/git/git-checks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/git-checks')>();
  return { ...actual, isGitRepo: (...args: unknown[]) => mockIsGitRepo(...args) };
});

// Defensive: imported (directly or transitively) by task-commands.ts. Stubbed so
// importing the handler stays cheap and touches no real DB, filesystem, or git.
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class { add = vi.fn(); list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class { create = mockBacklogRepoCreate; getById = vi.fn(); update = vi.fn(); list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class { add = vi.fn(); list = vi.fn(() => []); deleteByTaskId = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: vi.fn(),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPRForTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { handleCreateTask } from '../../src/main/agent/commands/task-commands';
import { parseWorktreeBranches } from '../../src/main/git/worktree-manager';
import type { CommandContext } from '../../src/main/agent/commands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HELD_BRANCH = 'rework-notifications-desktop-push';
const MAIN_CHECKOUT = '/mock/project';

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    getProjectDb: vi.fn(() => ({}) as never),
    getProjectPath: vi.fn(() => MAIN_CHECKOUT),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(async () => {}),
    onTasksReordered: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsGitRepo.mockReturnValue(true);
  mockFindWorktreeHoldingBranch.mockResolvedValue(null);
  mockResolveColumn.mockReturnValue({ swimlane: { id: 'lane-1', name: 'Planning' } });
  mockTaskRepoCreate.mockImplementation((input: { title: string }) => ({
    id: 'task-uuid-1', display_id: 7, title: input.title,
  }));
  mockBacklogRepoCreate.mockImplementation((input: { title: string }) => ({
    id: 'backlog-uuid-1', title: input.title, priority: 0,
  }));
});

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

describe('handleCreateTask - a branchName already checked out is refused', () => {
  it('creates NOTHING when the branch is held by another worktree', async () => {
    mockFindWorktreeHoldingBranch.mockResolvedValue(MAIN_CHECKOUT);

    const response = await handleCreateTask(
      { title: 'Rework notifications', branchName: HELD_BRANCH },
      makeContext(),
    );

    expect(response.success).toBe(false);
    // The whole point: pre-fix this created the row and returned success, then
    // failed invisibly at worktree creation a second later.
    expect(mockTaskRepoCreate).not.toHaveBeenCalled();
  });

  it('names the branch and the path holding it, so the caller can tell WHO has it', async () => {
    mockFindWorktreeHoldingBranch.mockResolvedValue(MAIN_CHECKOUT);

    const response = await handleCreateTask(
      { title: 'Rework notifications', branchName: HELD_BRANCH },
      makeContext(),
    );

    // The holding path is load-bearing: it is what tells the calling agent
    // whether the holder is the user's main checkout (it cannot act) or a
    // worktree it could free.
    expect(response.error).toContain(HELD_BRANCH);
    expect(response.error).toContain(MAIN_CHECKOUT);
    expect(response.error).toContain('No task was created');
  });

  it('offers a terminal state, not just a retry that would loop', async () => {
    mockFindWorktreeHoldingBranch.mockResolvedValue(MAIN_CHECKOUT);

    const response = await handleCreateTask(
      { title: 'Rework notifications', branchName: HELD_BRANCH },
      makeContext(),
    );

    const error = response.error ?? '';
    // Unlike the cross-project routing guard (fixable alone via `project:`), the
    // holder here is usually a checkout the calling agent cannot touch. Without
    // an explicit "stop and tell the user" branch it retries forever.
    expect(error).toMatch(/stop and tell the user/i);
    expect(error).toMatch(/fail identically/i);
    // Must NOT suggest useWorktree:false - this same guard rejects that too, so
    // it is a guaranteed loop.
    expect(error).not.toContain('useWorktree');
  });

  it('does not run the probe at all when no branchName is passed', async () => {
    const response = await handleCreateTask({ title: 'Ordinary task' }, makeContext());

    expect(response.success).toBe(true);
    // The common create must pay no git cost.
    expect(mockFindWorktreeHoldingBranch).not.toHaveBeenCalled();
    expect(mockTaskRepoCreate).toHaveBeenCalledOnce();
  });

  it('creates normally when the named branch is free', async () => {
    mockFindWorktreeHoldingBranch.mockResolvedValue(null);

    const response = await handleCreateTask(
      { title: 'Fresh work', branchName: 'feature/fresh' },
      makeContext(),
    );

    expect(response.success).toBe(true);
    expect(mockFindWorktreeHoldingBranch).toHaveBeenCalledWith('feature/fresh');
    const createInput = mockTaskRepoCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createInput.customBranchName).toBe('feature/fresh');
  });

  it('fails OPEN: a git probe that throws never blocks the create', async () => {
    mockFindWorktreeHoldingBranch.mockRejectedValue(new Error('git exploded'));

    const response = await handleCreateTask(
      { title: 'Fresh work', branchName: 'feature/fresh' },
      makeContext(),
    );

    // A check that cannot reason about the repo must not veto a create that
    // would otherwise be fine.
    expect(response.success).toBe(true);
    expect(mockTaskRepoCreate).toHaveBeenCalledOnce();
  });

  it('skips the probe outside a git repo', async () => {
    mockIsGitRepo.mockReturnValue(false);

    const response = await handleCreateTask(
      { title: 'Fresh work', branchName: 'feature/fresh' },
      makeContext(),
    );

    expect(response.success).toBe(true);
    expect(mockFindWorktreeHoldingBranch).not.toHaveBeenCalled();
  });

  it('does not probe for a Backlog item, which ignores branchName entirely', async () => {
    mockFindWorktreeHoldingBranch.mockResolvedValue(MAIN_CHECKOUT);

    const response = await handleCreateTask(
      { title: 'Someday', column: 'Backlog', branchName: HELD_BRANCH },
      makeContext(),
    );

    // The backlog path drops branchName, so a conflict there is not a conflict.
    expect(response.success).toBe(true);
    expect(mockFindWorktreeHoldingBranch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The porcelain parse
// ---------------------------------------------------------------------------

describe('parseWorktreeBranches', () => {
  it('maps the main checkout and each worktree to the branch it holds', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/.kangentic/worktrees/460',
      'HEAD def456',
      'branch refs/heads/some-task-a1b2c3d4',
      '',
    ].join('\n');

    const branches = parseWorktreeBranches(porcelain);

    // The main checkout is the first record, and it counts: that is exactly the
    // #538 case.
    expect(branches.get('main')).toBe('/repo');
    expect(branches.get('some-task-a1b2c3d4')).toBe('/repo/.kangentic/worktrees/460');
  });

  it('keeps slashes in a branch name, stripping refs/heads/ by PREFIX', () => {
    const porcelain = 'worktree /repo\nHEAD abc123\nbranch refs/heads/feature/login\n';

    // Splitting on '/' would yield 'feature' or 'login' and silently never match.
    expect(parseWorktreeBranches(porcelain).get('feature/login')).toBe('/repo');
  });

  it('ignores detached and bare records, which name no branch', () => {
    const porcelain = [
      'worktree /repo',
      'bare',
      '',
      'worktree /repo/detached',
      'HEAD abc123',
      'detached',
      '',
      'worktree /repo/attached',
      'HEAD def456',
      'branch refs/heads/live',
      '',
    ].join('\n');

    const branches = parseWorktreeBranches(porcelain);

    // A record without a branch line must not inherit the next record's branch,
    // nor leak a path onto one.
    expect(branches.size).toBe(1);
    expect(branches.get('live')).toBe('/repo/attached');
  });

  it('strips the trailing CR from Windows git output', () => {
    const porcelain = 'worktree C:\\repo\r\nHEAD abc123\r\nbranch refs/heads/main\r\n';

    const branches = parseWorktreeBranches(porcelain);

    // Without the \r strip the key is 'main\r' and the value 'C:\repo\r', so
    // every lookup misses and the guard silently never fires on Windows - the
    // platform this ships on.
    expect(branches.get('main')).toBe('C:\\repo');
  });

  it('returns an empty map for empty output', () => {
    expect(parseWorktreeBranches('').size).toBe(0);
  });
});

/**
 * Wiring tests for `captureGitChurn` / `resolveDefaultBaseBranch` calls inside
 * `applySuspendDbWrites` (src/main/ipc/handlers/session-reconcile.ts).
 *
 * Bug #1 of the usage-dashboard fix (see task-move-git-churn-wiring.test.ts for
 * the fuller writeup): git churn was undercounted because the only capture
 * site was move-to-Done, which in the PR flow runs after the branch is
 * already merged. `applySuspendDbWrites` is the shared DB-write path for
 * every suspend (user pause via SESSION_SUSPEND, idle-timeout, and the
 * settings-change respawn's suspend-then-resume), so it is also now a
 * capture site: it calls `captureGitChurn` right before
 * `markRecordSuspended`, resolving `projectPath` from
 * `context.projectRepo.getById(projectId)?.path` and the base branch via
 * `resolveDefaultBaseBranch`.
 *
 * `session-reconcile-helpers.test.ts` covers `reconcileTaskSessionRef` only
 * and stubs `applySuspendDbWrites`'s dependencies without ever invoking the
 * function itself. `session-idle-timeout.test.ts` invokes
 * `applySuspendDbWrites` indirectly (via the idle-timeout listener) but does
 * not mock `git-stats-capture` at all and never asserts `captureGitChurn` is
 * called - the real implementation runs against a stub `SessionRepository`
 * missing `listForTaskNewestFirst`/`setTaskGitStats`, which throws inside
 * `captureGitChurn`'s try/catch and is silently swallowed. Neither file
 * proves the wiring. `git-stats-capture` is mocked wholesale here (as in
 * task-move-git-churn-wiring.test.ts) so these tests assert the CALL, not the
 * git diff itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, SessionRecord } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'mocked-default-branch'),
}));

vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: hoisted.captureGitChurn,
  resolveDefaultBaseBranch: hoisted.resolveDefaultBaseBranch,
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

// getLatestForTask is driven per-test via mockGetLatestForTask (the `mock`
// prefix is required for Vitest to hoist the reference above the vi.mock
// factory that closes over it).
const mockGetLatestForTask = vi.fn(() => null as SessionRecord | null);
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = mockGetLatestForTask;
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {},
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  notifyBranchCheckoutBlocked: vi.fn(),
  spawnAgent: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(),
  deleteTaskWorktree: vi.fn(),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

// Import under test AFTER all mocks are registered.
import { applySuspendDbWrites } from '../../src/main/ipc/handlers/session-reconcile';
import { markRecordExited, markRecordSuspended } from '../../src/main/transition-engine/session-lifecycle';

const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/mock/project';
const TASK_ID = 'task-1';
const RESOLVED_BRANCH = 'mocked-default-branch';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'Test task',
    description: '',
    swimlane_id: 'lane-doing',
    position: 0,
    agent: 'claude',
    session_id: 'sess-1',
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'rec-1',
    task_id: TASK_ID,
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-1',
    command: 'claude',
    cwd: '/tmp',
    permission_mode: null,
    prompt: null,
    status: 'running',
    exit_code: null,
    started_at: new Date().toISOString(),
    suspended_at: null,
    exited_at: null,
    suspended_by: null,
    total_cost_usd: null,
    total_input_tokens: null,
    total_output_tokens: null,
    model_id: null,
    model_display_name: null,
    total_duration_ms: null,
    tool_call_count: null,
    lines_added: null,
    lines_removed: null,
    files_changed: null,
    ...overrides,
  };
}

function makeContext(taskRepo: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }) {
  mockGetProjectRepos.mockReturnValue({ tasks: taskRepo });
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: PROJECT_PATH,
    sessionManager: {
      getUsageCache: vi.fn(() => ({})),
      getEventsForSession: vi.fn(() => []),
    },
    projectRepo: {
      getById: vi.fn(() => ({ id: PROJECT_ID, path: PROJECT_PATH })),
    },
  };
}

describe('applySuspendDbWrites git-churn capture wiring', () => {
  let taskRepo: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveDefaultBaseBranch.mockReturnValue(RESOLVED_BRANCH);
    mockGetLatestForTask.mockReturnValue(null);
    taskRepo = { getById: vi.fn(), update: vi.fn() };
  });

  it('action "suspend": captures git churn with the record id, resolved project path, and resolved base branch', () => {
    const task = makeTask({ session_id: 'sess-1' });
    taskRepo.getById.mockReturnValue(task);
    const context = makeContext(taskRepo);
    mockGetLatestForTask.mockReturnValue(makeRecord({ id: 'rec-suspend' }));

    applySuspendDbWrites(context as never, PROJECT_ID, TASK_ID, 'user');

    expect(hoisted.resolveDefaultBaseBranch).toHaveBeenCalledWith(context, PROJECT_PATH);
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      task,
      expect.anything(),
      expect.anything(),
      'rec-suspend',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(expect.anything(), 'rec-suspend', 'user');
    expect(taskRepo.update).toHaveBeenCalledWith({ id: TASK_ID, session_id: null });
  });

  it('action "exit-queued": does NOT capture git churn (record never started a CLI)', () => {
    const task = makeTask({ session_id: 'sess-1' });
    taskRepo.getById.mockReturnValue(task);
    const context = makeContext(taskRepo);
    mockGetLatestForTask.mockReturnValue(
      makeRecord({ id: 'rec-queued', status: 'queued', agent_session_id: null }),
    );

    applySuspendDbWrites(context as never, PROJECT_ID, TASK_ID, 'user');

    expect(hoisted.captureGitChurn).not.toHaveBeenCalled();
    expect(hoisted.resolveDefaultBaseBranch).not.toHaveBeenCalled();
    expect(vi.mocked(markRecordExited)).toHaveBeenCalledWith(expect.anything(), 'rec-queued');
    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith({ id: TASK_ID, session_id: null });
  });

  it('no session record (action "noop"): does NOT capture git churn', () => {
    const task = makeTask({ session_id: 'sess-1' });
    taskRepo.getById.mockReturnValue(task);
    const context = makeContext(taskRepo);
    mockGetLatestForTask.mockReturnValue(null);

    applySuspendDbWrites(context as never, PROJECT_ID, TASK_ID, 'user');

    expect(hoisted.captureGitChurn).not.toHaveBeenCalled();
    expect(vi.mocked(markRecordExited)).not.toHaveBeenCalled();
    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith({ id: TASK_ID, session_id: null });
  });

  it('no session_id on task: early return before any repo access, no capture', () => {
    const task = makeTask({ session_id: null });
    taskRepo.getById.mockReturnValue(task);
    const context = makeContext(taskRepo);

    applySuspendDbWrites(context as never, PROJECT_ID, TASK_ID, 'user');

    expect(hoisted.captureGitChurn).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
  });
});

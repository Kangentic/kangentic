/**
 * Tests for reconcileTaskSessionRef in session-reconcile.ts.
 *
 * reconcileTaskSessionRef is an IPC helper (not a pure function - it reads
 * from repositories and the SessionManager), so these tests use a minimal
 * stub IpcContext rather than the full handler stack. Only the fields
 * actually accessed by the function under test are provided.
 *
 * Five scenarios:
 *   - Stale DB reference: registry status is 'suspended'  -> clear + null
 *   - Stale DB reference: registry status is 'exited'     -> clear + null
 *   - Missing registry entry: getSession returns undefined -> clear + null
 *   - Live registry entry: status 'running'               -> do not clear, return session
 *   - Live registry entry: status 'queued'                -> do not clear, return session
 *   - Clean state: task.session_id already null           -> getSession not called, return null
 *   - Task not found: getById returns undefined           -> throws
 *
 * The functions this replaces coverage for:
 *   - SESSION_RESUME Phase 1 and Phase 3 both call reconcileTaskSessionRef
 *   - The stale-clear path is the root-cause fix for the divergence bug
 *     described in the branch: idle-timeout suspended the registry entry but
 *     never cleared task.session_id, so SESSION_RESUME threw "already has an
 *     active session" instead of recovering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, Task } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Module-level mocks (must be registered before any import of the module
// under test so vitest's hoisting applies correctly).
// ---------------------------------------------------------------------------

// getProjectDb is called by applySuspendDbWrites (not by reconcileTaskSessionRef
// itself), but it is imported at module level by session-reconcile.ts so we
// mock it to prevent the real better-sqlite3 call.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

// SessionRepository is instantiated by applySuspendDbWrites, not by
// reconcileTaskSessionRef. Mock the class so the constructor is a no-op.
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

// session-lifecycle helpers are called by applySuspendDbWrites, not by
// reconcileTaskSessionRef. Mock them to keep these tests focused.
vi.mock('../../src/main/engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

// captureSessionMetrics is called by applySuspendDbWrites, not by
// reconcileTaskSessionRef directly.
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
}));

// getProjectRepos is the entry point for repository access. We intercept
// it here so reconcileTaskSessionRef reads from our stub task repo.
const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  spawnAgent: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(),
  deleteTaskWorktree: vi.fn(),
  buildAutoCommandVars: vi.fn(() => ({})),
}));

// Import under test AFTER all mocks are registered.
import { reconcileTaskSessionRef } from '../../src/main/ipc/handlers/session-reconcile';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
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

function makeSession(status: Session['status']): Session {
  return {
    id: 'sess-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    pid: null,
    status,
    shell: '/bin/bash',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
  };
}

/**
 * Build a minimal stub IpcContext with the fields that
 * reconcileTaskSessionRef actually reads. The stub tasks repo and
 * sessionManager.getSession are configurable per-test.
 */
function makeContext(
  taskRepo: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> },
  getSession: ReturnType<typeof vi.fn>,
) {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    sessionManager: {
      getSession,
      getUsageCache: vi.fn(() => ({})),
      getEventsForSession: vi.fn(() => []),
    },
  };
}

// ---------------------------------------------------------------------------
// reconcileTaskSessionRef test suite
// ---------------------------------------------------------------------------

describe('reconcileTaskSessionRef', () => {
  let taskRepo: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let getSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    taskRepo = {
      getById: vi.fn(),
      update: vi.fn(),
    };
    getSession = vi.fn();
    mockGetProjectRepos.mockReturnValue({ tasks: taskRepo });
  });

  // -------------------------------------------------------------------------
  // Stale-clear paths (registry status != running/queued or missing)
  // -------------------------------------------------------------------------

  it('clears session_id and returns liveSession:null when registry status is "suspended"', () => {
    const initialTask = makeTask({ session_id: 'sess-1' });
    const refreshedTask = makeTask({ session_id: null });
    taskRepo.getById
      .mockReturnValueOnce(initialTask)   // first read inside reconcile
      .mockReturnValueOnce(refreshedTask); // re-read after update
    getSession.mockReturnValue(makeSession('suspended'));

    const context = makeContext(taskRepo, getSession);
    const result = reconcileTaskSessionRef(context as never, 'proj-1', 'task-1');

    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'task-1', session_id: null });
    expect(result.liveSession).toBeNull();
    expect(result.task.session_id).toBeNull();
  });

  it('clears session_id and returns liveSession:null when registry status is "exited"', () => {
    const initialTask = makeTask({ session_id: 'sess-1' });
    const refreshedTask = makeTask({ session_id: null });
    taskRepo.getById
      .mockReturnValueOnce(initialTask)
      .mockReturnValueOnce(refreshedTask);
    getSession.mockReturnValue(makeSession('exited'));

    const context = makeContext(taskRepo, getSession);
    const result = reconcileTaskSessionRef(context as never, 'proj-1', 'task-1');

    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'task-1', session_id: null });
    expect(result.liveSession).toBeNull();
    expect(result.task.session_id).toBeNull();
  });

  it('clears session_id and returns liveSession:null when getSession returns undefined (missing from registry)', () => {
    // Auto-spawn placeholder safety-net case: task.session_id was set but the
    // registry never had the entry (app restart, or session was removed before
    // reconcile ran).
    const initialTask = makeTask({ session_id: 'sess-gone' });
    const refreshedTask = makeTask({ session_id: null });
    taskRepo.getById
      .mockReturnValueOnce(initialTask)
      .mockReturnValueOnce(refreshedTask);
    getSession.mockReturnValue(undefined);

    const context = makeContext(taskRepo, getSession);
    const result = reconcileTaskSessionRef(context as never, 'proj-1', 'task-1');

    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'task-1', session_id: null });
    expect(result.liveSession).toBeNull();
    expect(result.task.session_id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Live-session paths (registry status running or queued -> no DB write)
  // -------------------------------------------------------------------------

  it('does NOT clear session_id and returns the live session when registry status is "running"', () => {
    const task = makeTask({ session_id: 'sess-running' });
    taskRepo.getById.mockReturnValue(task);
    const liveSession = makeSession('running');
    getSession.mockReturnValue(liveSession);

    const context = makeContext(taskRepo, getSession);
    const result = reconcileTaskSessionRef(context as never, 'proj-1', 'task-1');

    // session_id must NOT have been cleared
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(result.liveSession).toBe(liveSession);
    expect(result.task.session_id).toBe('sess-running');
  });

  it('does NOT clear session_id and returns the live session when registry status is "queued"', () => {
    const task = makeTask({ session_id: 'sess-queued' });
    taskRepo.getById.mockReturnValue(task);
    const liveSession = makeSession('queued');
    getSession.mockReturnValue(liveSession);

    const context = makeContext(taskRepo, getSession);
    const result = reconcileTaskSessionRef(context as never, 'proj-1', 'task-1');

    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(result.liveSession).toBe(liveSession);
  });

  // -------------------------------------------------------------------------
  // Clean-state path (task.session_id already null)
  // -------------------------------------------------------------------------

  it('does not call getSession and returns liveSession:null when task.session_id is already null', () => {
    // No session reference in DB - nothing to reconcile. This is the normal
    // post-suspend state (every other suspend path paired registry suspend
    // with tasks.update({ session_id: null })).
    const task = makeTask({ session_id: null });
    taskRepo.getById.mockReturnValue(task);

    const context = makeContext(taskRepo, getSession);
    const result = reconcileTaskSessionRef(context as never, 'proj-1', 'task-1');

    expect(getSession).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(result.liveSession).toBeNull();
    expect(result.task).toBe(task);
  });

  // -------------------------------------------------------------------------
  // Task-not-found path
  // -------------------------------------------------------------------------

  it('throws when the task does not exist in the DB', () => {
    taskRepo.getById.mockReturnValue(undefined);

    const context = makeContext(taskRepo, getSession);

    expect(() => {
      reconcileTaskSessionRef(context as never, 'proj-1', 'task-missing');
    }).toThrow('Task task-missing not found');
  });
});

/**
 * `applySuspendDbWrites` (src/main/ipc/handlers/session-reconcile.ts) must write
 * the suspended session's OWN record, not the task's newest record.
 *
 * A task can hold two session tracks at once: a main session and an isolated
 * (column) session. `getLatestForTask` returns the newest record across BOTH
 * tracks, so when the other track's record is the newer one, a capture written
 * there counts the suspended run twice in that track's merged tool totals. The
 * site therefore resolves `findByAnyId(task.session_id)` first (a session
 * record id is its PTY session id) and only falls back to `getLatestForTask`
 * for a spawn whose record is not inserted yet.
 *
 * The fallback half is already pinned by the `action "suspend"` case in
 * session-reconcile-git-churn-wiring.test.ts (findByAnyId answers undefined,
 * and the getLatestForTask record lands on captureGitChurn and
 * markRecordSuspended), so this file pins only the own-record half.
 *
 * Red-green, reasoned from the code: reverting the lookup on the `record`
 * line of applySuspendDbWrites to `sessionRepo.getLatestForTask(taskId)`
 * alone makes `record` the other track's row. Every assertion below then
 * sees `rec-other-track` where it expects `rec-own`, and the lookup
 * assertion fails because findByAnyId is never asked for the session id.
 *
 * Harness copied from session-reconcile-git-churn-wiring.test.ts. The mock
 * keys findByAnyId on the exact session id, so passing the wrong argument
 * (the task id, say) also falls back to the other record and fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, SessionRecord } from '../../src/shared/types';
import { makeSessionRecord } from './helpers/session-record-fixture';

const hoisted = vi.hoisted(() => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'mocked-default-branch'),
  findByAnyId: vi.fn<(sessionId: string) => unknown>(),
  getLatestForTask: vi.fn<(taskId: string) => unknown>(),
}));

vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: hoisted.captureGitChurn,
  resolveDefaultBaseBranch: hoisted.resolveDefaultBaseBranch,
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = hoisted.findByAnyId;
    getLatestForTask = hoisted.getLatestForTask;
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
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(),
  deleteTaskWorktree: vi.fn(),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

// Import under test AFTER all mocks are registered.
import { applySuspendDbWrites } from '../../src/main/ipc/handlers/session-reconcile';
import { markRecordExited, markRecordSuspended } from '../../src/main/transition-engine/session-lifecycle';
import {
  captureSessionMetrics,
  refineTranscriptTokens,
  refineTranscriptToolCounts,
} from '../../src/main/ipc/handlers/session-metrics';

const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/mock/project';
const TASK_ID = 'task-1';
const SESSION_ID = 'sess-own';
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
    session_id: SESSION_ID,
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The suspended session's own record: the main track, started first. */
function makeOwnRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return makeSessionRecord({
    id: 'rec-own',
    task_id: TASK_ID,
    agent_session_id: 'agent-own',
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    started_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

/**
 * The task's NEWEST record, which belongs to the other track (an isolated
 * column session). It is eligible for a suspend capture too (running, with an
 * agent session id), so a site that picks it writes to it instead of no-oping.
 */
function makeOtherTrackRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return makeSessionRecord({
    id: 'rec-other-track',
    task_id: TASK_ID,
    agent_session_id: 'agent-other',
    session_type: 'codex_agent',
    isolated_swimlane_id: 'lane-review-isolated',
    started_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  });
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

describe('applySuspendDbWrites writes the session\'s own record, not the task\'s newest', () => {
  let taskRepo: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveDefaultBaseBranch.mockReturnValue(RESOLVED_BRANCH);
    hoisted.findByAnyId.mockReset();
    hoisted.getLatestForTask.mockReset();
    taskRepo = { getById: vi.fn(), update: vi.fn() };
  });

  it('action "suspend": capture, refine, churn, and markRecordSuspended all use the own record id when the task\'s newest record is the other track\'s', () => {
    const task = makeTask();
    taskRepo.getById.mockReturnValue(task);
    const context = makeContext(taskRepo);
    const ownRecord = makeOwnRecord();
    hoisted.findByAnyId.mockImplementation((sessionId) => (sessionId === SESSION_ID ? ownRecord : undefined));
    hoisted.getLatestForTask.mockReturnValue(makeOtherTrackRecord());

    applySuspendDbWrites(context as never, PROJECT_ID, TASK_ID, 'user');

    expect(hoisted.findByAnyId).toHaveBeenCalledWith(SESSION_ID);

    // Metrics snapshot: the PTY session id stays the 4th argument and the
    // RECORD id (arg 5), start time, and session type are the own record's.
    expect(vi.mocked(captureSessionMetrics)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureSessionMetrics)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      expect.anything(),
      SESSION_ID,
      'rec-own',
      ownRecord.started_at,
      'claude_agent',
    );

    expect(vi.mocked(refineTranscriptTokens)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refineTranscriptTokens)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      SESSION_ID,
      'rec-own',
    );
    expect(vi.mocked(refineTranscriptToolCounts)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refineTranscriptToolCounts)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      SESSION_ID,
      'rec-own',
    );

    expect(hoisted.captureGitChurn).toHaveBeenCalledTimes(1);
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      task,
      expect.anything(),
      expect.anything(),
      'rec-own',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );

    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(expect.anything(), 'rec-own', 'user');
    expect(vi.mocked(markRecordExited)).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith({ id: TASK_ID, session_id: null });
  });

  it('action "exit-queued": a queued own record is exited even when the other track\'s newest record is running', () => {
    taskRepo.getById.mockReturnValue(makeTask());
    const context = makeContext(taskRepo);
    hoisted.findByAnyId.mockImplementation((sessionId) => (
      sessionId === SESSION_ID
        ? makeOwnRecord({ id: 'rec-own-queued', status: 'queued', agent_session_id: null })
        : undefined
    ));
    hoisted.getLatestForTask.mockReturnValue(makeOtherTrackRecord());

    applySuspendDbWrites(context as never, PROJECT_ID, TASK_ID, 'user');

    expect(vi.mocked(markRecordExited)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markRecordExited)).toHaveBeenCalledWith(expect.anything(), 'rec-own-queued');
    // The other track's running record is never captured or suspended.
    expect(vi.mocked(captureSessionMetrics)).not.toHaveBeenCalled();
    expect(hoisted.captureGitChurn).not.toHaveBeenCalled();
    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith({ id: TASK_ID, session_id: null });
  });
});

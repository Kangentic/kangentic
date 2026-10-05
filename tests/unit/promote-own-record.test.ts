/**
 * The `session-changed` forwarder in registerSessionHandlers
 * (src/main/ipc/handlers/sessions.ts) promotes a queued session record to
 * `running` when its session reaches `running`. It must promote the session's
 * OWN record, not the task's newest record.
 *
 * A task can hold two session tracks at once: a main session and an isolated
 * (column) session. `getLatestForTask` returns the newest record across BOTH
 * tracks, so when the other track's record is the newer one, promoting it
 * flips the wrong row to `running` and leaves this session's own row queued.
 * The forwarder therefore resolves
 * `findByAnyId(sessionId) ?? getLatestForTask(managedSession.taskId)`: the
 * session's own record first (a record id is its PTY session id), the newest
 * only as the fallback for a spawn whose record is not inserted yet.
 *
 * Nothing asserted promoteRecord's argument before this file: every harness
 * that registers these handlers mocks it as a bare `vi.fn()`.
 *
 * Red-green, reasoned from the code: reverting the `record` lookup to
 * `sessionRepo.getLatestForTask(managedSession.taskId)` alone makes the
 * own-record case call promoteRecord with `rec-other-track` instead of
 * `rec-own`, and its findByAnyId assertion fails because the session id is
 * never looked up. The fallback case is the guard in the other direction:
 * dropping the `?? getLatestForTask` half leaves `record` undefined and
 * promoteRecord is never called.
 *
 * Harness copied from session-spawn-analytics.test.ts with three changes that
 * the promote branch needs:
 *   - The SessionRepository mock gains `findByAnyId`. Without it the call
 *     throws inside the forwarder's try, the catch swallows it, and
 *     promoteRecord never runs, so the test would fail for the wrong reason.
 *   - `getSession` answers with a managed session carrying the task id (it
 *     answers null there, which skips the whole `if (managedSession)` block).
 *   - `getSessionAgentName` answers undefined, which skips the spawn
 *     analytics enrichment so its own `getLatestForTask` read does not
 *     pollute the call counts asserted here.
 * The findByAnyId mock keys on the exact session id, so passing the wrong
 * argument (the task id, say) also falls back to the other record and fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, SessionRecord } from '../../src/shared/types';
import { makeSessionRecord } from './helpers/session-record-fixture';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any imports of the mocked modules)
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  findByAnyId: vi.fn<(sessionId: string) => unknown>(),
  getLatestForTask: vi.fn<(taskId: string) => unknown>(),
}));

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = hoisted.findByAnyId;
    getLatestForTask = hoisted.getLatestForTask;
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
  trackMilestone: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  abortBacklogPromotion: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
  },
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
  default: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    removeWorktree = vi.fn(async () => {});
    pruneWorktrees = vi.fn(async () => {});
    removeBranch = vi.fn(async () => {});
    static scheduleBackgroundPrune = vi.fn();
  },
}));

const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => {}),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({
    executeTransition: vi.fn(async () => ({ outcomes: [], failures: [], startedAgent: false })),
    resumeSuspendedSession: vi.fn(async () => {}),
  })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
}));

// Import the module under test AFTER all vi.mock declarations.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { promoteRecord } from '../../src/main/transition-engine/session-lifecycle';

const PROJECT_ID = 'proj-test';
const TASK_ID = 'task-promote-001';

/** The promoted session's own record: the main track, queued, started first. */
function makeOwnRecord(): SessionRecord {
  return makeSessionRecord({
    id: 'rec-own',
    task_id: TASK_ID,
    agent_session_id: null,
    status: 'queued',
    isolated_swimlane_id: null,
    started_at: '2026-01-01T00:00:00.000Z',
  });
}

/**
 * The task's NEWEST record, which belongs to the other track (an isolated
 * column session). It is queued too, so promoting it is a real wrong write
 * rather than a no-op.
 */
function makeOtherTrackRecord(): SessionRecord {
  return makeSessionRecord({
    id: 'rec-other-track',
    task_id: TASK_ID,
    agent_session_id: null,
    status: 'queued',
    isolated_swimlane_id: 'lane-review-isolated',
    started_at: '2026-01-02T00:00:00.000Z',
  });
}

function makeRunningSession(sessionId: string): Session {
  return {
    id: sessionId,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    pid: null,
    status: 'running',
    shell: '/bin/bash',
    cwd: '/home/dev/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    exitCode: null,
    resuming: false,
  };
}

function buildMockContext(sessionId: string) {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => [] as Session[]),
      // The managed session carries the task id the fallback keys on.
      getSession: vi.fn((id: string) => (id === sessionId ? { id, taskId: TASK_ID } : null)),
      getSessionTaskId: vi.fn(() => null as string | null),
      getSessionProjectId: vi.fn(() => PROJECT_ID as string | undefined),
      // Undefined skips the spawn analytics enrichment block.
      getSessionAgentName: vi.fn(() => undefined as string | undefined),
      getUsageCache: vi.fn(() => ({} as Record<string, unknown>)),
      getToolCallCount: vi.fn(() => 0),
      getUsageCacheForProject: vi.fn(() => ({})),
      getActivityCache: vi.fn(() => ({})),
      getActivityCacheForProject: vi.fn(() => ({})),
      getEventsCache: vi.fn(() => ({})),
      getEventsCacheForProject: vi.fn(() => ({})),
      getEventsForSession: vi.fn(() => []),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      setFocusedSessions: vi.fn(),
      killByTaskId: vi.fn(),
      removeByTaskId: vi.fn(),
      suspend: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
    },
    terminalSubmitScheduler: {
      scheduleKeystrokes: vi.fn(),
      cancel: vi.fn(),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })),
    },
  };
}

/** Register the handlers and fire a `running` status push for the session. */
function fireRunning(sessionId: string): void {
  const context = buildMockContext(sessionId);
  registerSessionHandlers(context as never);
  const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
  if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');
  sessionChangedHandler(sessionId, makeRunningSession(sessionId));
}

describe('session-changed forwarder promotes the session\'s own record, not the task\'s newest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    hoisted.findByAnyId.mockReset();
    hoisted.getLatestForTask.mockReset();
    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => null), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });
  });

  it('promotes the own record id when the task\'s newest record is the other track\'s', () => {
    const sessionId = 'promote-own-record-session-001';
    hoisted.findByAnyId.mockImplementation((id) => (id === sessionId ? makeOwnRecord() : undefined));
    hoisted.getLatestForTask.mockReturnValue(makeOtherTrackRecord());

    fireRunning(sessionId);

    expect(hoisted.findByAnyId).toHaveBeenCalledWith(sessionId);
    expect(vi.mocked(promoteRecord)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promoteRecord)).toHaveBeenCalledWith(expect.anything(), 'rec-own');
  });

  it('fallback: with no own record yet, promotes the task\'s newest record (looked up by the managed session\'s task id)', () => {
    const sessionId = 'promote-own-record-session-002';
    hoisted.findByAnyId.mockReturnValue(undefined);
    hoisted.getLatestForTask.mockReturnValue(
      makeSessionRecord({ id: 'rec-latest', task_id: TASK_ID, agent_session_id: null, status: 'queued' }),
    );

    fireRunning(sessionId);

    expect(hoisted.findByAnyId).toHaveBeenCalledWith(sessionId);
    expect(hoisted.getLatestForTask).toHaveBeenCalledWith(TASK_ID);
    expect(vi.mocked(promoteRecord)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promoteRecord)).toHaveBeenCalledWith(expect.anything(), 'rec-latest');
  });
});

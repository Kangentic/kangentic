/**
 * Wiring tests for the `captureGitChurn` call inside the PTY `exit` listener
 * (registerSessionHandlers, src/main/ipc/handlers/sessions.ts).
 *
 * Bug #1 of the usage-dashboard fix (see task-move-git-churn-wiring.test.ts
 * and session-reconcile-git-churn-wiring.test.ts for the fuller writeup):
 * a natural `/exit` or crash-exit finalizes a session without ever going
 * through a suspend or move, so the exit listener is also a capture site now.
 * It is gated on `session` (the live SessionManager entry at exit time)
 * being present, because only then can `session.taskId` resolve a task via
 * `new TaskRepository(db).getById(session.taskId)` - the exit-by-agent-id
 * fallback path has no manager entry to resolve a task from.
 *
 * `session-shutdown-exit-suspend.test.ts` covers the same listener's
 * suspended-vs-exited status persistence but does not mock `git-stats-capture`
 * and never asserts `captureGitChurn` (its `TaskRepository` mock always
 * returns null, so the `if (taskForChurn)` guard silently no-ops there).
 * `git-stats-capture` is mocked wholesale here (as in the sibling wiring
 * test files) so these tests assert the CALL, not the git diff itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'mocked-default-branch'),
}));

vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: hoisted.captureGitChurn,
  resolveDefaultBaseBranch: hoisted.resolveDefaultBaseBranch,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// The fallback path queries `SELECT id, status ... WHERE agent_session_id = ?`
// and the metrics-record query `SELECT id, started_at, session_type ...`;
// mockFallbackGet drives both (same prepared-statement stub, mirroring
// session-shutdown-exit-suspend.test.ts).
const mockFallbackGet = vi.fn((): { id: string; status: string; started_at?: string; session_type?: string } | undefined => undefined);
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({ prepare: vi.fn(() => ({ get: mockFallbackGet, run: vi.fn() })) })),
}));

const mockFindByAnyId = vi.fn((): { id: string; status: string; started_at: string; session_type: string } | null => null);
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = mockFindByAnyId;
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {},
}));

// getById is driven per-test via mockTaskRepoGetById.
const mockTaskRepoGetById = vi.fn((): { id: string } | null => null);
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = mockTaskRepoGetById;
  },
}));

const markRecordExitedMock = vi.fn(() => true);
const markRecordSuspendedMock = vi.fn(() => true);
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: (...args: unknown[]) => markRecordExitedMock(...args),
  markRecordSuspended: (...args: unknown[]) => markRecordSuspendedMock(...args),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

const isShuttingDownMock = vi.fn(() => false);
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => isShuttingDownMock(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/agent/shared', () => ({ interpolateTemplate: vi.fn((t: string) => t) }));
vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => false) } }));

const mockGetProjectRepos = vi.fn(() => ({
  tasks: { getById: vi.fn(() => null), update: vi.fn() },
  swimlanes: { getById: vi.fn(() => null) },
  actions: { getTransitionsFor: vi.fn(() => []) },
  attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({ executeTransition: vi.fn(async () => {}), resumeSuspendedSession: vi.fn(async () => {}) })),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => {}),
  autoLinkPRForTask: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

// Import module under test AFTER all mocks.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_PATH = '/mock/project';
const RESOLVED_BRANCH = 'mocked-default-branch';

function buildMockContext(getSession: (() => { id: string; taskId: string } | undefined) = () => ({ id: 'pty-1', taskId: 'task-1' })) {
  return {
    currentProjectId: 'proj-test',
    currentProjectPath: PROJECT_PATH,
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => []),
      getSession: vi.fn(getSession),
      getSessionTaskId: vi.fn(() => null as string | null),
      getSessionProjectId: vi.fn(() => 'proj-test' as string | undefined),
      getSessionAgentName: vi.fn(() => undefined),
      getUsageCache: vi.fn(() => ({})),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), cancel: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude', path: PROJECT_PATH })) },
  };
}

function fireExit(
  getSession: (() => { id: string; taskId: string } | undefined) = () => ({ id: 'pty-1', taskId: 'task-1' }),
  sessionId = 'pty-1',
  exitCode = 0,
) {
  const context = buildMockContext(getSession);
  registerSessionHandlers(context as never);
  const exitHandler = capturedSessionEventHandlers.get('exit');
  if (!exitHandler) throw new Error('exit handler was not registered');
  exitHandler(sessionId, exitCode);
  return context;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedSessionEventHandlers.clear();
  markRecordExitedMock.mockReturnValue(true);
  markRecordSuspendedMock.mockReturnValue(true);
  isShuttingDownMock.mockReturnValue(false);
  mockFindByAnyId.mockReturnValue(null);
  mockFallbackGet.mockReturnValue(undefined);
  mockTaskRepoGetById.mockReturnValue(null);
  hoisted.resolveDefaultBaseBranch.mockReturnValue(RESOLVED_BRANCH);
});

describe('PTY exit listener: git-churn capture wiring', () => {
  it('captures git churn when `session` is present at exit time and resolves to a task', () => {
    mockFindByAnyId.mockReturnValue({
      id: 'rec-exit', status: 'running', started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    });
    const task = { id: 'task-1', worktree_path: null, base_branch: null };
    mockTaskRepoGetById.mockReturnValue(task);

    fireExit(() => ({ id: 'pty-1', taskId: 'task-1' }));

    expect(mockTaskRepoGetById).toHaveBeenCalledWith('task-1');
    expect(hoisted.resolveDefaultBaseBranch).toHaveBeenCalledWith(expect.anything(), PROJECT_PATH);
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      task,
      expect.anything(),
      expect.anything(),
      'rec-exit',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
  });

  it('does NOT capture git churn when `session` is absent at exit time (exit-by-agent-id fallback)', () => {
    // Manager has no entry for this session id (session already removed /
    // never registered) - the fallback path resolves the record by
    // agent_session_id instead, which has no taskId to resolve a task from.
    mockFallbackGet.mockReturnValue({
      id: 'rec-fallback', status: 'running', started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    });

    fireExit(() => undefined);

    expect(mockTaskRepoGetById).not.toHaveBeenCalled();
    expect(hoisted.captureGitChurn).not.toHaveBeenCalled();
  });

  it('does NOT capture git churn when `session` is present but the task lookup misses', () => {
    mockFindByAnyId.mockReturnValue({
      id: 'rec-exit', status: 'running', started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    });
    mockTaskRepoGetById.mockReturnValue(null); // task was deleted/archived

    fireExit(() => ({ id: 'pty-1', taskId: 'task-1' }));

    expect(mockTaskRepoGetById).toHaveBeenCalledWith('task-1');
    expect(hoisted.captureGitChurn).not.toHaveBeenCalled();
  });
});

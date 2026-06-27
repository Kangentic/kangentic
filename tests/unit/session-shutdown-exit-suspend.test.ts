/**
 * Shutdown-race hardening in the PTY `exit` listener (registerSessionHandlers,
 * src/main/ipc/handlers/sessions.ts).
 *
 * On a clean quit, syncShutdownCleanup marks running records 'suspended' before
 * killAll. But a PTY can die first and reach the onExit listener before that
 * runs (and an OS shutdown can race the same way). Recording an abnormal
 * 'exited' there would force startup recovery to reinterpret it via the
 * interrupted-exited gather; marking 'suspended' keeps it on the clean resume
 * path. This is the belt to startup recovery's suspenders - it narrows the
 * app-initiated-shutdown window (power loss / SIGKILL leaves isShuttingDown()
 * false, where startup recovery remains the real fix).
 *
 * Behavior under test (only the exit listener's DB persistence):
 *   - isShuttingDown() && record running -> markRecordSuspended('system')
 *   - NOT shutting down -> markRecordExited (+ exit_code) [regression]
 *   - shutting down but record 'queued' -> markRecordExited (queued never
 *     started a CLI; matches syncShutdownCleanup)
 *
 * Harness mirrors session-spawn-analytics.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, SessionRecord } from '../../src/shared/types';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// The fallback path queries `SELECT id, status ... WHERE agent_session_id = ?`;
// mockFallbackGet controls what that returns (undefined by default).
const mockFallbackGet = vi.fn((): { id: string; status: string } | undefined => undefined);
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({ prepare: vi.fn(() => ({ get: mockFallbackGet, run: vi.fn() })) })),
}));

const mockFindByAnyId = vi.fn(() => null as SessionRecord | null);
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

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
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
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({ captureSessionMetrics: vi.fn() }));
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

function buildMockContext() {
  return {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => [] as Session[]),
      getSession: vi.fn(() => ({ id: 'pty-1', taskId: 'task-1' })),
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
    projectRepo: { getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })) },
  };
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'rec-1',
    task_id: 'task-1',
    session_type: 'claude',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-1',
    command: 'claude',
    cwd: '/p',
    permission_mode: 'default',
    prompt: null,
    status: 'running',
    exit_code: null,
    started_at: '2026-06-06T10:00:00.000Z',
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

function fireExit(sessionId: string, exitCode: number) {
  const context = buildMockContext();
  registerSessionHandlers(context as never);
  const exitHandler = capturedSessionEventHandlers.get('exit');
  if (!exitHandler) throw new Error('exit handler was not registered');
  exitHandler(sessionId, exitCode);
}

/**
 * Like fireExit, but forwards the `intentional` flag and returns the context
 * so the test can assert on the renderer-bound webContents.send payload.
 */
function fireExitReturningContext(sessionId: string, exitCode: number, intentional?: boolean) {
  const context = buildMockContext();
  registerSessionHandlers(context as never);
  const exitHandler = capturedSessionEventHandlers.get('exit');
  if (!exitHandler) throw new Error('exit handler was not registered');
  exitHandler(sessionId, exitCode, intentional);
  return context;
}

const SESSION_EXIT_CHANNEL = 'session:exit';

beforeEach(() => {
  vi.clearAllMocks();
  capturedSessionEventHandlers.clear();
  markRecordExitedMock.mockReturnValue(true);
  markRecordSuspendedMock.mockReturnValue(true);
  isShuttingDownMock.mockReturnValue(false);
  mockFindByAnyId.mockReturnValue(null);
  mockFallbackGet.mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PTY exit listener: shutdown-race suspend hardening', () => {
  it('shutting down + running record -> persists suspended, not exited', () => {
    isShuttingDownMock.mockReturnValue(true);
    mockFindByAnyId.mockReturnValue(makeRecord({ id: 'rec-1', status: 'running' }));

    // Windows hard-kill code: must NOT be recorded as an abnormal exit.
    fireExit('pty-1', 1073807364);

    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'rec-1', 'system');
    expect(markRecordExitedMock).not.toHaveBeenCalled();
  });

  it('NOT shutting down -> persists exited with the exit code (regression)', () => {
    isShuttingDownMock.mockReturnValue(false);
    mockFindByAnyId.mockReturnValue(makeRecord({ id: 'rec-1', status: 'running' }));

    fireExit('pty-1', 1073807364);

    expect(markRecordExitedMock).toHaveBeenCalledWith(
      expect.anything(),
      'rec-1',
      expect.objectContaining({ exit_code: 1073807364 }),
    );
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();
  });

  it('shutting down but record is queued -> still exits (queued never started a CLI)', () => {
    isShuttingDownMock.mockReturnValue(true);
    mockFindByAnyId.mockReturnValue(makeRecord({ id: 'rec-q', status: 'queued' }));

    fireExit('pty-1', 143);

    expect(markRecordExitedMock).toHaveBeenCalledWith(
      expect.anything(),
      'rec-q',
      expect.objectContaining({ exit_code: 143 }),
    );
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();
  });

  it('shutdown + fallback match by agent_session_id (primary lookup misses) -> suspends', () => {
    // Primary findByAnyId misses (e.g. pre-insert window); the agent_session_id
    // fallback finds a running record. The same shutdown guard must apply there.
    isShuttingDownMock.mockReturnValue(true);
    mockFindByAnyId.mockReturnValue(null);
    mockFallbackGet.mockReturnValue({ id: 'rec-fallback', status: 'running' });

    fireExit('pty-1', 1073807364);

    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'rec-fallback', 'system');
    expect(markRecordExitedMock).not.toHaveBeenCalled();
  });
});

describe('PTY exit listener: intentional-suspend flag propagation to SESSION_EXIT', () => {
  // The flag rides the renderer-bound SESSION_EXIT event so App.tsx can suppress
  // the false "Session crashed" notification on a deliberate suspend without
  // depending on cross-channel SESSION_STATUS ordering. The forwarder must pass
  // it through unchanged as the trailing argument, after the resolved projectId.
  it('forwards intentional=true for a deliberate suspend force-kill', () => {
    const context = fireExitReturningContext('pty-1', 1073807364, true);

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      SESSION_EXIT_CHANNEL, 'pty-1', 1073807364, 'proj-test', true,
    );
  });

  it('forwards intentional=false for a genuine crash exit', () => {
    const context = fireExitReturningContext('pty-1', 1, false);

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      SESSION_EXIT_CHANNEL, 'pty-1', 1, 'proj-test', false,
    );
  });

  it('forwards intentional=undefined when the emitter omits the flag (back-compat)', () => {
    // Older emit sites (spawn failure, queued-session removal) pass no flag;
    // undefined is falsy, so the renderer still treats it as a crash.
    const context = fireExitReturningContext('pty-1', 1);

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      SESSION_EXIT_CHANNEL, 'pty-1', 1, 'proj-test', undefined,
    );
  });
});

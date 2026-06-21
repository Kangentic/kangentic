/**
 * Tests for the session-idle PR auto-link trigger in registerSessionHandlers.
 *
 * When an agent finishes its turn the session transitions to ActivityState
 * 'idle'. That is the catch-all signal that a PR may have just been created
 * mid-session (the move-time resolve fired before the PR existed, and the
 * gh-command sniffer misses a PR opened any other way). The 'activity' listener
 * fires `autoLinkPRForTask` for the session's task on 'idle' so the card links
 * within seconds instead of waiting for the periodic sweep.
 *
 * These tests verify the listener:
 *   - calls autoLinkPRForTask(context, taskId, projectId) on 'idle' for a real,
 *     non-transient session;
 *   - does NOT call it on 'thinking' (the agent is still working);
 *   - does NOT call it when the session has no task (taskId undefined);
 *   - does NOT call it for a transient (Command Terminal) session, whose
 *     synthetic taskId is not a real task row.
 *
 * Mock strategy mirrors session-idle-timeout.test.ts: electron/ipcMain, the DB
 * helpers, repositories, and the transition-engine chain are stubbed so
 * registerSessionHandlers can run headless; sessionManager.on is captured into a
 * Map; and pr-linking is mocked so autoLinkPRForTask is a spy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any imports of the mocked modules)
// ---------------------------------------------------------------------------

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

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

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    insert = vi.fn();
    aggregate = vi.fn(() => []);
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

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({})),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/mock/project' })),
}));

// The unit under test: autoLinkPRForTask is a spy so we assert it fires on idle.
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
}));

// Import under test AFTER all mocks are registered.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { autoLinkPRForTask } from '../../src/main/pr/pr-linking';

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      getSession: vi.fn(() => ({ transient: false })),
      getSessionTaskId: vi.fn(() => 'task-1' as string | null | undefined),
      getSessionProjectId: vi.fn(() => 'proj-1' as string | null | undefined),
      getSessionAgentName: vi.fn(() => 'claude'),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })),
    },
  };
}

function fireActivity(context: ReturnType<typeof createMockContext>, sessionId: string, state: string): void {
  const handler = capturedSessionEventHandlers.get('activity');
  if (!handler) throw new Error('activity handler was not registered');
  handler(sessionId, state, undefined);
}

describe('session-idle PR auto-link trigger', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    context = createMockContext();
    registerSessionHandlers(context as never);
  });

  it('fires autoLinkPRForTask on idle for a real, non-transient session', () => {
    fireActivity(context, 'sess-1', 'idle');

    expect(autoLinkPRForTask).toHaveBeenCalledTimes(1);
    expect(autoLinkPRForTask).toHaveBeenCalledWith(context, 'task-1', 'proj-1');
  });

  it('does NOT fire on thinking (the agent is still working)', () => {
    fireActivity(context, 'sess-1', 'thinking');

    expect(autoLinkPRForTask).not.toHaveBeenCalled();
  });

  it('does NOT fire on idle when the session has no task', () => {
    context.sessionManager.getSessionTaskId.mockReturnValue(undefined);

    fireActivity(context, 'sess-1', 'idle');

    expect(autoLinkPRForTask).not.toHaveBeenCalled();
  });

  it('does NOT fire for a transient (Command Terminal) session on idle', () => {
    context.sessionManager.getSession.mockReturnValue({ transient: true });

    fireActivity(context, 'sess-transient', 'idle');

    expect(autoLinkPRForTask).not.toHaveBeenCalled();
  });
});

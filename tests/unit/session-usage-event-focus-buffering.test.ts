/**
 * Tests for the `isFocusedSession` gate in registerSessionHandlers
 * (src/main/ipc/handlers/sessions.ts), which decides whether a 'usage' or
 * 'event' SessionManager emission broadcasts to the renderer immediately or
 * gets buffered into the 2s background flush (bufferedUsage / bufferedEvents
 * / BACKGROUND_FLUSH_MS).
 *
 * isFocusedSession is default-closed, matching SessionManager's own
 * focused-set contract (see session-manager-data-tap.test.ts): an empty
 * focused set means NO session is focused, so a background session's usage
 * and event emissions must buffer rather than broadcast per-emit. Red-green:
 * these fail if `focused.size === 0 ||` (the all-focused escape) is ever
 * restored to isFocusedSession.
 *
 * Mock strategy mirrors session-idle-pr-link.test.ts: electron/ipcMain, the
 * DB helpers, repositories, and the transition-engine chain are stubbed so
 * registerSessionHandlers can run headless; sessionManager.on is captured
 * into a Map; fake timers drive the 2s background flush deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any imports of the mocked modules)
// ---------------------------------------------------------------------------

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
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
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

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
}));

// Import under test AFTER all mocks are registered.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { IPC } from '../../src/shared/ipc-channels';

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

function fireUsage(context: ReturnType<typeof createMockContext>, sessionId: string, data: unknown): void {
  const handler = capturedSessionEventHandlers.get('usage');
  if (!handler) throw new Error('usage handler was not registered');
  handler(sessionId, data);
}

function fireEvent(context: ReturnType<typeof createMockContext>, sessionId: string, event: unknown): void {
  const handler = capturedSessionEventHandlers.get('event');
  if (!handler) throw new Error('event handler was not registered');
  handler(sessionId, event);
}

describe('sessions.ts isFocusedSession gate for usage/event background buffering', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    vi.useFakeTimers();
    context = createMockContext();
    registerSessionHandlers(context as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('buffers a usage event for an unfocused session instead of broadcasting it immediately', () => {
    // Default-closed: getFocusedSessions() returns an empty Set (the initial,
    // pre-first-push state), so 'sess-1' is NOT focused.
    fireUsage(context, 'sess-1', { totalTokens: 100 });

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('delivers the buffered usage event after the 2s background flush timer', () => {
    fireUsage(context, 'sess-1', { totalTokens: 100 });
    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_USAGE,
      'sess-1',
      { totalTokens: 100 },
      'proj-1',
    );
  });

  it('broadcasts a usage event immediately for a focused session (no buffering)', () => {
    context.sessionManager.getFocusedSessions.mockReturnValue(new Set(['sess-1']));

    fireUsage(context, 'sess-1', { totalTokens: 100 });

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_USAGE,
      'sess-1',
      { totalTokens: 100 },
      'proj-1',
    );
    // No flush timer needed - it landed on the immediate path.
    expect(context.mainWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('buffers an event for an unfocused session instead of sending it immediately', () => {
    fireEvent(context, 'sess-1', { type: 'tool_start' });

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('delivers the buffered event after the 2s background flush timer', () => {
    fireEvent(context, 'sess-1', { type: 'tool_start' });
    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_EVENT,
      'sess-1',
      { type: 'tool_start' },
      'proj-1',
    );
  });

  it('sends an event immediately for a focused session (no buffering)', () => {
    context.sessionManager.getFocusedSessions.mockReturnValue(new Set(['sess-1']));

    fireEvent(context, 'sess-1', { type: 'tool_start' });

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_EVENT,
      'sess-1',
      { type: 'tool_start' },
      'proj-1',
    );
    expect(context.mainWindow.webContents.send).toHaveBeenCalledTimes(1);
  });
});

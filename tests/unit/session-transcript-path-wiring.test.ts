/**
 * How `registerSessionHandlers` (src/main/ipc/handlers/sessions.ts) wires the
 * transcript-path writer (`session-transcript-path.ts`) to the session manager.
 * `session-transcript-path.test.ts` calls `persistTranscriptPath` and
 * `forgetTranscriptPath` directly, so it cannot see WHERE the listeners call
 * them. Two placements matter and a refactor can move either without failing it:
 *
 * 1. The `usage` listener persists the path BEFORE its `mainWindow.isDestroyed()`
 *    early return. The session record needs the path whether or not a window is
 *    there to show the usage, and the resume check reads it long after the
 *    session folder is gone. Moved below the window check, a path reported
 *    while the window is closed or being recreated is never recorded.
 * 2. The `session-removed` listener forgets the session's remembered path. The
 *    writer skips a path it already wrote, so without the forget a session id
 *    that comes back reporting the same path (a record that was recreated, or
 *    removed and written again) is never written a second time.
 *
 * `session-transcript-path` is left real and its repository write is observed
 * through the mocked `SessionRepository.setTranscriptPath`, which answers
 * `true` like a real write that found its row: only a remembered path is
 * skipped, so "written again after removal" is a real signal and not the mock's
 * doing.
 *
 * Mock strategy mirrors session-removed-forwarding.test.ts: electron, the DB
 * helpers, the other repositories and the transition-engine chain are stubbed
 * so registerSessionHandlers runs headless, and every handler per event is
 * captured, since more than one listener subscribes to the same event name.
 *
 * Red-green: move `persistTranscriptPath(context, sessionId, data)` below the
 * `isDestroyed()` return in the `usage` listener and the first test fails;
 * delete `forgetTranscriptPath(sessionId)` from the `session-removed` listener
 * and the second fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '../../src/shared/types';

const capturedSessionEventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

const { mockBroadcast, setTranscriptPathMock } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
  setTranscriptPathMock: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  webContents: {
    fromId: vi.fn(() => undefined),
  },
}));

vi.mock('../../src/main/pop-out/window-broadcast', () => ({
  broadcast: mockBroadcast,
}));

// getOpenProjectDb is what the real writer reads; an open project database is a
// truthy handle, which is all the mocked repository below needs.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  getOpenProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
    findByAnyId = vi.fn(() => null);
    setTranscriptPath = (...args: unknown[]) => (setTranscriptPathMock as (...callArgs: unknown[]) => boolean)(...args);
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

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
  trackMilestone: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'main'),
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
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(() => undefined) },
}));

vi.mock('../../src/main/agent/message-trail-tracker', () => ({
  MessageTrailTracker: class {
    on = vi.fn();
    snapshot = vi.fn(() => ({}));
  },
}));

// Import under test AFTER all mocks are registered.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { forgetTranscriptPath } from '../../src/main/ipc/handlers/session-transcript-path';

const TRANSCRIPT_PATH = '/mock/.claude/projects/example/agent-1.jsonl';

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
        const handlers = capturedSessionEventHandlers.get(event) ?? [];
        handlers.push(handler);
        capturedSessionEventHandlers.set(event, handlers);
      }),
      listSessions: vi.fn(() => []),
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

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    pid: null,
    status: 'running',
    shell: '',
    cwd: '/mock/cwd',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    ...overrides,
  } as Session;
}

function fireUsage(sessionId: string, data: unknown): void {
  const handlers = capturedSessionEventHandlers.get('usage');
  if (!handlers || handlers.length === 0) throw new Error('usage handler was not registered');
  for (const handler of handlers) handler(sessionId, data);
}

function fireSessionRemoved(sessionId: string, session: Session): void {
  const handlers = capturedSessionEventHandlers.get('session-removed');
  if (!handlers || handlers.length === 0) throw new Error('session-removed handler was not registered');
  for (const handler of handlers) handler(sessionId, session);
}

describe('sessions.ts transcript-path wiring', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    setTranscriptPathMock.mockReturnValue(true);
    capturedSessionEventHandlers.clear();
    // The writer remembers each path it wrote in module state that outlives a test.
    forgetTranscriptPath('sess-1');
    vi.useFakeTimers();
    context = createMockContext();
    registerSessionHandlers(context as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the usage listener', () => {
    it('writes the reported path while the main window is destroyed, and shows the usage to no one', () => {
      context.mainWindow.isDestroyed.mockReturnValue(true);

      fireUsage('sess-1', { transcriptPath: TRANSCRIPT_PATH });

      expect(setTranscriptPathMock).toHaveBeenCalledTimes(1);
      expect(setTranscriptPathMock).toHaveBeenCalledWith('sess-1', TRANSCRIPT_PATH);
      // The window check still guards the broadcast and the background buffer.
      expect(mockBroadcast).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('writes the reported path while the main window is alive too', () => {
      fireUsage('sess-1', { transcriptPath: TRANSCRIPT_PATH });

      expect(setTranscriptPathMock).toHaveBeenCalledTimes(1);
      expect(setTranscriptPathMock).toHaveBeenCalledWith('sess-1', TRANSCRIPT_PATH);
    });
  });

  describe('the session-removed listener', () => {
    it('forgets the written path, so the same path reported again is written again', () => {
      fireUsage('sess-1', { transcriptPath: TRANSCRIPT_PATH });
      fireUsage('sess-1', { transcriptPath: TRANSCRIPT_PATH });
      // Dedupe is active: a repeated path costs no second write.
      expect(setTranscriptPathMock).toHaveBeenCalledTimes(1);

      fireSessionRemoved('sess-1', sessionFixture());
      fireUsage('sess-1', { transcriptPath: TRANSCRIPT_PATH });

      expect(setTranscriptPathMock).toHaveBeenCalledTimes(2);
      expect(setTranscriptPathMock).toHaveBeenLastCalledWith('sess-1', TRANSCRIPT_PATH);
    });
  });
});

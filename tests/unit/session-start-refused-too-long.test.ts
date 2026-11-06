/**
 * The `agent-start-refused` listener in registerSessionHandlers
 * (src/main/ipc/handlers/sessions.ts) reads `error.reason` off the refusal, so
 * it serves every AgentStartRefusedError and not only a missing folder.
 * session-idle-timeout.test.ts drives it with AgentCwdMissingError; this file
 * drives it with AgentCommandTooLongError and pins that the row and the DB
 * record both carry `prompt-too-long` and that the task is paused.
 *
 * Tier: Unit. The harness mocks mirror session-idle-timeout.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, SessionRecord } from '../../src/shared/types';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

const mockGetLatestForTask = vi.fn(() => null as SessionRecord | null);
const mockMarkLaunchFailed = vi.fn();
const mockSetStartBlockedReason = vi.fn();

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    markLaunchFailed = mockMarkLaunchFailed;
    setStartBlockedReason = mockSetStartBlockedReason;
    findByAnyId = vi.fn(() => undefined);
    getLatestForTask = mockGetLatestForTask;
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

const mockTaskRepositoryGetById = vi.fn((_taskId?: string) => null as { id: string; title: string } | null);
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = mockTaskRepositoryGetById;
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
  settleQueuedRecord: vi.fn(),
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
  default: { existsSync: vi.fn(() => false) },
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
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

const mockResumeTaskSession = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/handlers/session-resume', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/handlers/session-resume')>()),
  resumeTaskSession: mockResumeTaskSession,
}));

import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { AgentCommandTooLongError } from '../../src/main/pty/spawn/pty-spawn';
import { notifySpawnBlocked } from '../../src/main/ipc/helpers';
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';

const QUEUED_SESSION = {
  id: 'sess-queued',
  taskId: 'task-queued',
  transient: false,
  status: 'queued',
  resuming: false,
  projectId: 'proj-1',
} as Session;

function registerWithQueuedSession(task: { id: string; title: string }) {
  vi.clearAllMocks();
  capturedSessionEventHandlers.clear();
  mockGetLatestForTask.mockReturnValue({
    id: 'sess-queued',
    task_id: 'task-queued',
    agent_session_id: 'agent-queued',
    status: 'queued',
    suspended_by: null,
  } as SessionRecord);
  mockGetProjectRepos.mockReturnValue({
    tasks: {
      getById: vi.fn(() => ({ id: 'task-queued', session_id: 'sess-queued', swimlane_id: 'lane-merge' })),
      update: vi.fn(),
    },
    swimlanes: { getById: vi.fn(() => null) },
  });
  const context = {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      getSession: vi.fn((sessionId?: string) => (sessionId === 'sess-queued' ? QUEUED_SESSION : null)),
      findLiveSessionByTaskId: vi.fn(() => undefined),
      getSessionProjectId: vi.fn(() => 'proj-1'),
      getSessionTaskId: vi.fn(() => null),
      listSessions: vi.fn(() => [] as Session[]),
      suspend: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      markStartBlocked: vi.fn(),
      retireRefusedStart: vi.fn(),
      isResuming: vi.fn(() => false),
      getActivityCache: vi.fn(() => ({})),
      getPendingDraft: vi.fn(() => null),
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
  mockTaskRepositoryGetById.mockReturnValue(task);
  registerSessionHandlers(context as never);
  return context;
}

describe('agent-start-refused listener with a command too long for its shell', () => {
  beforeEach(() => {
    capturedSessionEventHandlers.clear();
  });

  it('pauses the task and records prompt-too-long on the row, the record and the notice', async () => {
    const task = { id: 'task-queued', title: 'Long prompt' };
    const context = registerWithQueuedSession(task);
    const refusal = new AgentCommandTooLongError();

    capturedSessionEventHandlers.get('agent-start-refused')?.('sess-queued', QUEUED_SESSION, refusal);
    await withTaskLock('task-queued', async () => {});

    await vi.waitFor(() => expect(context.sessionManager.markStartBlocked).toHaveBeenCalledWith('sess-queued', 'prompt-too-long'));
    expect(mockSetStartBlockedReason).toHaveBeenCalledWith('sess-queued', 'prompt-too-long');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-queued');
    expect(mockMarkLaunchFailed).toHaveBeenCalledWith('sess-queued');
    expect(notifySpawnBlocked).toHaveBeenCalledWith(context, task, 'agent', refusal, 'proj-1');
    expect(context.sessionManager.retireRefusedStart).not.toHaveBeenCalled();
  });
});

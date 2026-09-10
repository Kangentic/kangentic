/**
 * Tests the IPC.TASK_RESOLVE_PR handler's no-project early return
 * (registerSessionHandlers in src/main/ipc/handlers/sessions.ts).
 *
 * When no project id resolves (neither the caller-supplied `projectId` nor
 * `context.currentProjectId`), the handler must return
 * `reason: 'resolver-unavailable'`, NOT `reason: 'no-anchor'`. The
 * distinction is load-bearing: `no-anchor` means the TASK itself has nothing
 * recorded to search by (no PR number, no branch, no commit), which
 * TaskDetailHeader.tsx toasts as "nothing was searched, add an anchor first".
 * `resolver-unavailable` is TaskDetailHeader's "could not reach the PR host"
 * branch, which is the correct message when there is no project open at all -
 * the handler never got far enough to look at the task.
 *
 * Mock strategy mirrors session-branch-pushed-record.test.ts: mock every
 * module registerSessionHandlers imports so the real handler body runs
 * unmodified, then capture the ipcMain.handle registration for
 * IPC.TASK_RESOLVE_PR and invoke it directly (no Electron, no IPC transport).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  linkPRForTask: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

import { ipcMain } from 'electron';
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { linkPR } from '../../src/main/pr/pr-linking';
import { IPC } from '../../src/shared/ipc-channels';
import type { TaskResolvePrResult } from '../../src/shared/types';

function createMockContext(currentProjectId: string | null) {
  return {
    currentProjectId,
    currentProjectPath: currentProjectId ? '/mock/project' : null,
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      getSession: vi.fn(() => ({ transient: false })),
      getSessionTaskId: vi.fn(() => null),
      getSessionProjectId: vi.fn(() => null),
      getSessionAgentName: vi.fn(() => 'claude'),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn(),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    projectRepo: {
      getById: vi.fn(() => null),
    },
  };
}

/** Find the handler function registered for `channel` via ipcMain.handle. */
function findHandler(channel: string): (...args: unknown[]) => unknown {
  const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
  const registration = handleMock.mock.calls.find((call) => call[0] === channel);
  if (!registration) throw new Error(`No ipcMain.handle registration found for channel "${channel}"`);
  return registration[1] as (...args: unknown[]) => unknown;
}

describe('IPC.TASK_RESOLVE_PR - no project open', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns resolver-unavailable (not no-anchor) when neither projectId arg nor currentProjectId resolves', async () => {
    const context = createMockContext(null);
    registerSessionHandlers(context as never);
    const handler = findHandler(IPC.TASK_RESOLVE_PR);

    const result = (await handler(null, 'task-1', null)) as TaskResolvePrResult;

    expect(result).toEqual({
      task: null,
      linked: false,
      reason: 'resolver-unavailable',
      message: 'No project is open',
    });
    // The handler must bail before ever resolving the task, so linkPR (the
    // IPC-side wrapper around the confidence ladder) is never reached with no
    // project to search in.
    expect(linkPR).not.toHaveBeenCalled();
  });

  it('also bails when the caller omits projectId entirely and no project is current', async () => {
    const context = createMockContext(null);
    registerSessionHandlers(context as never);
    const handler = findHandler(IPC.TASK_RESOLVE_PR);

    const result = (await handler(null, 'task-1')) as TaskResolvePrResult;

    expect(result.reason).toBe('resolver-unavailable');
    expect(result.message).toBe('No project is open');
  });

  it('proceeds to resolve (does not short-circuit) once a project is current', async () => {
    const context = createMockContext('proj-1');
    registerSessionHandlers(context as never);
    const handler = findHandler(IPC.TASK_RESOLVE_PR);

    await handler(null, 'task-1', null);

    expect(linkPR).toHaveBeenCalledTimes(1);
    expect(linkPR).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ projectId: 'proj-1', taskId: 'task-1', force: true }),
    );
  });
});

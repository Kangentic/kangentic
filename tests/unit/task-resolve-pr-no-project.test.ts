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
 *
 * The second describe block pins what the handler puts on the board-changed bus
 * for a resolve: one `task-updated` for the stamped project, whether linkPR
 * settles or rejects, and nothing when no project is open.
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
    boardEvents: {
      emitBoardChanged: vi.fn(),
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

describe('IPC.TASK_RESOLVE_PR - announces the resolve on the board-changed bus', () => {
  // linkPR is mocked here, so its `onLinked` never fires and any event on the
  // bus comes from the handler itself. That is the point: a resolve that only
  // wrote the head SHA or the pushed branch still changes the task row, and a
  // paired phone hears about it only if the handler announces. The resolve is
  // stamped for 'proj-other' while the ambient project is 'proj-1', so a
  // regression that announces for the ambient project fails.
  const STAMPED_PROJECT = 'proj-other';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a resolve linkPR reports unchanged emits task-updated once for the stamped project', async () => {
    const context = createMockContext('proj-1');
    registerSessionHandlers(context as never);
    const handler = findHandler(IPC.TASK_RESOLVE_PR);

    const result = (await handler(null, 'task-1', STAMPED_PROJECT)) as TaskResolvePrResult;

    expect(result.reason).toBe('unchanged');
    expect(linkPR).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ projectId: STAMPED_PROJECT, taskId: 'task-1', force: true }),
    );
    expect(context.boardEvents.emitBoardChanged.mock.calls).toEqual([
      [{ projectId: STAMPED_PROJECT, change: 'task-updated', ids: ['task-1'] }],
    ]);
  });

  it('emits after linkPR has settled, so a re-read sees what the resolve wrote', async () => {
    const context = createMockContext('proj-1');
    registerSessionHandlers(context as never);
    const handler = findHandler(IPC.TASK_RESOLVE_PR);
    let linkPRSettled = false;
    vi.mocked(linkPR).mockImplementationOnce(async () => {
      await Promise.resolve();
      linkPRSettled = true;
      return { status: 'unchanged', task: null } as Awaited<ReturnType<typeof linkPR>>;
    });
    let settledAtEmit: boolean | undefined;
    context.boardEvents.emitBoardChanged.mockImplementation(() => {
      settledAtEmit = linkPRSettled;
    });

    await handler(null, 'task-1', STAMPED_PROJECT);

    expect(context.boardEvents.emitBoardChanged).toHaveBeenCalledTimes(1);
    expect(settledAtEmit).toBe(true);
  });

  it('a linkPR that rejects still rejects with its error and still emits once', async () => {
    const context = createMockContext('proj-1');
    registerSessionHandlers(context as never);
    const handler = findHandler(IPC.TASK_RESOLVE_PR);
    vi.mocked(linkPR).mockRejectedValueOnce(new Error('gh exploded'));

    await expect(handler(null, 'task-1', STAMPED_PROJECT)).rejects.toThrow('gh exploded');

    expect(context.boardEvents.emitBoardChanged.mock.calls).toEqual([
      [{ projectId: STAMPED_PROJECT, change: 'task-updated', ids: ['task-1'] }],
    ]);
  });

  it('a resolve with no project open emits nothing', async () => {
    const context = createMockContext(null);
    registerSessionHandlers(context as never);
    const handler = findHandler(IPC.TASK_RESOLVE_PR);

    const result = (await handler(null, 'task-1', null)) as TaskResolvePrResult;

    expect(result.reason).toBe('resolver-unavailable');
    expect(context.boardEvents.emitBoardChanged).not.toHaveBeenCalled();
  });
});

/**
 * BACKLOG_PROMOTE AbortError cleanup invariants.
 *
 * The BACKLOG_PROMOTE handler returns Phase 1 (createdTasks) synchronously
 * and then runs Phase 2 (per-task worktree + spawn) in a fire-and-forget
 * IIFE serialized by withTaskLock. If Phase 2 hits an AbortError - typically
 * because BACKLOG_DEMOTE or TASK_MOVE called abortBacklogPromotion(taskId)
 * while we were inside ensureTaskWorktree - the cleanup branch must:
 *
 *   1. Remove the partial PTY mapping via sessionManager.removeByTaskId
 *   2. Null the task's session_id row
 *   3. Swallow the error (no throw out of the IIFE)
 *
 * The same regression class that bit TASK_MOVE in commit 796fdf2 (when the
 * abort-only cleanup was generalized into a unified rollback) can bite this
 * branch the same way. See split-lock-cas.test.ts for the TASK_MOVE analogue.
 *
 * Real implementations: task-lifecycle-lock and abort-utils.
 * Mocked: every repository, ensureTaskWorktree (the throw site), and the
 * agent helpers downstream of it.
 *
 * The same describe block also pins the Phase 2 spawnAgent call's argument
 * shape on the happy path (no abort): projectId/projectPath/fromSwimlaneId/
 * toLane must all be threaded through so the spawn preamble and
 * resolveSpawnOverrides resolve against the real project instead of null.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => Buffer.from('')),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

// Per-repo state captured at module scope so the test can drive return
// values and assert mock-call patterns directly.
const backlogRepoMock = {
  getById: vi.fn(),
  delete: vi.fn(),
  createFromTask: vi.fn(),
};
const taskRepoMock = {
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const swimlaneRepoMock = {
  getById: vi.fn(),
};
const sessionRepoMock = {
  getLatestForTask: vi.fn(() => null),
  insert: vi.fn(),
  updateStatus: vi.fn(),
};
const attachmentRepoMock = {
  add: vi.fn(),
  list: vi.fn(() => []),
  deleteByTaskId: vi.fn(),
};
const backlogAttachmentRepoMock = {
  add: vi.fn(),
  list: vi.fn(() => []),
  deleteByTaskId: vi.fn(),
};
const actionRepoMock = {
  getTransitionsFor: vi.fn(() => []),
};

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    getById = backlogRepoMock.getById;
    delete = backlogRepoMock.delete;
    createFromTask = backlogRepoMock.createFromTask;
  },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    create = taskRepoMock.create;
    getById = taskRepoMock.getById;
    update = taskRepoMock.update;
    delete = taskRepoMock.delete;
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    getById = swimlaneRepoMock.getById;
  },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class {
    getTransitionsFor = actionRepoMock.getTransitionsFor;
  },
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {
    add = attachmentRepoMock.add;
    list = attachmentRepoMock.list;
    deleteByTaskId = attachmentRepoMock.deleteByTaskId;
  },
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    add = backlogAttachmentRepoMock.add;
    list = backlogAttachmentRepoMock.list;
    deleteByTaskId = backlogAttachmentRepoMock.deleteByTaskId;
  },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = sessionRepoMock.getLatestForTask;
    insert = sessionRepoMock.insert;
    updateStatus = sessionRepoMock.updateStatus;
  },
}));

// task-move is pulled in transitively; keep it a noop.
vi.mock('../../src/main/ipc/handlers/task-move', () => ({
}));

// boards: registerBacklogHandlers calls registerAsanaIpcHandlers and the
// import handlers reach into boardRegistry / ImportSourceStore. None of that
// runs during BACKLOG_PROMOTE, but the imports must resolve to something.
vi.mock('../../src/main/boards', () => ({
  boardRegistry: {
    get: vi.fn(() => null),
    requireStable: vi.fn(),
  },
  ImportSourceStore: class {
    list = vi.fn(() => []);
    add = vi.fn();
    remove = vi.fn();
    updateLabel = vi.fn();
  },
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({
  registerAsanaIpcHandlers: vi.fn(),
}));

// Mocked IPC helpers - configured per test.
const mockEnsureTaskWorktree = vi.fn(async () => {});
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});
const mockCreateTransitionEngine = vi.fn(() => ({
  executeTransition: vi.fn(async () => {}),
  resumeSuspendedSession: vi.fn(async () => {}),
}));
const mockCleanupTaskResources = vi.fn(async () => {});
const mockGetProjectRepos = vi.fn();
const mockNotifySpawnBlocked = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  notifySpawnBlocked: (...args: unknown[]) => mockNotifySpawnBlocked(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  cleanupTaskResources: (...args: unknown[]) => mockCleanupTaskResources(...args),
}));

// Import under test AFTER all mocks are registered.
import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    sessionManager: {
      listSessions: vi.fn(() => []),
      removeByTaskId: vi.fn(),
    },
    terminalSubmitScheduler: {
      cancel: vi.fn(),
    },
  };
}

describe('BACKLOG_PROMOTE AbortError cleanup', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    // clearAllMocks only clears call records, not implementations. Reset the
    // helper mocks that future tests in this file might re-arm via
    // mockImplementation, then re-establish their no-op defaults.
    mockEnsureTaskWorktree.mockReset();
    mockEnsureTaskWorktree.mockImplementation(async () => {});
    mockEnsureTaskBranchCheckout.mockReset();
    mockEnsureTaskBranchCheckout.mockImplementation(async () => {});
    mockSpawnAgent.mockReset();
    mockSpawnAgent.mockImplementation(async () => {});

    backlogRepoMock.getById.mockReturnValue({
      id: 'backlog-1',
      title: 'Promote me',
      description: 'desc',
      labels: [],
      priority: 0,
    });
    taskRepoMock.create.mockReturnValue({
      id: 'task-promoted',
      title: 'Promote me',
      swimlane_id: 'lane-doing',
      session_id: null,
    });
    taskRepoMock.getById.mockReturnValue({
      id: 'task-promoted',
      title: 'Promote me',
      swimlane_id: 'lane-doing',
      session_id: null,
    });
    swimlaneRepoMock.getById.mockReturnValue({
      id: 'lane-doing',
      auto_spawn: true,
      role: null,
    });

    context = createMockContext();
    registerBacklogHandlers(context as never);
  });

  it('removes session, nulls session_id, and swallows the abort when ensureTaskWorktree aborts in Phase 2', async () => {
    mockEnsureTaskWorktree.mockImplementation(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    const handler = capturedHandlers.get(IPC.BACKLOG_PROMOTE);
    if (!handler) throw new Error('BACKLOG_PROMOTE handler not registered');

    // Phase 1 returns synchronously with createdTasks. The fire-and-forget
    // Phase 2 IIFE runs in the background; we must wait for it to settle.
    const created = await handler(null, {
      backlogTaskIds: ['backlog-1'],
      targetSwimlaneId: 'lane-doing',
    });

    expect(created).toEqual([
      expect.objectContaining({ id: 'task-promoted', swimlane_id: 'lane-doing' }),
    ]);

    // Wait for the IIFE's cleanup branch to run. tasks.update with
    // session_id: null is the last observable side effect of the abort path.
    await vi.waitFor(() => {
      expect(taskRepoMock.update).toHaveBeenCalledWith({
        id: 'task-promoted',
        session_id: null,
      });
    });

    // Cleanup of the partial PTY mapping must have run.
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith('task-promoted');

    // The abort must NOT have propagated downstream: spawn never ran and the
    // post-worktree branch checkout never ran.
    expect(mockEnsureTaskBranchCheckout).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();

    // isAbortError re-throws before the notifySpawnBlocked call, so an abort
    // is silent by design - the abort itself already carries no user-actionable
    // information, unlike the arbitrary-failure case pinned below. This is the
    // other side of that boundary: the notify call must not fire here.
    expect(mockNotifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('notifies via notifySpawnBlocked for a NON-abort worktree failure in Phase 2', async () => {
    // isAbortError re-throws an abort-classified rejection before the notify
    // call, which is why the abort test above never reaches this line. An
    // arbitrary git failure (not an AbortError) is the case that must notify
    // and then stop, rather than falling through to checkout/spawn or being
    // left as a console-only failure. Red-green: pre-fix this call site did
    // not exist (the notify call was added by this change), so reverting it
    // would leave mockNotifySpawnBlocked uncalled and this test red.
    mockEnsureTaskWorktree.mockImplementation(async () => {
      throw new Error("fatal: 'feature-x' is already used by worktree at '/repo'");
    });

    const handler = capturedHandlers.get(IPC.BACKLOG_PROMOTE);
    if (!handler) throw new Error('BACKLOG_PROMOTE handler not registered');

    await handler(null, {
      backlogTaskIds: ['backlog-1'],
      targetSwimlaneId: 'lane-doing',
    });

    // Phase 2 is a fire-and-forget IIFE; wait for the notify call to land.
    await vi.waitFor(() => {
      expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
    });

    const [, notifiedTask, step, , notifiedProjectId] = mockNotifySpawnBlocked.mock.calls[0];
    expect((notifiedTask as { id: string }).id).toBe('task-promoted');
    expect(step).toBe('worktree');
    expect(notifiedProjectId).toBe(context.currentProjectId);

    // A non-abort worktree failure must stop the chain right there: no
    // checkout attempt, no spawn.
    expect(mockEnsureTaskBranchCheckout).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('notifies via notifySpawnBlocked with step="checkout" for a NON-abort branch-checkout failure in Phase 2', async () => {
    // Mirrors the worktree-failure test above one stage later: the worktree
    // succeeds (the beforeEach default), and it is ensureTaskBranchCheckout
    // that fails here. The step literal is what the renderer uses to tell
    // this notice apart from a worktree failure, so pinning it is the point
    // of this test - a count-only assertion would stay green against a
    // copy-pasted 'worktree' at this call site. Red-green: flip backlog.ts's
    // 'checkout' literal at this call site to 'worktree' and this assertion
    // reds.
    const checkoutError = new Error('fatal: another agent is running in that directory');
    mockEnsureTaskBranchCheckout.mockImplementation(async () => {
      throw checkoutError;
    });

    const handler = capturedHandlers.get(IPC.BACKLOG_PROMOTE);
    if (!handler) throw new Error('BACKLOG_PROMOTE handler not registered');

    await handler(null, {
      backlogTaskIds: ['backlog-1'],
      targetSwimlaneId: 'lane-doing',
    });

    // Phase 2 is a fire-and-forget IIFE; wait for the notify call to land.
    await vi.waitFor(() => {
      expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
    });

    const [, notifiedTask, step, notifiedError, notifiedProjectId] = mockNotifySpawnBlocked.mock.calls[0];
    expect((notifiedTask as { id: string }).id).toBe('task-promoted');
    expect(step).toBe('checkout');
    expect(notifiedError).toBe(checkoutError);
    expect(notifiedProjectId).toBe(context.currentProjectId);

    // A checkout failure must stop the chain right there: no spawn.
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('threads projectId, projectPath, fromSwimlaneId, and the target swimlane into the Phase 2 spawnAgent call', async () => {
    // Regression guard: the promote path's spawnAgent call must carry the
    // resolved projectId/projectPath so the spawn preamble (first-spawn
    // override lock, agent resolution) and resolveSpawnOverrides' project
    // default fallback see the real project instead of resolving against
    // null. Without them the handler still compiles and every count-only
    // assertion (spawnAgent called / not called) stays green, so this test
    // inspects the actual argument object rather than just the call count.
    const handler = capturedHandlers.get(IPC.BACKLOG_PROMOTE);
    if (!handler) throw new Error('BACKLOG_PROMOTE handler not registered');

    await handler(null, {
      backlogTaskIds: ['backlog-1'],
      targetSwimlaneId: 'lane-doing',
    });

    // Phase 2 is a fire-and-forget IIFE; wait for the spawn call to land.
    await vi.waitFor(() => {
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    });

    const spawnAgentArgs = mockSpawnAgent.mock.calls[0][0] as {
      projectId: string;
      projectPath: string;
      fromSwimlaneId: string;
      toLane: { id: string };
    };
    expect(spawnAgentArgs.projectId).toBe(context.currentProjectId);
    expect(spawnAgentArgs.projectPath).toBe(context.currentProjectPath);
    expect(spawnAgentArgs.fromSwimlaneId).toBe('*');
    expect(spawnAgentArgs.toLane).toEqual(expect.objectContaining({ id: 'lane-doing' }));
  });
});

// ---------------------------------------------------------------------------
// BACKLOG_DEMOTE external-origin carry-back (dedup regression guard).
//
// The BACKLOG_DEMOTE handler must pass the task's external_id/source/url into
// createFromTask so that a demote -> reimport round-trip stays deduplicated.
// Without this, a promoted-then-demoted issue loses its external origin and
// can be imported a second time.
// ---------------------------------------------------------------------------

describe('BACKLOG_DEMOTE external-origin carry-back', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    mockEnsureTaskWorktree.mockReset();
    mockEnsureTaskWorktree.mockImplementation(async () => {});
    mockEnsureTaskBranchCheckout.mockReset();
    mockEnsureTaskBranchCheckout.mockImplementation(async () => {});
    mockSpawnAgent.mockReset();
    mockSpawnAgent.mockImplementation(async () => {});
    mockCleanupTaskResources.mockReset();
    mockCleanupTaskResources.mockImplementation(async () => {});

    // Wire getProjectRepos to return the module-scope repo spies so we can
    // assert on tasks.delete and attachments.list inside the demote handler.
    mockGetProjectRepos.mockReturnValue({
      tasks: {
        getById: taskRepoMock.getById,
        delete: taskRepoMock.delete,
      },
      attachments: {
        list: attachmentRepoMock.list,
        deleteByTaskId: attachmentRepoMock.deleteByTaskId,
      },
    });

    // The re-fetch at the end of the handler: backlogRepo.getById(backlogTask.id).
    // Return undefined so the handler returns the original backlogTask object
    // rather than a re-fetched one - the exact value is not important here.
    backlogRepoMock.getById.mockReturnValue(undefined);

    context = createMockContext();
    registerBacklogHandlers(context as never);
  });

  it('passes the task external origin to createFromTask so dedup survives a demote', async () => {
    // Arrange: a promoted board task that carries the GitHub issue origin.
    taskRepoMock.getById.mockReturnValue({
      id: 'task-with-origin',
      title: 'GitHub issue',
      description: 'Some description',
      labels: ['bug'],
      priority: 2,
      external_id: '77',
      external_source: 'github_issues',
      external_url: 'https://github.com/acme/repo/issues/77',
      session_id: null,
    });
    const newBacklogTask = {
      id: 'backlog-demoted',
      title: 'GitHub issue',
      description: 'Some description',
    };
    backlogRepoMock.createFromTask.mockReturnValue(newBacklogTask);

    const handler = capturedHandlers.get(IPC.BACKLOG_DEMOTE);
    if (!handler) throw new Error('BACKLOG_DEMOTE handler not registered');

    await handler(null, { taskId: 'task-with-origin' });

    // The external origin must be forwarded as the 5th arg to createFromTask.
    expect(backlogRepoMock.createFromTask).toHaveBeenCalledWith(
      'GitHub issue',
      'Some description',
      2,
      ['bug'],
      { externalId: '77', externalSource: 'github_issues', externalUrl: 'https://github.com/acme/repo/issues/77' },
    );
  });

  it('passes null origin fields when the task has no external origin', async () => {
    // A hand-written board task has all external_* columns as null.
    // createFromTask receives that null triple (not undefined) so
    // BacklogRepository.createFromTask can apply its own ?? undefined coercions.
    taskRepoMock.getById.mockReturnValue({
      id: 'task-no-origin',
      title: 'Manual task',
      description: 'desc',
      labels: [],
      priority: 0,
      external_id: null,
      external_source: null,
      external_url: null,
      session_id: null,
    });
    const newBacklogTask = { id: 'backlog-manual', title: 'Manual task', description: 'desc' };
    backlogRepoMock.createFromTask.mockReturnValue(newBacklogTask);

    const handler = capturedHandlers.get(IPC.BACKLOG_DEMOTE);
    if (!handler) throw new Error('BACKLOG_DEMOTE handler not registered');

    await handler(null, { taskId: 'task-no-origin' });

    expect(backlogRepoMock.createFromTask).toHaveBeenCalledWith(
      'Manual task',
      'desc',
      0,
      [],
      { externalId: null, externalSource: null, externalUrl: null },
    );
  });
});

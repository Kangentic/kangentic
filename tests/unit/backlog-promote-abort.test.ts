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
};
const taskRepoMock = {
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
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
  },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    create = taskRepoMock.create;
    getById = taskRepoMock.getById;
    update = taskRepoMock.update;
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

// task-move only used for guardActiveNonWorktreeSessions - keep it a noop.
vi.mock('../../src/main/ipc/handlers/task-move', () => ({
  guardActiveNonWorktreeSessions: vi.fn(),
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

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
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
  });
});

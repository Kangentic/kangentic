/**
 * Unit tests for the task-archive IPC handlers:
 *   TASK_LIST_ARCHIVED, TASK_UNARCHIVE, TASK_BULK_UNARCHIVE
 *
 * Pattern mirrors bulk-delete-handler.test.ts: capture the function registered
 * with ipcMain.handle and invoke it directly. All dependencies are mocked so
 * no Electron binary or real filesystem is needed.
 *
 * task-lifecycle-lock is the REAL implementation so lock serialization
 * behavior is observable in the TASK_UNARCHIVE / TASK_BULK_UNARCHIVE tests.
 *
 * Covers:
 *   TASK_LIST_ARCHIVED
 *     - delegates to tasks.listArchived() and returns the result
 *
 *   TASK_UNARCHIVE
 *     - no-project throw: throws when context.currentProjectId is null
 *     - auto_spawn=false early return: returns task without spawning
 *     - worktree error branch: ensureTaskWorktree throws, returns task, no spawn
 *     - checkout error branch: ensureTaskBranchCheckout throws, returns task, no spawn
 *     - no done-lane branch: skips the spawn when no role='done' lane
 *     - routes through the shared spawnAgent chokepoint with the recovery-move
 *       contract: fromSwimlaneId=doneLane.id, skipPromptTemplate,
 *       suppressAutoCommand, projectId/projectPath threaded, and
 *       settingsSourceLane OMITTED (the destination the user picked is the
 *       settings lane for a never-spawned unarchived task). Engine-level
 *       behavior (transition, fallback resume, the first-spawn override lock,
 *       actual auto-command suppression) is spawnAgent's responsibility,
 *       covered by the spawn-agent-*.test.ts harness suites.
 *     - withTaskLock serialization: concurrent calls for the same id serialize;
 *       different ids run independently
 *     - lane order: every restore writes the target lane's order back through
 *       reorderWithinSwimlane (restoredLaneOrder), at the requested index or last,
 *       with the restored id once even when the lane list already holds it
 *     - resetSessionForTodoRestore: restoring into a role='todo' lane runs the
 *       SESSION-ONLY reset (cleanupTaskSession), never the full resource
 *       teardown (cleanupTaskResources), which force-deletes the branch when
 *       git.autoCleanup is on. A dedicated regression test pins this for a
 *       task whose worktree_path AND branch_name are both still set (the
 *       failed-Done-cleanup state) and asserts branch_name survives on the
 *       restored row. A non-todo lane runs neither cleanup path.
 *     - held messages: a restore into a role='todo' lane clears the task's held
 *       messages (clearHeldMessages, against the restore's own project id, even
 *       when the teardown after it throws); a non-todo lane that starts no agent
 *       and an auto-spawn lane do not
 *
 *   TASK_BULK_UNARCHIVE
 *     - auto_spawn=false lane skips spawn for every task in the batch
 *     - each restored task is written last in the lane, the second behind the first
 *     - per-task worktree error is caught; subsequent tasks still process
 *     - per-iteration lock is independent per id (different ids don't block)
 *     - every restored task goes through spawnAgent with the same
 *       recovery-move contract as the single handler
 *     - resetSessionForTodoRestore: same session-only-reset / branch-survival
 *       regression coverage as TASK_UNARCHIVE, applied per task in the batch
 *
 *   Both restores reach a paired phone
 *     - each emits task-updated on the board-changed bus once, after the row
 *       is unarchived, so the automations switch the restore cleared is what
 *       the phone re-reads; that includes a restore whose spawn fails, and a
 *       restore into a column that starts no agent (no session edge fires)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

// p-queue is NOT mocked here. task-lifecycle-lock uses the real p-queue
// (concurrency:1) to provide actual serialization. Stubbing p-queue would
// cause withTaskLock to run all tasks inline (no queuing), which would make
// the lock-serialization assertions vacuously pass or fail depending on the
// stub's implementation. task-archive.ts does not use PQueue directly, so
// there is no interference from leaving p-queue real.

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({})),
}));

// DB layer - not exercised directly (getProjectRepos is mocked)
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {},
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {},
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    removeWorktree = vi.fn(async () => true);
  },
}));

vi.mock('../../src/main/git/git-checks', () => ({
  isAutoGeneratedBranch: vi.fn(() => false),
}));

vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchIfStale: vi.fn(async () => 'main'),
}));

vi.mock('../../src/main/git/node-modules-link', () => ({
  linkNodeModules: vi.fn(),
  removeNodeModulesPath: vi.fn(),
}));

vi.mock('../../src/main/config/config-manager', () => ({
  ConfigManager: class {
    getEffectiveConfig = vi.fn(() => ({ git: { defaultBaseBranch: 'main' } }));
  },
}));

// task-lifecycle-lock: use the REAL implementation so lock semantics are preserved
// (TASK_UNARCHIVE and TASK_BULK_UNARCHIVE wrap each task in withTaskLock)

// Mocked helpers - configured per test
const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => null);
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockCreateTransitionEngine = vi.fn();
const mockSpawnAgent = vi.fn(async () => {});
// cleanupTaskSession (session-only teardown, preserves worktree + branch) and
// cleanupTaskResources (full teardown, force-deletes the branch when
// git.autoCleanup is on) are separate spies so resetSessionForTodoRestore's
// regression tests can assert exactly ONE of them ran. See the "regression
// guard" tests under TASK_UNARCHIVE / TASK_BULK_UNARCHIVE below.
const mockCleanupTaskSession = vi.fn(async () => {});
const mockCleanupTaskResources = vi.fn(async () => {});
const mockNotifySpawnBlocked = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  notifySpawnBlocked: (...args: unknown[]) => mockNotifySpawnBlocked(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  cleanupTaskSession: (...args: unknown[]) => mockCleanupTaskSession(...args),
  cleanupTaskResources: (...args: unknown[]) => mockCleanupTaskResources(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({
  handleTaskMove: vi.fn(async () => {}),
}));

// A restore into To Do clears the messages held for the task's next agent.
// Mocked so the tests observe the call itself: the real function swallows every
// error behind a try/catch, so against the stubbed project DB it would "pass"
// whether or not task-archive.ts ever called it.
const mockClearHeldMessages = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/held-messages/held-messages', () => ({
  clearHeldMessages: (...args: unknown[]) => mockClearHeldMessages(...args),
}));

// ---------------------------------------------------------------------------
// Capture handlers registered by ipcMain.handle
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTaskArchiveHandlers } from '../../src/main/ipc/handlers/task-archive';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

interface MockTask {
  id: string;
  title: string;
  swimlane_id: string;
  worktree_path: string | null;
  session_id: string | null;
  branch_name: string | null;
  base_branch: string | null;
}

interface MockSwimlane {
  id: string;
  role: string | null;
  auto_spawn: boolean;
  auto_command: string | null;
  permission_mode: string | null;
}

interface MockTaskRepo {
  listArchived: ReturnType<typeof vi.fn>;
  listArchivedPreview: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  unarchive: ReturnType<typeof vi.fn>;
  // Every restore writes the target lane's order back, so a fake without it
  // would throw from the handler. Tests that care read its calls.
  reorderWithinSwimlane: ReturnType<typeof vi.fn>;
}

interface MockSwimlaneRepo {
  list: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
}

interface MockEngine {
  executeTransition: ReturnType<typeof vi.fn>;
  resumeSuspendedSession: ReturnType<typeof vi.fn>;
}

interface MockContext {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  mainWindow: {
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn> };
  };
  sessionManager: {
    listSessions: ReturnType<typeof vi.fn>;
    getActivityCache: ReturnType<typeof vi.fn>;
  };
  configManager: {
    getEffectiveConfig: ReturnType<typeof vi.fn>;
  };
  boardConfigManager: {
    getDefaultBaseBranch: ReturnType<typeof vi.fn>;
    getBoardProfiles: ReturnType<typeof vi.fn>;
  };
  terminalSubmitScheduler: {
    scheduleKeystrokes: ReturnType<typeof vi.fn>;
  };
  projectRepo: {
    getById: ReturnType<typeof vi.fn>;
  };
  boardEvents: {
    emitBoardChanged: ReturnType<typeof vi.fn>;
  };
}

function createMockTask(id: string, overrides: Partial<MockTask> = {}): MockTask {
  return {
    id,
    title: `Task ${id}`,
    swimlane_id: 'lane-todo',
    worktree_path: null,
    session_id: null,
    branch_name: null,
    base_branch: null,
    ...overrides,
  };
}

function createMockSwimlane(id: string, overrides: Partial<MockSwimlane> = {}): MockSwimlane {
  return {
    id,
    role: null,
    auto_spawn: true,
    auto_command: null,
    permission_mode: null,
    ...overrides,
  };
}

function createMockTaskRepo(tasks: MockTask[]): MockTaskRepo {
  const taskMap = new Map(tasks.map((task) => [task.id, { ...task }]));
  return {
    listArchived: vi.fn(() => Array.from(taskMap.values())),
    listArchivedPreview: vi.fn((limit: number) => {
      const all = Array.from(taskMap.values());
      return { totalCount: all.length, tasks: all.slice(0, Math.max(1, Math.min(100, Math.floor(limit)))) };
    }),
    list: vi.fn((_swimlaneId?: string) => Array.from(taskMap.values())),
    getById: vi.fn((id: string) => taskMap.get(id) ?? null),
    unarchive: vi.fn((id: string, targetSwimlaneId: string, _position: number) => {
      const task = taskMap.get(id);
      if (!task) throw new Error(`Task ${id} not found`);
      task.swimlane_id = targetSwimlaneId;
      return task;
    }),
    reorderWithinSwimlane: vi.fn(),
  };
}

function createMockSwimlaneRepo(swimlanes: MockSwimlane[]): MockSwimlaneRepo {
  const laneMap = new Map(swimlanes.map((lane) => [lane.id, lane]));
  return {
    list: vi.fn(() => Array.from(laneMap.values())),
    getById: vi.fn((id: string) => laneMap.get(id) ?? null),
  };
}

function createMockEngine(): MockEngine {
  return {
    executeTransition: vi.fn(async () => ({ outcomes: [], failures: [], startedAgent: false })),
    resumeSuspendedSession: vi.fn(async () => {}),
  };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    currentProjectId: 'proj-123',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => []),
      getActivityCache: vi.fn(() => ({})),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
      getBoardProfiles: vi.fn(() => []),
    },
    terminalSubmitScheduler: {
      scheduleKeystrokes: vi.fn(),
    },
    projectRepo: {
      getById: vi.fn(() => ({ id: 'proj-123', default_agent: 'claude', default_model: null, default_effort: null })),
    },
    boardEvents: {
      emitBoardChanged: vi.fn(),
    },
    ...overrides,
  };
}

// Invoke a captured handler directly. The first argument (Electron Event
// object) is unused by all three archive handlers - pass null as a stand-in.
async function callHandler<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`Handler for ${channel} was not registered`);
  return handler(null, ...args) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('task-archive handlers', () => {
  let context: MockContext;
  let taskRepo: MockTaskRepo;
  let swimlaneRepo: MockSwimlaneRepo;

  // Swimlanes used across most tests:
  //   - doneLane: role='done' (the source for unarchive transitions)
  //   - targetLane: auto_spawn=true (default happy path target)
  let doneLane: MockSwimlane;
  let targetLane: MockSwimlane;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    doneLane = createMockSwimlane('lane-done', { role: 'done', auto_spawn: false });
    targetLane = createMockSwimlane('lane-doing', { role: null, auto_spawn: true });

    context = createMockContext();

    taskRepo = createMockTaskRepo([]);
    swimlaneRepo = createMockSwimlaneRepo([doneLane, targetLane]);

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { deleteByTaskId: vi.fn() },
    });

    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);

    const engine = createMockEngine();
    mockCreateTransitionEngine.mockReturnValue(engine);

    // The `as never` cast sidesteps the full IpcContext shape requirement.
    // Only the subset used by task-archive handlers is provided.
    registerTaskArchiveHandlers(context as never);
  });

  // =========================================================================
  // TASK_LIST_ARCHIVED
  // =========================================================================

  describe('TASK_LIST_ARCHIVED', () => {
    it('delegates to tasks.listArchived() and returns the result', async () => {
      const archived = [
        createMockTask('task-a'),
        createMockTask('task-b'),
      ];
      taskRepo.listArchived.mockReturnValue(archived);

      const result = await callHandler(IPC.TASK_LIST_ARCHIVED);

      expect(taskRepo.listArchived).toHaveBeenCalledTimes(1);
      expect(result).toEqual(archived);
    });

    it('returns an empty array when there are no archived tasks', async () => {
      taskRepo.listArchived.mockReturnValue([]);

      const result = await callHandler(IPC.TASK_LIST_ARCHIVED);

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // TASK_LIST_ARCHIVED_PREVIEW
  // =========================================================================

  describe('TASK_LIST_ARCHIVED_PREVIEW', () => {
    it('delegates to tasks.listArchivedPreview(limit) and returns the { totalCount, tasks } shape', async () => {
      const preview = { totalCount: 42, tasks: [createMockTask('task-a')] };
      taskRepo.listArchivedPreview.mockReturnValue(preview);

      const result = await callHandler(IPC.TASK_LIST_ARCHIVED_PREVIEW, 15);

      expect(taskRepo.listArchivedPreview).toHaveBeenCalledTimes(1);
      expect(taskRepo.listArchivedPreview).toHaveBeenCalledWith(15);
      expect(result).toEqual(preview);
    });

    it('forwards the requested limit to the repository', async () => {
      taskRepo.listArchivedPreview.mockReturnValue({ totalCount: 0, tasks: [] });

      await callHandler(IPC.TASK_LIST_ARCHIVED_PREVIEW, 5);

      expect(taskRepo.listArchivedPreview).toHaveBeenCalledWith(5);
    });
  });

  // =========================================================================
  // TASK_UNARCHIVE
  // =========================================================================

  describe('TASK_UNARCHIVE', () => {
    it('throws when context.currentProjectId is null', async () => {
      context.currentProjectId = null;
      // Re-register with the updated context so the handler closure captures null
      capturedHandlers.clear();
      registerTaskArchiveHandlers(context as never);

      await expect(
        callHandler(IPC.TASK_UNARCHIVE, { id: 'task-1', targetSwimlaneId: 'lane-doing' }),
      ).rejects.toThrow('No project is currently open');
    });

    it('returns task without spawning when target lane has auto_spawn=false', async () => {
      const noSpawnLane = createMockSwimlane('lane-backlog', { auto_spawn: false });
      swimlaneRepo = createMockSwimlaneRepo([doneLane, noSpawnLane]);
      const task = createMockTask('task-nospawn');
      taskRepo = createMockTaskRepo([task]);

      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      const result = await callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-nospawn',
        targetSwimlaneId: 'lane-backlog',
      });

      expect(result).toMatchObject({ id: 'task-nospawn' });
      expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
      expect(mockCreateTransitionEngine).not.toHaveBeenCalled();
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    // A card dragged out of Done onto a lane passes the slot that lane's cards
    // parted at (the board's drop gap). Any other restore passes none and lands
    // last. Either way the lane's order is written back (densely, by
    // `reorderWithinSwimlane`), so "last" holds on a lane whose stored positions
    // have gaps: a bare `position = laneTasks.length` would sort the card second
    // on a lane stored as 0, 5, 9.
    it('places the restored task at a position inside the lane, and last for none or one the lane cannot honor', async () => {
      const noSpawnLane = createMockSwimlane('lane-backlog', { auto_spawn: false });
      swimlaneRepo = createMockSwimlaneRepo([doneLane, noSpawnLane]);
      const restored = createMockTask('task-restored', { swimlane_id: 'lane-done' });
      const laneFirst = createMockTask('lane-first', { swimlane_id: 'lane-backlog' });
      const laneSecond = createMockTask('lane-second', { swimlane_id: 'lane-backlog' });
      const reorderWithinSwimlane = vi.fn();
      const repo = { ...createMockTaskRepo([restored, laneFirst, laneSecond]), reorderWithinSwimlane };
      repo.list = vi.fn((swimlaneId?: string) => (swimlaneId === 'lane-backlog' ? [laneFirst, laneSecond] : []));
      mockGetProjectRepos.mockReturnValue({
        tasks: repo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-restored', targetSwimlaneId: 'lane-backlog', position: 1 });

      expect(repo.unarchive).toHaveBeenCalledWith('task-restored', 'lane-backlog', 2);
      expect(reorderWithinSwimlane).toHaveBeenCalledWith('lane-backlog', ['lane-first', 'task-restored', 'lane-second']);

      reorderWithinSwimlane.mockClear();
      await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-restored', targetSwimlaneId: 'lane-backlog', position: 0 });
      expect(reorderWithinSwimlane).toHaveBeenCalledWith('lane-backlog', ['task-restored', 'lane-first', 'lane-second']);

      // 2 is the end slot of a two-card lane (honored); the rest are not whole
      // numbers inside the lane. All of them put the card last, and each still
      // writes the order back.
      for (const position of [undefined, 2, 7, -1, 0.5, Number.NaN]) {
        reorderWithinSwimlane.mockClear();
        await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-restored', targetSwimlaneId: 'lane-backlog', position });
        expect(reorderWithinSwimlane, `position ${String(position)}`).toHaveBeenCalledTimes(1);
        expect(reorderWithinSwimlane, `position ${String(position)}`).toHaveBeenCalledWith(
          'lane-backlog',
          ['lane-first', 'lane-second', 'task-restored'],
        );
      }
    });

    // The task being restored can already be a live row in the target lane, so
    // `tasks.list(targetSwimlaneId)` returns it among the lane's cards. The index
    // is into the OTHER cards: the id is placed once, and the bound is the lane
    // without it. Splicing it in over a list that already held it wrote it twice.
    describe('a restored task that is already a live row in the target lane', () => {
      function registerLaneHolding(laneCards: MockTask[]) {
        const noSpawnLane = createMockSwimlane('lane-backlog', { auto_spawn: false });
        swimlaneRepo = createMockSwimlaneRepo([doneLane, noSpawnLane]);
        const reorderWithinSwimlane = vi.fn();
        const repo = { ...createMockTaskRepo(laneCards), reorderWithinSwimlane };
        repo.list = vi.fn((swimlaneId?: string) => (swimlaneId === 'lane-backlog' ? laneCards : []));
        mockGetProjectRepos.mockReturnValue({
          tasks: repo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });
        return reorderWithinSwimlane;
      }

      function laneCardsWithRestoredSecond(): MockTask[] {
        return [
          createMockTask('lane-first', { swimlane_id: 'lane-backlog' }),
          createMockTask('task-restored', { swimlane_id: 'lane-backlog' }),
          createMockTask('lane-second', { swimlane_id: 'lane-backlog' }),
        ];
      }

      it('writes the id exactly once, at the requested index among the other cards', async () => {
        const expectedOrders: Array<[number, string[]]> = [
          [0, ['task-restored', 'lane-first', 'lane-second']],
          [1, ['lane-first', 'task-restored', 'lane-second']],
        ];
        for (const [position, expectedOrder] of expectedOrders) {
          const reorderWithinSwimlane = registerLaneHolding(laneCardsWithRestoredSecond());

          await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-restored', targetSwimlaneId: 'lane-backlog', position });

          expect(reorderWithinSwimlane).toHaveBeenCalledTimes(1);
          const [laneId, writtenOrder] = reorderWithinSwimlane.mock.calls[0] as [string, string[]];
          expect(laneId).toBe('lane-backlog');
          expect(writtenOrder).toEqual(expectedOrder);
          expect(writtenOrder.filter((taskId) => taskId === 'task-restored')).toHaveLength(1);
        }
      });

      it('puts it last, once, for the end slot among the other cards and for an index past it, though the lane list is one longer', async () => {
        // Three cards listed, but only two besides the restored one: index 2 is
        // the end slot of what remains (honored, so last), and 3 or none is
        // past it (also last). A bound counted over the lane list, restored id
        // included, would have written the id twice.
        for (const position of [2, 3, undefined]) {
          const reorderWithinSwimlane = registerLaneHolding(laneCardsWithRestoredSecond());

          await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-restored', targetSwimlaneId: 'lane-backlog', position });

          expect(reorderWithinSwimlane, `position ${String(position)}`).toHaveBeenCalledTimes(1);
          const [, writtenOrder] = reorderWithinSwimlane.mock.calls[0] as [string, string[]];
          expect(writtenOrder, `position ${String(position)}`).toEqual(['lane-first', 'lane-second', 'task-restored']);
          expect(writtenOrder.filter((taskId) => taskId === 'task-restored')).toHaveLength(1);
        }
      });
    });

    it('returns task without spawning when ensureTaskWorktree throws', async () => {
      const task = createMockTask('task-worktree-err');
      taskRepo = createMockTaskRepo([task]);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      mockEnsureTaskWorktree.mockRejectedValue(new Error('git worktree add failed'));

      const result = await callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-worktree-err',
        targetSwimlaneId: 'lane-doing',
      });

      expect(result).toMatchObject({ id: 'task-worktree-err' });
      expect(mockCreateTransitionEngine).not.toHaveBeenCalled();
      expect(mockSpawnAgent).not.toHaveBeenCalled();

      // The task is restored but the card would look identical to a healthy
      // spawn (null session, null worktree) unless the user is told the agent
      // did not start. Mirrors the assertion style already pinned for
      // TASK_BULK_UNARCHIVE below. Red-green: pre-fix this catch block only
      // ran console.error, so mockNotifySpawnBlocked would be uncalled here.
      expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
      const [, notifiedTask, step, , notifiedProjectId] = mockNotifySpawnBlocked.mock.calls[0];
      expect((notifiedTask as { id: string }).id).toBe('task-worktree-err');
      expect(step).toBe('worktree');
      expect(notifiedProjectId).toBe(context.currentProjectId);
    });

    it('returns task without spawning when ensureTaskBranchCheckout throws', async () => {
      const task = createMockTask('task-checkout-err');
      taskRepo = createMockTaskRepo([task]);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      mockEnsureTaskWorktree.mockResolvedValue(null);
      const checkoutError = new Error('branch locked by active session');
      mockEnsureTaskBranchCheckout.mockRejectedValue(checkoutError);

      const result = await callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-checkout-err',
        targetSwimlaneId: 'lane-doing',
      });

      expect(result).toMatchObject({ id: 'task-checkout-err' });
      expect(mockCreateTransitionEngine).not.toHaveBeenCalled();
      expect(mockSpawnAgent).not.toHaveBeenCalled();

      // Same notice contract as the worktree-error branch above, at the other
      // git step. The step literal is what discriminates the two notices in
      // the renderer, so pinning it here catches a copy-pasted 'worktree' at
      // this call site the same way task-create-handler.test.ts already does
      // for TASK_CREATE. Red-green: flip task-archive.ts's 'checkout' literal
      // at this call site to 'worktree' and this assertion reds.
      expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
      const [, checkoutNotifiedTask, checkoutStep, checkoutNotifiedError, checkoutNotifiedProjectId] =
        mockNotifySpawnBlocked.mock.calls[0];
      expect((checkoutNotifiedTask as { id: string }).id).toBe('task-checkout-err');
      expect(checkoutStep).toBe('checkout');
      expect(checkoutNotifiedError).toBe(checkoutError);
      expect(checkoutNotifiedProjectId).toBe(context.currentProjectId);
    });

    it('skips transition engine when no role=done lane exists', async () => {
      // Swimlanes with no role='done' entry
      const noRoleSwimlaneRepo = createMockSwimlaneRepo([
        createMockSwimlane('lane-a', { role: 'todo' }),
        targetLane,
      ]);
      const task = createMockTask('task-no-done');
      taskRepo = createMockTaskRepo([task]);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: noRoleSwimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      const result = await callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-no-done',
        targetSwimlaneId: 'lane-doing',
      });

      expect(result).toMatchObject({ id: 'task-no-done' });
      expect(mockCreateTransitionEngine).not.toHaveBeenCalled();
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Shared spawn chokepoint routing (the unarchive first-spawn contract)
    //
    // Unarchive is a first-ever-spawn entry point: a task created in To Do,
    // dragged to Done without spawning, and unarchived into a spawn column
    // truly first-spawns HERE. It must therefore route through spawnAgent,
    // whose preamble locks the Advanced overrides and resolves the agent -
    // and it must carry the recovery-move contract (skipPromptTemplate +
    // suppressAutoCommand: unarchive is always the first move out of Done,
    // so the session comes up idle for the user to inspect). Red-green: on
    // the pre-consolidation handler (its own executeTransition + fallback
    // block, no lock anywhere), spawnAgent is never called and this fails.
    // See .claude/rules/spawn-entry-point-parity.md.
    // -----------------------------------------------------------------------

    it('routes through spawnAgent with the recovery-move contract (doneLane source, suppress + skip, no settingsSourceLane)', async () => {
      const task = createMockTask('task-happy');
      taskRepo = createMockTaskRepo([task]);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      const engine = createMockEngine();
      mockCreateTransitionEngine.mockReturnValue(engine);

      await callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-happy',
        targetSwimlaneId: 'lane-doing',
      });

      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      const spawnArg = mockSpawnAgent.mock.calls[0][0] as {
        engine: MockEngine;
        tasks: MockTaskRepo;
        task: { id: string };
        fromSwimlaneId: string;
        toLane: MockSwimlane;
        skipPromptTemplate: boolean;
        suppressAutoCommand: boolean;
        projectId: string;
        projectPath: string;
      };
      expect(spawnArg.task).toMatchObject({ id: 'task-happy' });
      expect(spawnArg.fromSwimlaneId).toBe(doneLane.id);
      expect(spawnArg.toLane).toBe(targetLane);
      expect(spawnArg.skipPromptTemplate).toBe(true);
      expect(spawnArg.suppressAutoCommand).toBe(true);
      // settingsSourceLane OMITTED (not null): spawnAgent then locks against
      // the destination the user picked in the unarchive UI - Done's settings
      // were never shown in any dialog, and the config-time lane of a
      // never-spawned archived task is not recoverable.
      expect('settingsSourceLane' in spawnArg).toBe(false);
      // Project context threaded so the preamble sees project defaults.
      expect(spawnArg.projectId).toBe('proj-123');
      expect(spawnArg.projectPath).toBe('/mock/project');
      expect(spawnArg.engine).toBe(engine);
      expect(spawnArg.tasks).toBe(taskRepo);
    });

    it('threads onProgress + projectId into both git helpers', async () => {
      // Mirrors task-create-handler.test.ts's "threads onProgress + projectId
      // into both git helpers" test for the unarchive/restore entry point.
      const task = createMockTask('task-progress');
      taskRepo = createMockTaskRepo([task]);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      await callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-progress',
        targetSwimlaneId: 'lane-doing',
      });

      const worktreeOptions = mockEnsureTaskWorktree.mock.calls[0][4] as { onProgress?: unknown; projectId?: unknown };
      expect(typeof worktreeOptions.onProgress).toBe('function');
      expect(worktreeOptions.projectId).toBe('proj-123');

      const checkoutOptions = mockEnsureTaskBranchCheckout.mock.calls[0][3] as { onProgress?: unknown; projectId?: unknown };
      expect(typeof checkoutOptions.onProgress).toBe('function');
      expect(checkoutOptions.projectId).toBe('proj-123');
    });

    it('still returns the unarchived task when spawnAgent rejects', async () => {
      const task = createMockTask('task-spawn-err');
      taskRepo = createMockTaskRepo([task]);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });
      mockSpawnAgent.mockRejectedValueOnce(new Error('CLI not found'));

      const result = await callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-spawn-err',
        targetSwimlaneId: 'lane-doing',
      });

      expect(result).toMatchObject({ id: 'task-spawn-err' });
    });

    // -----------------------------------------------------------------------
    // resetSessionForTodoRestore: restoring an archived task into a role='todo'
    // lane runs a session-only reset (cleanupTaskSession), never the full
    // resource teardown (cleanupTaskResources), which would force-delete the
    // task's branch whenever git.autoCleanup is on. See the JSDoc above
    // resetSessionForTodoRestore in task-archive.ts for the full incident.
    // -----------------------------------------------------------------------

    describe('resetSessionForTodoRestore (role=todo restore session reset)', () => {
      it('tears down the session via cleanupTaskSession when restoring into a role=todo, auto_spawn=false lane', async () => {
        const todoLane = createMockSwimlane('lane-todo', { role: 'todo', auto_spawn: false });
        swimlaneRepo = createMockSwimlaneRepo([doneLane, todoLane]);
        const task = createMockTask('task-todo-restore', { session_id: 'session-abc' });
        taskRepo = createMockTaskRepo([task]);
        mockGetProjectRepos.mockReturnValue({
          tasks: taskRepo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });

        await callHandler(IPC.TASK_UNARCHIVE, {
          id: 'task-todo-restore',
          targetSwimlaneId: 'lane-todo',
        });

        expect(mockCleanupTaskSession).toHaveBeenCalledTimes(1);
        const [, cleanupTask, cleanupTasksRepo, cleanupProjectId, cleanupProjectPath] =
          mockCleanupTaskSession.mock.calls[0] as [unknown, MockTask, MockTaskRepo, string, string];
        expect(cleanupTask).toMatchObject({ id: 'task-todo-restore' });
        expect(cleanupTasksRepo).toBe(taskRepo);
        expect(cleanupProjectId).toBe('proj-123');
        expect(cleanupProjectPath).toBe('/mock/project');
        // Never the full resource teardown.
        expect(mockCleanupTaskResources).not.toHaveBeenCalled();
        // And never routed through the spawn path either - auto_spawn=false
        // already short-circuits before the reset runs.
        expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
        expect(mockSpawnAgent).not.toHaveBeenCalled();
      });

      it('regression guard: does not route through cleanupTaskResources for a task whose worktree_path AND branch_name are both still set (the failed-Done-cleanup state), and branch_name survives on the row', async () => {
        const todoLane = createMockSwimlane('lane-todo', { role: 'todo', auto_spawn: false });
        swimlaneRepo = createMockSwimlaneRepo([doneLane, todoLane]);
        const task = createMockTask('task-pinned-worktree', {
          worktree_path: '/mock/project/.kangentic/worktrees/task-pinned-worktree',
          branch_name: 'kangentic/task-pinned-worktree',
        });
        taskRepo = createMockTaskRepo([task]);
        mockGetProjectRepos.mockReturnValue({
          tasks: taskRepo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });

        const result = await callHandler<MockTask>(IPC.TASK_UNARCHIVE, {
          id: 'task-pinned-worktree',
          targetSwimlaneId: 'lane-todo',
        });

        // The session-only reset ran, carrying the task through with both
        // fields still on it...
        expect(mockCleanupTaskSession).toHaveBeenCalledTimes(1);
        const [, cleanupTask] = mockCleanupTaskSession.mock.calls[0] as [unknown, MockTask];
        expect(cleanupTask).toMatchObject({
          id: 'task-pinned-worktree',
          worktree_path: task.worktree_path,
          branch_name: task.branch_name,
        });

        // ...and NOT the full resource cleanup. cleanupTaskResources is what
        // would call worktreeManager.removeBranch / `git branch -D` on this
        // task's branch when git.autoCleanup is on (pinned directly against
        // the real cleanupTaskResources implementation in
        // delete-task-worktree.test.ts); this file mocks the whole helpers
        // barrel, so the guard here is that the WRONG helper is never
        // reached at all. Red-green: on the pre-fix handler (which called
        // cleanupTaskResources instead of cleanupTaskSession), this fails
        // because mockCleanupTaskSession is never called.
        expect(mockCleanupTaskResources).not.toHaveBeenCalled();

        // branch_name and worktree_path survive on the task row - nothing on
        // this route ever clears them.
        expect(result?.branch_name).toBe(task.branch_name);
        expect(result?.worktree_path).toBe(task.worktree_path);
      });

      it('does not run the session reset at all when restoring into a non-todo lane', async () => {
        const backlogLane = createMockSwimlane('lane-backlog', { role: null, auto_spawn: false });
        swimlaneRepo = createMockSwimlaneRepo([doneLane, backlogLane]);
        const task = createMockTask('task-non-todo-restore', { session_id: 'session-abc' });
        taskRepo = createMockTaskRepo([task]);
        mockGetProjectRepos.mockReturnValue({
          tasks: taskRepo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });

        await callHandler(IPC.TASK_UNARCHIVE, {
          id: 'task-non-todo-restore',
          targetSwimlaneId: 'lane-backlog',
        });

        expect(mockCleanupTaskSession).not.toHaveBeenCalled();
        expect(mockCleanupTaskResources).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // Held messages: a restore into To Do is a To Do move, and a To Do move
    // clears the messages held for the task's next agent (task-move.ts does
    // the same). Done holds none, so this only matters for rows from before
    // that rule. The clear lives in resetSessionForTodoRestore, behind its
    // `laneRole !== 'todo'` guard.
    // -----------------------------------------------------------------------

    describe('held messages on a restore', () => {
      function registerLane(lane: MockSwimlane, task: MockTask): void {
        swimlaneRepo = createMockSwimlaneRepo([doneLane, lane]);
        taskRepo = createMockTaskRepo([task]);
        mockGetProjectRepos.mockReturnValue({
          tasks: taskRepo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });
      }

      it('clears the task\'s held messages when it is restored into a role=todo lane', async () => {
        // Red: deleting `if (projectId) clearHeldMessages(projectId, task.id)`
        // from resetSessionForTodoRestore in task-archive.ts leaves the spy
        // uncalled.
        registerLane(
          createMockSwimlane('lane-todo', { role: 'todo', auto_spawn: false }),
          createMockTask('task-held-todo'),
        );

        await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-held-todo', targetSwimlaneId: 'lane-todo' });

        expect(mockClearHeldMessages).toHaveBeenCalledTimes(1);
        expect(mockClearHeldMessages).toHaveBeenCalledWith('proj-123', 'task-held-todo');
      });

      it('does not clear them when the task is restored into a non-todo lane that starts no agent', async () => {
        // This lane reaches resetSessionForTodoRestore (auto_spawn is off) and
        // leaves at its role guard. Red: hoisting the clear above
        // `if (laneRole !== 'todo') return;` calls the spy here.
        registerLane(
          createMockSwimlane('lane-parked', { role: null, auto_spawn: false }),
          createMockTask('task-held-parked'),
        );

        await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-held-parked', targetSwimlaneId: 'lane-parked' });

        expect(mockCleanupTaskSession).not.toHaveBeenCalled();
        expect(mockClearHeldMessages).not.toHaveBeenCalled();
      });

      it('leaves them for the agent a restore into an auto-spawn lane starts', async () => {
        // The restored agent claims them in its opening message (spawnAgent),
        // so a clear here would throw away what it is about to be sent.
        registerLane(
          createMockSwimlane('lane-working', { role: null, auto_spawn: true }),
          createMockTask('task-held-working'),
        );

        await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-held-working', targetSwimlaneId: 'lane-working' });

        expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
        expect(mockClearHeldMessages).not.toHaveBeenCalled();
      });

      it('clears against the project the restore was issued for, not the ambient current project', async () => {
        // Renderer-driven mutations carry an explicit interaction-time
        // projectId (.claude/rules/project-scoped-ipc.md). Red: passing
        // context.currentProjectId to clearHeldMessages in task-archive.ts
        // fails this with 'proj-123'.
        registerLane(
          createMockSwimlane('lane-todo', { role: 'todo', auto_spawn: false }),
          createMockTask('task-held-other-project'),
        );

        await callHandler(
          IPC.TASK_UNARCHIVE,
          { id: 'task-held-other-project', targetSwimlaneId: 'lane-todo' },
          'proj-other',
        );

        expect(mockClearHeldMessages).toHaveBeenCalledTimes(1);
        expect(mockClearHeldMessages).toHaveBeenCalledWith('proj-other', 'task-held-other-project');
      });

      it('still clears them when the session teardown that follows throws', async () => {
        // The clear sits before the best-effort teardown's try/catch, so a
        // failed cleanup cannot leave the task holding messages for an agent
        // it will never get. Red: moving the clear after `await
        // cleanupTaskSession(...)` inside the try skips it on the rejection.
        registerLane(
          createMockSwimlane('lane-todo', { role: 'todo', auto_spawn: false }),
          createMockTask('task-held-teardown-fails'),
        );
        mockCleanupTaskSession.mockRejectedValueOnce(new Error('pty host unreachable'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
          await expect(
            callHandler(IPC.TASK_UNARCHIVE, { id: 'task-held-teardown-fails', targetSwimlaneId: 'lane-todo' }),
          ).resolves.toMatchObject({ id: 'task-held-teardown-fails' });
        } finally {
          consoleError.mockRestore();
        }

        expect(mockCleanupTaskSession).toHaveBeenCalledTimes(1);
        expect(mockClearHeldMessages).toHaveBeenCalledWith('proj-123', 'task-held-teardown-fails');
      });
    });

    // -----------------------------------------------------------------------
    // Lock serialization: concurrent TASK_UNARCHIVE calls for the same task id
    // must complete in submission order; different ids run independently.
    // -----------------------------------------------------------------------

    it('serializes concurrent TASK_UNARCHIVE calls for the same task id', async () => {
      // Use a hold mechanism to control call timing:
      // - first invocation: holds until we release it
      // - second invocation: should queue behind the first
      let releaseFirstUnarchive!: () => void;
      const firstHold = new Promise<void>((resolve) => {
        releaseFirstUnarchive = resolve;
      });
      const entryOrder: number[] = [];

      mockEnsureTaskWorktree.mockImplementation(async () => {
        entryOrder.push(entryOrder.length);
        if (entryOrder.length === 1) {
          await firstHold;
        }
      });

      // Both tasks have the same id - must serialize
      const task = createMockTask('task-concurrent');
      taskRepo = createMockTaskRepo([task]);
      taskRepo.getById.mockReturnValue({ ...task, session_id: null });
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: createMockSwimlaneRepo([doneLane, targetLane]),
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      const engine = createMockEngine();
      mockCreateTransitionEngine.mockReturnValue(engine);

      const first = callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-concurrent',
        targetSwimlaneId: 'lane-doing',
      });
      const second = callHandler(IPC.TASK_UNARCHIVE, {
        id: 'task-concurrent',
        targetSwimlaneId: 'lane-doing',
      });

      // Only the first call should have entered ensureTaskWorktree so far
      await Promise.resolve(); // flush one microtask tick
      expect(entryOrder).toHaveLength(1);

      // Release the first; the second should now proceed
      releaseFirstUnarchive();
      await Promise.all([first, second]);

      // Both entered, in order
      expect(entryOrder).toHaveLength(2);
      expect(entryOrder).toEqual([0, 1]);
    });

    it('runs TASK_UNARCHIVE concurrently for different task ids', async () => {
      // Each call holds for a fixed delay; if they ran serially the total
      // elapsed time would be ~2x the delay. Parallelism collapses it to ~1x.
      const DELAY_MS = 40;
      let holdCount = 0;

      mockEnsureTaskWorktree.mockImplementation(async () => {
        holdCount += 1;
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      });

      const taskA = createMockTask('task-parallel-a');
      const taskB = createMockTask('task-parallel-b');
      const mixedTaskRepo = createMockTaskRepo([taskA, taskB]);
      mixedTaskRepo.getById.mockImplementation((id: string) => {
        return id === 'task-parallel-a' ? taskA : taskB;
      });
      mockGetProjectRepos.mockReturnValue({
        tasks: mixedTaskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      const engine = createMockEngine();
      mockCreateTransitionEngine.mockReturnValue(engine);

      const start = Date.now();
      await Promise.all([
        callHandler(IPC.TASK_UNARCHIVE, { id: 'task-parallel-a', targetSwimlaneId: 'lane-doing' }),
        callHandler(IPC.TASK_UNARCHIVE, { id: 'task-parallel-b', targetSwimlaneId: 'lane-doing' }),
      ]);
      const elapsed = Date.now() - start;

      // Both entered ensureTaskWorktree
      expect(holdCount).toBe(2);
      // If serialized, elapsed >= 2 * DELAY_MS; parallel keeps it under 1.5x
      expect(elapsed).toBeLessThan(DELAY_MS * 1.5 + 30); // 30ms scheduler headroom
    });
  });

  // =========================================================================
  // TASK_BULK_UNARCHIVE
  // =========================================================================

  describe('TASK_BULK_UNARCHIVE', () => {
    it('throws when context.currentProjectId is null', async () => {
      context.currentProjectId = null;
      capturedHandlers.clear();
      registerTaskArchiveHandlers(context as never);

      await expect(
        callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-1', 'task-2'], 'lane-doing'),
      ).rejects.toThrow('No project is currently open');
    });

    it('skips spawn for all tasks when target lane has auto_spawn=false', async () => {
      const noSpawnLane = createMockSwimlane('lane-backlog', { auto_spawn: false });
      swimlaneRepo = createMockSwimlaneRepo([doneLane, noSpawnLane]);
      const tasks = [
        createMockTask('task-bulk-a'),
        createMockTask('task-bulk-b'),
      ];
      taskRepo = createMockTaskRepo(tasks);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      await callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-bulk-a', 'task-bulk-b'], 'lane-backlog');

      // unarchive called for each task
      expect(taskRepo.unarchive).toHaveBeenCalledTimes(2);
      // ensureTaskWorktree must NOT have been called (auto_spawn=false short-circuits)
      expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
      expect(mockCreateTransitionEngine).not.toHaveBeenCalled();
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    // A bulk restore carries no slot, so every card goes last. It still writes
    // the lane's order back after each restore: appending at the lane's length
    // would sort a card second on a lane stored as 0, 5, 9. The fake keeps the
    // lane as the repository would (a restore adds the task, a reorder rewrites
    // the order), so the second restore reads the first one.
    it('writes each restored task last in the lane, the second behind the first', async () => {
      const noSpawnLane = createMockSwimlane('lane-backlog', { auto_spawn: false });
      swimlaneRepo = createMockSwimlaneRepo([doneLane, noSpawnLane]);
      const everyTask = [
        createMockTask('lane-first', { swimlane_id: 'lane-backlog' }),
        createMockTask('lane-second', { swimlane_id: 'lane-backlog' }),
        createMockTask('task-bulk-a', { swimlane_id: 'lane-done' }),
        createMockTask('task-bulk-b', { swimlane_id: 'lane-done' }),
      ];
      const taskById = new Map(everyTask.map((task) => [task.id, task]));
      let liveLaneIds = ['lane-first', 'lane-second'];
      const repo = createMockTaskRepo(everyTask);
      repo.list = vi.fn((swimlaneId?: string) => (swimlaneId === 'lane-backlog' ? liveLaneIds.map((id) => taskById.get(id)) : []));
      repo.unarchive = vi.fn((id: string) => {
        liveLaneIds = [...liveLaneIds, id];
        return taskById.get(id);
      });
      repo.reorderWithinSwimlane = vi.fn((_swimlaneId: string, orderedTaskIds: string[]) => {
        liveLaneIds = orderedTaskIds;
      });
      mockGetProjectRepos.mockReturnValue({
        tasks: repo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      await callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-bulk-a', 'task-bulk-b'], 'lane-backlog');

      expect(repo.reorderWithinSwimlane.mock.calls).toEqual([
        ['lane-backlog', ['lane-first', 'lane-second', 'task-bulk-a']],
        ['lane-backlog', ['lane-first', 'lane-second', 'task-bulk-a', 'task-bulk-b']],
      ]);
    });

    it('continues processing subsequent tasks when one worktree creation fails', async () => {
      const tasks = [
        createMockTask('task-fail-worktree'),
        createMockTask('task-succeed'),
      ];
      taskRepo = createMockTaskRepo(tasks);
      taskRepo.getById.mockImplementation((id: string) => {
        const found = tasks.find((t) => t.id === id);
        return found ? { ...found, session_id: id === 'task-succeed' ? 'session-ok' : null } : null;
      });
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      // First call throws, second succeeds
      mockEnsureTaskWorktree
        .mockRejectedValueOnce(new Error('worktree locked'))
        .mockResolvedValueOnce(null);

      const engine = createMockEngine();
      mockCreateTransitionEngine.mockReturnValue(engine);

      // Should not throw - per-task errors are caught
      await expect(
        callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-fail-worktree', 'task-succeed'], 'lane-doing'),
      ).resolves.toBeUndefined();

      // The second task still proceeded to ensureTaskWorktree
      expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(2);
      // spawnAgent reached for the successful task only
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      // ...and the one that failed says so, rather than being restored into the
      // column looking exactly like the one that succeeded. Red-green: pre-fix
      // this branch was `console.error` + `return`.
      expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
      const [, failedTask, step] = mockNotifySpawnBlocked.mock.calls[0];
      expect((failedTask as { id: string }).id).toBe('task-fail-worktree');
      expect(step).toBe('worktree');
    });

    it('continues processing subsequent tasks when one branch checkout fails, notifying with step="checkout"', async () => {
      // Same shape as the worktree-failure test above, one stage later: both
      // tasks clear ensureTaskWorktree, and it is ensureTaskBranchCheckout
      // that fails for the first task only. Mirrors the mockRejectedValueOnce
      // / mockResolvedValueOnce pairing above rather than mockRejectedValue,
      // so the second task's checkout still succeeds and the assertion that
      // it reaches spawnAgent actually proves the catch is per-task, not
      // batch-fatal.
      const tasks = [
        createMockTask('task-fail-checkout'),
        createMockTask('task-succeed-checkout'),
      ];
      taskRepo = createMockTaskRepo(tasks);
      taskRepo.getById.mockImplementation((id: string) => {
        const found = tasks.find((t) => t.id === id);
        return found ? { ...found, session_id: id === 'task-succeed-checkout' ? 'session-ok' : null } : null;
      });
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      mockEnsureTaskWorktree.mockResolvedValue(null);
      const checkoutError = new Error('branch locked by active session');
      mockEnsureTaskBranchCheckout
        .mockRejectedValueOnce(checkoutError)
        .mockResolvedValueOnce(undefined);

      const engine = createMockEngine();
      mockCreateTransitionEngine.mockReturnValue(engine);

      await expect(
        callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-fail-checkout', 'task-succeed-checkout'], 'lane-doing'),
      ).resolves.toBeUndefined();

      // The second task still proceeded to ensureTaskBranchCheckout.
      expect(mockEnsureTaskBranchCheckout).toHaveBeenCalledTimes(2);
      // ...and all the way through to spawnAgent - the signal that the catch
      // block for the first task's failure is per-task, not batch-fatal.
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);

      // The step literal is what discriminates this notice from a worktree
      // failure in the renderer. Red-green: flip task-archive.ts's 'checkout'
      // literal at this bulk call site to 'worktree' and this assertion reds;
      // before this change existed at all, no test in this suite exercised
      // the bulk checkout-failure branch, so the whole test reds against the
      // pre-fix handler's silent console-only catch.
      expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
      const [, failedCheckoutTask, checkoutStep] = mockNotifySpawnBlocked.mock.calls[0];
      expect((failedCheckoutTask as { id: string }).id).toBe('task-fail-checkout');
      expect(checkoutStep).toBe('checkout');
    });

    it('processes each task with an independent lock (different ids do not block each other)', async () => {
      // Two tasks with different ids are processed in the for-loop. Even though
      // each uses withTaskLock, different ids have independent queues so they
      // do not wait on each other. The for-loop is sequential by await, but
      // the LOCK overhead should not add cumulative delay across different ids.
      const tasks = [
        createMockTask('task-ind-a'),
        createMockTask('task-ind-b'),
      ];
      taskRepo = createMockTaskRepo(tasks);
      taskRepo.getById.mockReturnValue({ ...tasks[0], session_id: null });
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      const engine = createMockEngine();
      mockCreateTransitionEngine.mockReturnValue(engine);

      // Just verify both unarchive calls happen - the independence assertion
      // for bulk is at the for-loop level (sequential by design), not parallel
      await callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-ind-a', 'task-ind-b'], 'lane-doing');

      expect(taskRepo.unarchive).toHaveBeenCalledTimes(2);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    });

    it('routes every restored task through spawnAgent with the same recovery-move contract as the single handler', async () => {
      // Bulk unarchive (Completed Tasks dialog restore) is also a
      // first-ever-spawn entry point per task, so each task must go through
      // the shared spawnAgent chokepoint with the identical contract:
      // doneLane source, skipPromptTemplate + suppressAutoCommand (session
      // resumes idle, no auto_command on the recovery move), project context
      // threaded, settingsSourceLane omitted.
      const tasks = [
        createMockTask('task-bulk-cmd-a'),
        createMockTask('task-bulk-cmd-b'),
      ];
      taskRepo = createMockTaskRepo(tasks);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      const engine = createMockEngine();
      mockCreateTransitionEngine.mockReturnValue(engine);

      await callHandler(
        IPC.TASK_BULK_UNARCHIVE,
        ['task-bulk-cmd-a', 'task-bulk-cmd-b'],
        'lane-doing',
      );

      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
      const spawnedTaskIds = mockSpawnAgent.mock.calls.map(
        (call) => (call[0] as { task: { id: string } }).task.id,
      );
      expect(spawnedTaskIds).toEqual(['task-bulk-cmd-a', 'task-bulk-cmd-b']);
      for (const call of mockSpawnAgent.mock.calls) {
        const spawnArg = call[0] as {
          fromSwimlaneId: string;
          toLane: MockSwimlane;
          skipPromptTemplate: boolean;
          suppressAutoCommand: boolean;
          projectId: string;
          projectPath: string;
        };
        expect(spawnArg.fromSwimlaneId).toBe(doneLane.id);
        expect(spawnArg.toLane).toBe(targetLane);
        expect(spawnArg.skipPromptTemplate).toBe(true);
        expect(spawnArg.suppressAutoCommand).toBe(true);
        expect('settingsSourceLane' in spawnArg).toBe(false);
        expect(spawnArg.projectId).toBe('proj-123');
        expect(spawnArg.projectPath).toBe('/mock/project');
      }
    });

    it('threads onProgress + projectId into both git helpers for every task in the batch', async () => {
      // Mirrors the single-unarchive test above; bulk restore threads the same
      // pair per task, not just for the first one processed.
      const tasks = [
        createMockTask('task-bulk-progress-a'),
        createMockTask('task-bulk-progress-b'),
      ];
      taskRepo = createMockTaskRepo(tasks);
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: swimlaneRepo,
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });

      await callHandler(
        IPC.TASK_BULK_UNARCHIVE,
        ['task-bulk-progress-a', 'task-bulk-progress-b'],
        'lane-doing',
      );

      expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(2);
      expect(mockEnsureTaskBranchCheckout).toHaveBeenCalledTimes(2);
      for (const call of mockEnsureTaskWorktree.mock.calls) {
        const options = call[4] as { onProgress?: unknown; projectId?: unknown };
        expect(typeof options.onProgress).toBe('function');
        expect(options.projectId).toBe('proj-123');
      }
      for (const call of mockEnsureTaskBranchCheckout.mock.calls) {
        const options = call[3] as { onProgress?: unknown; projectId?: unknown };
        expect(typeof options.onProgress).toBe('function');
        expect(options.projectId).toBe('proj-123');
      }
    });

    // -----------------------------------------------------------------------
    // resetSessionForTodoRestore: same regression coverage as TASK_UNARCHIVE
    // above, applied to the bulk (Completed Tasks dialog "Restore selected")
    // path - every restored task in the batch must get the session-only
    // reset, never the branch-deleting full teardown.
    // -----------------------------------------------------------------------

    describe('resetSessionForTodoRestore (role=todo restore session reset)', () => {
      it('tears down the session via cleanupTaskSession for every task restored into a role=todo, auto_spawn=false lane', async () => {
        const todoLane = createMockSwimlane('lane-todo', { role: 'todo', auto_spawn: false });
        swimlaneRepo = createMockSwimlaneRepo([doneLane, todoLane]);
        const tasks = [
          createMockTask('task-bulk-todo-a', { session_id: 'session-a' }),
          createMockTask('task-bulk-todo-b', { session_id: 'session-b' }),
        ];
        taskRepo = createMockTaskRepo(tasks);
        mockGetProjectRepos.mockReturnValue({
          tasks: taskRepo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });

        await callHandler(
          IPC.TASK_BULK_UNARCHIVE,
          ['task-bulk-todo-a', 'task-bulk-todo-b'],
          'lane-todo',
        );

        expect(mockCleanupTaskSession).toHaveBeenCalledTimes(2);
        const cleanedUpTaskIds = mockCleanupTaskSession.mock.calls.map(
          (call) => (call[1] as MockTask).id,
        );
        expect(cleanedUpTaskIds).toEqual(['task-bulk-todo-a', 'task-bulk-todo-b']);
        expect(mockCleanupTaskResources).not.toHaveBeenCalled();
        expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
        expect(mockSpawnAgent).not.toHaveBeenCalled();
      });

      it('regression guard: does not route any task through cleanupTaskResources when worktree_path AND branch_name are both still set, and branch_name survives on every row', async () => {
        const todoLane = createMockSwimlane('lane-todo', { role: 'todo', auto_spawn: false });
        swimlaneRepo = createMockSwimlaneRepo([doneLane, todoLane]);
        const tasks = [
          createMockTask('task-bulk-pinned-a', {
            worktree_path: '/mock/project/.kangentic/worktrees/task-bulk-pinned-a',
            branch_name: 'kangentic/task-bulk-pinned-a',
          }),
          createMockTask('task-bulk-pinned-b', {
            worktree_path: '/mock/project/.kangentic/worktrees/task-bulk-pinned-b',
            branch_name: 'kangentic/task-bulk-pinned-b',
          }),
        ];
        taskRepo = createMockTaskRepo(tasks);
        mockGetProjectRepos.mockReturnValue({
          tasks: taskRepo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });

        await callHandler(
          IPC.TASK_BULK_UNARCHIVE,
          ['task-bulk-pinned-a', 'task-bulk-pinned-b'],
          'lane-todo',
        );

        // Both tasks went through the session-only reset with their fields intact...
        expect(mockCleanupTaskSession).toHaveBeenCalledTimes(2);
        for (const [taskArgIndex, sourceTask] of tasks.entries()) {
          const [, cleanupTask] = mockCleanupTaskSession.mock.calls[taskArgIndex] as [unknown, MockTask];
          expect(cleanupTask).toMatchObject({
            id: sourceTask.id,
            worktree_path: sourceTask.worktree_path,
            branch_name: sourceTask.branch_name,
          });
        }

        // ...and neither went through the branch-deleting full teardown.
        // Red-green: on the pre-fix handler (cleanupTaskResources instead of
        // cleanupTaskSession), mockCleanupTaskSession is never called and the
        // count assertion above fails.
        expect(mockCleanupTaskResources).not.toHaveBeenCalled();

        for (const sourceTask of tasks) {
          const restored = taskRepo.getById(sourceTask.id) as unknown as MockTask;
          expect(restored.branch_name).toBe(sourceTask.branch_name);
          expect(restored.worktree_path).toBe(sourceTask.worktree_path);
        }
      });

      it('does not run the session reset for any task when restoring into a non-todo lane', async () => {
        const backlogLane = createMockSwimlane('lane-backlog', { role: null, auto_spawn: false });
        swimlaneRepo = createMockSwimlaneRepo([doneLane, backlogLane]);
        const tasks = [
          createMockTask('task-bulk-non-todo-a', { session_id: 'session-a' }),
          createMockTask('task-bulk-non-todo-b', { session_id: 'session-b' }),
        ];
        taskRepo = createMockTaskRepo(tasks);
        mockGetProjectRepos.mockReturnValue({
          tasks: taskRepo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });

        await callHandler(
          IPC.TASK_BULK_UNARCHIVE,
          ['task-bulk-non-todo-a', 'task-bulk-non-todo-b'],
          'lane-backlog',
        );

        expect(mockCleanupTaskSession).not.toHaveBeenCalled();
        expect(mockCleanupTaskResources).not.toHaveBeenCalled();
      });

      it('clears the held messages of every task restored into a role=todo lane, and of none restored elsewhere', async () => {
        // The same resetSessionForTodoRestore call serves the bulk handler, so
        // one deleted clear fails both this and the single-restore test above.
        const todoLane = createMockSwimlane('lane-todo', { role: 'todo', auto_spawn: false });
        const parkedLane = createMockSwimlane('lane-parked', { role: null, auto_spawn: false });
        swimlaneRepo = createMockSwimlaneRepo([doneLane, todoLane, parkedLane]);
        const tasks = [
          createMockTask('task-bulk-held-a'),
          createMockTask('task-bulk-held-b'),
        ];
        taskRepo = createMockTaskRepo(tasks);
        mockGetProjectRepos.mockReturnValue({
          tasks: taskRepo,
          swimlanes: swimlaneRepo,
          actions: { getTransitionsFor: vi.fn(() => []) },
          attachments: { deleteByTaskId: vi.fn() },
        });

        await callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-bulk-held-a', 'task-bulk-held-b'], 'lane-parked');
        expect(mockClearHeldMessages).not.toHaveBeenCalled();

        await callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-bulk-held-a', 'task-bulk-held-b'], 'lane-todo');
        expect(mockClearHeldMessages.mock.calls).toEqual([
          ['proj-123', 'task-bulk-held-a'],
          ['proj-123', 'task-bulk-held-b'],
        ]);
      });
    });
  });

  // =========================================================================
  // Both restores reach a paired phone
  //
  // A restore from the archive is the desktop's real way out of Done (the UI
  // never routes an archived card through TASK_MOVE), and it puts the card back
  // on the board. A phone hears the restore only on the board-changed bus.
  // Before, it heard nothing unless an auto-spawn session happened to start, so
  // a restore into a column that starts no agent left its card stale in Done.
  // The restore keeps the task's automations switch (a held task comes back
  // held, task-repository-automations-disabled.test.ts pins that), so the fake
  // `unarchive` below leaves it alone, and each listener records the row as it
  // stands when the event fires.
  // =========================================================================

  describe('a restore reaches a paired phone', () => {
    /** The rows by id, as the fake repository holds them. */
    let rows: Map<string, MockTask & { archived_at: string | null; automations_disabled: boolean }>;
    /** Each emit's ids, with every listed row's archive flag and switch as they stood at that moment. */
    let rowsAtEmit: Array<Record<string, { archivedAt: string | null; automationsDisabled: boolean } | null>>;

    function arrangeHeldArchivedTasks(ids: string[], lanes: MockSwimlane[]): void {
      rows = new Map(ids.map((id) => [id, {
        ...createMockTask(id, { swimlane_id: doneLane.id }),
        archived_at: '2026-10-16T00:00:00.000Z',
        automations_disabled: true,
      }]));
      rowsAtEmit = [];
      taskRepo = createMockTaskRepo([]);
      taskRepo.getById.mockImplementation((id: string) => rows.get(id) ?? null);
      taskRepo.list.mockImplementation(() => []);
      taskRepo.unarchive.mockImplementation((id: string, targetSwimlaneId: string) => {
        const row = rows.get(id);
        if (!row) throw new Error(`Task ${id} not found`);
        // As TaskRepository.unarchive does: the lane and the archive flag, never the switch.
        row.swimlane_id = targetSwimlaneId;
        row.archived_at = null;
        return row;
      });
      mockGetProjectRepos.mockReturnValue({
        tasks: taskRepo,
        swimlanes: createMockSwimlaneRepo(lanes),
        actions: { getTransitionsFor: vi.fn(() => []) },
        attachments: { deleteByTaskId: vi.fn() },
      });
      // Recorded, not asserted, in the listener. The announce swallows a
      // listener's throw, so an expect there could never fail the test.
      context.boardEvents.emitBoardChanged.mockImplementation((event: { ids: string[] }) => {
        rowsAtEmit.push(Object.fromEntries(event.ids.map((id) => {
          const row = rows.get(id);
          return [id, row ? { archivedAt: row.archived_at, automationsDisabled: row.automations_disabled } : null];
        })));
      });
    }

    /** What the phone should read at the emit: back on the board, still held. */
    const restoredAndHeld = { archivedAt: null, automationsDisabled: true };

    it('TASK_UNARCHIVE into a column that starts no agent emits task-updated once, after the row is restored, with the switch kept', async () => {
      const quietLane = createMockSwimlane('lane-review', { auto_spawn: false });
      arrangeHeldArchivedTasks(['task-held'], [doneLane, quietLane]);

      await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-held', targetSwimlaneId: 'lane-review' });

      expect(context.boardEvents.emitBoardChanged.mock.calls).toEqual([
        [{ projectId: 'proj-123', change: 'task-updated', ids: ['task-held'] }],
      ]);
      expect(rowsAtEmit).toEqual([{ 'task-held': restoredAndHeld }]);
    });

    it('TASK_UNARCHIVE still emits once when the restore\'s worktree step fails', async () => {
      arrangeHeldArchivedTasks(['task-held'], [doneLane, targetLane]);
      mockEnsureTaskWorktree.mockRejectedValue(new Error('git worktree add failed'));

      await callHandler(IPC.TASK_UNARCHIVE, { id: 'task-held', targetSwimlaneId: 'lane-doing' });

      expect(context.boardEvents.emitBoardChanged).toHaveBeenCalledTimes(1);
      expect(rowsAtEmit).toEqual([{ 'task-held': restoredAndHeld }]);
    });

    it('TASK_UNARCHIVE emits nothing when it is refused before any write', async () => {
      context.currentProjectId = null;
      capturedHandlers.clear();
      registerTaskArchiveHandlers(context as never);

      await expect(
        callHandler(IPC.TASK_UNARCHIVE, { id: 'task-held', targetSwimlaneId: 'lane-doing' }),
      ).rejects.toThrow('No project is currently open');

      expect(context.boardEvents.emitBoardChanged).not.toHaveBeenCalled();
    });

    it('TASK_BULK_UNARCHIVE emits task-updated once for the batch, after every row is restored, with every switch kept', async () => {
      const quietLane = createMockSwimlane('lane-review', { auto_spawn: false });
      arrangeHeldArchivedTasks(['task-held-a', 'task-held-b'], [doneLane, quietLane]);

      await callHandler(IPC.TASK_BULK_UNARCHIVE, ['task-held-a', 'task-held-b'], 'lane-review');

      expect(context.boardEvents.emitBoardChanged.mock.calls).toEqual([
        [{ projectId: 'proj-123', change: 'task-updated', ids: ['task-held-a', 'task-held-b'] }],
      ]);
      expect(rowsAtEmit).toEqual([{ 'task-held-a': restoredAndHeld, 'task-held-b': restoredAndHeld }]);
    });
  });
});

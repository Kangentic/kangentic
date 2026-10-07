/**
 * Where the task leftover reap is wired, and where it deliberately is not.
 *
 * A terminal transition kills every process carrying the task's
 * `KANGENTIC_TASK_ID` tag through `reapTaskLeftovers` (src/main/ipc/helpers/
 * task-cleanup.ts). The reap's own logic is covered by task-reap-plan,
 * task-tagged-reap, task-process-readers and session-reap-real-processes; this
 * file pins the CALLS and their ORDER:
 *
 *   1. `cleanupTaskSession` / `cleanupTaskResources` (task-cleanup.ts, REAL):
 *      the reap runs AFTER every session of the task has exited (the kill and
 *      `removeByTaskId`), so no young agent is force-killed outside its exit
 *      grace, and BEFORE the worktree removal. It runs even when the task has
 *      no live session: an earlier session (suspended at a Code Review entry,
 *      say) may have left a dev server running.
 *   2. `handleTaskMove`'s Done branch (task-move.ts, REAL, the reap mocked at
 *      the barrel): suspend -> reap -> deleteTaskWorktree, including a Done
 *      move whose session had already ended before the move.
 *   3. The deliberate negatives: a move into an auto_spawn=false column and
 *      the Stop / Pause handlers (SESSION_KILL, SESSION_SUSPEND) never reap.
 *      The user chose to keep a parked task's dev server running.
 *   4. `PROJECT_DELETE` reaps after its sessions' exits and before removing
 *      worktrees (static line-order scan; the handler's mock graph is large).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Task, Swimlane } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';

// ---------------------------------------------------------------------------
// Shared call-order tracker. Reset per test.
// ---------------------------------------------------------------------------

const { callOrder } = vi.hoisted(() => ({ callOrder: [] as string[] }));

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
  default: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []) })) })),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    // No own-record row, so the capture sites fall back to getLatestForTask.
    findByAnyId = vi.fn(() => undefined);
    getLatestForTask = vi.fn(() => null);
    getSummaryForTask = vi.fn(() => null);
    updateGitStats = vi.fn();
    updateAppliedSettings = vi.fn();
    deleteByTaskId = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({ UsageHistoryRepository: class {} }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));

// WorktreeManager + prepareWorktreeForRemoval: shared by cleanupTaskResources
// (Section 1, real) and by task-move.ts's static
// `WorktreeManager.scheduleBackgroundPrune` reference (Section 2).
const mockRemoveWorktree = vi.fn(async (): Promise<boolean> => true);
const mockPrepareWorktreeForRemoval = vi.fn(async (): Promise<void> => {});
vi.mock('../../src/main/git/worktree-manager', () => ({
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
  prepareWorktreeForRemoval: (...args: [string, string]) => {
    callOrder.push('prepare');
    return mockPrepareWorktreeForRemoval(...args);
  },
  WorktreeManager: class {
    withLock = vi.fn(async (job: () => Promise<unknown>) => {
      callOrder.push('withLock');
      return job();
    });
    removeWorktree = (...args: [string, unknown]) => {
      callOrder.push('removeWorktree');
      return mockRemoveWorktree(...args);
    };
    pruneWorktrees = vi.fn(async () => {});
    removeBranch = vi.fn(async () => {});
    static scheduleBackgroundPrune = vi.fn();
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn() }));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  interpolateTaskTemplate: vi.fn((template: string) => template),
  resolveTaskTemplateVars: vi.fn(() => ({})),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

// Section 2's seam: task-move.ts imports reapTaskLeftovers / deleteTaskWorktree
// from this barrel, so mocking it here observes the CALL and its position.
const mockReapTaskLeftovers = vi.fn(async (): Promise<void> => {
  callOrder.push('reap');
});
const mockDeleteTaskWorktree = vi.fn(async (): Promise<boolean> => {
  callOrder.push('deleteWorktree');
  return true;
});
const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => null);
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});
const mockCreateTransitionEngine = vi.fn(() => ({}));

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: (...args: unknown[]) => mockDeleteTaskWorktree(...args),
  autoSpawnForTask: vi.fn(async () => {}),
  reapTaskLeftovers: (...args: unknown[]) => mockReapTaskLeftovers(...args),
}));

// ---------------------------------------------------------------------------
// Imports under test (after all mocks)
// ---------------------------------------------------------------------------

import { cleanupTaskSession, cleanupTaskResources } from '../../src/main/ipc/helpers/task-cleanup';
import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-aaa00001',
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: 'lane-todo',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSwimlane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id,
    name: `Lane ${id}`,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MockSessionManager {
  kill: ReturnType<typeof vi.fn>;
  awaitExit: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  removeByTaskId: ReturnType<typeof vi.fn>;
  killByTaskId: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  findLiveSessionByTaskId: ReturnType<typeof vi.fn>;
  reapTaskProcesses: ReturnType<typeof vi.fn>;
}

function makeSessionManager(): MockSessionManager {
  return {
    kill: vi.fn(() => { callOrder.push('kill'); }),
    awaitExit: vi.fn(async () => {}),
    remove: vi.fn(),
    removeByTaskId: vi.fn(async () => { callOrder.push('removeByTaskId'); }),
    killByTaskId: vi.fn(),
    listSessions: vi.fn(() => []),
    suspend: vi.fn(async () => { callOrder.push('suspend'); }),
    // Phase 1 reconciles task.session_id against the registry before the
    // Priority ladder; a live row for the pointed-at id keeps these fixtures
    // on the branches they exercise.
    getSession: vi.fn((id: string) => ({ id, status: 'running' })),
    findLiveSessionByTaskId: vi.fn(() => null),
    // Section 1 only: the real reapTaskLeftovers calls this. Section 2's
    // reapTaskLeftovers is the barrel mock, which never reaches it.
    reapTaskProcesses: vi.fn(async () => { callOrder.push('reap'); return []; }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockRemoveWorktree.mockClear();
  mockRemoveWorktree.mockResolvedValue(true);
  mockPrepareWorktreeForRemoval.mockClear();
  mockPrepareWorktreeForRemoval.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Section 1: cleanupTaskSession / cleanupTaskResources ordering
// (src/main/ipc/helpers/task-cleanup.ts, real implementation)
// ---------------------------------------------------------------------------

/** What `reapTaskLeftovers` reads besides the session manager: the setting, and the window its toast goes to. */
function reapSettings(stopLeftoverProcesses = true) {
  return {
    configManager: { load: vi.fn(() => ({ stopLeftoverProcesses })), getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  };
}

describe('cleanupTaskSession / cleanupTaskResources ordering (real task-cleanup.ts)', () => {
  it('reaps after the session is killed and every session of the task has exited', async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      currentProjectId: null,
      currentProjectPath: null,
      ...reapSettings(),
    } as unknown as IpcContext;
    const task = { id: 'task-1', session_id: 'pty-live-1', worktree_path: null, branch_name: null };
    const tasks = { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;

    await cleanupTaskSession(context, task, tasks, null, null);

    expect(callOrder).toEqual(['kill', 'removeByTaskId', 'reap']);
    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledWith(null, [{ id: 'task-1', worktreePath: null }], { stop: true });
  });

  it('still reaps when the task has no live session: an earlier session may have left a dev server', async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      currentProjectId: null,
      currentProjectPath: null,
      ...reapSettings(),
    } as unknown as IpcContext;
    const worktreePath = '/mock/project/.kangentic/worktrees/task-1b';
    const task = { id: 'task-1b', session_id: null, worktree_path: worktreePath, branch_name: null };
    const tasks = { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;

    await cleanupTaskSession(context, task, tasks, null, null);

    expect(sessionManager.kill).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['removeByTaskId', 'reap']);
    // The project and the worktree go with the id: only processes working
    // inside them are reaped.
    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledWith(null, [{ id: 'task-1b', worktreePath }], { stop: true });
  });

  it('kills nothing when the user turned "Stop leftover processes" off, and still reports', async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      currentProjectId: null,
      currentProjectPath: null,
      ...reapSettings(false),
    } as unknown as IpcContext;
    const task = { id: 'task-1d', session_id: null, worktree_path: null, branch_name: null };
    const tasks = { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;

    await cleanupTaskSession(context, task, tasks, null, null);

    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledWith(null, [{ id: 'task-1d', worktreePath: null }], { stop: false });
  });

  it('never fails the teardown when the reap throws', async () => {
    const sessionManager = makeSessionManager();
    sessionManager.reapTaskProcesses.mockRejectedValueOnce(new Error('host gone'));
    const context = { sessionManager, currentProjectId: null, currentProjectPath: null, ...reapSettings() } as unknown as IpcContext;
    const task = { id: 'task-1c', session_id: null, worktree_path: null, branch_name: null };
    const tasks = { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {});

    await expect(cleanupTaskSession(context, task, tasks, null, null)).resolves.toBeUndefined();
  });

  it('reaps leftover processes before removing the worktree', async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      currentProjectId: null,
      currentProjectPath: '/mock/project',
      ...reapSettings(),
    } as unknown as IpcContext;
    const task = {
      id: 'task-2',
      session_id: 'pty-live-2',
      worktree_path: '/mock/project/.kangentic/worktrees/task-2',
      branch_name: null,
    };
    const tasks = {
      getById: vi.fn(() => task),
      update: vi.fn(),
      setWorktreeSkipReason: vi.fn(),
    } as unknown as TaskRepository;

    await cleanupTaskResources(context, task, tasks, null, '/mock/project');

    expect(callOrder).toEqual(['kill', 'removeByTaskId', 'reap', 'prepare', 'withLock', 'removeWorktree']);
  });
});

// ---------------------------------------------------------------------------
// Section 2: handleTaskMove's Done branch, and the auto_spawn=false negative
// (src/main/ipc/handlers/task-move.ts, real implementation; the reap helper is
// mocked at the barrel per the comment above the mock declaration).
// ---------------------------------------------------------------------------

const SOURCE_LANE_ID = 'lane-doing';
const DONE_LANE_ID = 'lane-done';
const PARKED_LANE_ID = 'lane-parked';

interface MockContext {
  currentProjectId: string;
  currentProjectPath: string;
  boardEvents: { emitBoardChanged: ReturnType<typeof vi.fn> };
  mainWindow: { isDestroyed: ReturnType<typeof vi.fn>; webContents: { send: ReturnType<typeof vi.fn> } };
  sessionManager: MockSessionManager;
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  boardConfigManager: { getDefaultBaseBranch: ReturnType<typeof vi.fn> };
  terminalSubmitScheduler: { cancel: ReturnType<typeof vi.fn>; scheduleKeystrokes: ReturnType<typeof vi.fn> };
  projectRepo: { getById: ReturnType<typeof vi.fn> };
}

function makeTaskMoveContext(
  taskRepo: { getById: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; archive: ReturnType<typeof vi.fn> },
  swimlaneRepo: { getById: ReturnType<typeof vi.fn> },
): MockContext {
  const context: MockContext = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: makeSessionManager(),
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', name: 'Test Project', default_agent: 'claude' })) },
  };

  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: swimlaneRepo,
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { getPathsForTask: vi.fn(() => []), deleteByTaskId: vi.fn() },
  });

  return context;
}

function makeTaskRepo(task: Task) {
  return {
    getById: vi.fn(() => ({ ...task })),
    move: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    // Not used by anything this file asserts, but both paths under test clear
    // the skip reason on their way through, so the stub has to answer it.
    setWorktreeSkipReason: vi.fn(),
  };
}

function makeSwimlaneRepo(lanes: Swimlane[]) {
  const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));
  return { getById: vi.fn((id: string) => laneMap.get(id) ?? null) };
}

describe('handleTaskMove Done branch: suspend -> reap -> deleteTaskWorktree', () => {
  it('reaps the task after suspending its session and before deleting the worktree', async () => {
    const sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: null });
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done', auto_spawn: false });
    const task = makeTask({
      id: 'task-done-1',
      swimlane_id: SOURCE_LANE_ID,
      session_id: 'pty-active-done',
      worktree_path: '/mock/project/.kangentic/worktrees/task-done-1',
    });
    const taskRepo = makeTaskRepo(task);
    const swimlaneRepo = makeSwimlaneRepo([sourceLane, doneLane]);
    const context = makeTaskMoveContext(taskRepo, swimlaneRepo);

    await handleTaskMove(
      context as never,
      { taskId: task.id, targetSwimlaneId: DONE_LANE_ID, targetPosition: 0 },
      'renderer',
    );

    expect(callOrder).toEqual(['suspend', 'reap', 'deleteWorktree']);
    expect(mockReapTaskLeftovers).toHaveBeenCalledWith(context, '/mock/project', [expect.objectContaining({ id: 'task-done-1', worktree_path: '/mock/project/.kangentic/worktrees/task-done-1' })]);
  });

  it('reaps on Done even when the session ended before the move (a Code Review entry suspended it)', async () => {
    const sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: null });
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done', auto_spawn: false });
    const task = makeTask({
      id: 'task-done-2',
      swimlane_id: SOURCE_LANE_ID,
      session_id: null,
      worktree_path: '/mock/project/.kangentic/worktrees/task-done-2',
    });
    const taskRepo = makeTaskRepo(task);
    const swimlaneRepo = makeSwimlaneRepo([sourceLane, doneLane]);
    const context = makeTaskMoveContext(taskRepo, swimlaneRepo);

    await handleTaskMove(
      context as never,
      { taskId: task.id, targetSwimlaneId: DONE_LANE_ID, targetPosition: 0 },
      'renderer',
    );

    expect(callOrder).toEqual(['reap', 'deleteWorktree']);
    expect(mockReapTaskLeftovers).toHaveBeenCalledWith(context, '/mock/project', [expect.objectContaining({ id: 'task-done-2', worktree_path: '/mock/project/.kangentic/worktrees/task-done-2' })]);
  });
});

describe('handleTaskMove: auto_spawn=false negative (Priority 2.5)', () => {
  it('suspends the session but does NOT reap - the task is parked, and its dev server keeps running', async () => {
    const sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: null });
    const parkedLane = makeSwimlane(PARKED_LANE_ID, { role: null, auto_spawn: false });
    const task = makeTask({
      id: 'task-parked-1',
      swimlane_id: SOURCE_LANE_ID,
      session_id: 'pty-active-parked',
      worktree_path: '/mock/project/.kangentic/worktrees/task-parked-1',
    });
    const taskRepo = makeTaskRepo(task);
    const swimlaneRepo = makeSwimlaneRepo([sourceLane, parkedLane]);
    const context = makeTaskMoveContext(taskRepo, swimlaneRepo);

    await handleTaskMove(
      context as never,
      { taskId: task.id, targetSwimlaneId: PARKED_LANE_ID, targetPosition: 0 },
      'renderer',
    );

    // The path actually ran (suspend fired for the live session)...
    expect(callOrder).toContain('suspend');
    // ...but never reaped. A future accidental wiring of the reap into this
    // branch would turn this red.
    expect(mockReapTaskLeftovers).not.toHaveBeenCalled();
    expect(mockDeleteTaskWorktree).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Section 3: the Stop / Pause negative, proven by static source scan.
//
// The task detail header's Pause/Resume toggle calls SESSION_SUSPEND (parks the
// session, keeps the task and worktree); SESSION_KILL is reachable from the two
// task-delete flows, whose cleanup reaps through cleanupTaskSession, never
// from the handler itself. Extraction is bounded by the NEXT
// `ipcMain.handle(` registration, and each extraction asserts an anchor unique
// to that handler's body, so a mis-extraction fails loudly instead of passing
// the "does not contain" check on an empty slice.
// ---------------------------------------------------------------------------

function extractHandlerBody(source: string, channelConstant: string): string {
  const marker = `ipcMain.handle(IPC.${channelConstant},`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextHandlerStart = source.indexOf('ipcMain.handle(', start + marker.length);
  return nextHandlerStart === -1 ? source.slice(start) : source.slice(start, nextHandlerStart);
}

describe('Stop and Pause never reap (SESSION_KILL and SESSION_SUSPEND)', () => {
  let sessionsSource: string;

  beforeEach(() => {
    const sessionsPath = path.join(__dirname, '../../src/main/ipc/handlers/sessions.ts');
    sessionsSource = fs.readFileSync(sessionsPath, 'utf8');
  });

  it('SESSION_KILL never references reapTaskLeftovers / reapTaskProcesses', () => {
    const handlerRegion = extractHandlerBody(sessionsSource, 'SESSION_KILL');
    expect(handlerRegion).toContain('getSessionTaskId');
    expect(handlerRegion).not.toMatch(/reapTaskLeftovers|reapTaskProcesses/);
  });

  it('SESSION_SUSPEND (the Pause toggle) never references reapTaskLeftovers / reapTaskProcesses', () => {
    const handlerRegion = extractHandlerBody(sessionsSource, 'SESSION_SUSPEND');
    expect(handlerRegion).toContain('pauseTaskSession');
    expect(handlerRegion).not.toMatch(/reapTaskLeftovers|reapTaskProcesses/);
  });

  it("pauseTaskSession (the desktop Pause's and the phone's pause-session's shared path) never references reapTaskLeftovers / reapTaskProcesses", () => {
    const pauseSource = fs.readFileSync(path.join(__dirname, '../../src/main/ipc/handlers/session-pause.ts'), 'utf8');
    expect(pauseSource).toContain('applySuspendDbWrites');
    expect(pauseSource).not.toMatch(/reapTaskLeftovers|reapTaskProcesses/);

    // The phone's handler adds nothing to the shared path, a reap included.
    const phoneSource = fs.readFileSync(path.join(__dirname, '../../src/main/mobile-bridge/handlers/pause-session.ts'), 'utf8');
    expect(phoneSource).toContain('pauseTaskSession');
    expect(phoneSource).not.toMatch(/reapTaskLeftovers|reapTaskProcesses/);
  });
});

// ---------------------------------------------------------------------------
// Section 4: PROJECT_DELETE reaps between the session exits and the worktree
// removal (line-order scan of cleanupProject in handlers/projects.ts).
// ---------------------------------------------------------------------------

describe('PROJECT_DELETE reaps every task, archived ones included', () => {
  it('reaps after the sessions are removed and their in-flight spawns are cancelled and awaited, and before any worktree is detached', () => {
    const projectsSource = fs.readFileSync(path.join(__dirname, '../../src/main/ipc/handlers/projects.ts'), 'utf8');
    const bodyStart = projectsSource.indexOf('export async function cleanupProject(');
    expect(bodyStart).toBeGreaterThan(-1);
    const body = projectsSource.slice(bodyStart);
    const exitsAwaited = body.indexOf('await Promise.all(sessionExits)');
    // removeByTaskId cancels a spawn still in flight (no session_id names it
    // yet) and waits for it, so no PTY starts in a worktree about to be reaped.
    const spawnsCancelled = body.indexOf('context.sessionManager.removeByTaskId(');
    const reap = body.indexOf('await reapTaskLeftovers(');
    const worktreeRemoval = body.indexOf('worktreeManager.removeWorktree(');
    expect(exitsAwaited).toBeGreaterThan(-1);
    expect(spawnsCancelled).toBeGreaterThan(exitsAwaited);
    expect(reap).toBeGreaterThan(spawnsCancelled);
    expect(worktreeRemoval).toBeGreaterThan(reap);
    // The cancel is awaited, not fired and forgotten, before the reap starts.
    expect(body.slice(exitsAwaited, reap)).toContain('await Promise.all(allTasks.map((task) => context.sessionManager.removeByTaskId(task.id)))');
    // Archived tasks are reaped too, against the project being deleted: only
    // processes working inside it are killed.
    const reapRegion = body.slice(exitsAwaited, worktreeRemoval);
    expect(reapRegion).toContain('await reapTaskLeftovers(context, projectPath, [...allTasks, ...archivedTasks])');
  });
});

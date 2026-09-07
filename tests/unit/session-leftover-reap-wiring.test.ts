/**
 * Verified test-coverage holes from the session-leftover-reap code-review pass
 * (see the PR description: session teardown now kills whatever a session left
 * running inside its worktree, so a leaked dev server can no longer hold the
 * directory and block its removal on Windows).
 *
 * `captureSessionLeftovers` / `reapSessionLeftovers` (src/main/ipc/helpers/
 * task-cleanup.ts) already appeared in tests/, but only as inert module-level
 * mocks (`vi.fn(() => null)` / `vi.fn(async () => {})`) in
 * task-move-shutdown.test.ts and task-move-git-churn-wiring.test.ts. Nothing
 * asserted the ORDERING these two functions exist to enforce, and nothing
 * asserted the deliberate omission on the Stop / auto_spawn=false paths. This
 * file closes those gaps:
 *
 *   1. `cleanupTaskSession` / `cleanupTaskResources` (task-cleanup.ts, REAL):
 *      capture runs BEFORE the PTY kill; the reap runs AFTER the kill and
 *      BEFORE the worktree removal. session-tree-reap and worktree-manager are
 *      mocked; the functions under test are the real exports.
 *   2. `handleTaskMove`'s Done branch (task-move.ts, REAL): capture -> suspend
 *      -> reap -> deleteTaskWorktree, in that order. captureSessionLeftovers /
 *      reapSessionLeftovers / deleteTaskWorktree are mocked at the barrel
 *      (`ipc/helpers/index`), mirroring task-move-git-churn-wiring.test.ts's
 *      approach for captureGitChurn: this is a WIRING test asserting the CALL
 *      and its position, not the reap's own logic (already covered by
 *      session-tree-reap.test.ts / session-reap-real-processes.test.ts).
 *   3. The deliberate negative, in two halves:
 *      a. a move into an auto_spawn=false column (Priority 2.5, same file as #2)
 *         must NOT capture or reap - it parks the task rather than finishing it.
 *      b. "Stop" (sessions.ts) must NOT capture or reap either. There is no
 *         single dedicated IPC channel for that verb, so this checks both
 *         plausible readings: SESSION_KILL (the two task-delete flows) and
 *         SESSION_SUSPEND (the task-detail Pause toggle, which parks a
 *         session exactly the way Priority 2.5 parks a task). Proven by a
 *         static source scan of each handler body rather than a full import
 *         of sessions.ts, which would duplicate a large, unrelated mock
 *         graph (PR linking, transient sessions, git churn, ...) for no
 *         additional confidence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Task, Swimlane } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type { CapturedSessionTree } from '../../src/main/activity-engine/background-shell/process-tree';

// ---------------------------------------------------------------------------
// Shared call-order tracker. Reset per test; Section 1 (direct task-cleanup.ts
// calls) and Section 2 (handleTaskMove wiring) push into the same array but
// never within the same test, so there is no cross-talk.
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

// The real reap primitive, used only by Section 1's direct calls into the
// real cleanupTaskSession / cleanupTaskResources. Section 2 never reaches
// this module because task-move.ts's captureSessionLeftovers/
// reapSessionLeftovers are mocked at the barrel instead (see below).
const mockReapCapturedTree = vi.fn(async (): Promise<number[]> => []);
vi.mock('../../src/main/pty/session-tree-reap', () => ({
  reapCapturedTree: (...args: [CapturedSessionTree | null]) => {
    callOrder.push('reap');
    return mockReapCapturedTree(...args);
  },
}));

// Section 2's seam: task-move.ts imports captureSessionLeftovers /
// reapSessionLeftovers / deleteTaskWorktree from this barrel, so mocking it
// here observes the CALL and its position without re-running
// reapCapturedTree's own logic (covered elsewhere).
const mockCaptureSessionLeftovers = vi.fn((): CapturedSessionTree => {
  callOrder.push('capture');
  return { rootPid: 111, pids: [222], capturedAt: Date.now() };
});
const mockReapSessionLeftovers = vi.fn(async (): Promise<void> => {
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
  captureSessionLeftovers: (...args: unknown[]) => mockCaptureSessionLeftovers(...args),
  reapSessionLeftovers: (...args: unknown[]) => mockReapSessionLeftovers(...args),
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
  getCapturedSessionTree: ReturnType<typeof vi.fn>;
}

function makeSessionManager(): MockSessionManager {
  return {
    kill: vi.fn(() => { callOrder.push('kill'); }),
    awaitExit: vi.fn(async () => {}),
    remove: vi.fn(),
    removeByTaskId: vi.fn(),
    killByTaskId: vi.fn(),
    listSessions: vi.fn(() => []),
    suspend: vi.fn(async () => { callOrder.push('suspend'); }),
    // Section 1 only (the real captureSessionLeftovers calls this directly).
    // Section 2 never reaches it - task-move.ts's captureSessionLeftovers is
    // the barrel mock above, which never touches context.sessionManager.
    getCapturedSessionTree: vi.fn((): CapturedSessionTree => {
      callOrder.push('captureRead');
      return { rootPid: 111, pids: [222], capturedAt: Date.now() };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockReapCapturedTree.mockClear();
  mockReapCapturedTree.mockResolvedValue([]);
  mockRemoveWorktree.mockClear();
  mockRemoveWorktree.mockResolvedValue(true);
  mockPrepareWorktreeForRemoval.mockClear();
  mockPrepareWorktreeForRemoval.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Section 1: cleanupTaskSession / cleanupTaskResources ordering
// (src/main/ipc/helpers/task-cleanup.ts, real implementation)
// ---------------------------------------------------------------------------

describe('cleanupTaskSession / cleanupTaskResources ordering (real task-cleanup.ts)', () => {
  it('captures leftovers before killing the PTY, and reaps them after the kill', async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      currentProjectId: null,
      currentProjectPath: null,
    } as unknown as IpcContext;
    const task = { id: 'task-1', session_id: 'pty-live-1', worktree_path: null, branch_name: null };
    const tasks = { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;

    await cleanupTaskSession(context, task, tasks, null, null);

    expect(callOrder).toEqual(['captureRead', 'kill', 'reap']);
    expect(sessionManager.getCapturedSessionTree).toHaveBeenCalledWith('pty-live-1');
    expect(mockReapCapturedTree).toHaveBeenCalledWith({ rootPid: 111, pids: [222], capturedAt: expect.any(Number) });
  });

  it('is a no-op capture/reap when the task has no active session', async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      currentProjectId: null,
      currentProjectPath: null,
    } as unknown as IpcContext;
    const task = { id: 'task-1b', session_id: null, worktree_path: null, branch_name: null };
    const tasks = { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;

    await cleanupTaskSession(context, task, tasks, null, null);

    expect(sessionManager.getCapturedSessionTree).not.toHaveBeenCalled();
    expect(sessionManager.kill).not.toHaveBeenCalled();
    expect(mockReapCapturedTree).not.toHaveBeenCalled();
  });

  it('reaps leftover processes before removing the worktree', async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      currentProjectId: null,
      currentProjectPath: '/mock/project',
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
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

    expect(callOrder).toEqual(['captureRead', 'kill', 'reap', 'prepare', 'withLock', 'removeWorktree']);
  });
});

// ---------------------------------------------------------------------------
// Section 2: handleTaskMove's Done branch, and the auto_spawn=false negative
// (src/main/ipc/handlers/task-move.ts, real implementation; the reap helpers
// are mocked at the barrel per the comment above the mock declaration).
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

describe('handleTaskMove Done branch: capture -> suspend -> reap -> deleteTaskWorktree', () => {
  it('reaps leftovers after suspending the session and before deleting the worktree', async () => {
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

    expect(callOrder).toEqual(['capture', 'suspend', 'reap', 'deleteWorktree']);
    expect(mockCaptureSessionLeftovers).toHaveBeenCalledWith(context, 'pty-active-done');
    expect(mockDeleteTaskWorktree).toHaveBeenCalled();
  });
});

describe('handleTaskMove: auto_spawn=false negative (Priority 2.5)', () => {
  it('suspends the session but does NOT capture or reap - the task is parked, not finished', async () => {
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
    // ...but never touched the leftover-reap machinery. A future accidental
    // wiring of the reap into this branch would turn this red.
    expect(mockCaptureSessionLeftovers).not.toHaveBeenCalled();
    expect(mockReapSessionLeftovers).not.toHaveBeenCalled();
    expect(mockDeleteTaskWorktree).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Section 3: the Stop negative, proven by static source scan.
//
// "Stop" has no single dedicated IPC channel in the current UI: the task
// detail header's Pause/Resume toggle calls SESSION_SUSPEND (parks the
// session, keeps the task and worktree - exactly the "park rather than
// finish" contract this hole is about), while SESSION_KILL is reachable only
// from the two task-delete flows (TaskCard's context-menu delete and the
// task-detail dialog's delete). Both bodies are three to six lines and
// neither references the session manager's captured-tree snapshot today, so
// this scans BOTH rather than guessing which one "Stop" means.
//
// Extraction is bounded by the NEXT `ipcMain.handle(` registration rather
// than the first `\n<ws>});`, because a handler containing its own nested
// `withTaskLock(taskId, async () => { ... });` closes on exactly that shape
// before the outer handler does - a brace-shaped match would truncate the
// body there and silently stop seeing anything added after it. Each
// extraction also asserts an anchor string unique to that handler's real
// body, so a mis-extraction (e.g. capturing zero lines, or the wrong handler
// entirely) fails loudly instead of vacuously passing the "does not contain"
// check on an empty or unrelated slice.
//
// Importing the whole of sessions.ts (PR linking, transient sessions, git
// churn, session-reconcile, ...) just to invoke these two handlers would
// duplicate a large, unrelated mock graph for no additional confidence; a
// source scan states the same invariant directly and is exactly as
// red-green-able (verified by temporarily adding a call inside each handler
// body, including a nested-`withTaskLock`-shaped one for SESSION_KILL, and
// confirming red before restoring the source).
// ---------------------------------------------------------------------------

function extractHandlerBody(source: string, channelConstant: string): string {
  const marker = `ipcMain.handle(IPC.${channelConstant},`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextHandlerStart = source.indexOf('ipcMain.handle(', start + marker.length);
  return nextHandlerStart === -1 ? source.slice(start) : source.slice(start, nextHandlerStart);
}

describe('Stop does not capture or reap (SESSION_KILL and SESSION_SUSPEND)', () => {
  let sessionsSource: string;

  beforeEach(() => {
    const sessionsPath = path.join(__dirname, '../../src/main/ipc/handlers/sessions.ts');
    sessionsSource = fs.readFileSync(sessionsPath, 'utf8');
  });

  it('SESSION_KILL (task-delete flows) never references captureSessionLeftovers/reapSessionLeftovers', () => {
    const handlerRegion = extractHandlerBody(sessionsSource, 'SESSION_KILL');

    // Anchor: proves this is really SESSION_KILL's body, not an empty or
    // mis-bounded slice.
    expect(handlerRegion).toContain('getSessionTaskId');
    expect(handlerRegion).not.toMatch(/captureSessionLeftovers/);
    expect(handlerRegion).not.toMatch(/reapSessionLeftovers/);
  });

  it('SESSION_SUSPEND (the Pause toggle) never references captureSessionLeftovers/reapSessionLeftovers', () => {
    const handlerRegion = extractHandlerBody(sessionsSource, 'SESSION_SUSPEND');

    // Anchor: proves this is really SESSION_SUSPEND's body.
    expect(handlerRegion).toContain('applySuspendDbWrites');
    expect(handlerRegion).not.toMatch(/captureSessionLeftovers/);
    expect(handlerRegion).not.toMatch(/reapSessionLeftovers/);
  });
});

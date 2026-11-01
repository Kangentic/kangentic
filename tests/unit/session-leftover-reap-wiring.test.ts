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
 *      move whose session had already ended before the move. A removal that
 *      fails schedules the one delayed retry (`scheduleDoneWorktreeRemovalRetry`),
 *      right after it and for that task; a removal that succeeds schedules none.
 *   3. The deliberate negatives: a move into an auto_spawn=false column and
 *      the Stop / Pause handlers (SESSION_KILL, SESSION_SUSPEND) never reap.
 *      The user chose to keep a parked task's dev server running.
 *   4. `PROJECT_DELETE` reaps after its sessions' exits and before removing
 *      worktrees (static line-order scan; the handler's mock graph is large).
 *
 *   5. The distros a reap also runs in (`wslCliDistrosOf`, REAL, in the "real
 *      wslCliDistrosOf" block): the session records' `cli_target` distros reach
 *      `reapTaskProcesses`, merged after a caller's own, on Windows only; the
 *      startup sweep gets the same lookup through `leftoverSweepOptions`.
 *
 * The same terminal transitions close the task's windows (`closeTaskWindows`,
 * src/main/ipc/helpers/task-windows.ts: its pop-outs and its offscreen lane),
 * and the same negatives leave them open. The close sits after the sessions
 * have ended, so a Browser pop-out's closing guest is never handed off to a
 * lane for a live agent, and before the reap. Its own behavior is pinned in
 * task-windows.test.ts; this file pins where it is called. `cleanupProject`'s
 * window closing, on its missing-folder, tasks-read and read-failed paths, is
 * driven at runtime in project-delete-task-windows.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task, Swimlane } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';

// ---------------------------------------------------------------------------
// Shared call-order tracker. Reset per test.
// ---------------------------------------------------------------------------

const { callOrder, mockGetOpenProjectDb, mockListCliTargetsOfTasks, mockListForTaskNewestFirst, latestSession } = vi.hoisted(() => ({
  callOrder: [] as string[],
  // The task's newest session record, as `getLatestForTask` answers it. Null
  // (no record) unless a test sets one; a held pause keeps a move from spawning.
  latestSession: { record: null as unknown },
  // The WSL distro lookup (`wslCliDistrosOf` in task-cleanup.ts): the project's
  // open database, and the `cli_target` rows its sessions recorded.
  mockGetOpenProjectDb: vi.fn((_projectId: string): unknown => null),
  mockListCliTargetsOfTasks: vi.fn((_taskIds: readonly string[]): string[] => []),
  // The task's session records, newest first (`stopTaskBackgroundSessions`).
  mockListForTaskNewestFirst: vi.fn((_taskId: string): unknown[] => []),
}));

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []) })) })),
  getOpenProjectDb: (projectId: string) => mockGetOpenProjectDb(projectId),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    // No own-record row, so the capture sites fall back to getLatestForTask.
    findByAnyId = vi.fn(() => undefined);
    listCliTargetsOfTasks = (taskIds: readonly string[]) => mockListCliTargetsOfTasks(taskIds);
    listForTaskNewestFirst = (taskId: string) => mockListForTaskNewestFirst(taskId);
    getLatestForTask = vi.fn(() => latestSession.record);
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
// The Done move's one delayed retry of a failed worktree removal. Mocked, so
// the test observes the CALL (its arguments and position); the timer and the
// retry itself are pinned in leftover-worktree-retry.test.ts.
const mockScheduleDoneWorktreeRemovalRetry = vi.fn((..._retryArguments: unknown[]): void => {
  callOrder.push('scheduleRetry');
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
  scheduleDoneWorktreeRemovalRetry: (...args: unknown[]) => mockScheduleDoneWorktreeRemovalRetry(...args),
  reportAutomationFailures: vi.fn(),
}));

// Both task-move.ts and task-cleanup.ts import the window close from its own
// module, so one mock observes it in Section 1 and Section 2 alike.
const mockCloseTaskWindows = vi.fn((..._closeArguments: unknown[]): void => {
  callOrder.push('closeWindows');
});
vi.mock('../../src/main/ipc/helpers/task-windows', () => ({
  closeTaskWindows: (...args: unknown[]) => mockCloseTaskWindows(...args),
}));

// ---------------------------------------------------------------------------
// Imports under test (after all mocks)
// ---------------------------------------------------------------------------

import { cleanupTaskSession, cleanupTaskResources, reapTaskLeftovers, leftoverSweepOptions } from '../../src/main/ipc/helpers/task-cleanup';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { claudeSessionStartLine } from './helpers/claude-session-start';
import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { clearSpawnProgress } from '../../src/main/transition-engine/spawn-progress';

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
  latestSession.record = null;
  mockRemoveWorktree.mockClear();
  mockRemoveWorktree.mockResolvedValue(true);
  mockPrepareWorktreeForRemoval.mockClear();
  mockPrepareWorktreeForRemoval.mockResolvedValue(undefined);
  // Back to "no project database open, no session recorded a distro", so the
  // cases that do not look at distros keep reaping with `wslDistros: []`.
  mockGetOpenProjectDb.mockReset();
  mockGetOpenProjectDb.mockReturnValue(null);
  mockListCliTargetsOfTasks.mockReset();
  mockListCliTargetsOfTasks.mockReturnValue([]);
  mockListForTaskNewestFirst.mockReset();
  mockListForTaskNewestFirst.mockReturnValue([]);
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

    expect(callOrder).toEqual(['kill', 'removeByTaskId', 'closeWindows', 'reap']);
    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledWith(null, [{ id: 'task-1', worktreePath: null }], { stop: true, onLateEntries: expect.any(Function), wslDistros: [] });
  });

  it("closes the task's windows against its own project, after its sessions are gone and before the reap", async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      // Ambient project differs: the close must use the one the caller passed.
      currentProjectId: 'proj-ambient',
      currentProjectPath: null,
      ...reapSettings(),
    } as unknown as IpcContext;
    const task = { id: 'task-1w', session_id: 'pty-live-1w', worktree_path: null, branch_name: null };
    const tasks = { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;

    await cleanupTaskSession(context, task, tasks, 'proj-explicit', null);

    expect(callOrder).toEqual(['kill', 'removeByTaskId', 'closeWindows', 'reap']);
    expect(mockCloseTaskWindows).toHaveBeenCalledTimes(1);
    expect(mockCloseTaskWindows).toHaveBeenCalledWith('proj-explicit', 'task-1w');
  });

  it("closes the task's windows against the ambient project when the caller passes none", async () => {
    const sessionManager = makeSessionManager();
    const context = {
      sessionManager,
      // No explicit project below: the close falls back to this one.
      currentProjectId: 'proj-ambient',
      currentProjectPath: null,
      ...reapSettings(),
    } as unknown as IpcContext;
    const task = { id: 'task-1a', session_id: 'pty-live-1a', worktree_path: null, branch_name: null };
    const tasks = { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;

    await cleanupTaskSession(context, task, tasks, null, null);

    expect(callOrder).toEqual(['kill', 'removeByTaskId', 'closeWindows', 'reap']);
    expect(mockCloseTaskWindows).toHaveBeenCalledTimes(1);
    expect(mockCloseTaskWindows).toHaveBeenCalledWith('proj-ambient', 'task-1a');
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
    expect(callOrder).toEqual(['removeByTaskId', 'closeWindows', 'reap']);
    // The project and the worktree go with the id: only processes working
    // inside them are reaped.
    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledWith(null, [{ id: 'task-1b', worktreePath }], { stop: true, onLateEntries: expect.any(Function), wslDistros: [] });
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

    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledWith(null, [{ id: 'task-1d', worktreePath: null }], { stop: false, onLateEntries: expect.any(Function), wslDistros: [] });
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

    expect(callOrder).toEqual(['kill', 'removeByTaskId', 'closeWindows', 'reap', 'prepare', 'withLock', 'removeWorktree']);
  });
});

// ---------------------------------------------------------------------------
// Section 1b: the WSL distros a reap also runs in (`wslCliDistrosOf`)
//
// The in-distro reap runs in each distro a task's CLI ran in, which only the
// task's session records know (`sessions.cli_target`). Every case above passes
// `wslDistros: []`, so none of them notices a reap that stops asking the
// records. Here the records name a distro, and the REAL wslCliDistrosOf reads
// them through the project's open database. It reads them on Windows only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A conversation the agent CLI moved into its own background session (Claude
// Code's `/bg`) outlives the task's PTY. A terminal transition stops it through
// the CLI's own stop BEFORE the reap, which would otherwise kill it with no exit
// of its own (measured on 2.1.316: `claude stop` ran its SessionEnd hook).
// ---------------------------------------------------------------------------

describe('a conversation in the agent CLI\'s own background session stops before the reap', () => {
  const RECORD_ID = 'record-bg-0001';
  const MOVED = '0005843e-b5d5-4bc9-8a45-38ae97f6cdc2';
  const CLI_PATH = 'C:\\Users\\dev\\.local\\bin\\claude.exe';
  /** The conversation a record stored before a background move, in the stale-id cases. */
  const STALE = '6e21471d-887a-42d3-97d3-fcfedac9dd51';
  /** Only passed through to the move check, never read from disk. */
  const RECORD_CWD = '/mock/project/.kangentic/worktrees/bg-1';
  let projectPath: string;
  let adapter: AgentAdapter;
  let detect: ReturnType<typeof vi.fn>;
  let confirmsBackgroundMove: ReturnType<typeof vi.fn>;
  let stopBackgroundSession: ReturnType<typeof vi.fn>;

  function writeEvents(lines: string[], recordId = RECORD_ID): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', recordId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), lines.map((line) => line + '\n').join(''), 'utf8');
  }

  /** A distinct, UUID-shaped conversation id per index. */
  function conversationId(index: number): string {
    return `0000000${index}-b5d5-4bc9-8a45-38ae97f6cdc2`;
  }

  /** A session record as the repository hands it back, stored on `agentSessionId`. */
  function recordOf(recordId: string, agentSessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: recordId, task_id: 'task-bg-1', agent_session_id: agentSessionId, session_type: 'claude_agent', ...extra };
  }

  /** Events showing the record's own stored conversation in a background session (a `fork` SessionStart naming it). */
  function writeMovedRecordEvents(recordId: string, agentSessionId: string): void {
    writeEvents([claudeSessionStartLine(agentSessionId, 'fork', 2)], recordId);
  }

  /** The `agentSessionId` of every `stopBackgroundSession` call so far, sorted (stops run two at a time, so their order varies). */
  function stoppedConversationIds(): string[] {
    return stopBackgroundSession.mock.calls
      .map((call) => (call[0] as { agentSessionId: string }).agentSessionId)
      .sort();
  }

  function makeContext(sessionManager: MockSessionManager, stopLeftoverProcesses = true): IpcContext {
    return {
      sessionManager,
      currentProjectId: null,
      currentProjectPath: null,
      projectRepo: { list: vi.fn(() => [{ id: 'proj-bg', path: projectPath }]) },
      configManager: {
        load: vi.fn(() => ({ stopLeftoverProcesses })),
        getEffectiveConfig: vi.fn(() => ({ agent: { cliPaths: {} }, git: { autoCleanup: false } })),
      },
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
  }

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-bg-reap-'));
    mockGetOpenProjectDb.mockImplementation((projectId: string) => (projectId === 'proj-bg' ? { name: 'open-project-db' } : null));
    mockListForTaskNewestFirst.mockReturnValue([
      { id: RECORD_ID, task_id: 'task-bg-1', agent_session_id: MOVED, session_type: 'claude_agent' },
    ]);
    stopBackgroundSession = vi.fn(async () => { callOrder.push('stopBackgroundSession'); return true; });
    detect = vi.fn(async () => ({ found: true, path: CLI_PATH, version: '2.1.316' }));
    // Not a move by default; the stale-id cases say what the CLI's record shows.
    confirmsBackgroundMove = vi.fn(async () => false);
    adapter = {
      name: 'claude',
      runtime: {
        statusFile: {
          parseStatus: () => null,
          parseEvent: () => null,
          isFullRewrite: true,
          parseSessionStart: ClaudeStatusParser.parseSessionStart,
          confirmsBackgroundMove,
        },
      },
      detect,
      stopBackgroundSession,
    } as unknown as AgentAdapter;
    vi.spyOn(agentRegistry, 'getBySessionType').mockImplementation((sessionType) => (sessionType === 'claude_agent' ? adapter : undefined));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('stops the background session holding the conversation, then reaps', async () => {
    writeEvents([claudeSessionStartLine('6e21471d-887a-42d3-97d3-fcfedac9dd51', 'resume', 1), claudeSessionStartLine(MOVED, 'fork', 2)]);
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: MOVED, cliPath: CLI_PATH });
    expect(callOrder).toEqual(['stopBackgroundSession', 'reap']);
  });

  it('stops it with "Stop leftover processes" off too: it is the task\'s own agent, not a leftover', async () => {
    writeEvents([claudeSessionStartLine('6e21471d-887a-42d3-97d3-fcfedac9dd51', 'startup', 1), claudeSessionStartLine(MOVED, 'fork', 2)]);
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager, false), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledWith(projectPath, expect.anything(), expect.objectContaining({ stop: false }));
  });

  it('runs no CLI for a conversation that never moved into a background session', async () => {
    writeEvents([claudeSessionStartLine(MOVED, 'resume', 1)]);
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    expect(stopBackgroundSession).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['reap']);
  });

  it('checks only each task\'s 3 newest records', async () => {
    const indexes = [1, 2, 3, 4, 5];
    // Newest first, each moved into a background session under its own stored id.
    for (const index of indexes) writeMovedRecordEvents(`record-bg-${index}`, conversationId(index));
    mockListForTaskNewestFirst.mockReturnValue(indexes.map((index) => recordOf(`record-bg-${index}`, conversationId(index))));
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    expect(stoppedConversationIds()).toEqual([1, 2, 3].map((index) => conversationId(index)));
    expect(callOrder).toEqual(['stopBackgroundSession', 'stopBackgroundSession', 'stopBackgroundSession', 'reap']);
  });

  it('stops a conversation two records name once', async () => {
    writeMovedRecordEvents('record-bg-a', MOVED);
    writeMovedRecordEvents('record-bg-b', MOVED);
    mockListForTaskNewestFirst.mockReturnValue([recordOf('record-bg-a', MOVED), recordOf('record-bg-b', MOVED)]);
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: MOVED, cliPath: CLI_PATH });
    expect(callOrder).toEqual(['stopBackgroundSession', 'reap']);
  });

  it('detects the CLI once per adapter however many records need a stop', async () => {
    const indexes = [1, 2, 3];
    for (const index of indexes) writeMovedRecordEvents(`record-bg-${index}`, conversationId(index));
    mockListForTaskNewestFirst.mockReturnValue(indexes.map((index) => recordOf(`record-bg-${index}`, conversationId(index))));
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    // Three distinct conversations stopped, through one detection.
    expect(stopBackgroundSession).toHaveBeenCalledTimes(3);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(callOrder.at(-1)).toBe('reap');
  });

  it('stops nothing when the CLI is not found, and still reaps', async () => {
    writeEvents([claudeSessionStartLine(MOVED, 'fork', 2)]);
    detect.mockResolvedValue({ found: false });
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    // The record's events do show a move, so the CLI was looked for.
    expect(detect).toHaveBeenCalledTimes(1);
    expect(stopBackgroundSession).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['reap']);
  });

  it('still reaps when the stop throws', async () => {
    writeEvents([claudeSessionStartLine(MOVED, 'fork', 2)]);
    stopBackgroundSession.mockImplementation(async () => {
      callOrder.push('stopBackgroundSession');
      throw new Error('claude stop failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(callOrder).toEqual(['stopBackgroundSession', 'reap']);
  });

  it('still reaps when detecting the CLI throws', async () => {
    writeEvents([claudeSessionStartLine(MOVED, 'fork', 2)]);
    detect.mockRejectedValue(new Error('spawn failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    expect(detect).toHaveBeenCalledTimes(1);
    expect(stopBackgroundSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(callOrder).toEqual(['reap']);
  });

  it('skips an adapter that cannot stop a background session, and still reaps', async () => {
    writeEvents([claudeSessionStartLine(MOVED, 'fork', 2)]);
    delete adapter.stopBackgroundSession;
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    // No CLI is looked for either.
    expect(detect).not.toHaveBeenCalled();
    expect(stopBackgroundSession).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['reap']);
  });

  it('follows a record stored on a stale id to the background session the CLI confirms it moved to', async () => {
    writeEvents([claudeSessionStartLine(STALE, 'resume', 1), claudeSessionStartLine(MOVED, 'fork', 2)]);
    mockListForTaskNewestFirst.mockReturnValue([
      recordOf(RECORD_ID, STALE, { cwd: RECORD_CWD, cli_target: '{"kind":"wsl","distro":"Ubuntu"}' }),
    ]);
    confirmsBackgroundMove.mockResolvedValue(true);
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    // The move check gets the record's cwd and its parsed target, not the raw column.
    expect(confirmsBackgroundMove).toHaveBeenCalledWith({
      cwd: RECORD_CWD,
      fromAgentSessionId: STALE,
      toAgentSessionId: MOVED,
      cliTarget: { kind: 'wsl', distro: 'Ubuntu' },
    });
    expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: MOVED, cliPath: CLI_PATH });
    expect(callOrder).toEqual(['stopBackgroundSession', 'reap']);
  });

  it('stops nothing for a record stored on a stale id when the CLI says the other session is a /fork copy', async () => {
    writeEvents([claudeSessionStartLine(STALE, 'resume', 1), claudeSessionStartLine(MOVED, 'fork', 2)]);
    mockListForTaskNewestFirst.mockReturnValue([recordOf(RECORD_ID, STALE, { cwd: RECORD_CWD })]);
    confirmsBackgroundMove.mockResolvedValue(false);
    const sessionManager = makeSessionManager();

    await reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);

    // Asked, with no target for a record that ran on this machine, and refused.
    expect(confirmsBackgroundMove).toHaveBeenCalledWith({
      cwd: RECORD_CWD,
      fromAgentSessionId: STALE,
      toAgentSessionId: MOVED,
      cliTarget: null,
    });
    expect(stopBackgroundSession).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['reap']);
  });

  it('runs no more than 2 stops at once over a bulk reap', async () => {
    const tasks = [1, 2, 3, 4].map((index) => ({ id: `task-bg-${index}`, worktree_path: null }));
    const recordByTask = new Map<string, Record<string, unknown>>();
    tasks.forEach((task, position) => {
      const index = position + 1;
      writeMovedRecordEvents(`record-bg-t${index}`, conversationId(index));
      recordByTask.set(task.id, recordOf(`record-bg-t${index}`, conversationId(index), { task_id: task.id }));
    });
    mockListForTaskNewestFirst.mockImplementation((taskId: string) => [recordByTask.get(taskId)]);

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let inFlight = 0;
    let peak = 0;
    stopBackgroundSession.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return true;
    });
    const sessionManager = makeSessionManager();

    const reaping = reapTaskLeftovers(makeContext(sessionManager), projectPath, tasks);
    try {
      await vi.waitFor(() => expect(stopBackgroundSession.mock.calls.length).toBeGreaterThanOrEqual(2));
      // Intentional fixed wait: a third stop that must NOT start cannot be polled
      // for. Each stop begins only after real file reads, so this is the budget
      // an unbounded fan-out needs to get its other two in flight.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stopBackgroundSession).toHaveBeenCalledTimes(2);
      expect(inFlight).toBe(2);
    } finally {
      releaseGate();
    }
    await reaping;

    expect(stopBackgroundSession).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledTimes(1);
  });

  // The stops race one deadline, twice a single stop's own 10 s budget, so a
  // supervisor that never answers holds a bulk delete for 20 s, not for a
  // budget per record. At the deadline the queue is cleared, so a stop still
  // waiting for a slot never starts once the reap has gone ahead.
  it('goes ahead with the reap 20 s after stops that never answer, and starts no queued stop after it', async () => {
    const indexes = [1, 2, 3];
    for (const index of indexes) writeMovedRecordEvents(`record-bg-${index}`, conversationId(index));
    mockListForTaskNewestFirst.mockReturnValue(indexes.map((index) => recordOf(`record-bg-${index}`, conversationId(index))));
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    stopBackgroundSession.mockImplementation(async () => {
      callOrder.push('stopBackgroundSession');
      await gate;
      return true;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionManager = makeSessionManager();

    // Only the deadline's timer is faked. setImmediate and Date stay real, so the
    // file reads behind each stop run as they do in production, and `pause`
    // keeps the real timer for waiting on them.
    const realSetTimeout = globalThis.setTimeout;
    const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => { realSetTimeout(resolve, milliseconds); });
    const untilTrue = async (condition: () => boolean): Promise<void> => {
      const giveUpAt = Date.now() + 2500;
      while (!condition() && Date.now() < giveUpAt) await pause(5);
    };

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const reaping = reapTaskLeftovers(makeContext(sessionManager), projectPath, [{ id: 'task-bg-1', worktree_path: null }]);
      // Two slots, two stops in flight, the third record queued behind them.
      await untilTrue(() => stopBackgroundSession.mock.calls.length >= 2);
      expect(stopBackgroundSession).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(19_999);
      expect(sessionManager.reapTaskProcesses).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await untilTrue(() => sessionManager.reapTaskProcesses.mock.calls.length > 0);
      expect(sessionManager.reapTaskProcesses).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['stopBackgroundSession', 'stopBackgroundSession', 'reap']);

      // The stops that never answered finish late and free their slots. The
      // third stop must not take one. Intentional fixed wait: a stop that must
      // NOT start cannot be polled for, and each one begins only after real file
      // reads, so this is the budget a stop left in the queue would need.
      releaseGate();
      await pause(200);
      expect(stopBackgroundSession).toHaveBeenCalledTimes(2);
      await reaping;
    } finally {
      releaseGate();
      vi.useRealTimers();
    }
  });
});

describe('the distros a reap also runs in (real wslCliDistrosOf)', () => {
  const PROJECT_PATH = '/mock/project';
  const PROJECT_DB = { name: 'open-project-db' };
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

  function fakePlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
  }

  /** A session record's `cli_target` column, as the repository hands it back. */
  function recordedTarget(distro: string, extra: Record<string, string> = {}): string {
    return JSON.stringify({ kind: 'wsl', distro, ...extra });
  }

  function makeReapContext(sessionManager: MockSessionManager): IpcContext {
    return {
      sessionManager,
      currentProjectId: null,
      // A different project from the one the reap is asked about, so a lookup
      // that read the ambient path would miss the project below.
      currentProjectPath: '/mock/ambient-project',
      projectRepo: {
        list: vi.fn(() => [
          { id: 'proj-other', path: '/mock/other-project' },
          { id: 'proj-wsl', path: PROJECT_PATH },
        ]),
      },
      ...reapSettings(),
    } as unknown as IpcContext;
  }

  function makeTasksStub(task: { id: string }): TaskRepository {
    return { getById: vi.fn(() => task), update: vi.fn() } as unknown as TaskRepository;
  }

  /** The `wslDistros` the last host reap was asked for. */
  function reapedDistros(sessionManager: MockSessionManager): string[] {
    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledTimes(1);
    return (sessionManager.reapTaskProcesses.mock.calls[0] as unknown as [unknown, unknown, { wslDistros: string[] }])[2].wslDistros;
  }

  beforeEach(() => {
    fakePlatform('win32');
    // Only the open project's database answers; any other id has none open.
    mockGetOpenProjectDb.mockImplementation((projectId: string) => (projectId === 'proj-wsl' ? PROJECT_DB : null));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('cleanupTaskSession reaps in the distro a session of the task ran its CLI in', async () => {
    const sessionManager = makeSessionManager();
    const context = makeReapContext(sessionManager);
    const task = { id: 'task-wsl-1', session_id: null, worktree_path: null, branch_name: null };
    mockListCliTargetsOfTasks.mockReturnValue([recordedTarget('Ubuntu')]);

    await cleanupTaskSession(context, task, makeTasksStub(task), null, PROJECT_PATH);

    // The records are read through the project that owns the path, for this task.
    expect(mockListCliTargetsOfTasks).toHaveBeenCalledWith(['task-wsl-1']);
    expect(sessionManager.reapTaskProcesses).toHaveBeenCalledWith(
      PROJECT_PATH,
      [{ id: 'task-wsl-1', worktreePath: null }],
      { stop: true, onLateEntries: expect.any(Function), wslDistros: ['Ubuntu'] },
    );
  });

  it('merges the distros the caller supplies with the ones the session records name, the caller\'s first', async () => {
    const sessionManager = makeSessionManager();
    const context = makeReapContext(sessionManager);
    const task = { id: 'task-wsl-2', worktree_path: null, title: 'Fix login' };
    mockListCliTargetsOfTasks.mockReturnValue([recordedTarget('Ubuntu')]);

    await reapTaskLeftovers(context, PROJECT_PATH, [task], { wslDistros: ['Debian'] });

    expect(reapedDistros(sessionManager)).toEqual(['Debian', 'Ubuntu']);
  });

  it('keeps the distros the caller supplies when no session record names one', async () => {
    const sessionManager = makeSessionManager();
    const context = makeReapContext(sessionManager);

    await reapTaskLeftovers(context, PROJECT_PATH, [{ id: 'task-wsl-3', worktree_path: null }], { wslDistros: ['Debian'] });

    expect(reapedDistros(sessionManager)).toEqual(['Debian']);
  });

  it('names a distro once when several records of the task carry it, and skips a record that names none', async () => {
    const sessionManager = makeSessionManager();
    const context = makeReapContext(sessionManager);
    mockListCliTargetsOfTasks.mockReturnValue([
      // One session recorded its homes, an older one did not: two rows, one distro.
      recordedTarget('Ubuntu', { homeLinux: '/home/dev' }),
      recordedTarget('Ubuntu'),
      'not json',
      recordedTarget('Debian'),
    ]);

    await reapTaskLeftovers(context, PROJECT_PATH, [{ id: 'task-wsl-4', worktree_path: null }]);

    expect(reapedDistros(sessionManager)).toEqual(['Ubuntu', 'Debian']);
  });

  it('reads no record off Windows: a CLI path into a distro cannot exist there', async () => {
    fakePlatform('linux');
    const sessionManager = makeSessionManager();
    const context = makeReapContext(sessionManager);
    mockListCliTargetsOfTasks.mockReturnValue([recordedTarget('Ubuntu')]);

    await reapTaskLeftovers(context, PROJECT_PATH, [{ id: 'task-wsl-5', worktree_path: null }]);

    expect(mockListCliTargetsOfTasks).not.toHaveBeenCalled();
    expect(reapedDistros(sessionManager)).toEqual([]);
  });

  it('reaps in no distro, and opens nothing, when no project has the path the reap is asked about', async () => {
    const sessionManager = makeSessionManager();
    const context = makeReapContext(sessionManager);
    mockListCliTargetsOfTasks.mockReturnValue([recordedTarget('Ubuntu')]);

    await reapTaskLeftovers(context, '/mock/unlisted-project', [{ id: 'task-wsl-6', worktree_path: null }]);

    expect(mockGetOpenProjectDb).not.toHaveBeenCalled();
    expect(mockListCliTargetsOfTasks).not.toHaveBeenCalled();
    expect(reapedDistros(sessionManager)).toEqual([]);
  });

  it('reaps in no distro when the project\'s database is not open, rather than opening it', async () => {
    const sessionManager = makeSessionManager();
    const context = makeReapContext(sessionManager);
    mockGetOpenProjectDb.mockReturnValue(null);
    mockListCliTargetsOfTasks.mockReturnValue([recordedTarget('Ubuntu')]);

    await reapTaskLeftovers(context, PROJECT_PATH, [{ id: 'task-wsl-7', worktree_path: null }]);

    expect(mockGetOpenProjectDb).toHaveBeenCalledWith('proj-wsl');
    expect(mockListCliTargetsOfTasks).not.toHaveBeenCalled();
    expect(reapedDistros(sessionManager)).toEqual([]);
  });

  it('still reaps, in the caller\'s distros, when the records cannot be read', async () => {
    const sessionManager = makeSessionManager();
    const context = makeReapContext(sessionManager);
    mockListCliTargetsOfTasks.mockImplementation(() => { throw new Error('database is locked'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await reapTaskLeftovers(context, PROJECT_PATH, [{ id: 'task-wsl-8', worktree_path: null }], { wslDistros: ['Debian'] });

    expect(reapedDistros(sessionManager)).toEqual(['Debian']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read the distros'), expect.any(Error));
    warn.mockRestore();
  });

  it('hands the startup sweep the distros the swept tasks ran a CLI in, read against the project it sweeps', () => {
    const context = makeReapContext(makeSessionManager());
    mockListCliTargetsOfTasks.mockReturnValue([recordedTarget('Ubuntu')]);

    // The sweep names its own project; the context's ambient one is another.
    const distros = leftoverSweepOptions(context, PROJECT_PATH).wslDistrosOf?.(['archived-1', 'todo-1']);

    expect(mockListCliTargetsOfTasks).toHaveBeenCalledWith(['archived-1', 'todo-1']);
    expect(distros).toEqual(['Ubuntu']);
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

describe('handleTaskMove Done branch: suspend -> close windows -> reap -> deleteTaskWorktree', () => {
  it('closes the windows and reaps the task after suspending its session and before deleting the worktree', async () => {
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

    // The close follows the suspend: a Browser pop-out closing while the
    // session still ran would be handed off to a lane.
    expect(callOrder).toEqual(['suspend', 'closeWindows', 'reap', 'deleteWorktree']);
    expect(mockCloseTaskWindows).toHaveBeenCalledWith('proj-test', 'task-done-1');
    expect(mockReapTaskLeftovers).toHaveBeenCalledWith(context, '/mock/project', [expect.objectContaining({ id: 'task-done-1', worktree_path: '/mock/project/.kangentic/worktrees/task-done-1' })]);
  });

  it('closes the windows and reaps on Done even when the session ended before the move (a Code Review entry suspended it)', async () => {
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

    expect(callOrder).toEqual(['closeWindows', 'reap', 'deleteWorktree']);
    expect(mockCloseTaskWindows).toHaveBeenCalledWith('proj-test', 'task-done-2');
    expect(mockReapTaskLeftovers).toHaveBeenCalledWith(context, '/mock/project', [expect.objectContaining({ id: 'task-done-2', worktree_path: '/mock/project/.kangentic/worktrees/task-done-2' })]);
  });

  it('closes the windows against the explicit project the caller passed, not the ambient one', async () => {
    const sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: null });
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done', auto_spawn: false });
    const task = makeTask({
      id: 'task-done-explicit',
      swimlane_id: SOURCE_LANE_ID,
      session_id: null,
      worktree_path: '/mock/project/.kangentic/worktrees/task-done-explicit',
    });
    const taskRepo = makeTaskRepo(task);
    const swimlaneRepo = makeSwimlaneRepo([sourceLane, doneLane]);
    // The ambient project is 'proj-test'. A renderer move stamps the project the
    // drop happened in, which the user may have left by the time the move runs.
    const context = makeTaskMoveContext(taskRepo, swimlaneRepo);

    await handleTaskMove(
      context as never,
      { taskId: task.id, targetSwimlaneId: DONE_LANE_ID, targetPosition: 0 },
      'renderer',
      'proj-explicit',
    );

    expect(mockCloseTaskWindows).toHaveBeenCalledTimes(1);
    expect(mockCloseTaskWindows).toHaveBeenCalledWith('proj-explicit', 'task-done-explicit');
    expect(mockCloseTaskWindows).not.toHaveBeenCalledWith('proj-test', 'task-done-explicit');
  });

  it('schedules the delayed removal retry when the worktree removal failed, right after it and for that task', async () => {
    const sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: null });
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done', auto_spawn: false });
    const task = makeTask({
      id: 'task-done-3',
      swimlane_id: SOURCE_LANE_ID,
      session_id: null,
      worktree_path: '/mock/project/.kangentic/worktrees/task-done-3',
    });
    const taskRepo = makeTaskRepo(task);
    const swimlaneRepo = makeSwimlaneRepo([sourceLane, doneLane]);
    const context = makeTaskMoveContext(taskRepo, swimlaneRepo);
    // A holder still closing files in the directory: the removal reports failure.
    mockDeleteTaskWorktree.mockImplementationOnce(async () => {
      callOrder.push('deleteWorktree');
      return false;
    });

    await handleTaskMove(
      context as never,
      { taskId: task.id, targetSwimlaneId: DONE_LANE_ID, targetPosition: 0 },
      'renderer',
    );

    expect(callOrder).toEqual(['closeWindows', 'reap', 'deleteWorktree', 'scheduleRetry']);
    expect(mockScheduleDoneWorktreeRemovalRetry).toHaveBeenCalledTimes(1);
    expect(mockScheduleDoneWorktreeRemovalRetry).toHaveBeenCalledWith(context, '/mock/project', 'task-done-3');
  });

  it('schedules no removal retry when the worktree was removed', async () => {
    const sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: null });
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done', auto_spawn: false });
    const task = makeTask({
      id: 'task-done-4',
      swimlane_id: SOURCE_LANE_ID,
      session_id: null,
      worktree_path: '/mock/project/.kangentic/worktrees/task-done-4',
    });
    const taskRepo = makeTaskRepo(task);
    const swimlaneRepo = makeSwimlaneRepo([sourceLane, doneLane]);
    const context = makeTaskMoveContext(taskRepo, swimlaneRepo);

    await handleTaskMove(
      context as never,
      { taskId: task.id, targetSwimlaneId: DONE_LANE_ID, targetPosition: 0 },
      'renderer',
    );

    // The removal ran and succeeded (the mock's default answer), so there is nothing to retry.
    expect(mockDeleteTaskWorktree).toHaveBeenCalledTimes(1);
    expect(mockScheduleDoneWorktreeRemovalRetry).not.toHaveBeenCalled();
  });
});

describe('handleTaskMove: auto_spawn=false negative (Priority 2.5)', () => {
  it('suspends the session but does NOT reap or close its windows - the task is parked, and its dev server keeps running', async () => {
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
    // A parked task keeps its pop-outs: the user may still be testing in them.
    expect(mockCloseTaskWindows).not.toHaveBeenCalled();
  });
});

// #929. A move never starts a paused agent: only the user's Resume does. The
// destination's enter rows still run, with the agent paused, so a row that
// needs no agent runs and one that needs the agent waits for a Resume there.
// The same shape as Priority 2.5: no worktree work and no spawn.
describe('handleTaskMove: a task whose agent is paused (Priority 4)', () => {
  const REVIEW_LANE_ID = 'lane-review';
  const HELD_PAUSE_RECORD = { id: 'rec-paused', status: 'suspended', suspended_by: 'user' };
  let executeTransition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Each trigger the engine runs and each label clear lands in `callOrder`,
    // so a test can tell WHICH clear fired: the exit group's own `finally` also
    // clears the label on this path, so a bare "was cleared" cannot.
    executeTransition = vi.fn(async (_task: unknown, _lane: unknown, trigger: string) => {
      callOrder.push(`transition:${trigger}`);
      return { outcomes: [], failures: [], startedAgent: false };
    });
    mockCreateTransitionEngine.mockImplementation(() => ({ executeTransition }));
    vi.mocked(clearSpawnProgress).mockImplementation(() => { callOrder.push('clearSpawnProgress'); });
  });

  afterEach(() => {
    mockCreateTransitionEngine.mockImplementation(() => ({}));
    vi.mocked(clearSpawnProgress).mockImplementation(() => {});
  });

  interface PausedMoveScenario {
    /** The column the task leaves. Defaults to an ordinary column. */
    sourceLane?: Swimlane;
    taskOverrides?: Partial<Task>;
    destinationOverrides?: Partial<Swimlane>;
  }

  async function movePausedTask(record: unknown, scenario: PausedMoveScenario = {}) {
    latestSession.record = record;
    const sourceLane = scenario.sourceLane ?? makeSwimlane(SOURCE_LANE_ID, { role: null });
    const reviewLane = makeSwimlane(REVIEW_LANE_ID, { role: null, auto_spawn: true, ...scenario.destinationOverrides });
    const task = makeTask({
      id: 'task-paused-1',
      swimlane_id: sourceLane.id,
      session_id: null,
      worktree_path: '/mock/project/.kangentic/worktrees/task-paused-1',
      ...scenario.taskOverrides,
    });
    // The move lands the row in its destination, as the database does, so
    // Phase 3's re-check finds the task there and reaches `spawnAgent`.
    const taskRepo = {
      ...makeTaskRepo(task),
      move: vi.fn((moveInput: { targetSwimlaneId: string }) => { task.swimlane_id = moveInput.targetSwimlaneId; }),
      clearArchived: vi.fn(),
    };
    const context = makeTaskMoveContext(taskRepo, makeSwimlaneRepo([sourceLane, reviewLane]));

    await handleTaskMove(
      context as never,
      { taskId: task.id, targetSwimlaneId: REVIEW_LANE_ID, targetPosition: 0 },
      'mobile',
    );
    return { task, reviewLane, taskRepo, context };
  }

  it.each([['user'], ['auto']])('starts no agent for a %s pause and runs the enter rows with the agent paused', async (suspendedBy) => {
    const { task, reviewLane } = await movePausedTask({ id: 'rec-paused', status: 'suspended', suspended_by: suspendedBy });

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
    expect(executeTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      reviewLane,
      'enter',
      expect.objectContaining({ agentPaused: true }),
    );
  });

  it('takes the spawn path as before when the last suspend holds nothing (a system suspend)', async () => {
    const { task } = await movePausedTask({ id: 'rec-moved', status: 'suspended', suspended_by: 'system' });

    // Phase 2's worktree work is the spawn plan's: the paused branch returns
    // before it. The row lands in the new column, so Phase 3 reaches `spawnAgent`.
    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ id: task.id }) }));
    expect(executeTransition).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'enter', expect.anything());
  });

  it('retires the spawn-progress label and arms the enter group with nothing delivered', async () => {
    const { task, reviewLane, context } = await movePausedTask(HELD_PAUSE_RECORD);

    expect(executeTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      reviewLane,
      'enter',
      // The branch injected no column message, so no row counts as delivered.
      expect.objectContaining({ agentPaused: true, alreadyDelivered: undefined }),
    );
    expect(clearSpawnProgress).toHaveBeenCalledWith(context.mainWindow, task.id);
    // Two clears sit between the exit group and the enter group: the exit
    // group's own `finally`, then this branch's. Dropping the branch's leaves
    // the label an earlier step set to strand until its 120s TTL, since this
    // move never reaches Phase 3's clear.
    const exitIndex = callOrder.indexOf('transition:exit');
    const enterIndex = callOrder.indexOf('transition:enter');
    expect(exitIndex).toBeGreaterThan(-1);
    expect(enterIndex).toBeGreaterThan(exitIndex);
    expect(callOrder.slice(exitIndex + 1, enterIndex)).toEqual(['clearSpawnProgress', 'clearSpawnProgress']);
  });

  // The Resume of a held pause starts THIS column's agent, so the overrides
  // that were picked for the task's old agent must not carry across to it. The
  // clear runs before the held-pause branch returns, or a task paused through
  // an agent change would keep the old agent's model name for that Resume.
  it.each([
    ['model_override', { model_override: 'claude-sonnet-4-6' }],
    ['effort_override', { effort_override: 'high' }],
  ])('clears the %s of a held-pause task moved to a column with another agent, and still starts no agent', async (_overrideField, taskOverrides) => {
    // The project default is claude and the task has no agent of its own, so it
    // is a Claude task moving into a Codex column.
    const { task, reviewLane, taskRepo } = await movePausedTask(HELD_PAUSE_RECORD, {
      taskOverrides,
      destinationOverrides: { agent_override: 'codex' },
    });

    expect(taskRepo.update).toHaveBeenCalledWith({ id: task.id, model_override: null, effort_override: null });
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
    expect(executeTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      reviewLane,
      'enter',
      expect.objectContaining({ agentPaused: true }),
    );
  });

  it('keeps the overrides of a held-pause task moved to a column with the same agent', async () => {
    const { taskRepo } = await movePausedTask(HELD_PAUSE_RECORD, {
      taskOverrides: { model_override: 'claude-sonnet-4-6' },
      destinationOverrides: { agent_override: 'claude' },
    });

    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('restores a held-pause task moved out of Done: the worktree is made and the agent spawn is asked, not held', async () => {
    // Done removed the worktree and archived the task. This is the recovery
    // move, so the plan runs, as an unarchive does: `spawnAgent` is handed
    // `suppressAutoCommand` and starts nothing for a paused agent by itself
    // (its own held-pause check, not this branch's).
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done', auto_spawn: false });
    const { task } = await movePausedTask(HELD_PAUSE_RECORD, {
      sourceLane: doneLane,
      taskOverrides: { worktree_path: null, archived_at: '2025-01-02T00:00:00.000Z' },
    });

    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: task.id }),
      suppressAutoCommand: true,
    }));
    // Phase 1 does not arm a paused enter group here: the entry goes to
    // `spawnAgent` with the plan instead.
    expect(executeTransition).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'enter',
      expect.objectContaining({ agentPaused: true }),
    );
  });
});

describe('handleTaskMove: a reorder within Done closes nothing', () => {
  it('leaves the windows alone when the task stays in its column', async () => {
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done', auto_spawn: false });
    const task = makeTask({ id: 'task-done-reorder', swimlane_id: DONE_LANE_ID, archived_at: '2025-01-02T00:00:00.000Z' });
    const taskRepo = makeTaskRepo(task);
    const swimlaneRepo = makeSwimlaneRepo([doneLane]);
    const context = makeTaskMoveContext(taskRepo, swimlaneRepo);

    await handleTaskMove(
      context as never,
      { taskId: task.id, targetSwimlaneId: DONE_LANE_ID, targetPosition: 1 },
      'renderer',
    );

    expect(taskRepo.move).toHaveBeenCalled();
    expect(mockCloseTaskWindows).not.toHaveBeenCalled();
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
    // The handler delegates to `pauseTaskSession` (session-pause.ts), checked below.
    const handlerRegion = extractHandlerBody(sessionsSource, 'SESSION_SUSPEND');
    expect(handlerRegion).toContain('pauseTaskSession');
    expect(handlerRegion).not.toMatch(/reapTaskLeftovers|reapTaskProcesses/);
  });

  it("pauseTaskSession (the desktop Pause's, the phone's pause-session's and Pause workflow's shared path) never references reapTaskLeftovers / reapTaskProcesses", () => {
    const pauseSource = fs.readFileSync(path.join(__dirname, '../../src/main/ipc/handlers/session-pause.ts'), 'utf8');
    expect(pauseSource).toContain('applySuspendDbWrites');
    expect(pauseSource).not.toMatch(/reapTaskLeftovers|reapTaskProcesses/);

    // The phone's handler adds nothing to the shared path, a reap included.
    const phoneSource = fs.readFileSync(path.join(__dirname, '../../src/main/mobile-bridge/handlers/pause-session.ts'), 'utf8');
    expect(phoneSource).toContain('pauseTaskSession');
    expect(phoneSource).not.toMatch(/reapTaskLeftovers|reapTaskProcesses/);

    // Pause workflow pauses each task through the same path, and reaps nothing either.
    const workflowSource = fs.readFileSync(path.join(__dirname, '../../src/main/workflows/workflow-service.ts'), 'utf8');
    expect(workflowSource).toContain("import { pauseTaskSession } from '../ipc/handlers/session-pause';");
    const pauseWorkflow = workflowSource.slice(workflowSource.indexOf('export async function pauseWorkflow('));
    expect(pauseWorkflow.slice(0, pauseWorkflow.indexOf('\nexport '))).not.toMatch(/reapTaskLeftovers|reapTaskProcesses/);
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

  it("closes every task's windows once no session is left, and before the reap", () => {
    const projectsSource = fs.readFileSync(path.join(__dirname, '../../src/main/ipc/handlers/projects.ts'), 'utf8');
    const bodyStart = projectsSource.indexOf('export async function cleanupProject(');
    expect(bodyStart).toBeGreaterThan(-1);
    const body = projectsSource.slice(bodyStart);
    const spawnsCancelled = body.indexOf('await Promise.all(allTasks.map((task) => context.sessionManager.removeByTaskId(task.id)))');
    const windowsClosed = body.indexOf('closeTaskWindows(projectId, task.id)');
    const reap = body.indexOf('await reapTaskLeftovers(');
    expect(spawnsCancelled).toBeGreaterThan(-1);
    // After the sessions: a Browser pop-out closing never hands off to a lane.
    expect(windowsClosed).toBeGreaterThan(spawnsCancelled);
    expect(reap).toBeGreaterThan(windowsClosed);
  });

  // A new worktree's setup script runs after the per-project git queue, and a
  // removal INSIDE the queue refuses a path a creation still holds. So the
  // delete waits for that creation first, outside the queue, and only then
  // takes the queue to detach the worktree. Dropping the call leaves the
  // worktree behind for a creation still running; dropping the await, or
  // moving the call inside `withLock`, brings the refusal back.
  it('waits for a creation still setting a worktree up after the reap, outside the git queue, before it detaches that worktree', () => {
    const projectsSource = fs.readFileSync(path.join(__dirname, '../../src/main/ipc/handlers/projects.ts'), 'utf8');
    const bodyStart = projectsSource.indexOf('export async function cleanupProject(');
    expect(bodyStart).toBeGreaterThan(-1);
    const fromBody = projectsSource.slice(bodyStart);
    // Bound the scan to cleanupProject itself: the next top-level export ends it.
    const nextExport = fromBody.indexOf('\nexport ', 1);
    const body = nextExport === -1 ? fromBody : fromBody.slice(0, nextExport);

    const reap = body.indexOf('await reapTaskLeftovers(');
    const creationWait = body.indexOf("await prepareWorktreeForRemoval(task.worktree_path, 'thorough')");
    const queuedRemoval = body.indexOf('worktreeManager.withLock(');
    const worktreeRemoval = body.indexOf('worktreeManager.removeWorktree(');
    expect(reap).toBeGreaterThan(-1);
    expect(creationWait).toBeGreaterThan(-1);
    expect(queuedRemoval).toBeGreaterThan(-1);
    expect(worktreeRemoval).toBeGreaterThan(-1);

    expect(creationWait).toBeGreaterThan(reap);
    // Outside the queue: the wait comes before the lock is taken, not inside it.
    expect(queuedRemoval).toBeGreaterThan(creationWait);
    expect(worktreeRemoval).toBeGreaterThan(queuedRemoval);
  });
});

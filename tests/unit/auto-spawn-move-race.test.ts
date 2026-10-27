/**
 * A workflow move and the startup auto-spawn pass, run together.
 *
 * On 2026-10-27 a workflow moved four tasks from To Do to Planning. Each move
 * committed the column in its Phase 1 and released the task lock to make the
 * task's worktree. A renderer reload re-ran the background activation of every
 * project, and its `autoSpawnTasks` pass found the four tasks in an auto_spawn
 * column with no session. It started an agent for each in the project root,
 * with no prompt, because their worktrees were not written yet. Each move then
 * reached its Phase 3, found the session and skipped its own spawn.
 *
 * The real move handler and the real pass run here, with the real task lock and
 * the real controller registries, over one shared task row. The worktree step
 * blocks until the test releases it, which holds the move in its Phase 2 gap
 * while the pass runs. The outcome asserted is the one a move alone gives: one
 * agent, started by the move's board spawn (`spawnAgent`, which carries the
 * task prompt), on a row whose worktree is written.
 *
 * Red-green: drop `boardSpawnInFlight` from the pass's discovery and the task
 * with history gets a pass spawn in the project root. The task with none is
 * caught a second time, right before its hand-off, so drop the check there too
 * and it is handed to the board path while its move is still running. The
 * locked re-check, the third place the pass asks, is pinned on its own in
 * auto-spawn-only-task-ids.test.ts: a move commits its column before it
 * releases the lock, so here the column check would catch it first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  /** The one task row both the move and the pass read and write. */
  taskRow: null as null | Record<string, unknown>,
  /** The session history the pass reads (`getLatestForTask`). */
  latestRecord: undefined as undefined | { id: string; status: string },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// The pass checks the cwd it prepared still exists; every path does here.
vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) } }));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => undefined);
    getLatestForTask = vi.fn(() => hoisted.latestRecord);
    getHeldPausedTaskIds = vi.fn(() => new Set<string>());
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
    updateAppliedSettings = vi.fn();
  },
}));

// The pass's own reads of the shared row.
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = (swimlaneId: string) => (hoisted.taskRow && hoisted.taskRow.swimlane_id === swimlaneId ? [{ ...hoisted.taskRow }] : []);
    getById = (id: string) => (hoisted.taskRow && hoisted.taskRow.id === id ? { ...hoisted.taskRow } : undefined);
    update = (patch: Record<string, unknown>) => {
      if (hoisted.taskRow) hoisted.taskRow = { ...hoisted.taskRow, ...patch };
    };
    setWorktreeSkipReason = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = () => [
      { id: 'lane-todo', name: 'To Do', role: 'todo', auto_spawn: false },
      { id: 'lane-planning', name: 'Planning', role: null, auto_spawn: true },
    ];
  },
}));

// The guard for a task with no history: no enter group has run this visit.
vi.mock('../../src/main/db/repositories/automation-run-repository', () => ({
  AutomationRunRepository: class {
    hasEnterRunSince = vi.fn(() => false);
  },
}));
vi.mock('../../src/main/db/repositories/task-move-repository', () => ({
  TaskMoveRepository: class {
    visitStartedAt = vi.fn(() => null);
  },
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

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn() }));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  claimSpawnProgress: vi.fn(() => ({ onProgress: vi.fn(), release: vi.fn() })),
}));
vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));

// A workflow's own move: no lock refuses it, and the workflow hears of it.
vi.mock('../../src/main/workflows/workflow-lock-check', () => ({
  checkWorkflowMove: vi.fn(() => null),
  readTaskForWorkflowPrecheck: vi.fn(() => null),
}));
vi.mock('../../src/main/workflows/workflow-changed', () => ({ notifyWorkflowOfTask: vi.fn() }));

vi.mock('../../src/main/transition-engine/session-startup/timing', () => ({
  startStartupTimer: vi.fn(() => vi.fn()),
}));

/** The pass's own preparation: ready to spawn, so reaching it would spawn. */
const mockPrepareAgentSpawn = vi.fn(async (input: { task: { id: string }; cwd: string }) => ({
  ok: true as const,
  data: {
    sessionRecordId: `session-pass-${input.task.id}`,
    command: 'claude',
    cwd: input.cwd,
    extraEnv: null,
    statusOutputPath: '/mock/status.json',
    eventsOutputPath: '/mock/events.jsonl',
    adapter: { name: 'claude', sessionType: 'claude_agent' },
    agentSessionId: 'agent-pass',
    agent: 'claude',
    permissionMode: 'acceptEdits',
    appliedModel: null,
    appliedEffort: null,
    shell: 'powershell',
    cliTarget: null,
  },
}));
vi.mock('../../src/main/transition-engine/session-startup/prepare-spawn', () => ({
  prepareAgentSpawn: (...args: unknown[]) => mockPrepareAgentSpawn(...(args as [never])),
}));

const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => {});
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  notifySpawnBlocked: vi.fn(),
  resolveSpawnOverrides: vi.fn(() => ({})),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...(args as [])),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...(args as [])),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...(args as [])),
  createTransitionEngine: vi.fn(() => ({})),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { autoSpawnTasks, type FirstAgentStarter } from '../../src/main/transition-engine/session-startup/auto-spawn';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = 'task-915';
const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/mock/project';
const WORKTREE_PATH = '/mock/project/.kangentic/worktrees/915';

interface RegistryRow { id: string; taskId: string; status: string }

/** An agent session, whoever started it: the pass, or the move's board spawn. */
interface StartedAgent { by: 'pass' | 'move'; cwd: string | null; skipPromptTemplate: boolean | undefined }

function createContext(registry: RegistryRow[]) {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: PROJECT_PATH,
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      listSessions: vi.fn(() => registry),
      hasSessionForTask: vi.fn((taskId: string) => registry.some((row) => row.taskId === taskId)),
      getSession: vi.fn(() => null),
      findLiveSessionByTaskId: vi.fn(() => undefined),
      getSessionTaskId: vi.fn(() => null),
      getSessionProjectId: vi.fn(() => null),
      getShell: vi.fn(async () => 'powershell'),
      registerSuspendedPlaceholder: vi.fn(),
      killByTaskId: vi.fn(),
      removeByTaskId: vi.fn(),
      suspend: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      getActivityCache: vi.fn(() => ({})),
      getUsageCache: vi.fn(() => ({})),
      getEventsCache: vi.fn(() => ({})),
      on: vi.fn(),
      off: vi.fn(),
      spawn: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        git: { defaultBaseBranch: 'main' },
        agent: { permissionMode: 'acceptEdits', cliPaths: {} },
      })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), cancel: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, name: 'kangentic', default_agent: 'claude' })) },
  };
}

/** Hold the move in its Phase 2 gap: the worktree step blocks until released, then writes the worktree. */
function armWorktreeHold(): { worktreeEntered: Promise<void>; release: () => void } {
  let release!: () => void;
  let signalEntered!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const worktreeEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
  mockEnsureTaskWorktree.mockImplementation(async () => {
    signalEntered();
    await hold;
    if (hoisted.taskRow) hoisted.taskRow = { ...hoisted.taskRow, worktree_path: WORKTREE_PATH };
  });
  return { worktreeEntered, release };
}

describe('a workflow move and the startup auto-spawn pass, together', () => {
  let registry: RegistryRow[];
  let started: StartedAgent[];
  let context: ReturnType<typeof createContext>;
  let startFirstAgent: ReturnType<typeof vi.fn<FirstAgentStarter>>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = [];
    started = [];
    hoisted.taskRow = {
      id: TASK_ID,
      title: 'Extract the settings strings',
      description: '',
      swimlane_id: 'lane-todo',
      position: 0,
      worktree_path: null,
      session_id: null,
      branch_name: null,
      base_branch: null,
      agent: null,
      profile_id: null,
      archived_at: null,
    };
    hoisted.latestRecord = undefined;

    context = createContext(registry);
    // The pass's spawn: an agent in whatever cwd it prepared, with no prompt.
    context.sessionManager.spawn.mockImplementation(async (input: { id: string; taskId: string; cwd: string }) => {
      registry.push({ id: input.id, taskId: input.taskId, status: 'running' });
      started.push({ by: 'pass', cwd: input.cwd, skipPromptTemplate: undefined });
      return { id: input.id };
    });
    // The move's board spawn: the agent starts in the row's worktree, with the
    // task prompt unless the move says to skip it.
    mockSpawnAgent.mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { task: { id: string; worktree_path: string | null }; skipPromptTemplate?: boolean };
      registry.push({ id: 'session-move', taskId: options.task.id, status: 'running' });
      if (hoisted.taskRow) hoisted.taskRow = { ...hoisted.taskRow, session_id: 'session-move' };
      started.push({ by: 'move', cwd: options.task.worktree_path, skipPromptTemplate: options.skipPromptTemplate });
    });

    // The move's reads and writes of the same row.
    mockGetProjectRepos.mockReturnValue({
      tasks: {
        getById: vi.fn(() => (hoisted.taskRow ? { ...hoisted.taskRow } : undefined)),
        move: vi.fn((input: { targetSwimlaneId: string; targetPosition: number }) => {
          if (hoisted.taskRow) hoisted.taskRow = { ...hoisted.taskRow, swimlane_id: input.targetSwimlaneId, position: input.targetPosition };
        }),
        update: vi.fn((patch: Record<string, unknown>) => {
          if (hoisted.taskRow) hoisted.taskRow = { ...hoisted.taskRow, ...patch };
        }),
        archive: vi.fn(),
        clearArchived: vi.fn(),
      },
      swimlanes: {
        getById: vi.fn((id: string) => ({
          'lane-todo': { id: 'lane-todo', name: 'To Do', role: 'todo', auto_spawn: false, auto_command: null, permission_mode: null, agent_override: null },
          'lane-planning': { id: 'lane-planning', name: 'Planning', role: null, auto_spawn: true, auto_command: null, permission_mode: null, agent_override: null },
        }[id] ?? null)),
      },
      actions: { getTransitionsFor: vi.fn(() => []) },
      automations: {},
      automationRuns: {},
      attachments: { add: vi.fn(), deleteByTaskId: vi.fn(), listForTask: vi.fn(() => []) },
    });

    startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});
  });

  function runPass(): Promise<void> {
    return autoSpawnTasks(
      PROJECT_ID,
      PROJECT_PATH,
      context.sessionManager as never,
      context.configManager as never,
      'claude',
      null,
      null,
      null,
      [],
      { startFirstAgent },
    );
  }

  function startWorkflowMove(): Promise<void> {
    return handleTaskMove(
      context as never,
      { taskId: TASK_ID, targetSwimlaneId: 'lane-planning', targetPosition: 0 },
      'workflow',
      PROJECT_ID,
      PROJECT_PATH,
    );
  }

  /** What a move alone gives: one agent, from the move, in the worktree, with the task prompt. */
  function expectOnlyTheMovesAgent(): void {
    expect(started).toEqual([{ by: 'move', cwd: WORKTREE_PATH, skipPromptTemplate: false }]);
    expect(registry.filter((row) => row.taskId === TASK_ID)).toHaveLength(1);
    expect(hoisted.taskRow?.session_id).toBe('session-move');
  }

  it('a task that never had an agent: the pass leaves it to the move, which starts the one agent in its worktree', async () => {
    const { worktreeEntered, release } = armWorktreeHold();

    const move = startWorkflowMove();
    // Phase 1 has committed the column; the move is making the worktree.
    await worktreeEntered;
    expect(hoisted.taskRow?.swimlane_id).toBe('lane-planning');
    expect(hoisted.taskRow?.worktree_path).toBeNull();

    await runPass();

    // Not handed to the board path a second time, and not spawned here.
    expect(startFirstAgent).not.toHaveBeenCalled();
    expect(mockPrepareAgentSpawn).not.toHaveBeenCalled();
    expect(context.sessionManager.spawn).not.toHaveBeenCalled();

    release();
    await move;

    expectOnlyTheMovesAgent();
  });

  it('a task with session history: the pass does not start a prompt-less agent in the project root', async () => {
    hoisted.latestRecord = { id: 'session-earlier', status: 'exited' };
    const { worktreeEntered, release } = armWorktreeHold();

    const move = startWorkflowMove();
    await worktreeEntered;

    await runPass();

    expect(mockPrepareAgentSpawn).not.toHaveBeenCalled();
    expect(context.sessionManager.spawn).not.toHaveBeenCalled();

    release();
    await move;

    expectOnlyTheMovesAgent();
  });

  it('control: once the move has settled, the pass finds the session and starts nothing', async () => {
    hoisted.latestRecord = { id: 'session-earlier', status: 'exited' };
    armWorktreeHold().release();

    await startWorkflowMove();
    await runPass();

    expect(context.sessionManager.spawn).not.toHaveBeenCalled();
    expect(startFirstAgent).not.toHaveBeenCalled();
    expectOnlyTheMovesAgent();
  });

  it('another path starts an agent while the move makes its worktree: the move warns and starts no second one', async () => {
    // Red-green: console.warn back to console.log fails the warn assertion; deleting the session_id bail in Phase 3 fails the no-spawn ones.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { worktreeEntered, release } = armWorktreeHold();

      const move = startWorkflowMove();
      // Phase 1 found no session and released the lock; the move is making the worktree.
      await worktreeEntered;
      expect(hoisted.taskRow?.session_id).toBeNull();

      // Another path starts an agent for the task inside that unlocked gap.
      registry.push({ id: 'session-other', taskId: TASK_ID, status: 'running' });
      hoisted.taskRow = { ...hoisted.taskRow, session_id: 'session-other' };

      release();
      await move;

      // Phase 3 saw the session, left it alone and spawned nothing of its own.
      expect(mockSpawnAgent).not.toHaveBeenCalled();
      expect(started.filter((agent) => agent.by === 'move')).toEqual([]);
      expect(registry.filter((row) => row.taskId === TASK_ID)).toEqual([{ id: 'session-other', taskId: TASK_ID, status: 'running' }]);
      expect(hoisted.taskRow?.session_id).toBe('session-other');
      // A warning, so it reaches the log even with info lines off.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('started by another path'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('control: the harness sees a pass spawn when no move is in flight, so the negatives above are not vacuous', async () => {
    hoisted.latestRecord = { id: 'session-earlier', status: 'exited' };
    // A task left in Planning with no session by an earlier run, and no move now.
    hoisted.taskRow = { ...hoisted.taskRow, swimlane_id: 'lane-planning' };

    await runPass();

    expect(started).toEqual([{ by: 'pass', cwd: PROJECT_PATH, skipPromptTemplate: undefined }]);
  });
});

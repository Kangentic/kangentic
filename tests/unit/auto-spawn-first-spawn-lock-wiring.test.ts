/**
 * Wiring tests for the startup auto-spawn reconcile
 * (src/main/transition-engine/session-startup/auto-spawn.ts).
 *
 * A task with session history (a crash, an agent that exited) gets a fresh
 * agent here through prepareAgentSpawn, which runs the shared spawn preamble
 * (the first-spawn Advanced-override lock + agent resolution). The preamble
 * needs two inputs only this caller can supply: a live TaskRepository handle
 * (`tasks`) and the first-ever-spawn signal (`hasSessionRecord`, derived from
 * the session repository).
 *
 * A task with NO session history never reaches prepareAgentSpawn. It never had
 * an agent, so it goes to the board path (`startFirstAgent`, which the project
 * open paths wire to `autoSpawnForTask`): its worktree first, then the column's
 * prompt, as the move into the column would have done. A fresh spawn here would
 * start it in the project root with no prompt, which is what four tasks got on
 * 2026-10-27 while their workflow move was still making their worktrees. With
 * no starter the pass leaves such a task alone, and it does the same when the
 * column's enter automations already ran this visit: that move reached its
 * spawn and the agent failed to start, so a hand-off would run them again.
 *
 * prepareAgentSpawn itself is mocked (returning a skip signal to short-circuit
 * the spawn pass); its lock behavior is covered by
 * prepare-spawn-first-spawn-lock.test.ts.
 *
 * Red-green: let a task with no record fall through to the fresh spawn and the
 * hand-off and no-starter tests fail; drop the enter-run guard and the guard
 * test fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';

const mockPrepareAgentSpawn = vi.fn(async () => ({ ok: false as const, reason: 'cli-not-found' as const }));
const mockTaskList = vi.fn();
const mockTaskUpdate = vi.fn();
const mockSetWorktreeSkipReason = vi.fn();
const mockGetLatestForTask = vi.fn();
const mockGetHeldPausedTaskIds = vi.fn(() => new Set<string>());
const mockSwimlaneList = vi.fn();
const mockReadLocalBranchSha = vi.fn(async (): Promise<string | null> => null);
const mockVisitStartedAt = vi.fn((): string | null => null);
const mockHasEnterRunSince = vi.fn((): boolean => false);

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
}));

// The missing-worktree demotion captures the surviving local branch's tip
// before dropping the name. Mocked so no real git runs against the mock path.
vi.mock('../../src/main/git/worktree-head', () => ({
  readLocalBranchSha: (...args: unknown[]) => mockReadLocalBranchSha(...(args as [])),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    // The spawn pass re-reads its task under the task lock: answer with what the
    // discovery pass was handed.
    listed = new Map<string, unknown>();
    list = (...args: unknown[]) => {
      const rows = (mockTaskList(...args) ?? []) as Array<{ id: string }>;
      for (const row of rows) this.listed.set(row.id, row);
      return rows;
    };
    getById = (id: string) => this.listed.get(id);
    update = (...args: unknown[]) => mockTaskUpdate(...args);
    setWorktreeSkipReason = (...args: unknown[]) => mockSetWorktreeSkipReason(...args);
  },
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = (...args: unknown[]) => mockGetLatestForTask(...args);
    getHeldPausedTaskIds = (...args: unknown[]) => mockGetHeldPausedTaskIds(...args);
  },
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = (...args: unknown[]) => mockSwimlaneList(...args);
  },
}));

// The enter-run guard for a task that never had an agent: when did its current
// visit to the column begin, and has the column's enter group run since.
vi.mock('../../src/main/db/repositories/task-move-repository', () => ({
  TaskMoveRepository: class {
    visitStartedAt = (...args: unknown[]) => mockVisitStartedAt(...(args as []));
  },
}));

vi.mock('../../src/main/db/repositories/automation-run-repository', () => ({
  AutomationRunRepository: class {
    hasEnterRunSince = (...args: unknown[]) => mockHasEnterRunSince(...(args as []));
  },
}));

vi.mock('../../src/main/pty/session-manager', () => ({ SessionManager: class {} }));
vi.mock('../../src/main/config/config-manager', () => ({ ConfigManager: class {} }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));

vi.mock('../../src/main/transition-engine/session-startup/timing', () => ({
  startStartupTimer: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/main/transition-engine/session-startup/prepare-spawn', () => ({
  prepareAgentSpawn: (...args: unknown[]) => mockPrepareAgentSpawn(...(args as [never])),
}));

import { autoSpawnTasks, type FirstAgentStarter } from '../../src/main/transition-engine/session-startup/auto-spawn';
// The mocked flag, driven per test by the shutdown cases at the end of the file.
import { isShuttingDown } from '../../src/main/shutdown-state';
// The real registry: a move in flight is read off it.
import { registerMoveController, releaseMoveController } from '../../src/main/ipc/handlers/task-move-controllers';

const TASK_ID = 'task-auto-spawn-001';
const TASK_TITLE = 'Extract the settings strings';
const LANE_ID = 'lane-executing';
const VISIT_STARTED_AT = '2026-10-27T18:20:08.000Z';

function makeSessionManager() {
  return {
    hasSessionForTask: vi.fn(() => false),
    getShell: vi.fn(async () => 'powershell'),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(),
  };
}

function makeConfigManager() {
  return {
    getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits', cliPaths: {} } })),
  };
}

async function runAutoSpawn(startFirstAgent?: FirstAgentStarter) {
  const sessionManager = makeSessionManager();
  await autoSpawnTasks(
    'proj-123',
    '/mock/project',
    sessionManager as never,
    makeConfigManager() as never,
    'claude',
    null,
    'claude-opus-4-8',
    'xhigh',
    undefined,
    { startFirstAgent },
  );
  return sessionManager;
}

type PreparedSpawnInput = {
  task: { id: string };
  hasSessionRecord: boolean;
  tasks: { update: (input: unknown) => void };
};

describe('autoSpawnTasks first-spawn wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneList.mockReturnValue([
      { id: LANE_ID, auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ]);
    mockTaskList.mockReturnValue([
      { id: TASK_ID, title: TASK_TITLE, swimlane_id: LANE_ID, worktree_path: null, branch_name: null },
    ]);
    mockGetHeldPausedTaskIds.mockReturnValue(new Set());
    mockVisitStartedAt.mockReturnValue(VISIT_STARTED_AT);
    mockHasEnterRunSince.mockReturnValue(false);
  });

  it('hands a task that never had an agent to the board path, and prepares no spawn of its own', async () => {
    mockGetLatestForTask.mockReturnValue(undefined);
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});

    const sessionManager = await runAutoSpawn(startFirstAgent);

    expect(mockGetLatestForTask).toHaveBeenCalledWith(TASK_ID);
    expect(startFirstAgent).toHaveBeenCalledTimes(1);
    expect(startFirstAgent).toHaveBeenCalledWith({ id: TASK_ID, title: TASK_TITLE }, LANE_ID);
    expect(mockPrepareAgentSpawn).not.toHaveBeenCalled();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    // The guard read the task's current visit to its column.
    expect(mockVisitStartedAt).toHaveBeenCalledWith(TASK_ID, LANE_ID);
    expect(mockHasEnterRunSince).toHaveBeenCalledWith(TASK_ID, LANE_ID, VISIT_STARTED_AT);
  });

  it('leaves a task that never had an agent alone when the pass has no starter', async () => {
    mockGetLatestForTask.mockReturnValue(undefined);

    const sessionManager = await runAutoSpawn();

    expect(mockPrepareAgentSpawn).not.toHaveBeenCalled();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('leaves a task that never had an agent alone when its column\'s enter automations already ran this visit', async () => {
    mockGetLatestForTask.mockReturnValue(undefined);
    mockHasEnterRunSince.mockReturnValue(true);
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const sessionManager = await runAutoSpawn(startFirstAgent);

      expect(startFirstAgent).not.toHaveBeenCalled();
      expect(mockPrepareAgentSpawn).not.toHaveBeenCalled();
      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('enter automations'));
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('keeps going after a hand-off that throws', async () => {
    mockGetLatestForTask.mockReturnValue(undefined);
    mockTaskList.mockReturnValue([
      { id: 'task-first', title: 'First', swimlane_id: LANE_ID, worktree_path: null, branch_name: null },
      { id: 'task-second', title: 'Second', swimlane_id: LANE_ID, worktree_path: null, branch_name: null },
    ]);
    const startFirstAgent = vi.fn<FirstAgentStarter>(async (task) => {
      if (task.id === 'task-first') throw new Error('worktree failed');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runAutoSpawn(startFirstAgent);

      expect(startFirstAgent.mock.calls.map(([task]) => task.id)).toEqual(['task-first', 'task-second']);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('task-first'), expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  // The hand-off runs after the whole fresh-spawn pass, which awaits the shell
  // and every agent's detection. A move that takes the task in that time owns
  // its spawn, so the pass asks the registry again right before the hand-off.
  //
  // Red-green: drop `boardSpawnInFlight` from the hand-off loop in auto-spawn.ts
  // and the starter is called for the moved task.
  it('does not hand off a task a move took while the pass prepared another task', async () => {
    const FIRST_TASK = 'task-never-ran';
    const HISTORY_TASK = 'task-ran-before';
    mockTaskList.mockReturnValue([
      { id: FIRST_TASK, title: 'Never ran', swimlane_id: LANE_ID, worktree_path: null, branch_name: null },
      { id: HISTORY_TASK, title: 'Ran before', swimlane_id: LANE_ID, worktree_path: null, branch_name: null },
    ]);
    mockGetLatestForTask.mockImplementation((taskId: unknown) => (
      taskId === HISTORY_TASK ? { id: 'rec-1', task_id: HISTORY_TASK, status: 'exited' } : undefined
    ));
    const moveController = new AbortController();
    mockPrepareAgentSpawn.mockImplementationOnce(async () => {
      // A workflow moves the task with no history while the other one prepares.
      registerMoveController(FIRST_TASK, moveController);
      return { ok: false as const, reason: 'cli-not-found' as const };
    });
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});

    try {
      await runAutoSpawn(startFirstAgent);

      expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
      expect(startFirstAgent).not.toHaveBeenCalled();
    } finally {
      releaseMoveController(FIRST_TASK, moveController);
    }
  });

  it('passes hasSessionRecord: true and the live task repository when the task has session history (crash recovery shape)', async () => {
    mockGetLatestForTask.mockReturnValue({ id: 'rec-1', task_id: TASK_ID, status: 'exited' });
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});

    await runAutoSpawn(startFirstAgent);

    expect(startFirstAgent).not.toHaveBeenCalled();
    expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
    const prepareInput = mockPrepareAgentSpawn.mock.calls[0][0] as unknown as PreparedSpawnInput;
    expect(prepareInput.task).toMatchObject({ id: TASK_ID });
    expect(prepareInput.hasSessionRecord).toBe(true);
    // The tasks handle is the REAL repository instance, so a lock inside the
    // preamble actually persists.
    prepareInput.tasks.update({ id: TASK_ID, agent_override: 'codex' });
    expect(mockTaskUpdate).toHaveBeenCalledWith({ id: TASK_ID, agent_override: 'codex' });
    // A task with history skips the guard: its column's automations are not in question.
    expect(mockHasEnterRunSince).not.toHaveBeenCalled();
  });
});

/**
 * The stale-`worktree_path` fallback: a task carries a `worktree_path` from a
 * prior run, but the directory is gone (the worktree was deleted out from
 * under it). auto-spawn.ts nulls both `worktree_path` and `branch_name`,
 * records WHY via `taskRepo.setWorktreeSkipReason(task.id, 'worktree-missing')`
 * so the board can say the agent runs in the shared project checkout, and
 * falls back to spawning at `projectPath`. Nothing previously drove this
 * branch at all.
 *
 * The demotion keeps the PR anchors that describe the WORK rather than the
 * checkout: `pushed_branch` is never in the patch, and the surviving local
 * branch's tip is captured into `head_sha` when it can be read.
 */
describe('autoSpawnTasks: stale worktree_path fallback', () => {
  const STALE_WORKTREE_PATH = '/mock/project/.kangentic/worktrees/task-auto-spawn-001';

  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneList.mockReturnValue([
      { id: LANE_ID, auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ]);
    mockGetHeldPausedTaskIds.mockReturnValue(new Set());
    // A task that had an agent before: one with no record goes to the board
    // path, which makes its worktree itself, and never reaches this fallback.
    mockGetLatestForTask.mockReturnValue({ id: 'rec-1', task_id: TASK_ID, status: 'exited' });
    // Only the stale worktree path is missing; the project path (the
    // fallback cwd) still exists, so the spawn proceeds to prepareAgentSpawn
    // rather than being skipped by the "CWD missing" guard right after it.
    vi.mocked(fs.existsSync).mockImplementation((checkedPath) => checkedPath !== STALE_WORKTREE_PATH);
  });

  afterEach(() => {
    // Restore the file-level default so later tests in this file (which run
    // after this describe, but a rerun/`--repeat-each` should not depend on
    // ordering) see every path as existing again.
    vi.mocked(fs.existsSync).mockImplementation(() => true);
  });

  it('detects a stale worktree_path, clears it, records worktree-missing, and falls back to the project path', async () => {
    mockTaskList.mockReturnValue([
      { id: TASK_ID, swimlane_id: LANE_ID, worktree_path: STALE_WORKTREE_PATH, branch_name: 'stale-branch' },
    ]);

    await runAutoSpawn();

    expect(mockTaskUpdate).toHaveBeenCalledWith({ id: TASK_ID, worktree_path: null, branch_name: null, resolved_base_branch: null });
    expect(mockSetWorktreeSkipReason).toHaveBeenCalledWith(TASK_ID, 'worktree-missing');
    expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
    const prepareInput = mockPrepareAgentSpawn.mock.calls[0][0] as unknown as { cwd: string };
    expect(prepareInput.cwd).toBe('/mock/project');
  });

  it('captures the surviving local branch tip into head_sha before dropping the branch name', async () => {
    mockTaskList.mockReturnValue([
      { id: TASK_ID, swimlane_id: LANE_ID, worktree_path: STALE_WORKTREE_PATH, branch_name: 'stale-branch' },
    ]);
    mockReadLocalBranchSha.mockResolvedValueOnce('abc123def456');

    await runAutoSpawn();

    expect(mockReadLocalBranchSha).toHaveBeenCalledWith('/mock/project', 'stale-branch');
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      id: TASK_ID, worktree_path: null, branch_name: null, resolved_base_branch: null, head_sha: 'abc123def456',
    });
  });

  it('does not touch worktree_path or the skip reason when the worktree directory still exists', async () => {
    mockTaskList.mockReturnValue([
      { id: TASK_ID, swimlane_id: LANE_ID, worktree_path: '/mock/project/.kangentic/worktrees/still-here', branch_name: 'live-branch' },
    ]);

    await runAutoSpawn();

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSetWorktreeSkipReason).not.toHaveBeenCalled();
    const prepareInput = mockPrepareAgentSpawn.mock.calls[0][0] as unknown as { cwd: string };
    expect(prepareInput.cwd).toBe('/mock/project/.kangentic/worktrees/still-here');
  });
});

/**
 * What the hand-off of a task with no record owes the rest of the pass: it runs
 * after the pass's own preparation and spawns (each hand-off can make a worktree,
 * so they go one at a time at the end), it stops once the app is quitting, a
 * failed read or preparation of one task does not end the pass, and a session
 * pointer nothing backs is cleared first.
 */
describe('autoSpawnTasks: hand-off ordering, shutdown and discovery failures', () => {
  const FIRST_TASK_ID = 'task-never-ran';
  const SECOND_TASK_ID = 'task-never-ran-either';
  const HISTORY_TASK_ID = 'task-ran-before';
  const PREPARED_RECORD_ID = 'record-prepared';

  function makeTaskRow(taskId: string, extraFields: Record<string, unknown> = {}) {
    return { id: taskId, title: `Title of ${taskId}`, swimlane_id: LANE_ID, worktree_path: null, branch_name: null, ...extraFields };
  }

  // Only the history task has a session record; every other task never had an agent.
  function mockHistoryTaskRecord() {
    mockGetLatestForTask.mockImplementation((taskId: unknown) => (
      taskId === HISTORY_TASK_ID ? { id: 'rec-1', task_id: HISTORY_TASK_ID, status: 'exited' } : undefined
    ));
  }

  function handedOffTaskIds(startFirstAgent: Mock<FirstAgentStarter>): string[] {
    return startFirstAgent.mock.calls.map(([task]) => task.id);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneList.mockReturnValue([
      { id: LANE_ID, auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ]);
    mockGetHeldPausedTaskIds.mockReturnValue(new Set());
    mockVisitStartedAt.mockReturnValue(VISIT_STARTED_AT);
    mockHasEnterRunSince.mockReturnValue(false);
  });

  afterEach(() => {
    // clearAllMocks keeps replaced and queued implementations, so a failing test
    // would leak its own into the next. mockReset puts the vi.fn(...) default back.
    vi.mocked(isShuttingDown).mockReset();
    mockPrepareAgentSpawn.mockReset();
    mockGetLatestForTask.mockReset();
    mockTaskUpdate.mockReset();
  });

  // Red-green: drop the `isShuttingDown()` check at the top of the hand-off
  // loop in auto-spawn.ts and the second task is handed off too.
  it('stops handing off tasks once the app starts shutting down', async () => {
    mockGetLatestForTask.mockReturnValue(undefined);
    mockTaskList.mockReturnValue([makeTaskRow(FIRST_TASK_ID), makeTaskRow(SECOND_TASK_ID)]);
    let shuttingDown = false;
    vi.mocked(isShuttingDown).mockImplementation(() => shuttingDown);
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {
      // The quit begins while the first task's agent starts.
      shuttingDown = true;
    });

    await runAutoSpawn(startFirstAgent);

    expect(handedOffTaskIds(startFirstAgent)).toEqual([FIRST_TASK_ID]);
  });

  // Red-green: drop the `if (isShuttingDown())` block before the spawn pass in
  // auto-spawn.ts and the prepared command is spawned and its hold never released.
  // The hand-off loop has a check of its own that would still stop the hand-off,
  // so the spawn and the hold are what pin the earlier block.
  it('spawns and hands off nothing when shutdown begins during preparation, and releases the prepared hold', async () => {
    mockTaskList.mockReturnValue([makeTaskRow(HISTORY_TASK_ID), makeTaskRow(FIRST_TASK_ID)]);
    mockHistoryTaskRecord();
    let shuttingDown = false;
    vi.mocked(isShuttingDown).mockImplementation(() => shuttingDown);
    const removeHooks = vi.fn();
    mockPrepareAgentSpawn.mockImplementation(async () => {
      // The quit begins after discovery, while the history task prepares.
      shuttingDown = true;
      return {
        ok: true as const,
        data: {
          adapter: { name: 'claude', sessionType: 'claude_agent', removeHooks },
          agent: 'claude',
          command: 'claude',
          cwd: '/mock/project',
          sessionRecordId: PREPARED_RECORD_ID,
          agentSessionId: null,
          permissionMode: 'acceptEdits',
          statusOutputPath: '/mock/status.json',
          eventsOutputPath: '/mock/events.jsonl',
          extraEnv: null,
          appliedModel: null,
          appliedEffort: null,
          shell: 'powershell',
          cliTarget: null,
          resumed: false,
        },
      } as never;
    });
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});

    const sessionManager = await runAutoSpawn(startFirstAgent);

    expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(removeHooks).toHaveBeenCalledWith('/mock/project', PREPARED_RECORD_ID);
    expect(startFirstAgent).not.toHaveBeenCalled();
  });

  // Red-green: call `handOff()` ahead of the preparation pass in auto-spawn.ts
  // and the hand-off is recorded before the preparation. Turn the failed
  // preparation's `continue` into a `return` and the hand-off never happens.
  it('hands off a task with no record only after the pass prepared the task with history, even when that preparation fails', async () => {
    const callOrder: string[] = [];
    // The task with no record is listed first, so a hand-off during discovery would also come first.
    mockTaskList.mockReturnValue([makeTaskRow(FIRST_TASK_ID), makeTaskRow(HISTORY_TASK_ID)]);
    mockHistoryTaskRecord();
    mockPrepareAgentSpawn.mockImplementation(async () => {
      callOrder.push('prepare');
      return { ok: false as const, reason: 'cli-not-found' as const };
    });
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {
      callOrder.push('hand-off');
    });

    await runAutoSpawn(startFirstAgent);

    expect(callOrder).toEqual(['prepare', 'hand-off']);
    expect(handedOffTaskIds(startFirstAgent)).toEqual([FIRST_TASK_ID]);
  });

  // Red-green: make the preparation's catch in auto-spawn.ts rethrow and the
  // pass rejects before any hand-off.
  it('still hands off a task with no record when preparing the task with history throws', async () => {
    mockTaskList.mockReturnValue([makeTaskRow(FIRST_TASK_ID), makeTaskRow(HISTORY_TASK_ID)]);
    mockHistoryTaskRecord();
    mockPrepareAgentSpawn.mockImplementation(async () => {
      throw new Error('detection failed');
    });
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runAutoSpawn(startFirstAgent);

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(`Preparation failed for task ${HISTORY_TASK_ID}`),
        expect.any(Error),
      );
      expect(handedOffTaskIds(startFirstAgent)).toEqual([FIRST_TASK_ID]);
    } finally {
      consoleError.mockRestore();
    }
  });

  // Red-green: drop the try/catch around the discovery reads in auto-spawn.ts
  // and the pass rejects on the first task's error, so the second is never handed off.
  it('skips a task whose discovery read fails and still hands off the next one', async () => {
    mockTaskList.mockReturnValue([makeTaskRow(FIRST_TASK_ID), makeTaskRow(SECOND_TASK_ID)]);
    mockGetLatestForTask.mockImplementation((taskId: unknown) => {
      if (taskId === FIRST_TASK_ID) throw new Error('database is locked');
      return undefined;
    });
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runAutoSpawn(startFirstAgent);

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(`Discovery failed for task ${FIRST_TASK_ID}`),
        expect.any(Error),
      );
      expect(handedOffTaskIds(startFirstAgent)).toEqual([SECOND_TASK_ID]);
    } finally {
      consoleError.mockRestore();
    }
  });

  // Red-green: drop the `if (task.session_id) await clearStaleSessionPointer(...)`
  // call in the hand-off loop in auto-spawn.ts and the row keeps its dead pointer.
  it('clears a session pointer nothing backs before it hands the task off', async () => {
    mockGetLatestForTask.mockReturnValue(undefined);
    mockTaskList.mockReturnValue([makeTaskRow(FIRST_TASK_ID, { session_id: 'session-stale' })]);
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});

    await runAutoSpawn(startFirstAgent);

    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    expect(mockTaskUpdate).toHaveBeenCalledWith({ id: FIRST_TASK_ID, session_id: null });
    expect(handedOffTaskIds(startFirstAgent)).toEqual([FIRST_TASK_ID]);
    // The board path's spawn would otherwise see a session and start no agent.
    expect(mockTaskUpdate.mock.invocationCallOrder[0]).toBeLessThan(startFirstAgent.mock.invocationCallOrder[0]);
  });

  // Control for the test above: a row that names no session needs no clearing.
  it('writes nothing to a task with no record whose row names no session', async () => {
    mockGetLatestForTask.mockReturnValue(undefined);
    mockTaskList.mockReturnValue([makeTaskRow(FIRST_TASK_ID, { session_id: null })]);
    const startFirstAgent = vi.fn<FirstAgentStarter>(async () => {});

    await runAutoSpawn(startFirstAgent);

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(handedOffTaskIds(startFirstAgent)).toEqual([FIRST_TASK_ID]);
  });
});

/**
 * Startup auto-spawn scoped to the tasks a pty host loss took down.
 *
 * When the host dies mid-run, the recovery resumes every lost session it can
 * and then calls `autoSpawnTasks` with a `lostScope` (`{ taskIds,
 * lostSessionIds }`) for the rest, the way a startup runs resume and then
 * auto-spawn. Three things make the scoped pass different from a startup one.
 * It must not touch a task outside `taskIds`: an unscoped pass would also
 * restart a task whose agent exited earlier this run. The lost rows are still
 * in the registry, exited, so `hasSessionForTask` would report every lost task
 * as covered and nothing would ever restart. And a task counts as having a
 * session for ANY registry row whose id is not in `lostSessionIds`, whatever its
 * status: a resume whose spawn failed leaves an exited row under a NEW id, which
 * a fresh agent must not replace.
 *
 * Red-green: drop the `taskIds.has` filter and the first test fails; use
 * `hasSessionForTask` in scoped mode and the second fails; count only rows that
 * are not `exited` (the rule before `lostSessionIds`) and the failed-resume and
 * second-loss tests fail. The lone-lost-row test is the positive control: it
 * keeps the rule from collapsing into "any row at all counts".
 */

import fs from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const mockPrepareAgentSpawn = vi.fn(async () => ({ ok: false as const, reason: 'cli-not-found' as const }));
const mockTaskList = vi.fn();
/** The task row as the database holds it now; unset, the row discovery listed. */
const mockTaskGetById = vi.fn((_id: string): unknown => undefined);
const mockSwimlaneList = vi.fn();
/** The spawn pass's writes: the task's new session, and the session row. */
const mockTaskUpdate = vi.fn();
const mockSessionInsert = vi.fn();

vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) } }));
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
    getById = (id: string) => mockTaskGetById(id) ?? this.listed.get(id);
    update = (...args: unknown[]) => mockTaskUpdate(...args);
  },
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => undefined);
    getUserPausedTaskIds = () => new Set<string>();
    insert = (...args: unknown[]) => mockSessionInsert(...args);
    updateAppliedSettings = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = (...args: unknown[]) => mockSwimlaneList(...args);
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

import { autoSpawnTasks, type LostSessionScope } from '../../src/main/transition-engine/session-startup/auto-spawn';

const ACTIVE_LANE = 'lane-active';

interface RegistryRow {
  id: string;
  taskId: string;
  status: string;
}

function activeLane() {
  return {
    id: ACTIVE_LANE,
    name: ACTIVE_LANE,
    role: null,
    auto_spawn: true,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    auto_command: null,
    handoff_context: false,
    plan_exit_target_id: null,
  };
}

function task(id: string) {
  return { id, swimlane_id: ACTIVE_LANE, profile_id: null, worktree_path: null };
}

/**
 * `taskIds` are the lost sessions' tasks; `lostSessionIds` are the lost rows
 * themselves, which stay in the registry, exited. Any other row of a task in the
 * registry counts as the task having a session.
 */
async function runScopedAutoSpawn(
  registry: RegistryRow[],
  taskIds: ReadonlySet<string>,
  lostSessionIds: ReadonlySet<string>,
  spawn: (input: { id: string }) => Promise<{ id: string }> = async (input) => ({ id: input.id }),
) {
  const lostScope: LostSessionScope = { taskIds, lostSessionIds };
  const sessionManager = {
    // Any row counts here, exited or not, which is why scoped mode cannot use it.
    hasSessionForTask: vi.fn((taskId: string) => registry.some((row) => row.taskId === taskId)),
    listSessions: vi.fn(() => registry),
    getShell: vi.fn(async () => 'powershell'),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(spawn),
  };
  await autoSpawnTasks(
    'proj-1',
    '/mock/project',
    sessionManager as never,
    { getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits', cliPaths: {} } })) } as never,
    'claude',
    null,
    null,
    null,
    [],
    lostScope,
  );
  return sessionManager;
}

function preparedTaskIds(): string[] {
  return mockPrepareAgentSpawn.mock.calls.map((call) => (call[0] as unknown as { task: { id: string } }).task.id);
}

describe('autoSpawnTasks: lostScope scopes the pass to the lost tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneList.mockReturnValue([activeLane()]);
  });

  it('leaves a task outside the set alone, even with no session at all', async () => {
    mockTaskList.mockReturnValue([task('task-lost'), task('task-exited-earlier')]);

    await runScopedAutoSpawn(
      [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
      new Set(['task-lost']),
      new Set(['session-lost']),
    );

    expect(preparedTaskIds()).toEqual(['task-lost']);
  });

  it('restarts a lost task whose only row is the exited one the loss left behind', async () => {
    mockTaskList.mockReturnValue([task('task-lost')]);

    const sessionManager = await runScopedAutoSpawn(
      [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
      new Set(['task-lost']),
      new Set(['session-lost']),
    );

    expect(preparedTaskIds()).toEqual(['task-lost']);
    expect(sessionManager.hasSessionForTask).not.toHaveBeenCalled();
  });

  it('skips a lost task the resume already took back, or left a paused placeholder for', async () => {
    mockTaskList.mockReturnValue([task('task-resumed'), task('task-paused'), task('task-lost')]);

    await runScopedAutoSpawn(
      [
        { id: 'session-resumed', taskId: 'task-resumed', status: 'running' },
        { id: 'session-paused', taskId: 'task-paused', status: 'suspended' },
        { id: 'session-lost', taskId: 'task-lost', status: 'exited' },
      ],
      new Set(['task-resumed', 'task-paused', 'task-lost']),
      new Set(['session-lost']),
    );

    expect(preparedTaskIds()).toEqual(['task-lost']);
  });

  it('does nothing for an empty set, not even a lane scan', async () => {
    await runScopedAutoSpawn([], new Set(), new Set());

    expect(mockSwimlaneList).not.toHaveBeenCalled();
    expect(mockPrepareAgentSpawn).not.toHaveBeenCalled();
  });

  // A resume whose spawn failed (handleSpawnFailure) leaves an exited row under a
  // NEW session id, next to the lost row it replaced. The agent on that task is
  // for the user to retry, not for a fresh start to cover.
  //
  // Red-green: count only rows whose status is not 'exited' (the rule before
  // `lostSessionIds`) and the task has no session, so it is prepared.
  it('does not start a fresh agent over a resume whose spawn failed and left an exited row of its own', async () => {
    mockTaskList.mockReturnValue([task('task-lost')]);

    await runScopedAutoSpawn(
      [
        { id: 'session-lost', taskId: 'task-lost', status: 'exited' },
        { id: 'session-resume-failed', taskId: 'task-lost', status: 'exited' },
      ],
      new Set(['task-lost']),
      new Set(['session-lost']),
    );

    // Discovery found a session, so nothing reached the preparation.
    expect(preparedTaskIds()).toEqual([]);
  });

  // The row's identity decides, not its status. Task A's only row is the lost
  // one. Task B's only row is exited too, but is not in this pass's
  // `lostSessionIds`: it is a session the earlier recovery resumed that the host
  // then lost a second time, which that later recovery owns.
  //
  // Red-green: same revert as above; both tasks are then prepared, not just A.
  it('counts an exited row that is not in this pass\'s lost set as a session, so a second loss is not started twice', async () => {
    mockTaskList.mockReturnValue([task('task-lost-now'), task('task-lost-again')]);

    await runScopedAutoSpawn(
      [
        { id: 'session-lost-now', taskId: 'task-lost-now', status: 'exited' },
        { id: 'session-resumed-then-lost-again', taskId: 'task-lost-again', status: 'exited' },
      ],
      new Set(['task-lost-now', 'task-lost-again']),
      new Set(['session-lost-now']),
    );

    expect(preparedTaskIds()).toEqual(['task-lost-now']);
  });
});

/**
 * What a successful `prepareAgentSpawn` hands the spawn pass. Its `cwd` is the
 * one the real preparation was given: the task's worktree, or the project path
 * for a task with none.
 */
function preparedSpawn(taskId: string, cwd = '/mock/project') {
  return {
    ok: true as const,
    data: {
      sessionRecordId: `session-new-${taskId}`,
      command: 'claude',
      cwd,
      extraEnv: null,
      statusOutputPath: '/mock/status.json',
      eventsOutputPath: '/mock/events.jsonl',
      adapter: { name: 'claude', sessionType: 'claude_agent' },
      agentSessionId: 'agent-1',
      agent: 'claude',
      permissionMode: 'acceptEdits',
      appliedModel: null,
      appliedEffort: null,
    },
  };
}

/**
 * The preparation awaits the shell and the agent's detection, seconds on a
 * real machine, and the user can act on the task meanwhile. The spawn re-reads
 * the task under its lifecycle lock and leaves one a user action took over.
 *
 * Red-green: drop the re-check in the spawn pass and every negative test below
 * fails (a user's session, a failed spawn, a move, a cleared session_id, a
 * cleared or gained worktree, a missing cwd).
 */
describe('autoSpawnTasks: the spawn re-checks its task under the task lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskGetById.mockReset();
    mockTaskGetById.mockImplementation(() => undefined);
    mockSwimlaneList.mockReturnValue([activeLane()]);
    mockTaskList.mockReturnValue([task('task-lost')]);
  });

  it('spawns the lost task when nothing took it over during the preparation', async () => {
    mockPrepareAgentSpawn.mockImplementationOnce(async () => preparedSpawn('task-lost') as never);

    const sessionManager = await runScopedAutoSpawn(
      [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
      new Set(['task-lost']),
      new Set(['session-lost']),
    );

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not spawn over a session the user started while the agent was being prepared', async () => {
    const registry: RegistryRow[] = [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }];
    mockPrepareAgentSpawn.mockImplementationOnce(async () => {
      registry.push({ id: 'session-user', taskId: 'task-lost', status: 'running' });
      return preparedSpawn('task-lost') as never;
    });

    const sessionManager = await runScopedAutoSpawn(registry, new Set(['task-lost']), new Set(['session-lost']));

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  // The same rule as the discovery pass, at the lock: a session the user started
  // while the agent was prepared, and whose spawn failed, is an exited row under
  // a new id, which still means the task is no longer this pass's to start.
  //
  // Red-green: count only rows whose status is not 'exited' in `hasSession` and
  // the spawn goes ahead over the failed one.
  it('does not spawn over a session whose own spawn failed while the agent was being prepared', async () => {
    const registry: RegistryRow[] = [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }];
    mockPrepareAgentSpawn.mockImplementationOnce(async () => {
      registry.push({ id: 'session-user-failed', taskId: 'task-lost', status: 'exited' });
      return preparedSpawn('task-lost') as never;
    });

    const sessionManager = await runScopedAutoSpawn(registry, new Set(['task-lost']), new Set(['session-lost']));

    expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSessionInsert).not.toHaveBeenCalled();
  });

  it('does not spawn a task moved to another column while the agent was being prepared', async () => {
    mockPrepareAgentSpawn.mockImplementationOnce(async () => {
      mockTaskGetById.mockImplementation((id) => (id === 'task-lost' ? { ...task('task-lost'), swimlane_id: 'lane-todo' } : undefined));
      return preparedSpawn('task-lost') as never;
    });

    const sessionManager = await runScopedAutoSpawn(
      [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
      new Set(['task-lost']),
      new Set(['session-lost']),
    );

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  describe('a reset that only clears the task\'s session_id', () => {
    // A Reset leaves the task's lane unchanged and starts no live session (the
    // registry still holds only the exited row), so the lane and session checks
    // both still pass. What it changes is `task.session_id`, which it clears.
    //
    // Red-green: drop `current.session_id !== input.task.session_id` from the
    // re-check in auto-spawn.ts and the first test spawns over the reset.
    const gatheredTask = () => ({ ...task('task-lost'), session_id: 'session-lost' });

    it('does not spawn a task whose session_id was cleared while the agent was being prepared, and writes nothing', async () => {
      mockTaskList.mockReturnValue([gatheredTask()]);
      mockPrepareAgentSpawn.mockImplementationOnce(async () => {
        mockTaskGetById.mockImplementation((id) => (id === 'task-lost' ? { ...gatheredTask(), session_id: null } : undefined));
        return preparedSpawn('task-lost') as never;
      });

      const sessionManager = await runScopedAutoSpawn(
        [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
        new Set(['task-lost']),
        new Set(['session-lost']),
      );

      expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(mockTaskUpdate).not.toHaveBeenCalled();
      expect(mockSessionInsert).not.toHaveBeenCalled();
    });

    it('still spawns a task whose non-null session_id is unchanged, so the check is not just refusing every such task', async () => {
      mockTaskList.mockReturnValue([gatheredTask()]);
      mockPrepareAgentSpawn.mockImplementationOnce(async () => preparedSpawn('task-lost') as never);

      const sessionManager = await runScopedAutoSpawn(
        [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
        new Set(['task-lost']),
        new Set(['session-lost']),
      );

      expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
      // The write spies are wired: the spawn records the new session on the task.
      expect(mockTaskUpdate).toHaveBeenCalledWith({ id: 'task-lost', session_id: 'session-new-task-lost', agent: 'claude' });
      expect(mockSessionInsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('a move to To Do and back inside the preparation', () => {
    // The round trip leaves the task's lane and `session_id` as they were and
    // starts no live session, so those checks all still pass. What it changes is
    // the worktree: To Do's cleanup removes it, and the move back makes it again
    // (its own spawn follows when it has). The agent was prepared in the old one.
    const WORKTREE = '/mock/project/.kangentic/worktrees/task-lost';
    const worktreeTask = () => ({ ...task('task-lost'), worktree_path: WORKTREE });
    const lostRegistry = (): RegistryRow[] => [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }];

    // Restore the shared fs mock: a test below flips it to "missing".
    afterEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
    });

    // Red-green: drop `(current.worktree_path || projectPath) !== input.cwd` from
    // the re-check in auto-spawn.ts and the lane, session_id, session and
    // existsSync checks all pass, so the agent starts in the removed worktree.
    it('does not spawn a task whose worktree_path was cleared while the agent was being prepared in it, and writes nothing', async () => {
      mockTaskList.mockReturnValue([worktreeTask()]);
      mockPrepareAgentSpawn.mockImplementationOnce(async () => {
        // To Do's cleanup: lane and session_id unchanged, worktree_path null.
        mockTaskGetById.mockImplementation((id) => (id === 'task-lost' ? { ...worktreeTask(), worktree_path: null } : undefined));
        return preparedSpawn('task-lost', WORKTREE) as never;
      });

      const sessionManager = await runScopedAutoSpawn(lostRegistry(), new Set(['task-lost']), new Set(['session-lost']));

      // The fixture is faithful: the preparation was handed the worktree.
      expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
      expect(mockPrepareAgentSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: WORKTREE }));
      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(mockTaskUpdate).not.toHaveBeenCalled();
      expect(mockSessionInsert).not.toHaveBeenCalled();
    });

    // Red-green: same revert as above. The task had none and the move back gave it
    // one, so the project path the agent was prepared in is no longer its cwd.
    it('does not spawn a task into the project path when the move back gave it a worktree meanwhile, and writes nothing', async () => {
      mockTaskList.mockReturnValue([task('task-lost')]);
      mockPrepareAgentSpawn.mockImplementationOnce(async () => {
        mockTaskGetById.mockImplementation((id) => (id === 'task-lost' ? worktreeTask() : undefined));
        return preparedSpawn('task-lost') as never;
      });

      const sessionManager = await runScopedAutoSpawn(lostRegistry(), new Set(['task-lost']), new Set(['session-lost']));

      expect(mockPrepareAgentSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/mock/project' }));
      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(mockTaskUpdate).not.toHaveBeenCalled();
      expect(mockSessionInsert).not.toHaveBeenCalled();
    });

    // Red-green: drop `!fs.existsSync(input.cwd)` from the re-check and the spawn
    // goes ahead into a directory that is gone. The worktree_path is unchanged
    // here, so only the existence check can refuse it.
    it('does not spawn a task whose worktree directory is gone by the time the spawn takes its lock, and writes nothing', async () => {
      mockTaskList.mockReturnValue([worktreeTask()]);
      mockPrepareAgentSpawn.mockImplementationOnce(async () => {
        // The discovery pass already found the directory; it goes during the preparation.
        vi.mocked(fs.existsSync).mockReturnValue(false);
        return preparedSpawn('task-lost', WORKTREE) as never;
      });

      const sessionManager = await runScopedAutoSpawn(lostRegistry(), new Set(['task-lost']), new Set(['session-lost']));

      expect(fs.existsSync).toHaveBeenLastCalledWith(WORKTREE);
      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(mockTaskUpdate).not.toHaveBeenCalled();
      expect(mockSessionInsert).not.toHaveBeenCalled();
    });

    it('still spawns a task in its worktree when the worktree_path is unchanged and the directory is there, so the check is not just refusing every worktree task', async () => {
      mockTaskList.mockReturnValue([worktreeTask()]);
      mockPrepareAgentSpawn.mockImplementationOnce(async () => preparedSpawn('task-lost', WORKTREE) as never);

      const sessionManager = await runScopedAutoSpawn(lostRegistry(), new Set(['task-lost']), new Set(['session-lost']));

      expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
      expect(sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: WORKTREE }));
      expect(mockSessionInsert).toHaveBeenCalledWith(expect.objectContaining({ cwd: WORKTREE }));
    });
  });
});

/**
 * A teardown that ends a session while it spawns (a move, a reset, a project
 * close) rejects the spawn with an AbortError: the canceller took the task over.
 * The pass logs that as a cancellation. "Spawn failed" read as a crash.
 *
 * Red-green: drop the `isAbortError` branch in auto-spawn.ts and the first test
 * sees console.error.
 */
describe('autoSpawnTasks: a spawn a teardown cancelled', () => {
  let consoleError: MockInstance<typeof console.error>;
  let consoleLog: MockInstance<typeof console.log>;
  const lostRegistry = (): RegistryRow[] => [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskGetById.mockReset();
    mockTaskGetById.mockImplementation(() => undefined);
    mockSwimlaneList.mockReturnValue([activeLane()]);
    mockTaskList.mockReturnValue([task('task-lost')]);
    mockPrepareAgentSpawn.mockImplementationOnce(async () => preparedSpawn('task-lost') as never);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  it('logs a spawn a teardown cancelled as cancelled, not as a failure, and writes nothing', async () => {
    const sessionManager = await runScopedAutoSpawn(lostRegistry(), new Set(['task-lost']), new Set(['session-lost']), async () => {
      throw new DOMException('The session was ended while it was being spawned', 'AbortError');
    });

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Spawn cancelled for task task-lost'));
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSessionInsert).not.toHaveBeenCalled();
  });

  it('still reports any other rejection as a failure', async () => {
    const failure = new Error('the pty host refused the spawn');
    await runScopedAutoSpawn(lostRegistry(), new Set(['task-lost']), new Set(['session-lost']), async () => {
      throw failure;
    });

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Spawn failed for task task-lost'), failure);
  });
});

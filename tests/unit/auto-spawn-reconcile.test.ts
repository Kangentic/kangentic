/**
 * Reconciling an `auto_spawn` change into the tasks ALREADY in the column.
 *
 * Before this existed, `auto_spawn` was only ever enforced by `autoSpawnTasks`
 * on project open. Switching a column on did nothing to the task sitting in it
 * until the app restarted, and switching it off left a live session running in a
 * column that no longer wanted one. `propagateStrategyToLiveSessions` could not
 * carry it: it bails on `!task.session_id`, so it can only inject into or
 * restart an EXISTING session, never create one.
 *
 * Two things are pinned here. The PLAN (which tasks get selected) is a pure
 * function, so the selection rules are readable without the spawn stack. The
 * EXECUTION is pinned separately, because the two properties that make it safe
 * are both structural: it must route spawns through `autoSpawnForTask` rather
 * than the engine (spawn-entry-point-parity), and it must never spawn a task the
 * user explicitly paused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAutoSpawnForTask = vi.fn(async () => {});
const mockApplySuspendDbWrites = vi.fn();
const mockSuspend = vi.fn(async () => {});
const mockKill = vi.fn(async () => {});
const mockRemoveByTaskId = vi.fn();
const mockCancel = vi.fn();
const mockGetUserPausedTaskIds = vi.fn(() => new Set<string>());
const mockHasSessionForTask = vi.fn(() => false);
const mockListSessions = vi.fn(
  (): Array<{ taskId: string; projectId: string; status: string }> => [],
);
const mockTaskGetById = vi.fn();
const mockWebContentsSend = vi.fn();

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getUserPausedTaskIds = () => mockGetUserPausedTaskIds();
  },
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({ tasks: { getById: (...args: unknown[]) => mockTaskGetById(...args) } })),
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  autoSpawnForTask: (...args: unknown[]) => mockAutoSpawnForTask(...args),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: (...args: unknown[]) => mockApplySuspendDbWrites(...args),
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn(async (_id: string, fn: () => Promise<void>) => fn()),
}));

import { planAutoSpawnReconcile, reconcileAutoSpawnChange } from '../../src/main/ipc/handlers/auto-spawn-reconcile';
import type { StrategyChange } from '../../src/main/ipc/handlers/strategy-propagation';
import type { Swimlane, Task } from '../../src/shared/types';

const LANE_ID = 'lane-planning';

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Planning',
    role: null,
    auto_spawn: false,
    model_override: null,
    effort_override: null,
    ...overrides,
  } as Swimlane;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Wire the reconcile',
    swimlane_id: LANE_ID,
    session_id: null,
    profile_id: null,
    ...overrides,
  } as Task;
}

/** A column edit turning auto-spawn ON for one task. */
function turnedOn(task: Task = makeTask()): StrategyChange {
  return {
    task,
    before: makeLane({ auto_spawn: false }),
    after: makeLane({ auto_spawn: true }),
    sourceName: 'Planning',
  };
}

/** A column edit turning auto-spawn OFF for one task. */
function turnedOff(task: Task): StrategyChange {
  return {
    task,
    before: makeLane({ auto_spawn: true }),
    after: makeLane({ auto_spawn: false }),
    sourceName: 'Planning',
  };
}

const NO_DEPENDENCIES = {
  userPausedTaskIds: new Set<string>(),
  hasSessionForTask: () => false,
};

/**
 * Flush the microtask queue completely by yielding to a macrotask. The event
 * loop always drains every pending microtask before running a queued
 * `setTimeout` callback, so this deterministically waits out any depth of
 * promise chaining inside `reconcileAutoSpawnChange`'s backgrounded IIFE
 * without guessing at a duration - unlike `vi.waitFor` on a "was NOT called"
 * assertion, which can resolve on its very first (too-early) check and prove
 * nothing about work still in flight.
 */
async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('planAutoSpawnReconcile', () => {
  it('selects a session-less task when the column is switched on', () => {
    const plan = planAutoSpawnReconcile([turnedOn()], NO_DEPENDENCIES);

    expect(plan.toSpawn).toEqual([{
      taskId: 'task-1',
      taskTitle: 'Wire the reconcile',
      swimlaneId: LANE_ID,
      sourceName: 'Planning',
    }]);
    expect(plan.toSuspend).toEqual([]);
  });

  it('never selects a user-paused task', () => {
    // The non-goal that outranks everything else here: a task the user
    // explicitly paused must not start again just because a column was
    // switched on. Only SESSION_RESUME clears that.
    const plan = planAutoSpawnReconcile([turnedOn()], {
      ...NO_DEPENDENCIES,
      userPausedTaskIds: new Set(['task-1']),
    });

    expect(plan.toSpawn).toEqual([]);
  });

  it('skips a task that already has a session', () => {
    const plan = planAutoSpawnReconcile([turnedOn()], {
      ...NO_DEPENDENCIES,
      hasSessionForTask: () => true,
    });

    expect(plan.toSpawn).toEqual([]);
  });

  it('selects a task with a live session when the column is switched off', () => {
    const plan = planAutoSpawnReconcile(
      [turnedOff(makeTask({ session_id: 'sess-1' }))],
      NO_DEPENDENCIES,
    );

    expect(plan.toSuspend).toEqual([
      { taskId: 'task-1', sessionId: 'sess-1', swimlaneId: LANE_ID, sourceName: 'Planning' },
    ]);
    expect(plan.toSpawn).toEqual([]);
  });

  it('has nothing to suspend for a session-less task when the column is switched off', () => {
    const plan = planAutoSpawnReconcile([turnedOff(makeTask())], NO_DEPENDENCIES);

    expect(plan.toSuspend).toEqual([]);
  });

  it('plans nothing when auto_spawn did not change', () => {
    // A colour, name, or icon edit re-saves the whole row. Acting on that would
    // suspend or respawn every task in the column on a cosmetic change.
    const plan = planAutoSpawnReconcile([{
      task: makeTask({ session_id: 'sess-1' }),
      before: makeLane({ auto_spawn: true, name: 'Planning' }),
      after: makeLane({ auto_spawn: true, name: 'Plan' }),
      sourceName: 'Plan',
    }], NO_DEPENDENCIES);

    expect(plan).toEqual({ toSpawn: [], toSuspend: [] });
  });

  it('judges each task on its own profile-folded lane, not the column\'s', () => {
    // auto_spawn is profile-scoped, so one column edit can be a real delta for a
    // task on Default and a no-op for a task whose profile pins it off. The
    // caller folds the profile; this asserts the gate respects that per task.
    const plan = planAutoSpawnReconcile([
      turnedOn(makeTask({ id: 'task-default' })),
      {
        task: makeTask({ id: 'task-profiled', profile_id: 'p1' }),
        before: makeLane({ auto_spawn: false }),
        after: makeLane({ auto_spawn: false }),
        sourceName: 'Planning',
      },
    ], NO_DEPENDENCIES);

    expect(plan.toSpawn.map((entry) => entry.taskId)).toEqual(['task-default']);
  });

  it('never selects a task when before could not be re-read (null) - spawn-storm guard', () => {
    // buildColumnStrategyChanges documents `before: Swimlane | null | undefined`
    // for "the row could not be re-read". Without this guard, a task in this
    // state would fall straight into the ON branch below and get selected for
    // a spawn on every task in the column, since there is no real before/after
    // to compare.
    const plan = planAutoSpawnReconcile([{
      task: makeTask(),
      before: null,
      after: makeLane({ auto_spawn: true }),
      sourceName: 'Planning',
    }], NO_DEPENDENCIES);

    expect(plan.toSpawn).toEqual([]);
    expect(plan.toSuspend).toEqual([]);
  });

  it('never selects a task when before could not be re-read (undefined) - spawn-storm guard', () => {
    const plan = planAutoSpawnReconcile([{
      task: makeTask(),
      before: undefined,
      after: makeLane({ auto_spawn: true }),
      sourceName: 'Planning',
    } as unknown as StrategyChange], NO_DEPENDENCIES);

    expect(plan.toSpawn).toEqual([]);
    expect(plan.toSuspend).toEqual([]);
  });

  it('never selects a To Do or Done task, however the flag got written', () => {
    // The Board Manager strips auto_spawn for a role column and apply-config
    // forces it false, but the MCP update_column tool writes the field with no
    // role validation. Since this reconcile acts IMMEDIATELY, an agent calling
    // update_column({ column: 'To Do', autoSpawn: true }) would otherwise spawn
    // an agent and a worktree for every card in To Do - and SESSION_RESUME then
    // refuses to resume any of them, because it rejects role 'todo'.
    for (const role of ['todo', 'done'] as const) {
      const plan = planAutoSpawnReconcile([{
        task: makeTask(),
        before: makeLane({ auto_spawn: false, role }),
        after: makeLane({ auto_spawn: true, role }),
        sourceName: role === 'todo' ? 'To Do' : 'Done',
      }], NO_DEPENDENCIES);

      expect(plan.toSpawn).toEqual([]);
    }
  });

  it('still suspends in a role column - only the ON direction is refused', () => {
    // The gate is deliberately one-directional. Stopping an agent that should
    // never have been there is always safe; starting one is what needs refusing.
    const plan = planAutoSpawnReconcile([{
      task: makeTask({ session_id: 'sess-1' }),
      before: makeLane({ auto_spawn: true, role: 'todo' }),
      after: makeLane({ auto_spawn: false, role: 'todo' }),
      sourceName: 'To Do',
    }], NO_DEPENDENCIES);

    expect(plan.toSuspend).toEqual([{
      taskId: 'task-1',
      sessionId: 'sess-1',
      swimlaneId: LANE_ID,
      sourceName: 'To Do',
    }]);
  });
});

describe('reconcileAutoSpawnChange', () => {
  function makeContext() {
    return {
      sessionManager: {
        hasSessionForTask: (...args: unknown[]) => mockHasSessionForTask(...args),
        listSessions: (...args: unknown[]) => mockListSessions(...args),
        suspend: (...args: unknown[]) => mockSuspend(...args),
        kill: mockKill,
        removeByTaskId: mockRemoveByTaskId,
      },
      terminalSubmitScheduler: { cancel: (...args: unknown[]) => mockCancel(...args) },
      mainWindow: { isDestroyed: () => false, webContents: { send: mockWebContentsSend } },
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserPausedTaskIds.mockReturnValue(new Set<string>());
    mockHasSessionForTask.mockReturnValue(false);
    mockListSessions.mockReturnValue([]);
    mockTaskGetById.mockReturnValue(makeTask({ session_id: 'sess-1' }));
  });

  it('spawns through autoSpawnForTask, the board-driven chokepoint', async () => {
    // spawn-entry-point-parity: a board-driven spawn routes through spawnAgent,
    // which autoSpawnForTask wraps (adding the task lock, the worktree, and the
    // branch checkout). Calling the engine or sessionManager.spawn directly here
    // would skip runSpawnPreamble and fail the parity scan.
    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [turnedOn()]);

    await vi.waitFor(() => expect(mockAutoSpawnForTask).toHaveBeenCalledTimes(1));
    expect(mockAutoSpawnForTask).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      { id: 'task-1', title: 'Wire the reconcile' },
      LANE_ID,
    );
  });

  it('suspends with the system marker, so a later spawn is not blocked', async () => {
    // 'user' is reserved for an explicit Pause and makes the suspend sticky
    // against spawnAgent's guard. A config change must not be sticky.
    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [
      turnedOff(makeTask({ session_id: 'sess-1' })),
    ]);

    await vi.waitFor(() => expect(mockSuspend).toHaveBeenCalledWith('sess-1'));
    expect(mockApplySuspendDbWrites).toHaveBeenCalledWith(expect.anything(), 'proj-1', 'task-1', 'system');
    expect(mockCancel).toHaveBeenCalledWith('task-1');
  });

  it('suspends rather than kills, so the card keeps its Resume affordance', async () => {
    // `suspend` marks the registry entry 'suspended' and KEEPS it
    // (session-manager.ts), which is what leaves the renderer a session to
    // render Resume from. `kill` / `removeByTaskId` would drop the entry and
    // strand the task exactly the way the startup path used to - the same
    // defect this change fixes on the other side.
    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [
      turnedOff(makeTask({ session_id: 'sess-1' })),
    ]);

    await vi.waitFor(() => expect(mockSuspend).toHaveBeenCalled());
    expect(mockKill).not.toHaveBeenCalled();
    expect(mockRemoveByTaskId).not.toHaveBeenCalled();
  });

  it('does not spawn a user-paused task', async () => {
    mockGetUserPausedTaskIds.mockReturnValue(new Set(['task-1']));

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [turnedOn()]);

    // The pause guard drops the only candidate, so plan.toSpawn and
    // plan.toSuspend are both empty and reconcileAutoSpawnChange returns
    // BEFORE ever starting its backgrounded async block - there is no
    // in-flight work to await. `vi.waitFor(() => expect(...).not
    // .toHaveBeenCalled())` would pass on its very first synchronous check
    // regardless of whether the guard actually ran, so it is not a
    // synchronization signal at all: reverting the guard would still start
    // the async block, and the assertions below could observe it before the
    // spawn call lands. Flush the macrotask queue instead - deterministic,
    // not a timing guess, since every mock here resolves immediately with no
    // real timers.
    await flushAsyncWork();

    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
    expect(mockWebContentsSend).not.toHaveBeenCalled();
  });

  it('does not push the resync when mainWindow is destroyed', async () => {
    // Every other test in this block hardcodes isDestroyed: () => false. This
    // pins the guard on the other side: real reconcile work (a suspend) still
    // happens, but the resync push must not reach a destroyed window.
    const destroyedContext = {
      sessionManager: {
        hasSessionForTask: (...args: unknown[]) => mockHasSessionForTask(...args),
        listSessions: (...args: unknown[]) => mockListSessions(...args),
        suspend: (...args: unknown[]) => mockSuspend(...args),
        kill: mockKill,
        removeByTaskId: mockRemoveByTaskId,
      },
      terminalSubmitScheduler: { cancel: (...args: unknown[]) => mockCancel(...args) },
      mainWindow: { isDestroyed: () => true, webContents: { send: mockWebContentsSend } },
    } as never;

    reconcileAutoSpawnChange(destroyedContext, 'proj-1', 'TEST', [
      turnedOff(makeTask({ session_id: 'sess-1' })),
    ]);

    await flushAsyncWork();

    // Anchored on the suspend having actually happened, not merely on the
    // plan being non-empty, so this proves real reconcile work ran before we
    // assert the send never fired.
    expect(mockSuspend).toHaveBeenCalledWith('sess-1');
    expect(mockWebContentsSend).not.toHaveBeenCalled();
  });

  it('spawns the second task even when the first spawn rejects (catch-and-continue)', async () => {
    // Sequential, not Promise.all: a rejected spawn must not stop the rest of
    // the column from reconciling, and the resync push must still fire.
    mockAutoSpawnForTask
      .mockRejectedValueOnce(new Error('first spawn boom'))
      .mockResolvedValueOnce(undefined);

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [
      turnedOn(makeTask({ id: 'task-first', title: 'First' })),
      turnedOn(makeTask({ id: 'task-second', title: 'Second' })),
    ]);

    await flushAsyncWork();

    expect(mockAutoSpawnForTask).toHaveBeenCalledTimes(2);
    expect(mockAutoSpawnForTask.mock.calls[1][2]).toMatchObject({ id: 'task-second', title: 'Second' });
    expect(mockWebContentsSend).toHaveBeenCalled();
  });

  it('suspends the second task even when the first suspend rejects (catch-and-continue)', async () => {
    mockSuspend
      .mockRejectedValueOnce(new Error('first suspend boom'))
      .mockResolvedValueOnce(undefined);
    mockTaskGetById
      .mockReturnValueOnce(makeTask({ id: 'task-first', session_id: 'sess-first' }))
      .mockReturnValueOnce(makeTask({ id: 'task-second', session_id: 'sess-second' }));

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [
      turnedOff(makeTask({ id: 'task-first', session_id: 'sess-first' })),
      turnedOff(makeTask({ id: 'task-second', session_id: 'sess-second' })),
    ]);

    await flushAsyncWork();

    expect(mockSuspend).toHaveBeenCalledTimes(2);
    expect(mockSuspend).toHaveBeenNthCalledWith(1, 'sess-first');
    expect(mockSuspend).toHaveBeenNthCalledWith(2, 'sess-second');
    expect(mockWebContentsSend).toHaveBeenCalled();
  });

  it('suspends before it spawns when a single reconcile carries both directions', async () => {
    mockTaskGetById.mockReturnValue(makeTask({ id: 'task-to-suspend', session_id: 'sess-1' }));

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [
      turnedOff(makeTask({ id: 'task-to-suspend', session_id: 'sess-1' })),
      turnedOn(makeTask({ id: 'task-to-spawn' })),
    ]);

    await flushAsyncWork();

    expect(mockSuspend).toHaveBeenCalledTimes(1);
    expect(mockAutoSpawnForTask).toHaveBeenCalledTimes(1);
    // invocationCallOrder is a monotonically increasing counter shared by
    // every vi.fn() in the run, so a lower index here means suspend's single
    // call in THIS test happened chronologically before spawn's.
    expect(mockSuspend.mock.invocationCallOrder[0])
      .toBeLessThan(mockAutoSpawnForTask.mock.invocationCallOrder[0]);
  });

  it('spawns for a task whose only registry entry has already exited', async () => {
    // `sessionManager.hasSessionForTask` matches ANY entry, and an exited entry
    // is never evicted from the registry, so keying the occupancy check off it
    // would permanently skip a task whose agent finished during this app run -
    // precisely the task switching the column back on exists to restart. The
    // startup pass gets away with the same predicate only because a fresh
    // registry holds no entry from a previous run.
    mockListSessions.mockReturnValue([{ taskId: 'task-1', projectId: 'proj-1', status: 'exited' }]);

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [turnedOn()]);

    await flushAsyncWork();

    expect(mockAutoSpawnForTask).toHaveBeenCalledTimes(1);
  });

  it('skips a task that still holds a suspended entry', async () => {
    // The other side of the same predicate: a suspended entry (including the
    // placeholder startup registers) IS a session the user can resume by hand,
    // so switching the column on must not spawn a second one alongside it.
    mockListSessions.mockReturnValue([
      { taskId: 'task-1', projectId: 'proj-1', status: 'suspended' },
    ]);

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [turnedOn()]);

    await flushAsyncWork();

    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
  });

  it('ignores an identically-keyed session belonging to another project', async () => {
    // The registry is app-wide. Threading an explicit projectId through this
    // path exists precisely so nothing here resolves ambiently, so the
    // occupancy scan has to be project-scoped too.
    mockListSessions.mockReturnValue([
      { taskId: 'task-1', projectId: 'other-project', status: 'running' },
    ]);

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [turnedOn()]);

    await flushAsyncWork();

    expect(mockAutoSpawnForTask).toHaveBeenCalledTimes(1);
  });

  it('does not suspend a task that was dragged into another column first', async () => {
    // The plan is a synchronous snapshot, but each suspend awaits a PTY
    // shutdown, so the last entry of a busy column can run many seconds later.
    // A card dragged into a column that still wants an agent keeps (or
    // respawns) a session; suspending it would stop an agent the board
    // legitimately wants running, and leave it stopped.
    mockTaskGetById.mockReturnValue(
      makeTask({ session_id: 'sess-1', swimlane_id: 'lane-somewhere-else' }),
    );

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [
      turnedOff(makeTask({ session_id: 'sess-1' })),
    ]);

    await flushAsyncWork();

    expect(mockSuspend).not.toHaveBeenCalled();
    expect(mockApplySuspendDbWrites).not.toHaveBeenCalled();
  });

  it('re-reads the task inside the lock and skips a session that already went away', async () => {
    // The plan is built before the lock is acquired; a drag or an explicit pause
    // can land in between. Suspending a stale id would kill the wrong session.
    mockTaskGetById.mockReturnValue(makeTask({ session_id: null }));

    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [
      turnedOff(makeTask({ session_id: 'sess-1' })),
    ]);

    await vi.waitFor(() => expect(mockWebContentsSend).toHaveBeenCalled());
    expect(mockSuspend).not.toHaveBeenCalled();
    expect(mockApplySuspendDbWrites).not.toHaveBeenCalled();
  });

  it('does nothing at all without a resolved project', () => {
    // The reconcile spawns and suspends, so it must never run against an
    // ambiently-guessed project.
    reconcileAutoSpawnChange(makeContext(), null, 'TEST', [turnedOn()]);

    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
    expect(mockSuspend).not.toHaveBeenCalled();
  });

  it('stays quiet when the edit changed nothing', () => {
    reconcileAutoSpawnChange(makeContext(), 'proj-1', 'TEST', [{
      task: makeTask({ session_id: 'sess-1' }),
      before: makeLane({ auto_spawn: true }),
      after: makeLane({ auto_spawn: true }),
      sourceName: 'Planning',
    }]);

    expect(mockWebContentsSend).not.toHaveBeenCalled();
  });
});

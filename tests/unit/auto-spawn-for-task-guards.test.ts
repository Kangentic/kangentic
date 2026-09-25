/**
 * Two guards `autoSpawnForTask` (src/main/ipc/helpers/agent-spawn.ts) now runs
 * before it ever touches a worktree, neither of which had a test before this
 * change landed. `autoSpawnForTask` is the entry point for the MCP-created-task
 * auto-spawn AND the auto_spawn reconcile's ON side (see
 * reconcileAutoSpawnChange, which routes every spawn through it for
 * spawn-entry-point-parity), so both guards protect every board-driven spawn
 * of an already-existing task, not just creation.
 *
 * 1. The `auto_spawn` guard now reads the profile-folded lane, not the raw
 *    column. `auto_spawn` is profile-scoped (see the `auto_spawn` case in
 *    `applyProfileToLane`), so a profile can turn it on for a column whose
 *    base has it off. Before this fix the guard read `rawLane.auto_spawn`
 *    directly and returned before the profile was ever folded in - never
 *    reaching `spawnAgent`'s own (later, idempotent) fold at all.
 *
 * 2. The re-read task's swimlane_id must still match the `swimlaneId` this
 *    call was planned against. The reconcile can await a worktree and a branch
 *    checkout per task in a column, so its later entries reach this call many
 *    seconds after the plan was built; a drag in that window moves the task to
 *    a column whose agent/model/permission-mode settings this call was never
 *    given. Spawning would apply the ORIGINAL column's settings to a task that
 *    has already left it.
 *
 * `ensureTaskWorktree` is the first side effect once both guards clear, so
 * observing whether it was called is enough to prove which way each guard
 * decided, without needing to mock the rest of the spawn machinery downstream
 * (branch checkout, transition engine, spawnAgent itself).
 *
 * Red-green: each guard's tests red against the pre-fix code - see the inline
 * note above each assertion.
 *
 * column-strategy.ts (applyProfileToLane, findTaskProfile) and task-profile.ts
 * (loadTaskProfile) are deliberately left UNMOCKED for the profile-fold tests:
 * the fold is exactly what those lock, mirroring auto-spawn-profile-scoped
 * .test.ts (the startup-sweep twin of this gate) and
 * resume-suspended-profile-scoped.test.ts (the placeholder twin).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSwimlaneGetById = vi.fn();
const mockTaskGetById = vi.fn();
const mockFindLiveSessionByTaskId = vi.fn((): unknown => undefined);
const mockEnsureTaskWorktree = vi.fn();
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockNotifySpawnBlocked = vi.fn();
const mockTrackEvent = vi.fn();
const mockReportHandledError = vi.fn();

/**
 * The order in which the task lock and the two git helpers ran, for the
 * split-lock tests below. The lock mock records its acquire and release
 * around the callback; the git mocks record themselves. Hoisted because the
 * vi.mock factories close over it.
 */
const sequence = vi.hoisted((): string[] => []);

const mockExecuteTransition = vi.hoisted(() =>
  vi.fn(async () => ({ outcomes: [], failures: [], startedAgent: false })),
);
const mockRunLegacySpawnAgent = vi.hoisted(() => vi.fn(async () => {}));
const mockResumeSuspendedSession = vi.hoisted(() => vi.fn(async () => {}));

// The two modules agent-spawn.ts imports that drag in the heaviest transitive
// graph (SessionManager -> node-pty, every agent adapter). Stubbed so the
// module loads without pulling either in, mirroring the same avoidance
// strategy strategy-propagation.test.ts documents for this file. The guard
// tests never reach them (autoSpawnForTask returns as soon as
// ensureTaskWorktree rejects); the split-lock tests below drive through to
// `spawnAgent`'s engine calls, so the engine carries jest-fn methods and the
// registry a real adapter shape, as auto-spawn-for-task-explicit-start-
// forward.test.ts does.
vi.mock('../../src/main/transition-engine/transition-engine', () => ({
  TransitionEngine: class {
    executeTransition = mockExecuteTransition;
    runLegacySpawnAgent = mockRunLegacySpawnAgent;
    resumeSuspendedSession = mockResumeSuspendedSession;
  },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    getById = (...args: unknown[]) => mockSwimlaneGetById(...args);
  },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask() {
      return undefined;
    }
    getLatestForTaskByTypeAndIsolation() {
      return undefined;
    }
  },
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: (...args: unknown[]) => mockTaskGetById(...args), update: vi.fn() },
    actions: {},
    automations: {},
    automationRuns: {},
    attachments: {},
  })),
}));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  ensureTaskWorktree: (...args: unknown[]) => {
    sequence.push('worktree');
    return mockEnsureTaskWorktree(...args);
  },
  ensureTaskBranchCheckout: (...args: unknown[]) => {
    sequence.push('checkout');
    return mockEnsureTaskBranchCheckout(...args);
  },
  notifySpawnBlocked: (...args: unknown[]) => mockNotifySpawnBlocked(...args),
}));
// A pass-through that records its edges, so a test can prove the git
// helpers ran OUTSIDE the lock rather than inside it.
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn(async (_taskId: string, fn: () => Promise<unknown>) => {
    sequence.push('lock:acquire');
    try {
      return await fn();
    } finally {
      sequence.push('lock:release');
    }
  }),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));
// Real failure reporting would count an aborted spawn as a failed one; the
// cancellation tests assert it does not.
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => mockReportHandledError(...args),
}));
// A partial mock: wraps the REAL registerResumeController / releaseResumeController
// in vi.fn so the "releases its own controller" test below can assert on their
// call args, while every other test in this file still gets the real
// register/abort/release behavior through the wrappers.
vi.mock('../../src/main/ipc/handlers/session-resume-controllers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/ipc/handlers/session-resume-controllers')>();
  return {
    ...actual,
    registerResumeController: vi.fn(actual.registerResumeController),
    releaseResumeController: vi.fn(actual.releaseResumeController),
  };
});

import { autoSpawnForTask } from '../../src/main/ipc/helpers/agent-spawn';
import { getInFlightSpawnProgress, __resetSpawnProgressForTest } from '../../src/main/transition-engine/spawn-progress';
// Deliberately the REAL registry: the cancellation tests abort through it,
// exactly as SESSION_SUSPEND / SESSION_RESET / a newer SESSION_RESUME do.
import { abortInFlightResume, registerResumeController, releaseResumeController } from '../../src/main/ipc/handlers/session-resume-controllers';
import type { BoardProfile, Swimlane } from '../../src/shared/types';

const TASK_ID = 'task-1';
const LANE_ID = 'lane-quiet';

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Quiet Column',
    auto_spawn: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    auto_command: null,
    handoff_context: false,
    plan_exit_target_id: null,
    ...overrides,
  } as Swimlane;
}

function makeContext(boardProfiles: BoardProfile[] = []) {
  return {
    projectRepo: {
      getById: vi.fn(() => ({
        id: 'proj-1', name: 'Example', path: '/mock/project', default_agent: 'claude', default_model: null, default_effort: null,
      })),
    },
    boardConfigManager: { getBoardProfiles: vi.fn(() => boardProfiles) },
    // The live-session re-check under the lock (see the "races itself" block).
    sessionManager: { findLiveSessionByTaskId: (...args: unknown[]) => mockFindLiveSessionByTaskId(...args) },
    // createProgressCallback / clearSpawnProgress (the real, unmocked
    // spawn-progress module) both read context.mainWindow.
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    // What spawnAgent's preamble and keystroke path read once the split-lock
    // tests drive through to it.
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'default' },
        git: {},
        mcpServer: { enabled: true },
      })),
    },
  } as never;
}

/** A task row sitting in the planned column, for the split-lock tests. */
function makeTaskInLane(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: 'Split-lock task',
    swimlane_id: LANE_ID,
    profile_id: null,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    run_mode: 'column_settings',
    auto_command: null,
    session_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sequence.length = 0;
  // mockReset, not only the clearAllMocks above: the split-lock CAS tests
  // queue `mockReturnValueOnce` values that only a two-read implementation
  // consumes, and clearAllMocks keeps an unconsumed queue, which then leaks
  // into whichever test runs next (seen against the pre-split code).
  mockTaskGetById.mockReset();
  mockSwimlaneGetById.mockReset();
  mockFindLiveSessionByTaskId.mockReset();
  mockFindLiveSessionByTaskId.mockReturnValue(undefined);
  mockExecuteTransition.mockImplementation(async () => ({ outcomes: [], failures: [], startedAgent: false }));
  // Rejects so autoSpawnForTask's own catch returns immediately once the
  // guard clears - the boundary this test needs, without mocking anything
  // downstream of the worktree phase.
  mockEnsureTaskWorktree.mockImplementation(async () => {
    throw new Error('stop here - worktree phase reached');
  });
  // vi.clearAllMocks() clears call records, not implementations, so a test
  // that overrides this with mockRejectedValue (the checkout-failure describe
  // block below) would otherwise leak a rejecting checkout into every test
  // that runs after it. Re-establish the default success implementation every
  // time, the same way backlog-promote-abort.test.ts resets its git mocks.
  mockEnsureTaskBranchCheckout.mockImplementation(async () => {});
});

describe('autoSpawnForTask: the auto_spawn guard reads the profile-folded lane', () => {
  it('spawns a profiled task whose column has auto_spawn off, because the profile turns it on', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: false }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Profiled task', swimlane_id: LANE_ID, profile_id: 'p1',
    });

    await autoSpawnForTask(
      makeContext([{ id: 'p1', name: 'Eager', columns: { [LANE_ID]: { autoSpawn: true } } }]),
      'proj-1',
      { id: TASK_ID, title: 'Profiled task' },
      LANE_ID,
    );

    // Reaching the worktree phase proves the guard read the FOLDED lane
    // (auto_spawn: true from the profile), not the raw column (auto_spawn:
    // false). Pre-fix, this guard read rawLane.auto_spawn directly and this
    // assertion reds: ensureTaskWorktree is never called.
    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
  });

  it('does not spawn a profiled task whose column has auto_spawn on, when the profile turns it off', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Profiled task', swimlane_id: LANE_ID, profile_id: 'p1',
    });

    await autoSpawnForTask(
      makeContext([{ id: 'p1', name: 'Manual', columns: { [LANE_ID]: { autoSpawn: false } } }]),
      'proj-1',
      { id: TASK_ID, title: 'Profiled task' },
      LANE_ID,
    );

    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });

  it('leaves an unprofiled task on its column\'s own flag (regression guard - both directions still hold)', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Unprofiled task', swimlane_id: LANE_ID, profile_id: null,
    });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Unprofiled task' }, LANE_ID);

    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);

    mockEnsureTaskWorktree.mockClear();
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: false }));

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Unprofiled task' }, LANE_ID);

    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });
});

describe('autoSpawnForTask: a task that already has a live session is never spawned again', () => {
  // A start that races itself: a second caller queued on the task lock while
  // the first was still spawning (two phone Starts a second apart on a slow
  // worktree ensure). spawnAgent's startAgent would bail on the session_id,
  // but the column's enter list would still run and its message row would
  // deliver to the LIVE session, typing the column message twice. task-move's
  // Phase 3 makes the same check; this chokepoint did not, because its
  // original callers (MCP create, the reconcile) could not race themselves.
  it('returns before the worktree phase when the registry already holds a live session for the task', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true, role: null }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Started twice', swimlane_id: LANE_ID, profile_id: null, session_id: 'sess-live',
    });
    mockFindLiveSessionByTaskId.mockReturnValue({ id: 'sess-live', taskId: TASK_ID, status: 'running' });

    await autoSpawnForTask(
      makeContext([]), 'proj-1', { id: TASK_ID, title: 'Started twice' }, LANE_ID,
      { explicitStart: true },
    );

    // Red before the guard existed: the worktree phase was reached and the
    // enter list ran against the live session.
    expect(mockFindLiveSessionByTaskId).toHaveBeenCalledWith(TASK_ID);
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });

  it('still spawns when the registry holds no live session, whatever a stale session_id says', async () => {
    // A natural exit leaves task.session_id pointing at an exited row; the
    // registry, not the column, is the source of truth for liveness.
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true, role: null }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Ended', swimlane_id: LANE_ID, profile_id: null, session_id: 'sess-stale',
    });
    mockFindLiveSessionByTaskId.mockReturnValue(undefined);

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Ended' }, LANE_ID);

    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
  });

  it('also returns before the worktree phase for a fully automatic caller, with no explicitStart at all', async () => {
    // The guard in the source is unconditional - it is not scoped behind
    // `options.explicitStart` - because the two automatic callers,
    // mcp-project-context.ts's task-created hook and the auto_spawn
    // reconcile (auto-spawn-reconcile.ts), both call autoSpawnForTask with no
    // options object at all. The docstring on the guard even calls the
    // reconcile's own pre-filtering "defense in depth" on top of THIS check,
    // which only holds if the check still runs for that caller. The sibling
    // test above only ever exercises the guard with explicitStart: true, so
    // it would not catch a future edit that accidentally scoped the guard to
    // the phone's explicit-start caller alone.
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true, role: null }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Created twice', swimlane_id: LANE_ID, profile_id: null, session_id: 'sess-live',
    });
    mockFindLiveSessionByTaskId.mockReturnValue({ id: 'sess-live', taskId: TASK_ID, status: 'running' });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Created twice' }, LANE_ID);

    expect(mockFindLiveSessionByTaskId).toHaveBeenCalledWith(TASK_ID);
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });
});

describe('autoSpawnForTask: explicitStart lifts the auto_spawn default, not the role gate', () => {
  // The phone's start-session verb is an explicit user gesture, the bridge
  // twin of the desktop's Resume button, which starts a session whatever the
  // column's "Start an agent here" default says. The flag exists to stop an
  // AUTOMATIC spawn from overriding a user's choice; an explicit Start is that
  // user changing their mind.
  it('reaches the worktree phase on an auto_spawn-off column when explicitStart is set', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: false, role: null }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Restarted from the phone', swimlane_id: LANE_ID, profile_id: null,
    });

    await autoSpawnForTask(
      makeContext([]), 'proj-1', { id: TASK_ID, title: 'Restarted from the phone' }, LANE_ID,
      { explicitStart: true },
    );

    // Red before the option existed: the auto_spawn guard returned first.
    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
  });

  it('still honors the auto_spawn default without the flag (the automatic callers are unchanged)', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: false, role: null }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Reconciled', swimlane_id: LANE_ID, profile_id: null,
    });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Reconciled' }, LANE_ID, {});

    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });

  it.each([['todo'], ['done']] as const)('never spawns into a %s column even with explicitStart', async (role) => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true, role }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Explicit start into a role column', swimlane_id: LANE_ID, profile_id: null,
    });

    await autoSpawnForTask(
      makeContext([]), 'proj-1', { id: TASK_ID, title: 'Explicit start into a role column' }, LANE_ID,
      { explicitStart: true },
    );

    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });
});

describe('autoSpawnForTask: a To Do or Done column never spawns, whatever its flag says', () => {
  // The flag can land on a role lane: MCP `update_column` writes it with no
  // role guard, and a Board Profile folds `autoSpawn` for any lane id. Every
  // other spawn path gates on NEVER_AUTO_SPAWN_ROLES (task-move.ts branches
  // on role, the startup and reconcile sweeps filter), but this chokepoint
  // read the flag alone, so a task created into such a To Do column spawned
  // a live agent behind a card the renderer treats as sessionless (#661).
  it.each([['todo'], ['done']] as const)('does not spawn into a %s column with auto_spawn on', async (role) => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true, role }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Created into a role column', swimlane_id: LANE_ID, profile_id: null,
    });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Created into a role column' }, LANE_ID);

    // Pre-fix this reached the worktree phase: the role never entered the
    // decision.
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });

  it('does not spawn when a profile turns auto_spawn on for a todo column', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: false, role: 'todo' }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Profiled into To Do', swimlane_id: LANE_ID, profile_id: 'p1',
    });

    await autoSpawnForTask(
      makeContext([{ id: 'p1', name: 'Eager', columns: { [LANE_ID]: { autoSpawn: true } } }]),
      'proj-1',
      { id: TASK_ID, title: 'Profiled into To Do' },
      LANE_ID,
    );

    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });

  it('still spawns into a custom column (role null) with auto_spawn on', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true, role: null }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Created into a working column', swimlane_id: LANE_ID, profile_id: null,
    });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Created into a working column' }, LANE_ID);

    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
  });
});

describe('autoSpawnForTask: re-checks the task is still in the planned column', () => {
  it('does not spawn a task that left the column before this call was reached', async () => {
    // The lane this call was planned against wants agents...
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true }));
    // ...but the re-read task has since moved to a different column entirely.
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Drifted task', swimlane_id: 'lane-elsewhere', profile_id: null,
    });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Drifted task' }, LANE_ID);

    // Pre-fix, there was no re-check at all: this call would have proceeded to
    // spawn against the column it left, applying that column's settings to a
    // task that is no longer in it. This assertion reds without the guard.
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });

  it('still spawns when the re-read task is exactly where this call was planned for', async () => {
    // Same shape as the drifted case above, but swimlane_id matches - proves
    // the guard compares by value rather than always bailing.
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Stayed put', swimlane_id: LANE_ID, profile_id: null,
    });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Stayed put' }, LANE_ID);

    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
  });
});

describe('autoSpawnForTask: a failed worktree tells the user', () => {
  it('notifies when worktree creation fails, stamped with the EXPLICIT projectId', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Branch in use', swimlane_id: LANE_ID, profile_id: null,
    });
    const worktreeError = new Error("fatal: 'some-branch' is already used by worktree at '/repo'");
    mockEnsureTaskWorktree.mockRejectedValue(worktreeError);

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Branch in use' }, LANE_ID);

    // This is exactly the task #538 path. Pre-fix the catch was `console.error`
    // + `return`, so an MCP-created task failed here with no UI trace at all.
    expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
    const [, , step, error, projectId] = mockNotifySpawnBlocked.mock.calls[0];
    expect(step).toBe('worktree');
    expect(error).toBe(worktreeError);
    // The explicit id, never the ambient one: MCP auto-spawn targets whichever
    // project the tool named, and the renderer filters the notice on it.
    expect(projectId).toBe('proj-1');
  });

  it('does not notify when the worktree phase is never reached', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: false }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Quiet task', swimlane_id: LANE_ID, profile_id: null,
    });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Quiet task' }, LANE_ID);

    // A column that simply does not auto-spawn is not a failure to report.
    expect(mockNotifySpawnBlocked).not.toHaveBeenCalled();
  });
});

describe('autoSpawnForTask: a failed branch checkout also tells the user', () => {
  it('notifies with step="checkout", stamped with the EXPLICIT projectId, distinctly from a worktree failure', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Branch locked', swimlane_id: LANE_ID, profile_id: null,
    });
    // The file-level beforeEach makes ensureTaskWorktree throw by default so
    // the guard-only tests above stop before any git work. This test needs
    // the worktree phase to SUCCEED so control reaches the checkout phase,
    // which is where this notice's call site lives.
    mockEnsureTaskWorktree.mockResolvedValue(null);
    const checkoutError = new Error('fatal: another agent is running in that directory');
    mockEnsureTaskBranchCheckout.mockRejectedValue(checkoutError);

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Branch locked' }, LANE_ID);

    expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
    const [, , step, error, projectId] = mockNotifySpawnBlocked.mock.calls[0];
    // The step literal is what the renderer/dialog uses to tell a checkout
    // failure from a worktree one - a copy-pasted 'worktree' at this call
    // site would silently mislabel every MCP auto-spawn checkout failure.
    // Red-green: flip agent-spawn.ts's 'checkout' literal at this call site
    // to 'worktree' and this assertion reds.
    expect(step).toBe('checkout');
    expect(error).toBe(checkoutError);
    expect(projectId).toBe('proj-1');
  });
});

describe('autoSpawnForTask: threads onProgress + projectId, and clears the label on every exit', () => {
  beforeEach(() => {
    __resetSpawnProgressForTest();
  });

  it('threads onProgress + projectId into both git helpers, and clears the label in the finally', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true }));
    mockTaskGetById.mockReturnValue({
      id: TASK_ID, title: 'Progress task', swimlane_id: LANE_ID, profile_id: null,
    });
    // The mocked worktree helper stands in for the real one emitting
    // 'fetching'; the label demonstrably landing is what makes the
    // "cleared in finally" assertion below non-vacuous (see task-create-
    // handler.test.ts's identical pattern). Stop before spawnAgent runs (its
    // real implementation pulls in SessionRepository et al, which this file
    // does not mock) the same way the checkout-failure test above does.
    mockEnsureTaskWorktree.mockImplementation(async (
      _context: unknown, _task: unknown, _tasks: unknown, _path: unknown,
      options?: { onProgress?: (phase: string) => void },
    ) => {
      options?.onProgress?.('fetching');
      return null;
    });
    const checkoutError = new Error('fatal: another agent is running in that directory');
    mockEnsureTaskBranchCheckout.mockRejectedValue(checkoutError);

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Progress task' }, LANE_ID);

    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
    const worktreeOptions = mockEnsureTaskWorktree.mock.calls[0][4] as { onProgress?: unknown; projectId?: unknown };
    expect(typeof worktreeOptions.onProgress).toBe('function');
    expect(worktreeOptions.projectId).toBe('proj-1');

    expect(mockEnsureTaskBranchCheckout).toHaveBeenCalledTimes(1);
    const checkoutOptions = mockEnsureTaskBranchCheckout.mock.calls[0][3] as { onProgress?: unknown; projectId?: unknown };
    expect(typeof checkoutOptions.onProgress).toBe('function');
    expect(checkoutOptions.projectId).toBe('proj-1');

    // The finally cleared the label the 'fetching' push landed, so an HMR
    // reconcile after this blocked auto-spawn cannot strand the card.
    expect(getInFlightSpawnProgress()).toEqual({});
  });
});

/**
 * The split-lock tests. autoSpawnForTask used to hold the task lock for its
 * whole run: gates, worktree ensure (a fetch), branch checkout, spawn. The
 * phone's start-session verb reaches it on demand, so a Start stuck in a slow
 * fetch made a desktop Pause or move on the same task wait behind it, and
 * nothing could cancel the fetch. It now mirrors SESSION_RESUME: Phase 1
 * locked (gates), Phase 2 unlocked (git), Phase 3 locked (gates again as the
 * CAS, then the spawn), with an abort controller on the same per-task
 * registry SESSION_SUSPEND / SESSION_RESET / a newer SESSION_RESUME abort.
 *
 * These drive through to spawnAgent's engine calls (the mocks above give the
 * engine jest-fn methods), so `executeTransition` is the observable "the spawn
 * happened" seam and the recorded `sequence` is the lock-ordering seam.
 */
describe('autoSpawnForTask: split lock', () => {
  beforeEach(() => {
    __resetSpawnProgressForTest();
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: true, role: null }));
    mockTaskGetById.mockReturnValue(makeTaskInLane());
    mockEnsureTaskWorktree.mockResolvedValue(null);
  });

  it('releases the task lock across the worktree ensure and branch checkout, and re-takes it for the spawn', async () => {
    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

    // Red on the single-lock shape: ['lock:acquire', 'worktree', 'checkout',
    // 'lock:release'], the git work INSIDE the lock.
    expect(sequence).toEqual(['lock:acquire', 'lock:release', 'worktree', 'checkout', 'lock:acquire', 'lock:release']);
    expect(mockExecuteTransition).toHaveBeenCalledTimes(1);
  });

  it('threads ONE abort signal into both git helpers and into spawnAgent', async () => {
    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

    const worktreeOptions = mockEnsureTaskWorktree.mock.calls[0][4] as { signal?: unknown };
    const checkoutOptions = mockEnsureTaskBranchCheckout.mock.calls[0][3] as { signal?: unknown };
    const transitionOptions = mockExecuteTransition.mock.calls[0][3] as { signal?: unknown };
    expect(worktreeOptions.signal).toBeInstanceOf(AbortSignal);
    expect(checkoutOptions.signal).toBe(worktreeOptions.signal);
    // Red before: autoSpawnForTask passed no signal, and spawnAgent
    // substituted a never-aborting controller of its own for the engine.
    expect(transitionOptions.signal).toBe(worktreeOptions.signal);
  });

  it('is cancelled mid-fetch by abortInFlightResume, quietly: no checkout, no spawn, no failure report, label cleared', async () => {
    // What SESSION_SUSPEND / SESSION_RESET / a newer SESSION_RESUME do while
    // this spawn is in its unlocked git phase.
    let labelsAtAbort: Record<string, string> = {};
    mockEnsureTaskWorktree.mockImplementation(async (
      _context: unknown, _task: unknown, _tasks: unknown, _path: unknown,
      options?: { signal?: AbortSignal; onProgress?: (phase: string) => void },
    ) => {
      options?.onProgress?.('fetching');
      labelsAtAbort = getInFlightSpawnProgress();
      abortInFlightResume(TASK_ID);
      options?.signal?.throwIfAborted();
    });

    // Red before the controller existed: abortInFlightResume found nothing
    // to abort, the checkout ran, and the spawn went ahead.
    await expect(
      autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID),
    ).resolves.toBeUndefined();

    expect(mockEnsureTaskBranchCheckout).not.toHaveBeenCalled();
    expect(mockExecuteTransition).not.toHaveBeenCalled();
    // A cancelled spawn is not a blocked one and not a failed one.
    expect(mockNotifySpawnBlocked).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockReportHandledError).not.toHaveBeenCalled();
    // The label demonstrably landed before the abort, so the finally clearing
    // it is a real clear rather than an empty map staying empty.
    expect(Object.keys(labelsAtAbort)).toEqual([TASK_ID]);
    expect(getInFlightSpawnProgress()).toEqual({});
  });

  it('releases its own controller in the finally and logs the cancellation, mid-fetch', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockEnsureTaskWorktree.mockImplementation(async (
      _context: unknown, _task: unknown, _tasks: unknown, _path: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      abortInFlightResume(TASK_ID);
      options?.signal?.throwIfAborted();
    });
    const registerResumeControllerSpy = vi.mocked(registerResumeController);
    const releaseResumeControllerSpy = vi.mocked(releaseResumeController);

    await expect(
      autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID),
    ).resolves.toBeUndefined();

    expect(registerResumeControllerSpy).toHaveBeenCalledTimes(1);
    const [, registeredController] = registerResumeControllerSpy.mock.calls[0];
    // Red on the finally's release removed: this chokepoint's own controller
    // would never leave the registry, so it would still sit there ready for a
    // LATER abort to find and abort an already-settled spawn.
    expect(releaseResumeControllerSpy).toHaveBeenCalledWith(TASK_ID, registeredController);
    // Red on the outer catch's isAbortError branch removed or its console.log
    // deleted: a cancelled spawn would either fall through to the generic
    // failure logging or log nothing at all.
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[auto-spawn] Aborted in-flight spawn for task'),
    );

    consoleLogSpy.mockRestore();
  });

  it('is cancelled between the git phase and the spawn: Phase 3 checks the signal before its gates', async () => {
    mockEnsureTaskBranchCheckout.mockImplementation(async () => {
      abortInFlightResume(TASK_ID);
    });

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

    // The checkout resolved normally after aborting, so the only thing that
    // can stop the spawn is Phase 3's own throwIfAborted.
    expect(mockExecuteTransition).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockReportHandledError).not.toHaveBeenCalled();
    expect(getInFlightSpawnProgress()).toEqual({});
  });

  it('is cancelled mid-checkout by abortInFlightResume, quietly: no blocked notice, no spawn, no failure report', async () => {
    // Unlike the "between the git phase and the spawn" test above, the
    // checkout call itself never resolves here: it observes the abort and
    // rethrows, the same shape ensureTaskWorktree's mid-fetch abort test uses
    // for the worktree phase.
    mockEnsureTaskBranchCheckout.mockImplementation(async (
      _context: unknown, _task: unknown, _path: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      abortInFlightResume(TASK_ID);
      options?.signal?.throwIfAborted();
    });

    // Red before the isAbortError check at the checkout catch: the rethrown
    // AbortError would be treated as an ordinary checkout failure, and
    // notifySpawnBlocked would be called with 'checkout'.
    await expect(
      autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID),
    ).resolves.toBeUndefined();

    expect(mockNotifySpawnBlocked).not.toHaveBeenCalled();
    expect(mockExecuteTransition).not.toHaveBeenCalled();
    // A cancelled spawn is not a blocked one and not a failed one.
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockReportHandledError).not.toHaveBeenCalled();
    expect(getInFlightSpawnProgress()).toEqual({});
  });

  it('still routes a real git failure to the per-step blocked notice, not the abort branch', async () => {
    mockEnsureTaskWorktree.mockRejectedValue(new Error('fatal: could not read from remote'));

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

    // The blocked notice is the per-step path; an ordinary rejection still
    // reaches it and never the outer failure counter, as before.
    expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
    expect(mockExecuteTransition).not.toHaveBeenCalled();
  });

  it('still counts a real failure past the git phase as a spawn failure (the abort branch is narrow), and still releases its controller', async () => {
    // A Phase 3 read against a closed DB. It escapes the locked block and
    // lands in the outer catch, which must still count and report it: the new
    // isAbortError branch sits in front of that reporting, and an inverted
    // condition there would silence every real spawn failure with nothing
    // else noticing.
    mockTaskGetById
      .mockReturnValueOnce(makeTaskInLane())
      .mockImplementationOnce(() => {
        throw new Error('The database connection is not open');
      });
    const registerResumeControllerSpy = vi.mocked(registerResumeController);
    const releaseResumeControllerSpy = vi.mocked(releaseResumeController);

    await expect(
      autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID),
    ).resolves.toBeUndefined();

    expect(mockExecuteTransition).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith('spawn_failed', expect.objectContaining({ reason: 'auto_spawn' }));
    expect(mockReportHandledError).toHaveBeenCalledTimes(1);
    expect(getInFlightSpawnProgress()).toEqual({});

    // The release lives in the function-level finally, not inside the
    // isAbortError branch alone (the mid-fetch abort test above pins that
    // branch specifically, and only that branch). Red if a future edit moved
    // the release call into just the abort branch: a real, non-abort failure
    // would then leak this controller in the registry forever, ready for a
    // LATER abort to find and cancel an already-settled spawn.
    expect(registerResumeControllerSpy).toHaveBeenCalledTimes(1);
    const [, registeredController] = registerResumeControllerSpy.mock.calls[0];
    expect(releaseResumeControllerSpy).toHaveBeenCalledWith(TASK_ID, registeredController);
  });

  it('registers its controller without aborting one already in flight (a Start never cancels desktop work)', async () => {
    const desktopResume = new AbortController();
    const abortSpy = vi.spyOn(desktopResume, 'abort');
    registerResumeController(TASK_ID, desktopResume);

    await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

    // SESSION_RESUME's shape would be abortInFlightResume-then-register; this
    // chokepoint deliberately only registers. See startTaskSession's docblock.
    expect(abortSpy).not.toHaveBeenCalled();
    expect(mockExecuteTransition).toHaveBeenCalledTimes(1);

    // And registering alongside the desktop resume did not displace it: the
    // Pause that follows still reaches it. Red on the single-slot registry,
    // where this chokepoint's registration overwrote the resume's entry and
    // its own release then emptied the slot.
    abortInFlightResume(TASK_ID);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    releaseResumeController(TASK_ID, desktopResume);
  });

  describe('Phase 3 re-runs the gates as the CAS', () => {
    it('does not spawn a task that moved to another column during the git phase', async () => {
      mockTaskGetById
        .mockReturnValueOnce(makeTaskInLane())
        .mockReturnValueOnce(makeTaskInLane({ swimlane_id: 'lane-elsewhere' }));

      await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

      // Red on a single read: Phase 1's row would carry through to the spawn.
      expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
      expect(mockExecuteTransition).not.toHaveBeenCalled();
      expect(getInFlightSpawnProgress()).toEqual({});
    });

    it('does not spawn when another caller registered a live session during the git phase', async () => {
      // Two phone Starts a second apart: the second passes Phase 1 while the
      // first is still fetching, then finds the first's session under the
      // Phase 3 lock. Without this the column's enter list would run and its
      // message row would type the column message at the live session again.
      mockFindLiveSessionByTaskId
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({ id: 'sess-live', taskId: TASK_ID, status: 'running' });

      await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

      expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
      expect(mockExecuteTransition).not.toHaveBeenCalled();
    });

    it('does not spawn when the column turned auto_spawn off during the git phase', async () => {
      // The one outcome the single lock did not have: the column is re-read
      // in Phase 3, the same way the reconcile's suspend side re-reads before
      // acting on a column it planned against.
      mockSwimlaneGetById
        .mockReturnValueOnce(makeLane({ auto_spawn: true, role: null }))
        .mockReturnValueOnce(makeLane({ auto_spawn: false, role: null }));

      await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

      expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
      expect(mockExecuteTransition).not.toHaveBeenCalled();
    });

    it('spawns with the RE-READ task row, not the Phase 1 snapshot', async () => {
      // Pins WHICH read the spawn uses: the second one, made under the Phase 3
      // lock. (Against the real repository that is also how the worktree the
      // git phase recorded reaches the spawn; the mock returns a fresh literal
      // per read, so that propagation is not what this checks.)
      mockTaskGetById
        .mockReturnValueOnce(makeTaskInLane())
        .mockReturnValue(makeTaskInLane({ worktree_path: '/mock/project/.kangentic/worktrees/1' }));

      await autoSpawnForTask(makeContext([]), 'proj-1', { id: TASK_ID, title: 'Split-lock task' }, LANE_ID);

      expect(mockExecuteTransition).toHaveBeenCalledTimes(1);
      const [spawnedTask] = mockExecuteTransition.mock.calls[0] as unknown[];
      expect(spawnedTask).toMatchObject({ worktree_path: '/mock/project/.kangentic/worktrees/1' });
    });
  });
});

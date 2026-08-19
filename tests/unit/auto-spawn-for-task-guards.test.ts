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
const mockEnsureTaskWorktree = vi.fn();
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockNotifySpawnBlocked = vi.fn();

// The two modules agent-spawn.ts imports that drag in the heaviest transitive
// graph (SessionManager -> node-pty, every agent adapter). Neither is ever
// reached here: autoSpawnForTask returns as soon as ensureTaskWorktree rejects,
// well before `createTransitionEngine` or `spawnAgent`'s handoff-agent lookup
// run. Stubbed so the module loads without pulling either in, mirroring the
// same avoidance strategy strategy-propagation.test.ts documents for this file.
vi.mock('../../src/main/transition-engine/transition-engine', () => ({
  TransitionEngine: class {},
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => undefined) },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    getById = (...args: unknown[]) => mockSwimlaneGetById(...args);
  },
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: (...args: unknown[]) => mockTaskGetById(...args) },
    actions: {},
    attachments: {},
  })),
}));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  notifySpawnBlocked: (...args: unknown[]) => mockNotifySpawnBlocked(...args),
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn(async (_taskId: string, fn: () => Promise<void>) => fn()),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

import { autoSpawnForTask } from '../../src/main/ipc/helpers/agent-spawn';
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
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', name: 'Example', path: '/mock/project' })) },
    boardConfigManager: { getBoardProfiles: vi.fn(() => boardProfiles) },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
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

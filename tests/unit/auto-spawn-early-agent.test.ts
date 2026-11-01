/**
 * The early-agent wiring of `autoSpawnForTask` (src/main/ipc/helpers/agent-spawn.ts),
 * the MCP, phone and reconcile auto-spawn path (#955). A new worktree's setup
 * script can run while the task's agent boots, and this path has to carry that
 * through its three phases:
 *
 *   - Phase 2 hands `ensureTaskWorktree` an `initScript` mode built by
 *     `resolveInitScriptMode`, and keeps the handle it returns;
 *   - Phase 3 passes that handle to `spawnAgent` as `earlyAgent`, and passes
 *     `setupStillRunning` when the script runs on in the background;
 *   - the `finally` discards the handle on every exit that does not reach the
 *     spawn (a gate that changed, a blocked checkout, an abort).
 *
 * Harness follows auto-spawn-for-task-guards.test.ts: the same module's
 * dependencies are mocked, `spawnAgent` itself is the real one, and its engine
 * is the mocked `TransitionEngine`. The mocked engine's `resumeSuspendedSession`
 * is where `spawnAgent`'s `startAgent` hands over `earlyAgent` (the last
 * argument) and the setup note (the seventh), so those calls are the seam that
 * shows what Phase 3 passed. `isWorktreeCreationInFlight` is mocked so a test
 * decides whether the script is still running; `setupStillRunningFor` is real.
 *
 * The real `spawnAgent` also discards a handle it was given, in its own
 * `finally`. The discard-count assertions therefore sit only on paths that never
 * reach it, where the single discard can only be `autoSpawnForTask`'s `finally`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { EarlyAgentHandle } from '../../src/main/transition-engine/early-agent';

const TASK_ID = 'task-1';
const LANE_ID = 'lane-agent';
const WORKTREE_PATH = '/mock/project/.kangentic/worktrees/1';
const SETUP_SCRIPT = 'pnpm install --frozen-lockfile';

const mockSwimlaneGetById = vi.fn();
const mockTaskGetById = vi.fn();
const mockEnsureTaskWorktree = vi.fn();
const mockEnsureTaskBranchCheckout = vi.fn(async (..._args: unknown[]): Promise<void> => {});
const mockNotifySpawnBlocked = vi.fn();
const mockIsWorktreeCreationInFlight = vi.fn((_worktreePath: string): boolean => false);

const mockExecuteTransition = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ outcomes: [], failures: [], startedAgent: false })),
);
const mockRunLegacySpawnAgent = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<void> => {}));
const mockResumeSuspendedSession = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<void> => {}));

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
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  notifySpawnBlocked: (...args: unknown[]) => mockNotifySpawnBlocked(...args),
}));
// A pass-through: this file is about what the phases pass along, not the lock.
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn(async (_taskId: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError: vi.fn() }));
// Partial: only the in-flight probe is controlled, so `setupStillRunningFor`
// (real) decides from what a test says about the registry.
vi.mock('../../src/main/git/worktree-creation-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/worktree-creation-registry')>();
  return {
    ...actual,
    isWorktreeCreationInFlight: (worktreePath: string) => mockIsWorktreeCreationInFlight(worktreePath),
  };
});

// Partial: no held messages for the task. The real claim reads the project
// database, which this file stubs as an empty object, and logs the failure.
vi.mock('../../src/main/held-messages/held-messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/held-messages/held-messages')>();
  return { ...actual, claimHeldMessages: () => null };
});

import { autoSpawnForTask } from '../../src/main/ipc/helpers/agent-spawn';
import { __resetSpawnProgressForTest } from '../../src/main/transition-engine/spawn-progress';
// The REAL registry, so a test can cancel the spawn the way a Pause does.
import { abortInFlightResume } from '../../src/main/ipc/handlers/session-resume-controllers';
import type { Swimlane } from '../../src/shared/types';

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Agent Column',
    auto_spawn: true,
    role: null,
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

/** A task row sitting in the agent column, with no worktree unless told otherwise. */
function makeTaskInLane(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: 'Early agent task',
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
    worktree_path: null,
    ...overrides,
  };
}

/** The project config a test wants `resolveInitScriptMode` and `setupStillRunningFor` to read. */
function makeContext(gitConfig: Record<string, unknown> = {}) {
  return {
    projectRepo: {
      getById: vi.fn(() => ({
        id: 'proj-1', name: 'Example', path: '/mock/project', default_agent: 'claude', default_model: null, default_effort: null,
      })),
    },
    boardConfigManager: { getBoardProfiles: vi.fn(() => []) },
    sessionManager: { findLiveSessionByTaskId: vi.fn(() => undefined) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'default' },
        git: gitConfig,
        mcpServer: { enabled: true },
      })),
    },
  } as never;
}

/** A project that holds the agent's prompt until the setup script exits. */
const HOLD_PROMPT_GIT = { initScript: SETUP_SCRIPT, holdPromptForInitScript: true };
/** A project that lets the agent start on its prompt while the script runs on. */
const BACKGROUND_GIT = { initScript: SETUP_SCRIPT, holdPromptForInitScript: false };

function makeHandle(): EarlyAgentHandle & { discard: Mock<() => Promise<void>> } {
  return {
    sessionId: 'early-session',
    taskId: TASK_ID,
    agentName: 'claude',
    agentSessionId: 'agent-session',
    command: 'claude',
    cwd: WORKTREE_PATH,
    launchKey: 'launch-key',
    launchedAt: 0,
    isSettled: () => false,
    markAdopted: () => true,
    discard: vi.fn(async () => {}),
  };
}

function startAutoSpawn(context: ReturnType<typeof makeContext>): Promise<void> {
  return autoSpawnForTask(context, 'proj-1', { id: TASK_ID, title: 'Early agent task' }, LANE_ID);
}

/** The arguments `spawnAgent`'s `startAgent` gave the engine on its one start. */
function resumeCallArguments(): unknown[] {
  expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
  return mockResumeSuspendedSession.mock.calls[0] as unknown[];
}

/** The spawn overrides argument, where `spawnAgent` puts `earlyAgent`. */
function spawnOverridesOf(callArguments: unknown[]): { earlyAgent?: unknown } {
  return callArguments[7] as { earlyAgent?: unknown };
}

/** The options `autoSpawnForTask` gave `ensureTaskWorktree` on its one call. */
function worktreeOptions(): { initScript?: { mode: string; launchAgent?: unknown } } {
  expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
  return mockEnsureTaskWorktree.mock.calls[0][4] as { initScript?: { mode: string; launchAgent?: unknown } };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSpawnProgressForTest();

  mockSwimlaneGetById.mockReset();
  mockSwimlaneGetById.mockReturnValue(makeLane());
  // A fresh row per read, so a test that mutates the Phase 1 row (as the real
  // ensureTaskWorktree does when it records a new worktree) leaves Phase 3's
  // re-read untouched.
  mockTaskGetById.mockReset();
  mockTaskGetById.mockImplementation(() => makeTaskInLane());
  mockEnsureTaskWorktree.mockReset();
  mockEnsureTaskWorktree.mockResolvedValue(null);
  mockEnsureTaskBranchCheckout.mockReset();
  mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
  mockIsWorktreeCreationInFlight.mockReset();
  mockIsWorktreeCreationInFlight.mockReturnValue(false);
  mockExecuteTransition.mockReset();
  mockExecuteTransition.mockResolvedValue({ outcomes: [], failures: [], startedAgent: false });
  mockResumeSuspendedSession.mockReset();
  mockResumeSuspendedSession.mockResolvedValue(undefined);
  mockRunLegacySpawnAgent.mockReset();
  mockRunLegacySpawnAgent.mockResolvedValue(undefined);
});

describe('autoSpawnForTask: the agent started during the worktree setup script', () => {
  it('hands the handle ensureTaskWorktree returned to the Phase 3 spawn as earlyAgent', async () => {
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockResolvedValue(handle);

    await startAutoSpawn(makeContext(HOLD_PROMPT_GIT));

    // Red if `earlyAgent: earlyAgent ?? undefined` is dropped from the spawnAgent
    // call, or if the ensureTaskWorktree result is no longer kept in `earlyAgent`:
    // the engine would then be offered no agent to adopt and would launch a
    // second one beside the early agent.
    const overrides = spawnOverridesOf(resumeCallArguments());
    expect(overrides.earlyAgent).toBe(handle);
  });

  it('passes no earlyAgent to the spawn when the worktree ensure launched none', async () => {
    mockEnsureTaskWorktree.mockResolvedValue(null);

    await startAutoSpawn(makeContext(HOLD_PROMPT_GIT));

    // Red if the null result is forwarded as-is instead of normalized to
    // undefined: the engine would receive `earlyAgent: null`.
    const overrides = spawnOverridesOf(resumeCallArguments());
    expect(overrides.earlyAgent).toBeUndefined();
  });

  it('discards the handle when a Phase 3 gate changed during the git phase', async () => {
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockResolvedValue(handle);
    // Phase 1 reads the task in its column, Phase 3 finds it has moved on: the
    // second readAutoSpawnGates returns null.
    mockTaskGetById
      .mockReturnValueOnce(makeTaskInLane())
      .mockReturnValueOnce(makeTaskInLane({ swimlane_id: 'lane-elsewhere' }));

    await startAutoSpawn(makeContext(HOLD_PROMPT_GIT));

    // The git phase finished and Phase 3 declined: no spawn, so the real
    // spawnAgent never ran and could not have discarded the handle itself.
    expect(mockEnsureTaskBranchCheckout).toHaveBeenCalledTimes(1);
    expect(mockExecuteTransition).not.toHaveBeenCalled();
    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    // Red if the `finally` loses `await earlyAgent?.discard()`: the hidden agent
    // would keep running behind a task that is no longer spawning it.
    expect(handle.discard).toHaveBeenCalledTimes(1);
  });

  it('discards the handle when the branch checkout fails, after telling the user', async () => {
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockResolvedValue(handle);
    mockEnsureTaskBranchCheckout.mockRejectedValue(new Error('fatal: another agent is running in that directory'));

    await startAutoSpawn(makeContext(HOLD_PROMPT_GIT));

    // The blocked-checkout branch is what returned.
    expect(mockNotifySpawnBlocked).toHaveBeenCalledTimes(1);
    expect(mockNotifySpawnBlocked.mock.calls[0][2]).toBe('checkout');
    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    // Red if the checkout failure return stops passing through the discarding
    // `finally` (a handle kept in a variable the early return never settles).
    expect(handle.discard).toHaveBeenCalledTimes(1);
  });

  it('discards the handle when the spawn is cancelled during the git phase', async () => {
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockResolvedValue(handle);
    // What a Pause, a reset or a newer Resume does while the checkout runs.
    mockEnsureTaskBranchCheckout.mockImplementation(async () => {
      abortInFlightResume(TASK_ID);
    });

    await expect(startAutoSpawn(makeContext(HOLD_PROMPT_GIT))).resolves.toBeUndefined();

    // Phase 3's throwIfAborted ended the spawn before any engine call.
    expect(mockExecuteTransition).not.toHaveBeenCalled();
    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    expect(mockNotifySpawnBlocked).not.toHaveBeenCalled();
    // Red if the abort path skips the `finally`: a cancelled spawn would leave
    // its early agent running with nothing to adopt it.
    expect(handle.discard).toHaveBeenCalledTimes(1);
  });
});

describe('autoSpawnForTask: the setup script mode handed to ensureTaskWorktree', () => {
  it('hands a hold-prompt mode with a launcher when the project holds the prompt for its script', async () => {
    await startAutoSpawn(makeContext(HOLD_PROMPT_GIT));

    // Red if `initScript: initScriptMode` is dropped from the ensureTaskWorktree
    // options: the script would then run before the agent, as it did before.
    const initScript = worktreeOptions().initScript;
    expect(initScript?.mode).toBe('hold-prompt');
    expect(typeof initScript?.launchAgent).toBe('function');
  });

  it('hands a background mode, with no launcher, when the project lets the script run on', async () => {
    await startAutoSpawn(makeContext(BACKGROUND_GIT));

    expect(worktreeOptions().initScript).toEqual({ mode: 'background' });
  });

  it('hands no mode when the project has no setup script', async () => {
    await startAutoSpawn(makeContext({ holdPromptForInitScript: true }));

    expect(worktreeOptions().initScript).toBeUndefined();
  });
});

describe('autoSpawnForTask: setupStillRunning reaches the Phase 3 spawn only for a script still running in a new worktree', () => {
  /** Records the worktree on the Phase 1 row, as the real ensureTaskWorktree does for a new one. */
  function recordNewWorktree(): void {
    mockEnsureTaskWorktree.mockImplementation(async (_context: unknown, worktreeTask: { worktree_path: string | null }) => {
      worktreeTask.worktree_path = WORKTREE_PATH;
      return null;
    });
  }

  it('passes a note naming the script when the task had no worktree, the prompt is not held, and the creation is in flight', async () => {
    recordNewWorktree();
    mockIsWorktreeCreationInFlight.mockReturnValue(true);

    await startAutoSpawn(makeContext(BACKGROUND_GIT));

    // Red if `setupStillRunning` is dropped from the spawnAgent call (the note
    // would be undefined), or if the created worktree is not the one asked about.
    expect(mockIsWorktreeCreationInFlight).toHaveBeenCalledWith(WORKTREE_PATH);
    const setupNote = resumeCallArguments()[6];
    expect(typeof setupNote).toBe('string');
    expect(setupNote).toEqual(expect.stringContaining(SETUP_SCRIPT));
  });

  it('passes no note when the task already had a worktree before the git phase', async () => {
    // The task came in with a worktree, so this ensure created none and no script
    // of this call's runs. The creation probe says "in flight" anyway, so only the
    // had-a-worktree check keeps the note away.
    mockTaskGetById.mockImplementation(() => makeTaskInLane({ worktree_path: WORKTREE_PATH }));
    mockIsWorktreeCreationInFlight.mockReturnValue(true);

    await startAutoSpawn(makeContext(BACKGROUND_GIT));

    // Red if the `hadWorktree ? null : fullTask.worktree_path` argument becomes
    // `fullTask.worktree_path`: the existing path would be probed and the agent
    // told a script is running that this spawn never started.
    expect(resumeCallArguments()[6]).toBeUndefined();
    expect(mockIsWorktreeCreationInFlight).not.toHaveBeenCalled();
  });

  it.each([
    ['the project holds the prompt for the script', HOLD_PROMPT_GIT, true],
    ['the project has no setup script', { holdPromptForInitScript: false }, true],
    ['the script already finished', BACKGROUND_GIT, false],
  ])('passes no note when %s', async (_reason, gitConfig, creationInFlight) => {
    recordNewWorktree();
    mockIsWorktreeCreationInFlight.mockReturnValue(creationInFlight);

    await startAutoSpawn(makeContext(gitConfig));

    // Red if the mode or the creation check stops gating the note (for example
    // a hardcoded background mode): a held-prompt or finished script would be
    // reported as still running in the background.
    expect(resumeCallArguments()[6]).toBeUndefined();
  });
});

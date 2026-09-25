/**
 * `autoSpawnForTask` (src/main/ipc/helpers/agent-spawn.ts) forwards its own
 * `explicitStart` option into the `spawnAgent({...})` call it makes once the
 * worktree and branch checkout succeed. `auto-spawn-for-task-guards.test.ts`
 * deliberately stops before that call: its `beforeEach` makes
 * `ensureTaskWorktree` throw and stubs `TransitionEngine` as an empty class,
 * so nothing there observes what `spawnAgent` was actually given.
 *
 * This file drives `autoSpawnForTask` all the way through a successful
 * worktree ensure and branch checkout, past `spawnAgent`'s own guards, to the
 * point where `spawnAgent` calls `engine.executeTransition(task, toLane,
 * 'enter', ...)`. That call is the observable seam: `spawnAgent`'s own
 * `!toLane.auto_spawn && !options.explicitStart` guard (line ~269 in
 * agent-spawn.ts) returns before ever reaching the engine, so the engine is
 * called only when the forwarded flag survived the trip from
 * `autoSpawnForTask`'s options into `spawnAgent`'s options.
 *
 * Red-green: deleting the `explicitStart: options.explicitStart,` line from
 * `autoSpawnForTask`'s `spawnAgent({...})` call reds the first test below,
 * because `autoSpawnForTask`'s own `auto_spawn` gate is lifted by the
 * `explicitStart: true` passed to IT, but `spawnAgent` then receives
 * `explicitStart: undefined` and returns before the engine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

const mockSwimlaneGetById = vi.fn();
const mockTaskGetById = vi.fn();
const mockFindLiveSessionByTaskId = vi.fn((): unknown => undefined);
const mockEnsureTaskWorktree = vi.fn();
const mockEnsureTaskBranchCheckout = vi.fn();
const mockNotifySpawnBlocked = vi.fn();

const mockExecuteTransition = vi.hoisted(() =>
  vi.fn(async () => ({ outcomes: [], failures: [], startedAgent: false })),
);
const mockRunLegacySpawnAgent = vi.hoisted(() => vi.fn(async () => {}));
const mockResumeSuspendedSession = vi.hoisted(() => vi.fn(async () => {}));

// The two modules agent-spawn.ts imports that drag in the heaviest transitive
// graph (SessionManager -> node-pty, every agent adapter), the same avoidance
// strategy auto-spawn-for-task-guards.test.ts uses. Unlike that file, this one
// gives TransitionEngine real (jest-fn) methods and agentRegistry a real
// adapter shape, because the point here is to observe what reaches the engine.
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
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn(async (_taskId: string, fn: () => Promise<void>) => fn()),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

import { autoSpawnForTask } from '../../src/main/ipc/helpers/agent-spawn';

const TASK_ID = 'task-explicit-forward';
const LANE_ID = 'lane-quiet';
const PROJECT_ID = 'proj-1';

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Quiet Column',
    role: null,
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'Restarted from the phone',
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
  } as Task;
}

const PROJECT_ROW = {
  id: PROJECT_ID,
  name: 'Example',
  path: '/mock/project',
  default_agent: 'claude',
  default_model: null,
  default_effort: null,
};

function makeContext() {
  return {
    projectRepo: { getById: vi.fn(() => PROJECT_ROW) },
    boardConfigManager: { getBoardProfiles: vi.fn(() => []) },
    sessionManager: { findLiveSessionByTaskId: (...args: unknown[]) => mockFindLiveSessionByTaskId(...args) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockFindLiveSessionByTaskId.mockReturnValue(undefined);
  mockEnsureTaskWorktree.mockResolvedValue(null);
  mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
  mockExecuteTransition.mockClear();
  mockExecuteTransition.mockImplementation(async () => ({ outcomes: [], failures: [], startedAgent: false }));
  mockRunLegacySpawnAgent.mockClear();
  mockResumeSuspendedSession.mockClear();
});

describe('autoSpawnForTask: forwards explicitStart into the spawnAgent call it makes', () => {
  it('reaches the engine on an auto_spawn-off column when explicitStart is set', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: false, role: null }));
    mockTaskGetById.mockReturnValue(makeTask());

    await autoSpawnForTask(
      makeContext(), PROJECT_ID, { id: TASK_ID, title: 'Restarted from the phone' }, LANE_ID,
      { explicitStart: true },
    );

    // Red on a deleted forward: autoSpawnForTask's own gate lifts (it reads
    // explicitStart directly off its own options), the worktree and checkout
    // both succeed, but spawnAgent then receives explicitStart: undefined and
    // returns before the engine, leaving this uncalled.
    expect(mockExecuteTransition).toHaveBeenCalledTimes(1);
    const [calledTask, calledLane, calledPhase] = mockExecuteTransition.mock.calls[0];
    expect(calledTask).toMatchObject({ id: TASK_ID });
    expect(calledLane).toMatchObject({ id: LANE_ID });
    expect(calledPhase).toBe('enter');
  });

  it('does not reach the engine on the same column without explicitStart', async () => {
    mockSwimlaneGetById.mockReturnValue(makeLane({ auto_spawn: false, role: null }));
    mockTaskGetById.mockReturnValue(makeTask({ title: 'Reconciled' }));

    await autoSpawnForTask(
      makeContext(), PROJECT_ID, { id: TASK_ID, title: 'Reconciled' }, LANE_ID, {},
    );

    // autoSpawnForTask's own auto_spawn gate returns first here, before the
    // worktree phase even starts - this is the automatic-caller control the
    // forward test above is contrasted against.
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
    expect(mockExecuteTransition).not.toHaveBeenCalled();
  });
});

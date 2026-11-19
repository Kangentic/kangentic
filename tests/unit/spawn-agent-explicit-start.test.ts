/**
 * `explicitStart` on `spawnAgent` (src/main/ipc/helpers/agent-spawn.ts): an
 * explicit user Start, today the phone's start-session verb, lifts exactly
 * two guards, the column's `auto_spawn` default and the manually-paused
 * check, because both exist to stop an AUTOMATIC spawn from overriding a
 * choice the user made. It is the bridge twin of the desktop's Resume button,
 * which starts a session whatever the column's default says and clears a
 * pause the same user set.
 *
 * Both pairs below are red-green against the pre-option code: without the
 * flag each guard still returns before the engine is touched, so the
 * automatic callers (create, promote, unarchive, reconcile) keep their
 * behavior; with it the enter automations run. The role gate is pinned as
 * NOT lifted: an explicit Start into To Do or Done still spawns nothing.
 *
 * Harness mirrors spawn-agent-lock-overrides.test.ts: the real spawnAgent
 * runs end to end with injected engine / repos / context mocks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));

const mockTrackEvent = vi.fn();
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));
const mockReportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => mockReportHandledError(...args),
}));

// The two holds `isLiftableIdlePause` reads besides the record: a paused
// workflow and a workflow recovery. Real by default (the task is in no
// workflow), switched on per test.
const idlePauseHolds = vi.hoisted(() => ({ workflowPaused: false, underRecovery: false }));
vi.mock('../../src/main/workflows/workflow-home', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-home')>();
  return {
    ...actual,
    workflowOfTask: (...args: Parameters<typeof actual.workflowOfTask>) => (
      idlePauseHolds.workflowPaused ? { state: 'paused' } : actual.workflowOfTask(...args)
    ),
  };
});
vi.mock('../../src/main/workflows/workflow-recovery-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-recovery-state')>();
  return {
    ...actual,
    isUnderWorkflowRecovery: (taskId: string) => idlePauseHolds.underRecovery || actual.isUnderWorkflowRecovery(taskId),
  };
});

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';
import { idlePauseLiftReporter } from '../../src/main/ipc/helpers/idle-pause-lift';

const TASK_ID = 'task-explicit-001';
const TO_LANE_ID = 'lane-quiet';
const PROJECT_ID = 'project-001';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: 'Do the thing',
    swimlane_id: TO_LANE_ID,
    position: 0,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    run_mode: 'column_settings',
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/my-task',
    branch_name: 'my-task',
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
  } as Task;
}

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: TO_LANE_ID,
    name: 'Quiet Column',
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
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Swimlane;
}

const PROJECT_ROW = {
  id: PROJECT_ID,
  name: 'Mock Project',
  path: '/mock/project',
  default_agent: 'claude',
  default_model: 'claude-opus-4-8',
  default_effort: 'xhigh',
};

function makeDeps(args: { latestSession: unknown; task: Task }) {
  const tasks = { getById: vi.fn(() => args.task), update: vi.fn() };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => args.latestSession),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => undefined),
  };
  const engine = {
    executeTransition: vi.fn(async () => ({ outcomes: [], failures: [], startedAgent: false })),
    runLegacySpawnAgent: vi.fn(async () => {}),
    resumeSuspendedSession: vi.fn(async () => {}),
  };
  const context = {
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => PROJECT_ROW) },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'auto' },
        git: { defaultBaseBranch: 'main' },
      })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined) },
  };
  return { tasks, sessionRepo, engine, context };
}

async function runSpawn(
  task: Task,
  toLane: Swimlane,
  deps: ReturnType<typeof makeDeps>,
  extraOptions: { explicitStart?: boolean; resumesEntry?: boolean; liftsIdlePause?: boolean; projectId?: string | undefined } = {},
) {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task,
    fromSwimlaneId: TO_LANE_ID,
    toLane,
    projectId: PROJECT_ID,
    projectPath: '/mock/project',
    ...extraOptions,
  });
}

const USER_PAUSED_RECORD = { id: 'rec-1', status: 'suspended', suspended_by: 'user', agent_session_id: 'agent-1' };
// Kangentic paused the agent while it waited on the user (low memory, the
// idle timeout). Held exactly like the user's own pause.
const AUTO_PAUSED_RECORD = { id: 'rec-1', status: 'suspended', suspended_by: 'auto', agent_session_id: 'agent-1' };
// A quit, a move or a settings restart. Holds nothing: the next move resumes it.
const SYSTEM_SUSPENDED_RECORD = { id: 'rec-1', status: 'suspended', suspended_by: 'system', agent_session_id: 'agent-1' };

describe('spawnAgent explicitStart: the auto_spawn default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still returns before the engine on an auto_spawn-off column without the flag', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: false }), deps);

    expect(deps.engine.executeTransition).not.toHaveBeenCalled();
    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('runs the column enter automations on an auto_spawn-off column with the flag', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: false }), deps, { explicitStart: true });

    // Red before the option existed: the guard returned first.
    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    // And the fallback start ran, since no automation row started an agent.
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });
});

describe('spawnAgent explicitStart: the manually-paused guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still skips a user-paused task without the flag (automatic callers never un-pause)', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: USER_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps);

    expect(deps.engine.executeTransition).not.toHaveBeenCalled();
    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('resumes a user-paused task with the flag, the same way the Resume button does', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: USER_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { explicitStart: true });

    // Red before the option existed: the pause guard returned first.
    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('skips a task Kangentic paused without the flag, as it does a user pause', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: AUTO_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps);

    expect(deps.engine.executeTransition).not.toHaveBeenCalled();
    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('resumes a task Kangentic paused with the flag', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: AUTO_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { explicitStart: true });

    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('starts a system-suspended task without the flag, since that suspend holds nothing', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: SYSTEM_SUSPENDED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps);

    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });
});

// #929. The user's Resume of an agent that was paused when its task entered
// this column (`resumeTaskSession`) does what that entry would have done.
describe('spawnAgent resumesEntry: a Resume after the task entered its column paused', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lifts the held-pause guard and runs only the enter rows that need the agent', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: USER_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { resumesEntry: true });

    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(deps.engine.executeTransition).toHaveBeenCalledWith(
      task, expect.anything(), 'enter', expect.objectContaining({ onlyRowsNeedingAgent: true }),
    );
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the column\'s auto_spawn default: a column that starts no agent starts none', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: USER_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: false }), deps, { resumesEntry: true });

    expect(deps.engine.executeTransition).not.toHaveBeenCalled();
    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('runs the whole enter group on an ordinary spawn', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: SYSTEM_SUSPENDED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps);

    expect(deps.engine.executeTransition).toHaveBeenCalledWith(
      task, expect.anything(), 'enter', expect.not.objectContaining({ onlyRowsNeedingAgent: true }),
    );
  });
});

// The owner's move of an idle-paused task (`handleTaskMove`, Priority 4) starts
// its agent as a move starts a running task's: the whole enter group, and only
// for an idle pause nothing else holds, asked again here under the task lock.
describe('spawnAgent liftsIdlePause: the owner moved an idle-paused task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idlePauseHolds.workflowPaused = false;
    idlePauseHolds.underRecovery = false;
  });

  it('starts the agent and runs the whole enter group for an idle pause', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: AUTO_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { liftsIdlePause: true });

    // Red before the option: the held-pause guard returned first.
    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(deps.engine.executeTransition).toHaveBeenCalledWith(
      task, expect.anything(), 'enter', expect.not.objectContaining({ onlyRowsNeedingAgent: true }),
    );
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  /**
   * The lift was declined under the lock. The move armed no enter rows of its
   * own, so spawnAgent runs the group once with the agent paused, as the move's
   * held branch would have, and starts nothing.
   */
  function expectHeldWithEnterRowsRun(deps: ReturnType<typeof makeDeps>, task: Task): void {
    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(deps.engine.executeTransition).toHaveBeenCalledWith(
      task, expect.anything(), 'enter', expect.objectContaining({ agentPaused: true }),
    );
    expect(deps.engine.executeTransition).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'enter', expect.objectContaining({ startAgent: expect.anything() }),
    );
    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  }

  it.each([
    ['the user\'s Pause', USER_PAUSED_RECORD],
    ['an earlier version\'s low-memory pause', { ...AUTO_PAUSED_RECORD, suspended_by: 'low_memory' }],
    ['an idle pause whose start never reached an agent', { ...AUTO_PAUSED_RECORD, launch_failed_at: '2026-11-19T00:00:00.000Z' }],
  ])('keeps %s held', async (_label, record) => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: record, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { liftsIdlePause: true });

    expectHeldWithEnterRowsRun(deps, task);
  });

  it('keeps an idle pause held in a paused workflow', async () => {
    idlePauseHolds.workflowPaused = true;
    const task = makeTask({ workflow_id: 'workflow-1' } as Partial<Task>);
    const deps = makeDeps({ latestSession: AUTO_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { liftsIdlePause: true });

    expectHeldWithEnterRowsRun(deps, task);
  });

  it('keeps an idle pause held while a workflow recovery owns the next start', async () => {
    idlePauseHolds.underRecovery = true;
    const task = makeTask();
    const deps = makeDeps({ latestSession: AUTO_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { liftsIdlePause: true });

    expectHeldWithEnterRowsRun(deps, task);
  });

  it('keeps an idle pause held when no projectId was given to re-ask the lift with', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: AUTO_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { liftsIdlePause: true, projectId: undefined });

    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(deps.engine.executeTransition).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'enter', expect.objectContaining({ startAgent: expect.anything() }),
    );
  });

  it('resolves, and reports the failure, when the enter rows of a declined lift fail', async () => {
    idlePauseLiftReporter.reset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = makeTask();
    const deps = makeDeps({ latestSession: USER_PAUSED_RECORD, task });
    deps.engine.executeTransition.mockRejectedValueOnce(new RangeError('enter list failed'));

    await expect(
      runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { liftsIdlePause: true }),
    ).resolves.toBeUndefined();

    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(mockReportHandledError).toHaveBeenCalledTimes(1);
    const [reportedError, reportedTags] = mockReportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(reportedError.message).toBe('Handled idle_pause_lift failure: RangeError');
    expect(reportedTags).toMatchObject({ source: 'idle_pause_lift' });
  });

  it('rejects when the enter rows of a declined lift are aborted, and reports nothing', async () => {
    idlePauseLiftReporter.reset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = makeTask();
    const deps = makeDeps({ latestSession: USER_PAUSED_RECORD, task });
    const abortError = new DOMException('The move was superseded', 'AbortError');
    deps.engine.executeTransition.mockRejectedValueOnce(abortError);

    await expect(
      runSpawn(task, makeSwimlane({ auto_spawn: true }), deps, { liftsIdlePause: true }),
    ).rejects.toBe(abortError);

    expect(mockReportHandledError).not.toHaveBeenCalled();
  });

  it('runs no enter rows for a held pause when the move did not ask to lift it', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: AUTO_PAUSED_RECORD, task });

    await runSpawn(task, makeSwimlane({ auto_spawn: true }), deps);

    // The move's own held branch ran them; a second run here would double them.
    expect(deps.engine.executeTransition).not.toHaveBeenCalled();
  });
});

describe('spawnAgent explicitStart: the role gate is not lifted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([['todo'], ['done']] as const)('spawns nothing into a %s column even with the flag', async (role) => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeSwimlane({ role, auto_spawn: true }), deps, { explicitStart: true });

    expect(deps.engine.executeTransition).not.toHaveBeenCalled();
    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });
});

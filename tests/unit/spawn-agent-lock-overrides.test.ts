/**
 * Tests for the "lock Advanced overrides on first spawn" behavior in
 * `spawnAgent` -> `runSpawnPreamble` / `lockAdvancedOverridesOnFirstSpawn`
 * (src/main/transition-engine/spawn-preamble.ts, wired in
 * src/main/ipc/helpers/agent-spawn.ts).
 *
 * A task that already carries at least one explicit Agent/Model/Effort/
 * Permission override but leaves the others on "inherit" gets ALL FOUR
 * fields locked, the moment it spawns for the very first time ever, to the
 * values the Advanced tab displayed when the user configured it: task
 * override -> the lane the task lived in at config time (the settings lane;
 * a drag move passes the SOURCE lane) -> project default / global permission
 * mode. The DESTINATION column's settings never leak into the locked
 * contract. A task with NO overrides at all is untouched.
 *
 * Harness mirrors spawn-agent-continuation-prompt.test.ts: the real
 * spawnAgent runs end to end with injected engine/repos/context mocks. The
 * REAL agent resolver runs too (deliberately unmocked), so these tests also
 * pin the preamble's ordering contract: the lock runs BEFORE agent
 * resolution, and the resolved agent is what reaches the engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';

const TASK_ID = 'task-lock-001';
const TO_LANE_ID = 'lane-executing';
const FROM_LANE_ID = 'lane-todo';
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
    name: 'Executing',
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

/**
 * The destination column deliberately differs from the project defaults in
 * EVERY field, so any leak of destination settings into the locked values is
 * caught by every test below.
 */
function makeDestinationLane(): Swimlane {
  return makeSwimlane({
    agent_override: null,
    model_override: 'sonnet-5',
    effort_override: 'high',
    permission_mode: 'acceptEdits',
  });
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
  const update = vi.fn();
  const getById = vi.fn(() => args.task);
  const tasks = { getById, update };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => args.latestSession),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => undefined),
  };
  const engine = {
    executeTransition: vi.fn(async () => {}),
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
    // resolveDefaultBaseBranch (git-stats-capture.ts) reads this for the
    // team-shared board default; undefined falls through to the git config
    // default above, matching resolveAutoCommandVars in agent-spawn.ts. No
    // fixture here sets a truthy auto_command today, but every real spawnAgent
    // context carries this shape - keep the mock honest.
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined) },
  };
  return { tasks, sessionRepo, engine, context };
}

async function runSpawn(
  task: Task,
  toLane: Swimlane,
  deps: ReturnType<typeof makeDeps>,
  settingsSourceLane?: Swimlane | null,
  extraOptions: { skipPromptTemplate?: boolean; suppressAutoCommand?: boolean } = {},
) {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task,
    fromSwimlaneId: FROM_LANE_ID,
    toLane,
    projectId: PROJECT_ID,
    projectPath: '/mock/project',
    ...(settingsSourceLane !== undefined ? { settingsSourceLane } : {}),
    ...extraOptions,
  });
}

describe('spawnAgent lock-Advanced-overrides-on-first-spawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks ALL FOUR fields to the settings-lane/project/global chain, never the destination column', async () => {
    const task = makeTask({ model_override: 'fable-5' });
    // Drag move: the source lane (To Do) has no overrides of its own, so the
    // dialog displayed project defaults + the global permission mode.
    const sourceLane = makeSwimlane({ id: FROM_LANE_ID, name: 'To Do', role: 'todo', auto_spawn: false });
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeDestinationLane(), deps, sourceLane);

    expect(deps.tasks.update).toHaveBeenCalledWith({
      id: TASK_ID,
      agent_override: 'claude',
      model_override: 'fable-5',
      effort_override: 'xhigh',
      permission_mode: 'auto',
    });
    // The in-memory task is updated too, so the spawn already in flight
    // resolves against the locked values (not the destination column's).
    expect(task.effort_override).toBe('xhigh');
    expect(task.permission_mode).toBe('auto');
  });

  it('resolves inherited fields against the settings lane when it has its own overrides', async () => {
    const task = makeTask({ model_override: 'fable-5' });
    const sourceLane = makeSwimlane({
      id: FROM_LANE_ID,
      name: 'Staging',
      effort_override: 'low',
      permission_mode: 'plan',
    });
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeDestinationLane(), deps, sourceLane);

    expect(deps.tasks.update).toHaveBeenCalledWith({
      id: TASK_ID,
      agent_override: 'claude',
      model_override: 'fable-5',
      effort_override: 'low',
      permission_mode: 'plan',
    });
  });

  it('falls back to the destination lane as settings lane when settingsSourceLane is omitted (creation/promotion into a spawn column)', async () => {
    const task = makeTask({ model_override: 'fable-5' });
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeDestinationLane(), deps);

    expect(deps.tasks.update).toHaveBeenCalledWith({
      id: TASK_ID,
      agent_override: 'claude',
      model_override: 'fable-5',
      effort_override: 'high',
      permission_mode: 'acceptEdits',
    });
  });

  it('falls back to project/global defaults when the settings lane is null (source lane no longer resolves)', async () => {
    const task = makeTask({ effort_override: 'max' });
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeDestinationLane(), deps, null);

    expect(deps.tasks.update).toHaveBeenCalledWith({
      id: TASK_ID,
      agent_override: 'claude',
      model_override: 'claude-opus-4-8',
      effort_override: 'max',
      permission_mode: 'auto',
    });
  });

  it('a permission-only pin also triggers the lock', async () => {
    const task = makeTask({ permission_mode: 'plan' });
    const sourceLane = makeSwimlane({ id: FROM_LANE_ID, name: 'To Do', role: 'todo', auto_spawn: false });
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeDestinationLane(), deps, sourceLane);

    expect(deps.tasks.update).toHaveBeenCalledWith({
      id: TASK_ID,
      agent_override: 'claude',
      model_override: 'claude-opus-4-8',
      effort_override: 'xhigh',
      permission_mode: 'plan',
    });
  });

  it('does not lock anything on first ever spawn when no override is set', async () => {
    const task = makeTask();
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeDestinationLane(), deps, makeSwimlane({ id: FROM_LANE_ID, role: 'todo' }));

    expect(deps.tasks.update).not.toHaveBeenCalled();
  });

  it('does not re-lock a task reset to To Do and redragged (task.agent survives the reset)', async () => {
    // No session record (wiped by the To-Do reset), but task.agent is still
    // set from its original first spawn - this must NOT be mistaken for a
    // fresh first-ever spawn.
    const task = makeTask({ agent: 'claude', model_override: 'fable-5' });
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, makeDestinationLane(), deps, makeSwimlane({ id: FROM_LANE_ID, role: 'todo' }));

    expect(deps.tasks.update).not.toHaveBeenCalled();
  });

  it('locks then resolves: a conflicting destination agent_override loses to the just-locked settings-lane agent', async () => {
    // The settings lane pins codex; the destination column says claude. The
    // lock must persist codex (settings lane, the values the dialog showed)
    // AND the spawn must actually run codex - the lock runs BEFORE agent
    // resolution, so the just-locked task.agent_override wins over the
    // destination column's agent_override. This is the create-path divergence
    // bug shape: a locked agent that never reaches the engine.
    const task = makeTask({ model_override: 'fable-5' });
    const sourceLane = makeSwimlane({ id: FROM_LANE_ID, name: 'Staging', agent_override: 'codex' });
    const destinationLane = makeSwimlane({ agent_override: 'claude' });
    const deps = makeDeps({ latestSession: undefined, task });

    await runSpawn(task, destinationLane, deps, sourceLane);

    expect(deps.tasks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID, agent_override: 'codex' }),
    );
    // The resolved agent reaches the engine on BOTH legs: the transition
    // (agentOverride is the 7th argument) and the fallback resume (6th).
    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(deps.engine.executeTransition.mock.calls[0][6]).toBe('codex');
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(deps.engine.resumeSuspendedSession.mock.calls[0][5]).toBe('codex');
  });

  it('previously-spawned unarchive shape: no re-lock, and the resume keeps the task agent', async () => {
    // The unarchive handlers route through spawnAgent with skipPromptTemplate
    // + suppressAutoCommand. For a task that already spawned (session record
    // in hand, task.agent set), the lock must no-op and the resolved agent
    // must stay the task's agent - an unarchive never silently flips agents.
    const task = makeTask({ agent: 'claude', model_override: 'fable-5' });
    const suspendedRecord = { status: 'suspended', suspended_by: null };
    const deps = makeDeps({ latestSession: suspendedRecord, task });

    await runSpawn(task, makeDestinationLane(), deps, undefined, {
      skipPromptTemplate: true,
      suppressAutoCommand: true,
    });

    expect(deps.tasks.update).not.toHaveBeenCalled();
    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(deps.engine.executeTransition.mock.calls[0][6]).toBe('claude');
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(deps.engine.resumeSuspendedSession.mock.calls[0][5]).toBe('claude');
  });
});

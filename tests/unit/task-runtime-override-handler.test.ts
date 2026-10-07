/**
 * Unit tests for the TASK_SET_RUNTIME_OVERRIDE IPC handler.
 *
 * Pattern mirrors task-create-handler.test.ts: capture the function
 * registered with ipcMain.handle and invoke it directly with mocked
 * dependencies. The real `task-lifecycle-lock` is used so withTaskLock
 * semantics are observable.
 *
 * Covers the two apply paths plus the recovery contract:
 *   - `persisted`: task has no live session, or nothing changed to a concrete value
 *   - `restart`: a model or effort change to a concrete value -> shared
 *     restartSessionForSettingsChange helper. Nothing is ever typed into the
 *     PTY, whatever the adapter's getInjectionSequence would offer.
 *   - `ok: false` (pre-persist): unknown agent on a task with a session
 *   - `ok: false` (post-persist): restartSessionForSettingsChange returns ok:false
 *     but the override IS persisted so the existing Resume UI affordance can retry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

const hoisted = vi.hoisted(() => ({
  updateAppliedSettings: vi.fn(),
  restartSessionForSettingsChange: vi.fn(async () => ({ ok: true })),
  /** When set, the reconcile mock treats the task's pointer as a dead session. */
  stalePointer: { value: false },
  /**
   * The live session's own record, read for `applied_effort`. Null by default:
   * no record, so the pick's effort source is the agent's report or nothing.
   */
  sessionRecord: { value: null as { id: string; applied_model?: string | null; applied_effort: string | null } | null },
  /**
   * The task's newest record, which `getLatestForTask` serves. Null by default,
   * in which case it serves `sessionRecord` too (one record, one track). Set it
   * to model a task whose newest record belongs to ANOTHER track (an isolated
   * swimlane's), so a read that skips the live session's own record goes wrong.
   */
  latestRecord: { value: null as { id: string; applied_model?: string | null; applied_effort: string | null } | null },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    updateAppliedSettings = hoisted.updateAppliedSettings;
    findByAnyId = vi.fn((id: string) => (hoisted.sessionRecord.value?.id === id ? hoisted.sessionRecord.value : undefined));
    getLatestForTask = vi.fn(() => hoisted.latestRecord.value ?? hoisted.sessionRecord.value ?? undefined);
  },
}));

// getProjectRepos is used by the handler directly (to read task + swimlane),
// plus it is called internally by restartSessionForSettingsChange (which we mock
// away). The mock only needs to cover the handler's own usage.
const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
}));

// restartSessionForSettingsChange is the shared helper the handler delegates
// all suspend+respawn work to. We test it in isolation in a dedicated file.
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  restartSessionForSettingsChange: (...args: unknown[]) =>
    hoisted.restartSessionForSettingsChange(...args),
  // The handler reconciles task.session_id against the registry before it
  // acts. These fixtures set `session_id` only when the session is live, so a
  // set pointer IS the live session here.
  reconcileTaskSessionRef: (_context: unknown, _projectId: string, taskId: string) => {
    const repos = mockGetProjectRepos() as { tasks: { getById: (id: string) => MockTask | null; update?: (patch: unknown) => void } };
    const task = repos.tasks.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (hoisted.stalePointer.value && task.session_id) {
      // What the real reconcile does for a pointer at an exited row.
      repos.tasks.update?.({ id: taskId, session_id: null });
      return { task: { ...task, session_id: null }, liveSession: null };
    }
    return {
      task,
      liveSession: task.session_id ? { id: task.session_id, taskId, status: 'running' } : null,
    };
  },
}));

const mockAgentRegistryGet = vi.fn();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (name: string) => mockAgentRegistryGet(name),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTaskRuntimeOverrideHandlers } from '../../src/main/ipc/handlers/task-runtime-override';
import { IPC } from '../../src/shared/ipc-channels';
import type { TaskSetRuntimeOverrideInput, TaskSetRuntimeOverrideResult } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockTask {
  id: string;
  agent: string | null;
  agent_override?: string | null;
  swimlane_id: string;
  session_id: string | null;
  model_override: string | null;
  effort_override: string | null;
  profile_id?: string | null;
}

interface MockContext {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  sessionManager: {
    suspend: ReturnType<typeof vi.fn>;
    getSessionAgentName: ReturnType<typeof vi.fn>;
    getUsageCache: ReturnType<typeof vi.fn>;
    getFirstReportedEffort: ReturnType<typeof vi.fn>;
  };
  terminalSubmitScheduler: { scheduleKeystrokes: ReturnType<typeof vi.fn> };
  projectRepo: { getById: ReturnType<typeof vi.fn> };
  boardConfigManager: { getBoardProfiles: ReturnType<typeof vi.fn> };
}

function createMockTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task-1',
    agent: 'claude',
    swimlane_id: 'lane-1',
    session_id: 'session-1',
    model_override: null,
    effort_override: null,
    ...overrides,
  };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    sessionManager: {
      suspend: vi.fn(async () => {}),
      getSessionAgentName: vi.fn(() => undefined),
      // Empty by default: the agent reports no effort, so the pick's effort
      // source falls back to the session record.
      getUsageCache: vi.fn((): Record<string, unknown> => ({})),
      getFirstReportedEffort: vi.fn((): string | null => null),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', default_agent: 'claude', default_model: null, default_effort: null })) },
    boardConfigManager: { getBoardProfiles: vi.fn(() => []) },
    ...overrides,
  };
}

async function callHandler(input: TaskSetRuntimeOverrideInput): Promise<TaskSetRuntimeOverrideResult> {
  const handler = capturedHandlers.get(IPC.TASK_SET_RUNTIME_OVERRIDE);
  if (!handler) throw new Error(`Handler for ${IPC.TASK_SET_RUNTIME_OVERRIDE} was not registered`);
  return handler(null, input) as Promise<TaskSetRuntimeOverrideResult>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TASK_SET_RUNTIME_OVERRIDE handler', () => {
  let context: MockContext;
  let task: MockTask;
  let taskRepo: { getById: ReturnType<typeof vi.fn>; updateOverrides: ReturnType<typeof vi.fn> };
  let swimlaneRepo: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.updateAppliedSettings.mockReset();
    hoisted.restartSessionForSettingsChange.mockReset();
    hoisted.restartSessionForSettingsChange.mockResolvedValue({ ok: true });
    hoisted.sessionRecord.value = null;
    hoisted.latestRecord.value = null;
    capturedHandlers.clear();

    task = createMockTask();
    taskRepo = {
      getById: vi.fn((_id: string) => task),
      // Writes through to the fixture: the apply step re-reads the task after
      // the persist, so its targets come from the written pins.
      updateOverrides: vi.fn((_id: string, patch: Partial<MockTask>) => {
        Object.assign(task, patch);
      }),
      // Written by the reconcile mock when it clears a stale pointer.
      update: vi.fn(),
    };
    swimlaneRepo = {
      getById: vi.fn(() => ({
        id: 'lane-1',
        permission_mode: null,
        model_override: null,
        effort_override: null,
      })),
    };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: {},
      attachments: {},
    });

    context = createMockContext();
    registerTaskRuntimeOverrideHandlers(context as never);
  });

  // =========================================================================
  // Pre-persist failures: rollback is correct on the renderer side
  // =========================================================================

  it('returns ok:false when no project is open (no DB write)', async () => {
    context = createMockContext({ currentProjectId: null });
    capturedHandlers.clear();
    registerTaskRuntimeOverrideHandlers(context as never);

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: false, reason: 'no project is currently open' });
    expect(taskRepo.updateOverrides).not.toHaveBeenCalled();
  });

  it('returns ok:false when task is not found (no DB write)', async () => {
    taskRepo.getById.mockReturnValue(null);
    const result = await callHandler({ taskId: 'task-missing', model: 'sonnet' });
    expect(result).toEqual({ ok: false, reason: 'task not found' });
    expect(taskRepo.updateOverrides).not.toHaveBeenCalled();
  });

  it('returns ok:false BEFORE persist when agent is unknown on a live session', async () => {
    task = createMockTask({ agent: 'made-up-agent', session_id: 'sess-x' });
    taskRepo.getById.mockReturnValue(task);
    mockAgentRegistryGet.mockReturnValue(undefined);

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: false, reason: 'unknown agent "made-up-agent"' });
    expect(taskRepo.updateOverrides).not.toHaveBeenCalled();
  });

  it('resolves the adapter from the live session when task.agent is null (default-agent task)', async () => {
    // Default-agent tasks never write the project default into `task.agent`.
    // The handler must fall back to the live session's registry agent name so
    // the override applies instead of being rejected with "unknown agent".
    task = createMockTask({ agent: null });
    taskRepo.getById.mockReturnValue(task);
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    const getInjectionSequence = vi.fn(() => ['/effort high']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', effort: 'high' });

    expect(result).toEqual({ ok: true, mode: 'restart' });
    expect(context.sessionManager.getSessionAgentName).toHaveBeenCalledWith('session-1');
    expect(mockAgentRegistryGet).toHaveBeenCalledWith('claude');
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
      { phase: 'applying-settings' },
    );
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('returns unknown agent when task.agent is null and the live session has no tracked agent', async () => {
    task = createMockTask({ agent: null });
    taskRepo.getById.mockReturnValue(task);
    context.sessionManager.getSessionAgentName.mockReturnValue(undefined);

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: false, reason: 'unknown agent "(none)"' });
    expect(taskRepo.updateOverrides).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Happy paths
  // =========================================================================

  it('returns mode:"persisted" with the DB write when the task has no live session', async () => {
    task = createMockTask({ session_id: null });
    taskRepo.getById.mockReturnValue(task);

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: true, mode: 'persisted' });
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: 'sonnet',
      effort_override: null,
    });
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('returns mode:"persisted" when the task\'s pointer names a session that is no longer live (#682 follow-up)', async () => {
    // The pointer outlives a CLI that ended by itself. On the raw pointer a
    // model pick restarted a dead session and an effort pick scheduled
    // keystrokes into a PTY that was gone; the reconcile clears it first, so
    // both land here with the override saved for the next spawn.
    hoisted.stalePointer.value = true;
    try {
      task = createMockTask({ session_id: 'dead-session' });
      taskRepo.getById.mockReturnValue(task);
      mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => ['/model sonnet']) });

      const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(taskRepo.update).toHaveBeenCalledWith({ id: 'task-1', session_id: null });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
      expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    } finally {
      hoisted.stalePointer.value = false;
    }
  });

  it('returns mode:"persisted" without further work when the spec is a no-op delta', async () => {
    // Task already has model_override='sonnet' and its session launched with
    // it; user picks 'sonnet' again.
    task = createMockTask({ model_override: 'sonnet' });
    taskRepo.getById.mockReturnValue(task);
    hoisted.sessionRecord.value = { id: 'session-1', applied_model: 'sonnet', applied_effort: null };
    mockAgentRegistryGet.mockReturnValue({
      getInjectionSequence: vi.fn(() => ['/model sonnet']),
    });

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: true, mode: 'persisted' });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
  });

  it('MODEL change returns mode:"restart" and calls restartSessionForSettingsChange (never live-swaps)', async () => {
    // A model change ALWAYS restarts (suspend + --resume --model X), never emits
    // a live /model swap. restartSessionForSettingsChange is the shared helper.
    const getInjectionSequence = vi.fn(() => ['/model sonnet']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });

    expect(result).toEqual({ ok: true, mode: 'restart' });
    // The helper is called with the correct project coordinates.
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
      { phase: 'switching-model' },
    );
    // Live slash injection must NOT fire on a model restart, and the handler
    // never asks the adapter for one.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(getInjectionSequence).not.toHaveBeenCalled();
  });

  it('EFFORT-only change restarts with applying-settings even when the adapter offers a live slash', async () => {
    // The adapter would emit `/effort high` (Claude does), but a task session
    // never types it: a mid-turn `/effort` writes nothing the verifier can
    // confirm. The pick restarts the session with `--effort high` instead.
    const getInjectionSequence = vi.fn(() => ['/effort high']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', effort: 'high' });

    expect(result).toEqual({ ok: true, mode: 'restart' });
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
      { phase: 'applying-settings' },
    );
    expect(getInjectionSequence).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    // The respawn records `applied_effort` from its own flag.
    expect(hoisted.updateAppliedSettings).not.toHaveBeenCalled();
  });

  it('EFFORT cleared to "use column default" with nothing below it stays persisted (no restart)', async () => {
    // Task pinned 'high'; the column and project set no effort. Clearing the pin
    // makes the effective effort null: there is no `--effort` to apply, and
    // `--resume` keeps whatever the session runs at, so restarting would churn
    // the PTY for nothing.
    task = createMockTask({ effort_override: 'high' });
    taskRepo.getById.mockReturnValue(task);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });

    const result = await callHandler({ taskId: 'task-1', effort: null });

    expect(result).toEqual({ ok: true, mode: 'persisted' });
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: null,
      effort_override: null,
    });
  });

  it('EFFORT cleared to "use column default" restarts when the column sets a different effort', async () => {
    // Task pinned 'high'; the column sets 'low'. Clearing the pin moves the
    // effective effort high -> low, a concrete change.
    task = createMockTask({ effort_override: 'high' });
    taskRepo.getById.mockReturnValue(task);
    swimlaneRepo.getById.mockReturnValue({
      id: 'lane-1',
      permission_mode: null,
      model_override: null,
      effort_override: 'low',
    });
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => ['/effort low']) });

    const result = await callHandler({ taskId: 'task-1', effort: null });

    expect(result).toEqual({ ok: true, mode: 'restart' });
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
      { phase: 'applying-settings' },
    );
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('"Use column default" resolves through to the swimlane override and RESTARTS (concrete model target)', async () => {
    // task pinned 'sonnet', swimlane 'opus', input.model=null -> effective model
    // sonnet->opus is a CONCRETE model change -> must restart (not live-inject).
    task = createMockTask({ model_override: 'sonnet' });
    taskRepo.getById.mockReturnValue(task);
    swimlaneRepo.getById.mockReturnValue({
      id: 'lane-1',
      permission_mode: null,
      model_override: 'opus',
      effort_override: null,
    });
    const getInjectionSequence = vi.fn((spec: { modelChanged: boolean; model: string | null }) => {
      const out: string[] = [];
      if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
      return out;
    });
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', model: null });

    expect(result).toEqual({ ok: true, mode: 'restart' });
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
      { phase: 'switching-model' },
    );
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    // The cleared override (null) is persisted, not the resolved effective value.
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: null,
      effort_override: null,
    });
  });

  it('"Use column default" with no swimlane override stays as mode:"persisted" (no concrete target)', async () => {
    // Clearing a per-task override on a column that has no model override of its
    // own: new effective model is null. A null target is not a real change (no
    // --model flag to set) so restarting would churn the PTY for nothing.
    task = createMockTask({ model_override: 'sonnet' });
    taskRepo.getById.mockReturnValue(task);
    swimlaneRepo.getById.mockReturnValue({
      id: 'lane-1',
      permission_mode: null,
      model_override: null,
      effort_override: null,
    });
    const getInjectionSequence = vi.fn((spec: { modelChanged: boolean; model: string | null }) => {
      const out: string[] = [];
      if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
      return out;
    });
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', model: null });

    expect(result).toEqual({ ok: true, mode: 'persisted' });
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: null,
      effort_override: null,
    });
  });

  describe('project default model tier', () => {
    // The project's default model applies only to a task running the project's
    // default agent, the same gate `resolveSpawnOverrides` applies at respawn.
    function useProjectDefaultModel(): void {
      context.projectRepo.getById.mockReturnValue({
        id: 'proj-1',
        default_agent: 'claude',
        default_model: 'opus',
        default_effort: null,
      });
      mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });
    }

    it('clearing a pin on a task running a DIFFERENT agent than the project default stays persisted', async () => {
      // Without the gate, 'gpt-5' -> null read as gpt-5 -> 'opus' (the project
      // default) and restarted for a model the respawn never passes.
      useProjectDefaultModel();
      task = createMockTask({ agent_override: 'codex', model_override: 'gpt-5' });
      taskRepo.getById.mockReturnValue(task);

      const result = await callHandler({ taskId: 'task-1', model: null });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
      expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
        model_override: null,
        effort_override: null,
      });
    });

    it('clearing a pin on a task running the project default agent restarts onto the project default', async () => {
      useProjectDefaultModel();
      task = createMockTask({ agent_override: null, model_override: 'gpt-5' });
      taskRepo.getById.mockReturnValue(task);

      const result = await callHandler({ taskId: 'task-1', model: null });

      expect(result).toEqual({ ok: true, mode: 'restart' });
      expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
        expect.anything(),
        'proj-1',
        '/mock/project',
        'task-1',
        { phase: 'switching-model' },
      );
    });
  });

  it('clearing one field when the other needs restart does restart (model change)', async () => {
    // codex, model 'gpt-5', effort null: model is concrete so restart fires.
    task = createMockTask({ agent: 'codex', model_override: null, effort_override: 'high' });
    taskRepo.getById.mockReturnValue(task);
    swimlaneRepo.getById.mockReturnValue({
      id: 'lane-1',
      permission_mode: null,
      model_override: null,
      effort_override: null,
    });
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });

    const result = await callHandler({ taskId: 'task-1', model: 'gpt-5', effort: null });

    expect(result).toEqual({ ok: true, mode: 'restart' });
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
      { phase: 'switching-model' },
    );
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('restarts on a model change whatever the adapter offers', async () => {
    // Codex-style adapter: getInjectionSequence returns [] but model changed ->
    // restartSessionForSettingsChange is called. The detailed suspend/respawn
    // mechanics are tested in restart-session-for-settings-change.test.ts.
    const getInjectionSequence = vi.fn(() => []);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', model: 'gpt-5' });
    expect(result).toEqual({ ok: true, mode: 'restart' });

    // DB persist happened before the restart.
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: 'gpt-5',
      effort_override: null,
    });
    // Delegate to the shared helper; do NOT call suspend/engine directly.
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
      { phase: 'switching-model' },
    );
    // Nothing is typed into the session on the restart path.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('EFFORT change to a concrete target on an adapter with no live slash takes the RESTART path', async () => {
    // The adapter's capability does not matter any more (every effort change
    // restarts), but an agent with no live `/effort` must still reach the
    // restart rather than the persisted path. The task starts with no effort
    // override (null) and the swimlane also has no override, so
    // newEffectiveEffort comes from the input (`'xhigh'`).
    task = createMockTask({ model_override: null, effort_override: null });
    taskRepo.getById.mockReturnValue(task);
    swimlaneRepo.getById.mockReturnValue({
      id: 'lane-1',
      permission_mode: null,
      model_override: null,
      effort_override: null,
    });
    // Adapter that has no live-switch slash for effort changes.
    const getInjectionSequence = vi.fn(() => []);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', effort: 'xhigh' });

    // The handler must return mode:'restart', not mode:'persisted'.
    expect(result).toEqual({ ok: true, mode: 'restart' });

    // restartSessionForSettingsChange must have been called with the correct
    // project context - this is the key assertion the gap was about. An
    // effort-only restart labels itself as a settings change, not a model
    // switch.
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
      { phase: 'applying-settings' },
    );

    // Live slash injection must NOT fire.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();

    // The DB persist must have happened first (override captured before PTY action).
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: null,
      effort_override: 'xhigh',
    });
  });

  // =========================================================================
  // Effort source: what the session runs at, not the task's old config
  // =========================================================================

  describe('effort source', () => {
    /** The agent reports `live` now and reported `first` right after launch. */
    function reportEffort(live: string, first: string): void {
      context.sessionManager.getUsageCache.mockReturnValue({
        'session-1': { model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort: live } },
      });
      context.sessionManager.getFirstReportedEffort.mockImplementation(
        (sessionId: string) => (sessionId === 'session-1' ? first : null),
      );
    }

    function useLaneEffort(effort: string | null): void {
      swimlaneRepo.getById.mockReturnValue({
        id: 'lane-1',
        permission_mode: null,
        model_override: null,
        effort_override: effort,
      });
    }

    beforeEach(() => {
      mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });
    });

    it('a pick equal to an effort the user set by hand with /effort persists without a restart', async () => {
      // Launched at the column's `high`, then the user typed `/effort medium`.
      // The old diff read high -> medium off the config and restarted a
      // session already running at medium.
      useLaneEffort('high');
      hoisted.sessionRecord.value = { id: 'session-1', applied_effort: 'high' };
      reportEffort('medium', 'high');

      const result = await callHandler({ taskId: 'task-1', effort: 'medium' });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
      expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
        model_override: null,
        effort_override: 'medium',
      });
    });

    it('re-picking a level the model silently downgrades persists without a restart', async () => {
      // Launched at the column's `max` on a model that tops out at `high`, so
      // the agent reports `high` from its first status write. The user pinned
      // `high` (no restart: the session already ran at it) and now picks `max`
      // again. A restart would pass `--effort max` and land on `high` again.
      useLaneEffort('max');
      task = createMockTask({ effort_override: 'high' });
      taskRepo.getById.mockReturnValue(task);
      hoisted.sessionRecord.value = { id: 'session-1', applied_effort: 'max' };
      reportEffort('high', 'high');

      const result = await callHandler({ taskId: 'task-1', effort: 'max' });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    });

    it('re-picking the pin restarts when the session drifted off it with /effort', async () => {
      // Pinned and launched at `medium`, then the user typed `/effort high`.
      // The old diff read medium -> medium and left the session at high.
      task = createMockTask({ effort_override: 'medium' });
      taskRepo.getById.mockReturnValue(task);
      hoisted.sessionRecord.value = { id: 'session-1', applied_effort: 'medium' };
      reportEffort('high', 'medium');

      const result = await callHandler({ taskId: 'task-1', effort: 'medium' });

      expect(result).toEqual({ ok: true, mode: 'restart' });
      expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
        expect.anything(),
        'proj-1',
        '/mock/project',
        'task-1',
        { phase: 'applying-settings' },
      );
    });

    it('a model-only pick does not restart for an effort the user changed by hand with /effort', async () => {
      // Launched at the column's `high` on `opus`, then the user typed
      // `/effort medium`. A pick of `opus` (what the session runs) touches no
      // effort, so the effort drift must not restart it. Sourcing the effort
      // from the live report on every pick would read medium -> high and
      // restart.
      useLaneEffort('high');
      hoisted.sessionRecord.value = { id: 'session-1', applied_model: 'opus', applied_effort: 'high' };
      reportEffort('medium', 'high');

      const result = await callHandler({ taskId: 'task-1', model: 'opus' });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
      expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
        model_override: 'opus',
        effort_override: null,
      });
    });

    it('with no live report, a pick equal to the launch effort persists without a restart', async () => {
      // The session launched at `high` and then moved into a Default column,
      // where `--resume` kept it at high. Its effective config reads null, so
      // the old diff read null -> high and restarted. The record says high.
      useLaneEffort(null);
      hoisted.sessionRecord.value = { id: 'session-1', applied_effort: 'high' };

      const result = await callHandler({ taskId: 'task-1', effort: 'high' });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    });

    it('with no live report, a pick different from the launch effort restarts', async () => {
      useLaneEffort(null);
      hoisted.sessionRecord.value = { id: 'session-1', applied_effort: 'high' };

      const result = await callHandler({ taskId: 'task-1', effort: 'low' });

      expect(result).toEqual({ ok: true, mode: 'restart' });
      expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
        expect.anything(),
        'proj-1',
        '/mock/project',
        'task-1',
        { phase: 'applying-settings' },
      );
    });
  });

  // =========================================================================
  // Model source: the model the session launched with, not the old config
  // =========================================================================

  describe('model source', () => {
    beforeEach(() => {
      mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });
    });

    it('a model pick equal to the model the session launched with persists without a restart', async () => {
      // Launched with `--model opus`, then moved into a Default column, where
      // `--resume` kept it on opus. Its effective config reads null, so the old
      // diff read null -> opus and restarted a session already on opus.
      hoisted.sessionRecord.value = { id: 'session-1', applied_model: 'opus', applied_effort: null };

      const result = await callHandler({ taskId: 'task-1', model: 'opus' });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    });

    it('a model pick different from the launch model restarts with switching-model', async () => {
      hoisted.sessionRecord.value = { id: 'session-1', applied_model: 'opus', applied_effort: null };

      const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });

      expect(result).toEqual({ ok: true, mode: 'restart' });
      expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
        expect.anything(), 'proj-1', '/mock/project', 'task-1', { phase: 'switching-model' },
      );
    });

    it('an effort-only pick does not restart for a model the pick never touched', async () => {
      // The column says sonnet but the session runs opus. An effort pick the
      // session already runs at must not restart to realign the model.
      swimlaneRepo.getById.mockReturnValue({
        id: 'lane-1',
        permission_mode: null,
        model_override: 'sonnet',
        effort_override: null,
      });
      hoisted.sessionRecord.value = { id: 'session-1', applied_model: 'opus', applied_effort: 'high' };

      const result = await callHandler({ taskId: 'task-1', effort: 'high' });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Profile detach and the live session's own record
  // =========================================================================

  describe('profile detach and own session record', () => {
    beforeEach(() => {
      mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });
      // The real repository returns a fresh object per read. Sharing one
      // reference would let the persist below mutate the handler's pre-write
      // copy of the task, hiding the profile detach from it.
      taskRepo.getById.mockImplementation(() => ({ ...task }));
    });

    /**
     * Mirrors `TaskRepository.updateOverrides`: a concrete (non-null) pin
     * detaches the task from its Board Profile.
     */
    function persistLikeRealRepository(): void {
      taskRepo.updateOverrides.mockImplementation((_id: string, patch: Partial<MockTask>) => {
        Object.assign(task, patch);
        if (patch.model_override != null || patch.effort_override != null) {
          task.profile_id = null;
        }
      });
    }

    it('an effort-only pick on a profile task restarts with switching-model when the detach moves the model target', async () => {
      // The task rides a profile that sets `opus` for this column, and its
      // session launched on `opus`. The column's own model is `sonnet`. Pinning
      // an effort detaches the profile, so the model the respawn passes becomes
      // `sonnet`: the model field changed too, even though the pick never named
      // it. Passing only `model: input.model !== undefined` would read the
      // session as already on its model target and leave it on `opus`.
      task = createMockTask({ profile_id: 'profile-1' });
      persistLikeRealRepository();
      context.boardConfigManager.getBoardProfiles.mockReturnValue([
        { id: 'profile-1', name: 'Planning ladder', columns: { 'lane-1': { modelOverride: 'opus' } } },
      ]);
      swimlaneRepo.getById.mockReturnValue({
        id: 'lane-1',
        permission_mode: null,
        model_override: 'sonnet',
        effort_override: null,
      });
      hoisted.sessionRecord.value = { id: 'session-1', applied_model: 'opus', applied_effort: 'high' };

      const result = await callHandler({ taskId: 'task-1', effort: 'high' });

      expect(result).toEqual({ ok: true, mode: 'restart' });
      expect(task.profile_id).toBeNull();
      expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
        expect.anything(), 'proj-1', '/mock/project', 'task-1', { phase: 'switching-model' },
      );
    });

    it('a pick that clears a field (no concrete pin) keeps the profile and does not count as a detach', async () => {
      // `updateOverrides` only detaches on a non-null pin, so clearing one
      // field leaves the profile in place and the other field untouched.
      task = createMockTask({ profile_id: 'profile-1', effort_override: null });
      persistLikeRealRepository();
      context.boardConfigManager.getBoardProfiles.mockReturnValue([
        { id: 'profile-1', name: 'Planning ladder', columns: { 'lane-1': { modelOverride: 'opus' } } },
      ]);
      swimlaneRepo.getById.mockReturnValue({
        id: 'lane-1',
        permission_mode: null,
        model_override: 'sonnet',
        effort_override: null,
      });
      // The session drifted off the profile's `opus` (say a manual `/model`).
      // A pick that touched only effort must not restart to realign it.
      hoisted.sessionRecord.value = { id: 'session-1', applied_model: 'sonnet', applied_effort: null };

      const result = await callHandler({ taskId: 'task-1', effort: null });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(task.profile_id).toBe('profile-1');
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    });

    it('reads the live session\'s own record, not the task\'s newest record from another track', async () => {
      // The live session launched on `opus` at `high`. The task's newest
      // record belongs to an isolated swimlane's track (`sonnet` at `low`).
      // Re-picking what the live session runs at must persist. Reading
      // `getLatestForTask` directly would see sonnet/low and restart.
      hoisted.sessionRecord.value = { id: 'session-1', applied_model: 'opus', applied_effort: 'high' };
      hoisted.latestRecord.value = { id: 'isolated-track-1', applied_model: 'sonnet', applied_effort: 'low' };

      const result = await callHandler({ taskId: 'task-1', model: 'opus', effort: 'high' });

      expect(result).toEqual({ ok: true, mode: 'persisted' });
      expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Recovery contract: post-persist failures keep the override in DB
  // =========================================================================

  it('returns ok:false on suspend failure but leaves the override persisted (recovery contract)', async () => {
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });
    hoisted.restartSessionForSettingsChange.mockResolvedValue({
      ok: false,
      reason: 'suspend failed: PTY already exited',
    });

    const result = await callHandler({ taskId: 'task-1', model: 'gpt-5' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The 'suspend failed' prefix tells the renderer NOT to roll back the
      // optimistic UI - the DB persist is the source of truth.
      expect(result.reason).toMatch(/^suspend failed:/);
    }
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: 'gpt-5',
      effort_override: null,
    });
  });

  it('returns ok:false on respawn failure but leaves the override persisted (recovery contract)', async () => {
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });
    hoisted.restartSessionForSettingsChange.mockResolvedValue({
      ok: false,
      reason: 'respawn failed: CLI exited',
    });

    const result = await callHandler({ taskId: 'task-1', model: 'gpt-5' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^respawn failed:/);
    }
    // The override IS persisted so the user can hit "Resume" with the saved choice.
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: 'gpt-5',
      effort_override: null,
    });
  });
});

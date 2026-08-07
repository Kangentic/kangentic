/**
 * Unit tests for the TASK_SET_RUNTIME_OVERRIDE IPC handler.
 *
 * Pattern mirrors task-create-handler.test.ts: capture the function
 * registered with ipcMain.handle and invoke it directly with mocked
 * dependencies. The real `task-lifecycle-lock` is used so withTaskLock
 * semantics are observable.
 *
 * Covers the three apply paths plus the recovery contract:
 *   - `persisted`: task has no live session
 *   - `live`: adapter implements getInjectionSequence -> effort-only slash injection
 *   - `restart`: model change (always) or adapter has empty getInjectionSequence
 *     for a concrete-target effort -> shared restartSessionForSettingsChange helper
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
}));

const mockBuildCommandInjectionVerifier = vi.fn(() => null);
vi.mock('../../src/main/transition-engine/injection-plan', () => ({
  buildCommandInjectionVerifier: (...args: unknown[]) =>
    mockBuildCommandInjectionVerifier(...(args as [never, never, never])),
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
  swimlane_id: string;
  session_id: string | null;
  model_override: string | null;
  effort_override: string | null;
}

interface MockContext {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  sessionManager: {
    suspend: ReturnType<typeof vi.fn>;
    getSessionAgentName: ReturnType<typeof vi.fn>;
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
    capturedHandlers.clear();

    task = createMockTask();
    taskRepo = {
      getById: vi.fn((_id: string) => task),
      updateOverrides: vi.fn(),
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
    // Use an EFFORT change so this stays on the live path and asserts adapter resolution.
    task = createMockTask({ agent: null });
    taskRepo.getById.mockReturnValue(task);
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    const getInjectionSequence = vi.fn(() => ['/effort high']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', effort: 'high' });

    expect(result).toEqual({ ok: true, mode: 'live' });
    expect(context.sessionManager.getSessionAgentName).toHaveBeenCalledWith('session-1');
    expect(mockAgentRegistryGet).toHaveBeenCalledWith('claude');
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'task-1',
      'session-1',
      [{ text: '/effort high', verify: 'command-match' }],
      { verifier: null },
    );
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

  it('returns mode:"persisted" without further work when the spec is a no-op delta', async () => {
    // Task already has model_override='sonnet'; user picks 'sonnet' again.
    task = createMockTask({ model_override: 'sonnet' });
    taskRepo.getById.mockReturnValue(task);
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
    );
    // Live slash injection must NOT fire on a model restart.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    // getInjectionSequence is NOT the path that decides model vs restart here -
    // the handler checks restartForModel BEFORE calling the adapter. The adapter
    // mock is registered but the handler branches before calling scheduleKeystrokes.
  });

  it('EFFORT-only change returns mode:"live" when the adapter emits a sequence', async () => {
    // Effort changes via live injection when the adapter supports it.
    const getInjectionSequence = vi.fn(() => ['/effort high']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', effort: 'high' });

    expect(result).toEqual({ ok: true, mode: 'live' });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'task-1',
      'session-1',
      [{ text: '/effort high', verify: 'command-match' }],
      { verifier: null },
    );
    // Effort is persisted to the session record so the next column move diffs
    // against the true running value and does not re-inject.
    expect(hoisted.updateAppliedSettings).toHaveBeenCalledWith('session-1', { effort: 'high' });
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
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
    );
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('falls back to restart when the adapter has no live-switch slash for a model change', async () => {
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
    );
    // No live-switch slash should fire on the restart path.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('EFFORT change with empty getInjectionSequence and concrete target takes the RESTART path', async () => {
    // Gap: an EFFORT change where the adapter returns [] from getInjectionSequence
    // (no live `/effort` slash) AND the resolved effective effort is a concrete
    // non-null target must restart (suspend + respawn), not stay on the persisted path.
    // The task starts with no effort override (null) and the swimlane also has no
    // override, so newEffectiveEffort comes from the input (`'xhigh'`).
    // The adapter signals it cannot live-swap effort (empty sequence), so
    // `restartNeededForEffort` becomes true, and the restart path is taken.
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
    // project context - this is the key assertion the gap was about.
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      '/mock/project',
      'task-1',
    );

    // Live slash injection must NOT fire (adapter returned empty sequence).
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();

    // The DB persist must have happened first (override captured before PTY action).
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: null,
      effort_override: 'xhigh',
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

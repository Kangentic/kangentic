/**
 * Unit tests for the SWIMLANE_UPDATE and SWIMLANE_DELETE IPC handlers in board.ts.
 *
 * SWIMLANE_UPDATE focuses on the two branches introduced by the model-change
 * restart feature:
 *
 *   1. MODEL change (prepareInjectionPlan returns needsRestartForModel: true)
 *      -> restartSessionForSettingsChange is called fire-and-forget inside
 *      withTaskLock; scheduleKeystrokes is NOT called.
 *
 *   2. EFFORT-only change (prepareInjectionPlan returns a plan with a non-empty
 *      sequence and needsRestartForModel: false)
 *      -> scheduleKeystrokes IS called; restartSessionForSettingsChange is NOT.
 *
 * The handler is SYNCHRONOUS (returns the swimlane update result immediately).
 * The restart is FIRE-AND-FORGET via `void withTaskLock(taskId, async () => ...)`.
 * Tests use the REAL withTaskLock (exercises the p-queue wiring) and poll for
 * the async side-effect via vi.waitFor, which is the canonical pattern for
 * assertions on fire-and-forget async callbacks.
 *
 * SWIMLANE_DELETE focuses on Board Profile pruning: profiles live in
 * kangentic.json with no FK, so nothing in the DB layer reaches a `columns[uuid]`
 * delta or a `planExitTarget` naming the deleted column. The handler prunes them
 * via `pruneDeletedColumnFromProfiles`, and the ORDER matters - the prune must
 * write `setBoardProfiles` before `triggerWriteBack` re-serializes the on-disk
 * file, or the write-back carries the stale (unpruned) profiles straight back out.
 *
 * Pattern: capture the function registered via ipcMain.handle(IPC.SWIMLANE_UPDATE)
 * (or IPC.SWIMLANE_DELETE) and invoke it directly - same approach as
 * task-runtime-override-handler.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state (must be defined before vi.mock calls)
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

const hoisted = vi.hoisted(() => ({
  restartSessionForSettingsChange: vi.fn(async () => ({ ok: true as const })),
  prepareInjectionPlan: vi.fn(() => null as ReturnType<typeof import('../../src/main/transition-engine/injection-plan').prepareInjectionPlan>),
}));

// ---------------------------------------------------------------------------
// Module mocks (declared before any imports)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(async () => '') },
}));

// board.ts imports `fs` for attachment open - stub it so no real FS access occurs.
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

vi.mock('node:path', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:path')>();
  return { default: original };
});

vi.mock('node:os', () => ({
  default: { tmpdir: vi.fn(() => '/tmp') },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    updateAppliedSettings = vi.fn();
    // Read by the auto_spawn reconcile that SWIMLANE_UPDATE now also dispatches.
    // Empty: none of these cases flips auto_spawn, so nothing is ever planned.
    getUserPausedTaskIds = vi.fn(() => new Set<string>());
  },
}));

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
}));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  restartSessionForSettingsChange: (...args: unknown[]) =>
    hoisted.restartSessionForSettingsChange(...args),
}));

vi.mock('../../src/main/transition-engine/injection-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/transition-engine/injection-plan')>()),
  prepareInjectionPlan: (...args: unknown[]) => hoisted.prepareInjectionPlan(...args as [never]),
}));

const mockAgentRegistryGet = vi.fn();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (name: string) => mockAgentRegistryGet(name),
  },
}));

vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock declarations)
// ---------------------------------------------------------------------------

import { registerBoardHandlers } from '../../src/main/ipc/handlers/board';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

interface MockSwimlaneBefore {
  id: string;
  name: string;
  model_override: string | null;
  effort_override: string | null;
}

interface MockTask {
  id: string;
  agent: string | null;
  session_id: string | null;
  swimlane_id: string;
  model_override: string | null;
  effort_override: string | null;
}

interface MockContext {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  sessionManager: {
    getSession: ReturnType<typeof vi.fn>;
    getUsageCache: ReturnType<typeof vi.fn>;
  };
  terminalSubmitScheduler: { scheduleKeystrokes: ReturnType<typeof vi.fn> };
  boardConfigManager: {
    writeBack: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    exportFromDb: ReturnType<typeof vi.fn>;
    applyFileChange: ReturnType<typeof vi.fn>;
    getShortcuts: ReturnType<typeof vi.fn>;
    setShortcuts: ReturnType<typeof vi.fn>;
    setDefaultBaseBranch: ReturnType<typeof vi.fn>;
    // SWIMLANE_UPDATE folds each task's Board Profile over the edited column
    // before deciding whether that TASK's resolved settings actually changed.
    // Empty here: these cases are all unprofiled tasks, so the fold is identity
    // and the before/after comparison is the column's own values, as before.
    getBoardProfiles: ReturnType<typeof vi.fn>;
    setBoardProfiles: ReturnType<typeof vi.fn>;
  };
  projectRepo: {
    getById: ReturnType<typeof vi.fn>;
  };
  mainWindow: {
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn> };
  };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    currentProjectId: 'proj-board-1',
    currentProjectPath: '/mock/board-project',
    sessionManager: {
      getSession: vi.fn(() => ({ status: 'running' })),
      // Read by resolveLiveEffort; empty = the agent reports no effort, so the
      // delta source falls back to the session record as it did before.
      getUsageCache: vi.fn(() => ({})),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    boardConfigManager: {
      writeBack: vi.fn(),
      exists: vi.fn(() => false),
      exportFromDb: vi.fn(),
      applyFileChange: vi.fn(() => ({ warnings: [] })),
      getShortcuts: vi.fn(() => []),
      setShortcuts: vi.fn(),
      setDefaultBaseBranch: vi.fn(),
      getBoardProfiles: vi.fn(() => []),
      setBoardProfiles: vi.fn(),
    },
    projectRepo: {
      getById: vi.fn(() => ({ id: 'proj-board-1', name: 'Test Project', path: '/mock/board-project' })),
    },
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    ...overrides,
  };
}

function createSwimlaneBefore(overrides: Partial<MockSwimlaneBefore> = {}): MockSwimlaneBefore {
  return {
    id: 'lane-executing',
    name: 'Executing',
    model_override: null,
    effort_override: null,
    ...overrides,
  };
}

function createTaskInLane(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task-board-1',
    agent: 'claude',
    session_id: 'session-board-1',
    swimlane_id: 'lane-executing',
    model_override: null,
    effort_override: null,
    ...overrides,
  };
}

/** Build the repos mock returned by getProjectRepos for the SWIMLANE_UPDATE call. */
function buildProjectRepos(
  swimlaneBefore: MockSwimlaneBefore | null,
  updatedSwimlane: MockSwimlaneBefore,
  tasksInLane: MockTask[],
) {
  const swimlaneRepo = {
    getById: vi.fn(() => swimlaneBefore),
    update: vi.fn(() => updatedSwimlane),
    list: vi.fn(() => [updatedSwimlane]),
    create: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
  };
  const taskRepo = {
    list: vi.fn(() => tasksInLane),
    getById: vi.fn(() => tasksInLane[0] ?? null),
  };
  return {
    swimlanes: swimlaneRepo,
    tasks: taskRepo,
    actions: {
      list: vi.fn(() => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      listTransitions: vi.fn(() => []),
      setTransitions: vi.fn(),
      getTransitionsFor: vi.fn(() => []),
    },
    attachments: {
      list: vi.fn(() => []),
      add: vi.fn(),
      remove: vi.fn(),
      getDataUrl: vi.fn(),
      getById: vi.fn(),
      deleteByTaskId: vi.fn(),
    },
  };
}

/**
 * Invoke the captured SWIMLANE_UPDATE handler with the given input and context.
 * Returns the synchronous result (the updated swimlane row).
 */
async function callSwimlaneUpdate(
  input: { id: string; name?: string; model_override?: string | null; effort_override?: string | null },
  context: MockContext,
): Promise<unknown> {
  const handler = capturedHandlers.get(IPC.SWIMLANE_UPDATE);
  if (!handler) throw new Error(`Handler for ${IPC.SWIMLANE_UPDATE} was not registered`);
  return handler(null, input);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SWIMLANE_UPDATE handler - restart-on-model and effort live-inject branches', () => {
  let context: MockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.restartSessionForSettingsChange.mockReset();
    hoisted.restartSessionForSettingsChange.mockResolvedValue({ ok: true });
    hoisted.prepareInjectionPlan.mockReset();
    hoisted.prepareInjectionPlan.mockReturnValue(null);
    capturedHandlers.clear();

    context = createMockContext();
    registerBoardHandlers(context as never);
  });

  // =========================================================================
  // Test 1: MODEL change -> restartSessionForSettingsChange called, no scheduleKeystrokes
  // =========================================================================

  it('MODEL change: calls restartSessionForSettingsChange and does NOT call scheduleKeystrokes', async () => {
    // A running task in the swimlane. prepareInjectionPlan signals needsRestartForModel.
    const task = createTaskInLane({ id: 'task-board-1', session_id: 'session-board-1' });
    const swimlaneBefore = createSwimlaneBefore({ id: 'lane-executing' });
    const updatedSwimlane = { ...swimlaneBefore, model_override: 'opus', name: 'Executing' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    // sessionManager.getSession returns a running session for this task.
    context.sessionManager.getSession.mockReturnValue({ status: 'running' });

    // agentRegistry resolves the adapter for this task's agent.
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    // prepareInjectionPlan indicates a model change requires a restart.
    hoisted.prepareInjectionPlan.mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });

    // Handler is synchronous. Call it and let it return.
    await callSwimlaneUpdate({ id: 'lane-executing', model_override: 'opus' }, context);

    // The restart runs fire-and-forget inside withTaskLock.
    // Poll until the async callback has had a chance to execute.
    await vi.waitFor(() => {
      expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Verify the exact arguments passed to the shared helper.
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      context,
      'proj-board-1',
      '/mock/board-project',
      'task-board-1',
    );

    // Live-injection must NOT fire alongside a model-change restart.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 2: EFFORT-only change -> scheduleKeystrokes called, no restart
  // =========================================================================

  it('EFFORT-only change: calls scheduleKeystrokes and does NOT call restartSessionForSettingsChange', async () => {
    const task = createTaskInLane({ id: 'task-board-2', session_id: 'session-board-2' });
    const swimlaneBefore = createSwimlaneBefore({ id: 'lane-executing' });
    const updatedSwimlane = { ...swimlaneBefore, effort_override: 'xhigh', name: 'Executing' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    context.sessionManager.getSession.mockReturnValue({ status: 'running' });
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    // prepareInjectionPlan returns a live-inject plan (no model restart needed).
    hoisted.prepareInjectionPlan.mockReturnValue({
      sequence: ['/effort xhigh'],
      verifier: null,
      verifiedPrefixLength: 1,
      needsRestartForModel: false,
      appliedSettings: { effort: 'xhigh' },
    });

    await callSwimlaneUpdate({ id: 'lane-executing', effort_override: 'xhigh' }, context);

    // scheduleKeystrokes fires synchronously in the handler body (not fire-and-forget).
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'task-board-2',
      'session-board-2',
      ['/effort xhigh'],
      { verifier: null, verifiedPrefixLength: 1 },
    );

    // No restart should have been triggered for an effort-only change.
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 3: NO-OP / non-override save -> loop is skipped entirely
  // =========================================================================

  it('NO-OP save (overrides unchanged, only name changed): skips the loop, no restart, no inject, no plan', async () => {
    // A running task lives in the column, so if the loop ran it WOULD reach
    // prepareInjectionPlan. The column's model/effort overrides are identical
    // before and after; only the name changed. The handler must short-circuit
    // before touching the running session.
    const task = createTaskInLane({ id: 'task-board-3', session_id: 'session-board-3' });
    const swimlaneBefore = createSwimlaneBefore({
      id: 'lane-executing',
      model_override: 'opus',
      effort_override: 'xhigh',
    });
    const updatedSwimlane = { ...swimlaneBefore, name: 'Executing (renamed)' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    context.sessionManager.getSession.mockReturnValue({ status: 'running' });
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    await callSwimlaneUpdate({ id: 'lane-executing', name: 'Executing (renamed)' }, context);

    // The per-task loop must be skipped: the override-change gate is false, so
    // prepareInjectionPlan is never consulted and neither side-effect fires.
    expect(hoisted.prepareInjectionPlan).not.toHaveBeenCalled();
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 4: before === null (new swimlane / first save) -> loop is skipped
  // =========================================================================

  it('new swimlane (before === null): skips the loop even with a running task present', async () => {
    // Scenario: the swimlane row did not exist before this update (e.g. first
    // save of a just-created column). swimlanes.getById returns null, so `!!before`
    // is false and `overridesChanged` is false regardless of the override values
    // on the result. The per-task loop must not run.
    //
    // Red-green rationale: if the gate were `if (before)` (the pre-fix
    // condition) instead of `if (overridesChanged)`, this test would FAIL because
    // `before` being null makes the whole expression false -- but if the gate
    // checked the result's overrides directly, the loop could erroneously fire.
    // The `!!before` guard is the "swimlane existed pre-update" invariant; this
    // test locks it.
    const task = createTaskInLane({ id: 'task-board-4', session_id: 'session-board-4' });

    // Pass null as swimlaneBefore so getById returns null.
    const updatedSwimlane = createSwimlaneBefore({
      id: 'lane-new',
      model_override: 'opus',
      effort_override: 'xhigh',
    });
    const repos = buildProjectRepos(null, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    context.sessionManager.getSession.mockReturnValue({ status: 'running' });
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    await callSwimlaneUpdate({ id: 'lane-new', model_override: 'opus' }, context);

    // overridesChanged is false when before is null; the loop body never executes.
    expect(hoisted.prepareInjectionPlan).not.toHaveBeenCalled();
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 5: both-null no-op (WIP-limit / color edit on a plain column)
  // =========================================================================

  it('both-null no-op (name/color edit, no overrides ever set): skips the loop, null !== null is false', async () => {
    // Scenario: a column that has never had model or effort overrides (both
    // fields null). The user edits only the name or color. Before and after
    // both carry null overrides. The `null !== null` comparison for both OR
    // arms is false, so overridesChanged is false and the loop is skipped.
    //
    // Red-green rationale: this documents that the `||` condition is correctly
    // short-circuited when both arms evaluate to `null !== null` (false). If the
    // gate were inadvertently changed to `before.model_override !== undefined`
    // or a truthy coercion, this test would catch the regression.
    const task = createTaskInLane({ id: 'task-board-5', session_id: 'session-board-5' });
    const swimlaneBefore = createSwimlaneBefore({
      id: 'lane-plain',
      model_override: null,
      effort_override: null,
    });
    const updatedSwimlane = { ...swimlaneBefore, name: 'Plain (renamed)' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    context.sessionManager.getSession.mockReturnValue({ status: 'running' });
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    await callSwimlaneUpdate({ id: 'lane-plain', name: 'Plain (renamed)' }, context);

    // null !== null is false for both arms of the OR; the per-task loop is skipped.
    expect(hoisted.prepareInjectionPlan).not.toHaveBeenCalled();
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 6: effort-only change with non-null, unchanged model (OR right arm)
  // =========================================================================

  it('effort-only change with non-null unchanged model: OR right arm fires, scheduleKeystrokes called, no restart', async () => {
    // Scenario: a column already has model_override='opus' (non-null, unchanged).
    // Only effort_override changes (null -> 'xhigh'). The left arm of the OR is
    // `'opus' !== 'opus'` = false; the right arm is `null !== 'xhigh'` = true.
    // overridesChanged is true, the loop runs, and since prepareInjectionPlan
    // returns needsRestartForModel: false, scheduleKeystrokes fires.
    //
    // Red-green rationale: this proves the OR's right arm independently triggers
    // the loop even when the left arm (model) is equal-but-non-null. Without the
    // right arm, an effort-only change on a column with a pre-existing model would
    // silently skip injection. If the gate were changed to check model_override
    // only, this test would fail (loop skipped) because the model is unchanged.
    const task = createTaskInLane({
      id: 'task-board-6',
      session_id: 'session-board-6',
      agent: 'claude',
    });
    const swimlaneBefore = createSwimlaneBefore({
      id: 'lane-with-model',
      model_override: 'opus',
      effort_override: null,
    });
    const updatedSwimlane = { ...swimlaneBefore, effort_override: 'xhigh' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    context.sessionManager.getSession.mockReturnValue({ status: 'running' });
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    // prepareInjectionPlan returns a live-inject plan (model unchanged, no restart needed).
    hoisted.prepareInjectionPlan.mockReturnValue({
      sequence: ['/effort xhigh'],
      verifier: null,
      verifiedPrefixLength: 1,
      needsRestartForModel: false,
      appliedSettings: { effort: 'xhigh' },
    });

    await callSwimlaneUpdate({ id: 'lane-with-model', effort_override: 'xhigh' }, context);

    // The OR's right arm (effort change) triggered the loop. scheduleKeystrokes must fire.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'task-board-6',
      'session-board-6',
      ['/effort xhigh'],
      { verifier: null, verifiedPrefixLength: 1 },
    );

    // Model is unchanged, so no restart should be triggered.
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 7: MODEL change, restart succeeds -> TASK_SESSION_RESYNC pushed
  // =========================================================================

  it('MODEL change, restart succeeds: pushes TASK_SESSION_RESYNC to the renderer', async () => {
    // The board store keeps the pre-restart session_id until it re-syncs. The
    // handler must push a quiet (toast-free) TASK_SESSION_RESYNC once the
    // restart resolves ok, so ContextBar's task join (and every other
    // session_id-keyed consumer) recovers without a full reload.
    const task = createTaskInLane({ id: 'task-board-7', session_id: 'session-board-7' });
    const swimlaneBefore = createSwimlaneBefore({ id: 'lane-executing' });
    const updatedSwimlane = { ...swimlaneBefore, model_override: 'opus', name: 'Executing' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    context.sessionManager.getSession.mockReturnValue({ status: 'running' });
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    hoisted.prepareInjectionPlan.mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });
    hoisted.restartSessionForSettingsChange.mockResolvedValue({ ok: true });

    await callSwimlaneUpdate({ id: 'lane-executing', model_override: 'opus' }, context);

    await vi.waitFor(() => {
      expect(context.mainWindow.webContents.send).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.TASK_SESSION_RESYNC,
      'proj-board-1',
    );
  });

  // =========================================================================
  // Test 8: MODEL change, restart fails -> TASK_SESSION_RESYNC is NOT pushed
  // =========================================================================

  it('MODEL change, restart fails: does NOT push TASK_SESSION_RESYNC', async () => {
    // If the restart could not resolve a new session, there is nothing for the
    // renderer to re-sync to; pushing anyway would race the (now stale) id
    // against whatever the failed restart left behind.
    const task = createTaskInLane({ id: 'task-board-8', session_id: 'session-board-8' });
    const swimlaneBefore = createSwimlaneBefore({ id: 'lane-executing' });
    const updatedSwimlane = { ...swimlaneBefore, model_override: 'opus', name: 'Executing' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    context.sessionManager.getSession.mockReturnValue({ status: 'running' });
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    hoisted.prepareInjectionPlan.mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });
    hoisted.restartSessionForSettingsChange.mockResolvedValue({ ok: false, reason: 'no session found' });

    await callSwimlaneUpdate({ id: 'lane-executing', model_override: 'opus' }, context);

    // Wait for the fire-and-forget restart to have run before asserting the
    // negative (there is no positive condition to poll for here).
    await vi.waitFor(() => {
      expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SWIMLANE_DELETE - Board Profile pruning, and its ordering vs the write-back
// ---------------------------------------------------------------------------

describe('SWIMLANE_DELETE handler - Board Profile pruning', () => {
  let context: MockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.restartSessionForSettingsChange.mockReset();
    hoisted.restartSessionForSettingsChange.mockResolvedValue({ ok: true });
    hoisted.prepareInjectionPlan.mockReset();
    hoisted.prepareInjectionPlan.mockReturnValue(null);
    capturedHandlers.clear();

    context = createMockContext();
    registerBoardHandlers(context as never);
  });

  function callSwimlaneDelete(id: string): unknown {
    const handler = capturedHandlers.get(IPC.SWIMLANE_DELETE);
    if (!handler) throw new Error(`Handler for ${IPC.SWIMLANE_DELETE} was not registered`);
    return handler(null, id);
  }

  it('prunes both a columns[uuid] delta and a planExitTarget naming the deleted column, and writes profiles BEFORE the kangentic.json write-back', () => {
    const doomedSwimlane = createSwimlaneBefore({ id: 'lane-doomed', name: 'Brand Review' });
    // buildProjectRepos's second/third args (update result, tasks-in-lane) are not
    // read by the delete path - only swimlanes.getById and swimlanes.delete are.
    const repos = buildProjectRepos(doomedSwimlane, doomedSwimlane, []);
    mockGetProjectRepos.mockReturnValue(repos);

    context.boardConfigManager.getBoardProfiles.mockReturnValue([
      {
        id: 'profile-1',
        name: 'Heavy',
        columns: {
          'lane-doomed': { modelOverride: 'opus' },
          'lane-planning': { planExitTarget: 'Brand Review' },
        },
      },
    ]);

    callSwimlaneDelete('lane-doomed');

    expect(repos.swimlanes.delete).toHaveBeenCalledWith('lane-doomed');
    expect(context.boardConfigManager.setBoardProfiles).toHaveBeenCalledTimes(1);
    const [writtenProfiles] = context.boardConfigManager.setBoardProfiles.mock.calls[0];
    expect(writtenProfiles[0].columns).not.toHaveProperty('lane-doomed');
    expect(writtenProfiles[0].columns['lane-planning']).not.toHaveProperty('planExitTarget');

    // Revert proof (a): deleting the `if (doomed) { pruneDeletedColumnFromProfiles(...) }`
    // block in board.ts reds this assertion - setBoardProfiles is never called.
    expect(context.boardConfigManager.writeBack).toHaveBeenCalledTimes(1);

    // ORDERING - a test that only checked "both were called" would NOT go red if
    // the order flipped, and flipping it re-serializes the stale (unpruned)
    // profiles from the on-disk file straight back out.
    // Revert proof (b): moving the prune block to AFTER triggerWriteBack(context)
    // reds only this assertion, leaving the two above green.
    const setBoardProfilesOrder = context.boardConfigManager.setBoardProfiles.mock.invocationCallOrder[0];
    const writeBackOrder = context.boardConfigManager.writeBack.mock.invocationCallOrder[0];
    expect(setBoardProfilesOrder).toBeLessThan(writeBackOrder);
  });

  it('does not write profiles when nothing referenced the deleted column', () => {
    const doomedSwimlane = createSwimlaneBefore({ id: 'lane-doomed', name: 'Brand Review' });
    const repos = buildProjectRepos(doomedSwimlane, doomedSwimlane, []);
    mockGetProjectRepos.mockReturnValue(repos);

    // A profile exists, but references a DIFFERENT lane - exercises the "computed
    // a diff, decided not to write" path, not just an empty-profiles short-circuit.
    context.boardConfigManager.getBoardProfiles.mockReturnValue([
      { id: 'profile-1', name: 'Heavy', columns: { 'other-lane': { modelOverride: 'opus' } } },
    ]);

    callSwimlaneDelete('lane-doomed');

    expect(context.boardConfigManager.setBoardProfiles).not.toHaveBeenCalled();
    expect(context.boardConfigManager.writeBack).toHaveBeenCalledTimes(1);
  });
});

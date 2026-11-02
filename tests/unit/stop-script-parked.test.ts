/**
 * A project's Stop script after a pause Kangentic made (src/main/stop-script/):
 * the decision, the recheck of a stop a connected client held off, and which
 * pauses qualify, read through the real record check.
 *
 * Brief table, rows this file pins:
 *   idle-timeout pause (`auto`), low-memory pause (`low_memory`): runs, unless a
 *     client is connected.
 *   user Pause or Stop, `auto_spawn=false` entry (`user`, `system`): no.
 *   respawn, handoff (`system`): no. Quit: no.
 * Terminal transitions are in session-leftover-reap-wiring.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskProbeEntry } from '../../src/main/pty/process-tag/tagged-reap';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const { mockGetOpenProjectDb, mockGetLatestForTask, mockGetTaskById, mockListEligible, mockHoldTaskMessage, mockDestroyLanes, mockRunStopScript } = vi.hoisted(() => ({
  mockGetOpenProjectDb: vi.fn((_projectId: string): unknown => ({ name: 'db' })),
  mockGetLatestForTask: vi.fn((_taskId: string): unknown => null),
  mockGetTaskById: vi.fn((_taskId: string): unknown => null),
  mockListEligible: vi.fn((): string[] => []),
  mockHoldTaskMessage: vi.fn((..._args: unknown[]): { status: string } => ({ status: 'held' })),
  mockDestroyLanes: vi.fn((_taskId: string): number => 0),
  mockRunStopScript: vi.fn(async (_input: unknown): Promise<unknown> => ({ status: 'ok' })),
}));

vi.mock('../../src/main/db/database', () => ({ getOpenProjectDb: (projectId: string) => mockGetOpenProjectDb(projectId) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = (taskId: string) => mockGetLatestForTask(taskId);
    listStopEligiblePausedTasks = () => mockListEligible();
  },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = (taskId: string) => mockGetTaskById(taskId);
  },
}));
vi.mock('../../src/main/held-messages/held-messages', () => ({ holdTaskMessage: (...args: unknown[]) => mockHoldTaskMessage(...args) }));
vi.mock('../../src/main/browser/browser-lane-manager', () => ({ destroyLanesForTask: (taskId: string) => mockDestroyLanes(taskId) }));
vi.mock('../../src/main/stop-script/run-stop-script', () => ({
  STOP_SCRIPT_PAUSE_TIMEOUT_MS: 120_000,
  isStopScriptRunning: vi.fn(() => false),
  runStopScript: (input: unknown) => mockRunStopScript(input),
}));

import {
  createParkedStopDeps,
  relieveParkedTasks,
  resetParkedStopsForTests,
  startParkedStop,
  tickHeldOffStops,
} from '../../src/main/stop-script/parked-stop-service';
import { HeldOffStops, HELD_OFF_RECHECK_TICKS } from '../../src/main/stop-script/held-off-stops';
import { stopParkedTask, stoppedProcessesMessage, type ParkedStopDeps } from '../../src/main/stop-script/parked-stop';
import { resetStopScriptFailureReportsForTests } from '../../src/main/stop-script/stop-script-failure';
import { IPC } from '../../src/shared/ipc-channels';

const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/mock/project';
const TASK_ID = 'task-aaaa-0001';
const TARGET = { projectId: PROJECT_ID, projectPath: PROJECT_PATH, taskId: TASK_ID };
const SERVER = { pid: 501, startKey: 'k-501', label: 'node (vite)' };
const SIDECAR = { pid: 502, startKey: 'k-502', label: 'python3 (http.server)' };

function entry(overrides: Partial<TaskProbeEntry> = {}): TaskProbeEntry {
  return { taskId: TASK_ID, processes: [SERVER], connected: false, ...overrides };
}

function makeDeps(overrides: Partial<ParkedStopDeps> = {}): ParkedStopDeps & { probe: ReturnType<typeof vi.fn>; runScript: ReturnType<typeof vi.fn>; holdMessage: ReturnType<typeof vi.fn> } {
  return {
    scriptOf: () => 'npm run stop',
    isStoppingEnabled: () => true,
    isShuttingDown: () => false,
    parkedTask: () => ({ title: 'Fix login', worktreePath: '/mock/project/.kangentic/worktrees/t1' }),
    isScriptRunning: () => false,
    probe: vi.fn()
      .mockResolvedValueOnce(entry())
      .mockResolvedValue(entry({ processes: [] })),
    closeOffscreenLanes: () => 0,
    folderOf: async (_target, worktreePath) => worktreePath ?? PROJECT_PATH,
    runScript: vi.fn(async () => ({ status: 'ok' as const })),
    holdMessage: vi.fn(),
    reportFailure: vi.fn(),
    wait: async () => {},
    ...overrides,
  } as ParkedStopDeps & { probe: ReturnType<typeof vi.fn>; runScript: ReturnType<typeof vi.fn>; holdMessage: ReturnType<typeof vi.fn> };
}

describe('stopParkedTask', () => {
  it('asks the host nothing for a project with no script', async () => {
    const deps = makeDeps({ scriptOf: () => null });

    expect(await stopParkedTask(deps, TARGET)).toBe('skipped');
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.runScript).not.toHaveBeenCalled();
  });

  it('runs nothing with "Stop leftover processes" off', async () => {
    const deps = makeDeps({ isStoppingEnabled: () => false });

    expect(await stopParkedTask(deps, TARGET)).toBe('skipped');
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it('runs nothing during a quit', async () => {
    const deps = makeDeps({ isShuttingDown: () => true });

    expect(await stopParkedTask(deps, TARGET)).toBe('skipped');
    expect(deps.runScript).not.toHaveBeenCalled();
  });

  it('runs nothing for a task no longer parked', async () => {
    const deps = makeDeps({ parkedTask: () => null });

    expect(await stopParkedTask(deps, TARGET)).toBe('not-paused');
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it('runs no script when nothing runs', async () => {
    const deps = makeDeps({ probe: vi.fn(async () => entry({ processes: [] })) });

    expect(await stopParkedTask(deps, TARGET)).toBe('nothing-running');
    expect(deps.runScript).not.toHaveBeenCalled();
  });

  it('runs no script when the host could not tell', async () => {
    const deps = makeDeps({ probe: vi.fn(async () => null) });

    expect(await stopParkedTask(deps, TARGET)).toBe('unknown');
    expect(deps.runScript).not.toHaveBeenCalled();
  });

  it('runs the script in the task\'s worktree when nobody is connected', async () => {
    const deps = makeDeps();

    expect(await stopParkedTask(deps, TARGET)).toBe('stopped');
    expect(deps.runScript).toHaveBeenCalledWith(TASK_ID, 'npm run stop', '/mock/project/.kangentic/worktrees/t1');
  });

  it('runs it in the project folder for a task with no worktree', async () => {
    const deps = makeDeps({ parkedTask: () => ({ title: 'Fix login', worktreePath: null }) });

    await stopParkedTask(deps, TARGET);

    expect(deps.runScript).toHaveBeenCalledWith(TASK_ID, 'npm run stop', PROJECT_PATH);
  });

  it('holds the stop off while a client is connected', async () => {
    const deps = makeDeps({ probe: vi.fn(async () => entry({ connected: true })) });

    expect(await stopParkedTask(deps, TARGET)).toBe('held-off');
    expect(deps.runScript).not.toHaveBeenCalled();
  });

  it('closes an offscreen lane that is the only client, and then stops', async () => {
    const closeOffscreenLanes = vi.fn(() => 1);
    const probe = vi.fn()
      .mockResolvedValueOnce(entry({ connected: true }))
      .mockResolvedValueOnce(entry())
      .mockResolvedValue(entry({ processes: [] }));
    const deps = makeDeps({ closeOffscreenLanes, probe });

    expect(await stopParkedTask(deps, TARGET)).toBe('stopped');
    expect(closeOffscreenLanes).toHaveBeenCalledWith(TASK_ID);
    expect(deps.runScript).toHaveBeenCalledTimes(1);
  });

  it('leaves a lane alone when nobody is connected, and holds off when a client outlives it', async () => {
    const closeOffscreenLanes = vi.fn(() => 1);
    const untouched = makeDeps({ closeOffscreenLanes });
    await stopParkedTask(untouched, TARGET);
    expect(closeOffscreenLanes).not.toHaveBeenCalled();

    const stillConnected = makeDeps({ closeOffscreenLanes, probe: vi.fn(async () => entry({ connected: true })) });
    expect(await stopParkedTask(stillConnected, TARGET)).toBe('held-off');
    expect(closeOffscreenLanes).toHaveBeenCalledTimes(1);
  });

  it('runs nothing when the task was resumed during the probe', async () => {
    const parkedTask = vi.fn()
      .mockReturnValueOnce({ title: 'Fix login', worktreePath: null })
      .mockReturnValue(null);
    const deps = makeDeps({ parkedTask });

    expect(await stopParkedTask(deps, TARGET)).toBe('not-paused');
    expect(deps.runScript).not.toHaveBeenCalled();
  });

  it('names what ended in the next agent\'s message, and only that', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(entry({ processes: [SERVER, SIDECAR] }))
      .mockResolvedValue(entry({ processes: [SIDECAR] }));
    const deps = makeDeps({ probe });

    expect(await stopParkedTask(deps, TARGET)).toBe('stopped');
    expect(deps.holdMessage).toHaveBeenCalledTimes(1);
    const message = deps.holdMessage.mock.calls[0][1] as string;
    expect(message).toContain('node (vite)');
    expect(message).not.toContain('python3');
  });

  it('holds no message when the script exited clean and stopped nothing', async () => {
    const deps = makeDeps({ probe: vi.fn(async () => entry()) });
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {});

    expect(await stopParkedTask(deps, TARGET)).toBe('no-effect');
    expect(deps.holdMessage).not.toHaveBeenCalled();
  });

  it('reads a reused pid as a process that ended', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(entry())
      .mockResolvedValue(entry({ processes: [{ ...SERVER, startKey: 'k-reused' }] }));
    const deps = makeDeps({ probe });

    expect(await stopParkedTask(deps, TARGET)).toBe('stopped');
  });

  it('reports a failure, holds no message and changes nothing else', async () => {
    const failure = { kind: 'exit-code', exitCode: 1, detail: 'not recognized' } as const;
    const reportFailure = vi.fn();
    const deps = makeDeps({ runScript: vi.fn(async () => ({ status: 'failed' as const, failure })), reportFailure });

    expect(await stopParkedTask(deps, TARGET)).toBe('failed');
    expect(reportFailure).toHaveBeenCalledWith(TARGET, 'Fix login', failure);
    expect(deps.holdMessage).not.toHaveBeenCalled();
  });

  it('tells a low-memory pass as the script starts, not as it ends', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const deps = makeDeps({ runScript: vi.fn(async () => { await finished; return { status: 'ok' as const }; }) });
    const onScriptStart = vi.fn();

    const stop = stopParkedTask(deps, TARGET, { onScriptStart });
    await vi.waitFor(() => expect(onScriptStart).toHaveBeenCalledTimes(1));
    finish();
    await stop;
  });
});

describe('stoppedProcessesMessage', () => {
  it('says what stopped and that the agent may start it again', () => {
    expect(stoppedProcessesMessage(['node (vite)', 'python3 (http.server)'])).toBe(
      "The project's Stop script stopped what this task left running while it was paused: node (vite), python3 (http.server). Start them again if you need them.",
    );
  });

  it('counts past five names', () => {
    expect(stoppedProcessesMessage(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toContain('a, b, c, d, e and 2 more.');
  });
});

describe('HeldOffStops', () => {
  it('does nothing at all while empty', () => {
    const stops = new HeldOffStops();
    const attempt = vi.fn();

    for (let tick = 0; tick < HELD_OFF_RECHECK_TICKS * 3; tick += 1) stops.onTick(attempt);

    expect(attempt).not.toHaveBeenCalled();
  });

  it('checks every fifth tick, and stops the task once the client has gone', async () => {
    const stops = new HeldOffStops();
    stops.add(TARGET);
    const attempt = vi.fn()
      .mockResolvedValueOnce('held-off')
      .mockResolvedValueOnce('stopped');

    for (let tick = 0; tick < HELD_OFF_RECHECK_TICKS - 1; tick += 1) stops.onTick(attempt);
    expect(attempt).not.toHaveBeenCalled();

    stops.onTick(attempt);
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(stops.size).toBe(1);

    for (let tick = 0; tick < HELD_OFF_RECHECK_TICKS; tick += 1) stops.onTick(attempt);
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(stops.size).toBe(0));
  });

  it.each(['not-paused', 'nothing-running', 'failed', 'no-effect', 'skipped', 'stopped'] as const)('drops a task on %s', async (result) => {
    const stops = new HeldOffStops();
    stops.add(TARGET);

    for (let tick = 0; tick < HELD_OFF_RECHECK_TICKS; tick += 1) stops.onTick(async () => result);

    await vi.waitFor(() => expect(stops.size).toBe(0));
  });

  it('keeps a task the host could not read, and survives an attempt that throws', async () => {
    const stops = new HeldOffStops();
    stops.add(TARGET);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let tick = 0; tick < HELD_OFF_RECHECK_TICKS; tick += 1) stops.onTick(async () => { throw new Error('host gone'); });

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(stops.size).toBe(1);
    warn.mockRestore();
  });
});

describe('the parked stop against the app', () => {
  function makeContext(overrides: { script?: string | null; stopLeftoverProcesses?: boolean; live?: boolean; probe?: unknown } = {}) {
    return {
      boardConfigManager: { getStopScriptForPath: vi.fn(() => (overrides.script === undefined ? 'npm run stop' : overrides.script)) },
      configManager: { load: vi.fn(() => ({ stopLeftoverProcesses: overrides.stopLeftoverProcesses ?? true })) },
      projectRepo: {
        getById: vi.fn(() => ({ id: PROJECT_ID, path: PROJECT_PATH })),
        list: vi.fn(() => [{ id: PROJECT_ID, path: PROJECT_PATH }]),
      },
      sessionManager: {
        findLiveSessionByTaskId: vi.fn(() => (overrides.live ? { id: 'live' } : null)),
        probeTaskProcesses: vi.fn(async () => overrides.probe ?? [entry({ processes: [] })]),
      },
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    };
  }

  function pausedBy(suspendedBy: string | null, status = 'suspended'): void {
    mockGetLatestForTask.mockReturnValue({ status, suspended_by: suspendedBy });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetParkedStopsForTests();
    resetStopScriptFailureReportsForTests();
    mockGetOpenProjectDb.mockReturnValue({ name: 'db' });
    mockGetTaskById.mockReturnValue({ id: TASK_ID, title: 'Fix login', worktree_path: null, archived_at: null });
    mockRunStopScript.mockResolvedValue({ status: 'ok' });
    mockDestroyLanes.mockReturnValue(0);
    mockListEligible.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['auto', true],
    ['low_memory', true],
    ['user', false],
    ['system', false],
    [null, false],
  ])('reads a pause by %s as parked: %s', (suspendedBy, parked) => {
    pausedBy(suspendedBy);
    const deps = createParkedStopDeps(makeContext() as unknown as IpcContext);

    expect(deps.parkedTask(TARGET) !== null).toBe(parked);
  });

  it('reads a task with a live session, an exited record or an archive as not parked', () => {
    pausedBy('auto');
    expect(createParkedStopDeps(makeContext({ live: true }) as unknown as IpcContext).parkedTask(TARGET)).toBeNull();

    pausedBy('auto', 'exited');
    expect(createParkedStopDeps(makeContext() as unknown as IpcContext).parkedTask(TARGET)).toBeNull();

    pausedBy('auto');
    mockGetTaskById.mockReturnValue({ id: TASK_ID, title: 'Fix login', worktree_path: null, archived_at: '2026-11-01T00:00:00.000Z' });
    expect(createParkedStopDeps(makeContext() as unknown as IpcContext).parkedTask(TARGET)).toBeNull();
  });

  it('makes no host call for a project with no script', async () => {
    pausedBy('auto');
    const context = makeContext({ script: null });

    startParkedStop(context as unknown as IpcContext, PROJECT_ID, TASK_ID);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(context.sessionManager.probeTaskProcesses).not.toHaveBeenCalled();
  });

  it('after a pause, runs the script on its own budget and holds what it stopped for the next agent', async () => {
    pausedBy('auto');
    const context = makeContext();
    context.sessionManager.probeTaskProcesses
      .mockResolvedValueOnce([entry()])
      .mockResolvedValue([entry({ processes: [] })]);

    startParkedStop(context as unknown as IpcContext, PROJECT_ID, TASK_ID);

    await vi.waitFor(() => expect(mockHoldTaskMessage).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mockRunStopScript).toHaveBeenCalledWith({ taskId: TASK_ID, script: 'npm run stop', cwd: PROJECT_PATH, timeoutMs: 120_000 });
    const [, held] = mockHoldTaskMessage.mock.calls[0] as [unknown, { projectId: string; taskId: string; message: string }];
    expect(held).toMatchObject({ projectId: PROJECT_ID, taskId: TASK_ID });
    expect(held.message).toContain('node (vite)');
  });

  it('pushes a failed run for the toast, once a minute per project', async () => {
    pausedBy('auto');
    const failure = { kind: 'timeout', timeoutMs: 120_000 };
    mockRunStopScript.mockResolvedValue({ status: 'failed', failure });
    const context = makeContext();
    context.sessionManager.probeTaskProcesses.mockImplementation(async (_projectPath: string, tasks: Array<{ id: string }>) => (
      tasks.map((task) => entry({ taskId: task.id }))
    ));

    startParkedStop(context as unknown as IpcContext, PROJECT_ID, TASK_ID);
    startParkedStop(context as unknown as IpcContext, PROJECT_ID, 'task-aaaa-0002');

    await vi.waitFor(() => expect(mockRunStopScript).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(context.mainWindow.webContents.send).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(context.mainWindow.webContents.send).toHaveBeenCalledTimes(1);
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.STOP_SCRIPT_FAILED, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      taskTitle: 'Fix login',
      failure,
    });
    expect(mockHoldTaskMessage).not.toHaveBeenCalled();
  });

  it('holds a connected stop off, and a later tick stops it once the client has gone', async () => {
    pausedBy('auto');
    const context = makeContext();
    context.sessionManager.probeTaskProcesses.mockResolvedValue([entry({ connected: true })]);

    startParkedStop(context as unknown as IpcContext, PROJECT_ID, TASK_ID);
    await vi.waitFor(() => expect(context.sessionManager.probeTaskProcesses).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(mockRunStopScript).not.toHaveBeenCalled();

    context.sessionManager.probeTaskProcesses
      .mockReset()
      .mockResolvedValueOnce([entry()])
      .mockResolvedValue([entry({ processes: [] })]);
    for (let tick = 0; tick < HELD_OFF_RECHECK_TICKS; tick += 1) tickHeldOffStops(context as unknown as IpcContext);

    await vi.waitFor(() => expect(mockRunStopScript).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockHoldTaskMessage).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('polls nothing while no stop is held off', () => {
    const context = makeContext();

    for (let tick = 0; tick < HELD_OFF_RECHECK_TICKS * 3; tick += 1) tickHeldOffStops(context as unknown as IpcContext);

    expect(context.sessionManager.probeTaskProcesses).not.toHaveBeenCalled();
    expect(mockGetLatestForTask).not.toHaveBeenCalled();
  });

  describe('a low-memory pass', () => {
    it('starts a parked task\'s stop and answers before the script ends', async () => {
      pausedBy('auto');
      mockListEligible.mockReturnValue([TASK_ID]);
      let finish!: (outcome: unknown) => void;
      mockRunStopScript.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const context = makeContext({ probe: [entry()] });

      expect(await relieveParkedTasks(context as unknown as IpcContext)).toBe('started');
      finish({ status: 'ok' });
    });

    it('answers none when nothing is parked, and for a project with no script reads no session', async () => {
      mockListEligible.mockReturnValue([TASK_ID]);
      const context = makeContext({ script: null });

      expect(await relieveParkedTasks(context as unknown as IpcContext)).toBe('none');
      expect(mockListEligible).not.toHaveBeenCalled();
    });

    it('answers none with "Stop leftover processes" off', async () => {
      pausedBy('auto');
      mockListEligible.mockReturnValue([TASK_ID]);
      const context = makeContext({ stopLeftoverProcesses: false, probe: [entry()] });

      expect(await relieveParkedTasks(context as unknown as IpcContext)).toBe('none');
      expect(mockRunStopScript).not.toHaveBeenCalled();
    });

    it('answers held while a client holds the task off', async () => {
      pausedBy('auto');
      mockListEligible.mockReturnValue([TASK_ID]);
      const context = makeContext({ probe: [entry({ connected: true })] });

      expect(await relieveParkedTasks(context as unknown as IpcContext)).toBe('held');
      expect(mockRunStopScript).not.toHaveBeenCalled();
    });

    it('does not try a failing script on every tick of a spell, which would pause no agent', async () => {
      pausedBy('auto');
      mockListEligible.mockReturnValue([TASK_ID]);
      mockRunStopScript.mockResolvedValue({ status: 'failed', failure: { kind: 'exit-code', exitCode: 1, detail: '' } });
      const context = makeContext({ probe: [entry()] });

      expect(await relieveParkedTasks(context as unknown as IpcContext)).toBe('started');
      expect(await relieveParkedTasks(context as unknown as IpcContext)).toBe('none');
      expect(mockRunStopScript).toHaveBeenCalledTimes(1);
    });
  });
});

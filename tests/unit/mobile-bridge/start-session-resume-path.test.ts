/**
 * start-session on a PAUSED task resumes exactly as the desktop Resume button
 * does, and on an exited or sessionless task still starts the column.
 *
 * Runs the bridge handler through the REAL startTaskSession and the REAL
 * resumeTaskSession (the body the SESSION_RESUME handler calls), the real task
 * lock, and the real spawn-progress module. What stands in is the layer below:
 * the git helpers, the transition engine, and autoSpawnForTask.
 *
 * Why this matters: a phone Resume on a paused task in Code Review used to go
 * through autoSpawnForTask -> spawnAgent, which runs the column's enter
 * automations (`engine.executeTransition(task, lane, 'enter', ...)`) and with
 * them the column message, so it re-sent `/code-review`. The desktop's Resume
 * never does. The engine's `executeTransition` is the only door to enter
 * automations and column messages, and autoSpawnForTask is the only path that
 * opens it here, so both staying untouched is the pin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session, Task } from '../../../src/shared/types';

const TASK_ID = 'task-paused';
const PROJECT_ID = 'proj-1';
const LANE = { id: 'lane-review', name: 'Code Review', role: null, permission_mode: null };

let storedTask: Task;
let registryRows: Session[] = [];
let labelDuringGitPhase: string | undefined;

const engine = {
  resumeSuspendedSession: vi.fn(async (): Promise<void> => {
    storedTask = { ...storedTask, session_id: 'sess-resumed' };
  }),
  executeTransition: vi.fn(async (): Promise<void> => {}),
};
const mockAutoSpawnForTask = vi.fn(async (): Promise<void> => {});
const mockEnsureTaskWorktree = vi.fn(async (): Promise<void> => {
  labelDuringGitPhase = getInFlightSpawnProgress()[TASK_ID];
});

interface ReconcileResult {
  task: Task;
  liveSession: Partial<Session> | null;
}

// No live session for the task; the paused pointer is cleared, as the real
// reconcile does for a suspended row. Once the resume has run, the task points
// at the resumed session and that one is live.
function defaultReconcile(..._args: unknown[]): ReconcileResult {
  if (storedTask.session_id === 'sess-resumed') {
    return { task: storedTask, liveSession: { id: 'sess-resumed', taskId: TASK_ID, status: 'running' } };
  }
  return { task: { ...storedTask, session_id: null }, liveSession: null };
}
const mockReconcileTaskSessionRef = vi.fn(defaultReconcile);

const taskRepo = {
  getById: vi.fn(() => storedTask),
  update: vi.fn((patch: Partial<Task> & { id: string }) => {
    storedTask = { ...storedTask, ...patch };
  }),
};
const repos = {
  tasks: taskRepo,
  swimlanes: { getById: vi.fn(() => LANE) },
  automations: {},
  automationRuns: {},
  attachments: {},
};

vi.mock('../../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../../src/main/ipc/helpers', () => ({
  getProjectRepos: () => repos,
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...(args as [])),
  createTransitionEngine: () => engine,
  resolveSpawnOverrides: () => ({}),
}));
vi.mock('../../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: () => repos,
  resolveProjectContext: (_context: unknown, projectId: string | null | undefined) => ({ projectId: projectId ?? null, projectPath: '/mock/project' }),
}));
vi.mock('../../../src/main/ipc/helpers/agent-spawn', () => ({
  autoSpawnForTask: (...args: unknown[]) => mockAutoSpawnForTask(...(args as [])),
}));
vi.mock('../../../src/main/ipc/handlers/session-reconcile', () => ({
  // Overridable per test: startTaskSession calls it for its own decision and
  // the resume's Phase 1 calls it again, so a test can answer differently on
  // each call. beforeEach restores defaultReconcile.
  reconcileTaskSessionRef: (...args: unknown[]) => mockReconcileTaskSessionRef(...args),
}));
vi.mock('../../../src/main/transition-engine/column-strategy', () => ({
  applyProfileToLane: (lane: unknown) => lane,
}));
vi.mock('../../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: () => null,
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleStartSession } from '../../../src/main/mobile-bridge/handlers/start-session';
import { getInFlightSpawnProgress, __resetSpawnProgressForTest } from '../../../src/main/transition-engine/spawn-progress';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'start-session', payload: { taskId: TASK_ID, projectId: PROJECT_ID } };
}

function session(overrides: Partial<Session>): Session {
  return {
    id: 'sess-paused',
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    pid: null,
    status: 'suspended',
    shell: '/bin/bash',
    cwd: '/mock/project',
    startedAt: '2026-10-06T00:00:00.000Z',
    exitCode: null,
    resuming: false,
    ...overrides,
  };
}

function fakeContext(): IpcContext {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, path: '/mock/project' })) },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), cancel: vi.fn() },
    sessionManager: {
      listSessions: () => registryRows,
      getSession: (id: string) => (id === 'sess-resumed' ? session({ id, status: 'running', resuming: true }) : undefined),
      removeByTaskId: vi.fn(),
    },
  } as unknown as IpcContext;
}

describe('start-session: a paused task resumes like the desktop Resume button', () => {
  beforeEach(() => {
    __resetSpawnProgressForTest();
    storedTask = { id: TASK_ID, title: 'Review the PR', swimlane_id: LANE.id, session_id: 'sess-paused', archived_at: null } as Task;
    registryRows = [session({})];
    labelDuringGitPhase = undefined;
    engine.resumeSuspendedSession.mockClear();
    engine.executeTransition.mockClear();
    mockAutoSpawnForTask.mockClear();
    mockEnsureTaskWorktree.mockClear();
    mockReconcileTaskSessionRef.mockReset();
    mockReconcileTaskSessionRef.mockImplementation(defaultReconcile);
  });

  afterEach(() => {
    __resetSpawnProgressForTest();
  });

  it('answers starting, resumes the session, runs no enter automations, sends no column message, and shows the Resuming label', async () => {
    const context = fakeContext();

    const response = await handleStartSession(fakeRequest(), context);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ ok: true, outcome: 'starting' });

    await vi.waitFor(() => expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1));
    // The phone sends no prompt, so the resumed CLI comes up idle, as it does
    // after a desktop Resume (argument 4 is the resume prompt).
    const resumeCall = engine.resumeSuspendedSession.mock.calls[0] as unknown[];
    expect(resumeCall[3]).toBeUndefined();

    // No enter automations, no column message: the column's enter list runs
    // only through executeTransition, reached only from autoSpawnForTask.
    expect(engine.executeTransition).not.toHaveBeenCalled();
    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();

    // The desktop Resume's label, up through the git phase, retired after.
    expect(labelDuringGitPhase).toBe('Resuming session...');
    await vi.waitFor(() => expect(getInFlightSpawnProgress()[TASK_ID]).toBeUndefined());
  });

  it.each([
    ['an exited session', [session({ id: 'sess-ended', status: 'exited', exitCode: 0 })]],
    ['no session at all', []],
  ])('%s still starts the column, enter automations and column message included', async (_label, rows) => {
    storedTask = { ...storedTask, session_id: null };
    registryRows = rows;

    const response = await handleStartSession(fakeRequest(), fakeContext());

    expect(response.payload).toEqual({ ok: true, outcome: 'starting' });
    // autoSpawnForTask -> spawnAgent is the chokepoint that runs the column's
    // enter list, column message included (spawn-agent-explicit-start.test.ts).
    expect(mockAutoSpawnForTask).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      { id: TASK_ID, title: 'Review the PR' },
      LANE.id,
      { explicitStart: true },
    );
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });

  it('answers starting on acceptance, while the git phase is still running', async () => {
    // A deferred the test controls, not a promise that never settles: a hung
    // resume would leave its controller registered and its label up for the
    // next test.
    let releaseGitPhase: () => void = () => {};
    const gitPhase = new Promise<void>((resolve) => {
      releaseGitPhase = resolve;
    });
    mockEnsureTaskWorktree.mockImplementationOnce(async (): Promise<void> => {
      labelDuringGitPhase = getInFlightSpawnProgress()[TASK_ID];
      await gitPhase;
    });

    let answered = false;
    const responsePromise = handleStartSession(fakeRequest(), fakeContext()).then((response) => {
      answered = true;
      return response;
    });

    try {
      // The resume reports acceptance before ensureTaskWorktree, so the phone
      // is answered while the git phase is parked on the deferred. If the
      // answer waited on the git phase, this would stay false.
      await vi.waitFor(() => expect(answered).toBe(true));
      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.payload).toEqual({ ok: true, outcome: 'starting' });

      // The git phase has started and is still pending: the engine's resume,
      // which runs after it, has not been reached, and the card shows the label.
      expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
      expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
      expect(getInFlightSpawnProgress()[TASK_ID]).toBe('Resuming session...');
    } finally {
      releaseGitPhase();
    }

    // Let the resume finish so nothing hangs into the next test.
    await vi.waitFor(() => expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1));
    expect(labelDuringGitPhase).toBe('Resuming session...');
    await vi.waitFor(() => expect(getInFlightSpawnProgress()[TASK_ID]).toBeUndefined());
  });

  it('answers live, spawning nothing, when a session went live between the decision and the resume\'s Phase 1', async () => {
    // startTaskSession reconciles once for its own decision, then the resume's
    // Phase 1 reconciles again. The first call must show NO live session (and
    // the task a suspended one, so the decision picks the resume path); only
    // the second call, inside the resume, finds the session that came up in
    // the gap. A live session on the FIRST call would short-circuit to `live`
    // in the decision and never reach the resume's own acceptance.
    storedTask = { ...storedTask, session_id: null };
    registryRows = [session({})];
    mockReconcileTaskSessionRef
      .mockImplementationOnce(() => ({ task: storedTask, liveSession: null }))
      .mockImplementationOnce(() => ({
        task: storedTask,
        liveSession: { id: 'sess-went-live', taskId: TASK_ID, status: 'running' },
      }));

    const response = await handleStartSession(fakeRequest(), fakeContext());

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ ok: true, outcome: 'live' });
    // Both reconciles ran: the decision's and the resume's Phase 1.
    expect(mockReconcileTaskSessionRef).toHaveBeenCalledTimes(2);
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
    expect(engine.executeTransition).not.toHaveBeenCalled();
    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
    // Phase 1 found a live session, so no label was ever raised.
    expect(getInFlightSpawnProgress()[TASK_ID]).toBeUndefined();
  });
});

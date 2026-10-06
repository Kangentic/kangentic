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
interface TestLane {
  id: string;
  name: string;
  role: string | null;
  permission_mode: string | null;
}
const LANE: TestLane = { id: 'lane-review', name: 'Code Review', role: null, permission_mode: null };
// Where a task sits once it is moved to Done: the column a resume refuses.
const DONE_LANE: TestLane = { id: 'lane-done', name: 'Done', role: 'done', permission_mode: null };

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
  // Keyed by id so a test can move the task to Done by changing the task's
  // column, with nothing to restore afterwards.
  swimlanes: { getById: vi.fn((laneId?: string): TestLane => (laneId === DONE_LANE.id ? DONE_LANE : LANE)) },
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
import { startTaskSession } from '../../../src/main/ipc/handlers/session-start';
import { getInFlightSpawnProgress, onSpawnProgressChange, __resetSpawnProgressForTest } from '../../../src/main/transition-engine/spawn-progress';
import { resumeBlockMessage } from '../../../src/shared/session-resume-eligibility';
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

  it('refuses with the desktop Done copy, raising no label, when the task reached Done between the decision and the resume\'s Phase 1', async () => {
    // The decision reads the task in its own column, so it passes and picks the
    // resume path. The resume's Phase 1 reads the task again and finds it in
    // Done (the move to Done landed in the gap), so ITS refusal is the one
    // that fires. A decision that already saw Done would refuse before any
    // resume existed and could not tell the two checks apart.
    mockReconcileTaskSessionRef
      .mockImplementationOnce(() => ({ task: storedTask, liveSession: null }))
      .mockImplementationOnce(() => ({ task: { ...storedTask, swimlane_id: DONE_LANE.id }, liveSession: null }));
    const labelPushes: Array<string | null> = [];
    const stopListening = onSpawnProgressChange((taskId, label) => {
      if (taskId === TASK_ID) labelPushes.push(label);
    });

    try {
      // This harness has no capability router, so the refusal surfaces as the
      // handler's rejection; the router turns that into the phone's ok:false.
      await expect(handleStartSession(fakeRequest(), fakeContext())).rejects.toThrow(resumeBlockMessage('done'));
    } finally {
      stopListening();
    }

    // Both reconciles ran, so the refusal came from the resume's own Phase 1.
    expect(mockReconcileTaskSessionRef).toHaveBeenCalledTimes(2);
    // The refusal is before acceptance: no label was pushed, not even a
    // raised-then-cleared one, and nothing downstream of Phase 1 ran.
    expect(labelPushes).toEqual([]);
    expect(getInFlightSpawnProgress()[TASK_ID]).toBeUndefined();
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(engine.executeTransition).not.toHaveBeenCalled();
    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
  });

  describe('when the git phase fails after the phone was answered', () => {
    /**
     * Parks the git phase on a deferred the test rejects, so the rejection
     * lands AFTER the answer by construction instead of by microtask order.
     */
    function armFailingGitPhase(): { failGitPhase: (error: Error) => void } {
      let failGitPhase: (error: Error) => void = () => {};
      const gitPhase = new Promise<void>((_resolve, reject) => {
        failGitPhase = reject;
      });
      // Handled up front: the mock below awaits it, but a test that fails
      // before the git phase starts must not add an unhandled rejection.
      gitPhase.catch(() => {});
      mockEnsureTaskWorktree.mockImplementationOnce(async (): Promise<void> => {
        labelDuringGitPhase = getInFlightSpawnProgress()[TASK_ID];
        await gitPhase;
      });
      return { failGitPhase };
    }

    it('answers starting, then settled rejects with the worktree failure and the Resuming label is retired', async () => {
      const { failGitPhase } = armFailingGitPhase();
      let settled: Promise<void> | undefined;

      try {
        const result = await startTaskSession(fakeContext(), PROJECT_ID, TASK_ID);
        if (result.outcome !== 'starting') throw new Error(`expected outcome starting, got ${result.outcome}`);
        settled = result.settled;

        // Answered with the git phase still parked: the label is up and the
        // engine's resume, which runs after it, has not been reached.
        expect(labelDuringGitPhase).toBe('Resuming session...');
        expect(getInFlightSpawnProgress()[TASK_ID]).toBe('Resuming session...');
        expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
      } finally {
        failGitPhase(new Error('fetch failed'));
      }

      await expect(settled).rejects.toThrow('Worktree setup failed: fetch failed');
      // The claim's release runs in a finally before the rejection propagates,
      // so the label is already gone by the time settled has rejected.
      expect(getInFlightSpawnProgress()[TASK_ID]).toBeUndefined();
      expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
    });

    it('the bridge handler still answers starting and logs the failure instead of leaving a rejection unhandled', async () => {
      const { failGitPhase } = armFailingGitPhase();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const response = await handleStartSession(fakeRequest(), fakeContext());
        expect(response.ok).toBe(true);
        expect(response.payload).toEqual({ ok: true, outcome: 'starting' });

        failGitPhase(new Error('fetch failed'));

        // The handler's own catch on settled logs it; a missing catch would
        // surface as an unhandled rejection, which fails the vitest run.
        await vi.waitFor(() => {
          expect(consoleErrorSpy.mock.calls.some(([message]) => typeof message === 'string' && message.includes('failed after accept'))).toBe(true);
        });
        const loggedCall = consoleErrorSpy.mock.calls.find(([message]) => typeof message === 'string' && message.includes('failed after accept'));
        expect((loggedCall?.[1] as Error).message).toContain('Worktree setup failed: fetch failed');
        expect(getInFlightSpawnProgress()[TASK_ID]).toBeUndefined();
      } finally {
        failGitPhase(new Error('fetch failed'));
        consoleErrorSpy.mockRestore();
      }
    });
  });
});

/**
 * `resumeTaskSession` (src/main/ipc/handlers/session-resume.ts) refuses a task
 * its row already shows in To Do, in Done, or archived BEFORE it queues on the
 * task lock (`resumeRefusalBeforeLock`).
 *
 * A task's own agent moved it to Done. The move holds the task lock through its
 * suspend, reap and worktree removal (17 s on a project with a large
 * `node_modules`), and a Resume clicked meanwhile queued behind all of it, only
 * to be refused once it got the lock.
 *
 * Runs the REAL resumeTaskSession, the REAL task lock and the REAL resume
 * controller registry; the repositories, the git helpers and the engine stand in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, Task } from '../../src/shared/types';

const TASK_ID = 'task-resume-before-lock';
const PROJECT_ID = 'proj-1';
const DONE_MESSAGE = 'This task is complete. Move it out of Done to continue working on it.';

const TESTING = { id: 'lane-testing', name: 'Testing', role: null, permission_mode: null, auto_spawn: true, is_ghost: false };
const DONE = { id: 'lane-done', name: 'Done', role: 'done', permission_mode: null, auto_spawn: false, is_ghost: false };
const LANES = new Map([[TESTING.id, TESTING], [DONE.id, DONE]]);

let storedTask: Task;
let liveSession: Session | null;
// Whether the task row has been deleted: `tasks.getById` then reads undefined,
// and the reconcile stand-in throws what the real one throws for it.
let taskRowMissing = false;

const engine = {
  resumeSuspendedSession: vi.fn(async (): Promise<void> => {
    storedTask = { ...storedTask, session_id: 'sess-resumed' };
  }),
};

const repos = {
  tasks: { getById: vi.fn((): Task | undefined => (taskRowMissing ? undefined : storedTask)), update: vi.fn() },
  swimlanes: {
    getById: vi.fn((laneId: string) => LANES.get(laneId)),
    list: vi.fn(() => [...LANES.values()]),
  },
  automations: {},
  automationRuns: {},
  attachments: {},
};

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask() { return { status: 'suspended', suspended_at: '2026-10-29T23:17:23.932Z' }; }
  },
}));
vi.mock('../../src/main/db/repositories/task-move-repository', () => ({
  TaskMoveRepository: class {
    currentVisit() { return null; }
  },
}));
const mockEnsureTaskWorktree = vi.fn(async (): Promise<void> => {});
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: () => repos,
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...(args as [])),
  createTransitionEngine: () => engine,
  resolveSpawnOverrides: () => ({}),
  spawnAgent: vi.fn(async (): Promise<void> => {}),
}));
const mockResolveProjectContext = vi.fn(
  (_context: unknown, projectId: string | null | undefined) => ({ projectId: projectId ?? null, projectPath: '/mock/project' }),
);
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: (...args: Parameters<typeof mockResolveProjectContext>) => mockResolveProjectContext(...args),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  reconcileTaskSessionRef: (_context: unknown, _projectId: string, taskId: string) => {
    // What the real reconcile does for a deleted task row
    // (src/main/ipc/handlers/session-reconcile.ts).
    if (taskRowMissing) throw new Error(`Task ${taskId} not found`);
    return { task: storedTask, liveSession };
  },
}));
vi.mock('../../src/main/transition-engine/column-strategy', () => ({
  applyProfileToLane: (lane: unknown) => lane,
}));
vi.mock('../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: () => null,
}));

import { resumeTaskSession } from '../../src/main/ipc/handlers/session-resume';
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';
import { registerResumeController, releaseResumeController } from '../../src/main/ipc/handlers/session-resume-controllers';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function fakeContext(currentProjectId: string | null = PROJECT_ID): IpcContext {
  return {
    currentProjectId,
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, path: '/mock/project' })) },
    sessionManager: {
      findLiveSessionByTaskId: vi.fn(() => liveSession ?? undefined),
      getSession: (id: string) => (id === 'sess-resumed' ? ({ id, taskId: TASK_ID, status: 'running' } as Session) : undefined),
    },
  } as unknown as IpcContext;
}

function inColumn(lane: { id: string }, archivedAt: string | null): void {
  storedTask = { id: TASK_ID, title: 'Release v1.3.0', swimlane_id: lane.id, session_id: null, archived_at: archivedAt } as Task;
}

/**
 * Holds the task lock the way a move to Done does through its teardown, until
 * the returned release is called. Resolves once the holder has the lock.
 */
async function holdTaskLock(): Promise<() => void> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let acquired: () => void = () => {};
  const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
  void withTaskLock(TASK_ID, async () => {
    acquired();
    await held;
  });
  await acquiredPromise;
  return release;
}

/** Whether `promise` has settled after the queued microtasks and one macrotask have run. */
async function settlesNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

describe('resumeTaskSession refuses before the task lock', () => {
  beforeEach(() => {
    engine.resumeSuspendedSession.mockClear();
    mockEnsureTaskWorktree.mockClear();
    // Reset, not just cleared: a case below queues a one-shot throw on each of
    // these, and a case that failed before consuming it must not leak the throw
    // into the next one. A reset restores the implementation given to `vi.fn`.
    repos.tasks.getById.mockReset();
    repos.swimlanes.getById.mockReset();
    mockResolveProjectContext.mockReset();
    liveSession = null;
    taskRowMissing = false;
  });

  it('refuses an archived task in Done at once while a move to Done still holds the lock', async () => {
    inColumn(DONE, '2026-10-29T23:17:16.630Z');
    const release = await holdTaskLock();
    try {
      const resume = resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      // Red before the pre-check: the resume queued behind the holder and
      // settled only after release().
      expect(await settlesNow(resume)).toBe(true);
      await expect(resume).rejects.toThrow(DONE_MESSAGE);
      expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
      expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('lets an archived task with a live PTY through, so the locked self-heal hands that PTY back', async () => {
    inColumn(DONE, '2026-10-29T23:17:16.630Z');
    liveSession = { id: 'sess-live', taskId: TASK_ID, status: 'running' } as Session;
    const release = await holdTaskLock();

    const resume = resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });
    // Released in a `finally` so a failed assertion cannot leave TASK_ID's lock
    // held and time out every later case.
    try {
      // Not refused: it waits for the lock like any resume.
      expect(await settlesNow(resume)).toBe(false);
    } finally {
      release();
    }

    await expect(resume).resolves.toMatchObject({ id: 'sess-live' });
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('leaves a resume already in flight alone when it refuses', async () => {
    // A refused click must not cancel another resume: the pre-check runs
    // before abortInFlightResume.
    inColumn(DONE, '2026-10-29T23:17:16.630Z');
    const inFlight = new AbortController();
    registerResumeController(TASK_ID, inFlight);
    try {
      await expect(resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID })).rejects.toThrow(DONE_MESSAGE);
      expect(inFlight.signal.aborted).toBe(false);
    } finally {
      releaseResumeController(TASK_ID, inFlight);
    }
  });

  it('still refuses under the lock when the move to Done commits after the pre-check', async () => {
    // The pre-check is an early exit only. A resume that passed it while the
    // task was still in Testing is refused by Phase 1 once the move lets go.
    inColumn(TESTING, null);
    const release = await holdTaskLock();

    const resume = resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });
    try {
      expect(await settlesNow(resume)).toBe(false);
      inColumn(DONE, '2026-10-29T23:17:16.630Z');
    } finally {
      release();
    }

    await expect(resume).rejects.toThrow(DONE_MESSAGE);
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  });

  it('resumes a task its row does not refuse', async () => {
    inColumn(TESTING, null);

    const session = await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(session?.id).toBe('sess-resumed');
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('refuses nothing before the lock for a task whose row is gone, and the locked path reports it', async () => {
    taskRowMissing = true;
    const release = await holdTaskLock();

    let resume: Promise<Session | null> | null = null;
    // Released in a `finally` so a failed assertion cannot leave TASK_ID's lock
    // held and time out every later case.
    try {
      resume = resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });
      // Not refused at once: with no row to read, the pre-check has nothing to
      // refuse, so the resume queues for the lock like any other.
      expect(await settlesNow(resume)).toBe(false);
    } finally {
      release();
    }

    // The locked reconcile's own error, not the Done copy.
    await expect(resume).rejects.toThrow(`Task ${TASK_ID} not found`);
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('falls through to the locked path when a pre-check read throws', async () => {
    inColumn(TESTING, null);
    // The pre-check is the first reader of the lane, so it takes this one-shot.
    repos.swimlanes.getById.mockImplementationOnce(() => { throw new Error('lane read failed'); });

    const session = await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(repos.swimlanes.getById.mock.results[0]?.type).toBe('throw');
    expect(session?.id).toBe('sess-resumed');
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('reads nothing before the lock and rejects when no project is open', async () => {
    // A task the pre-check would refuse: a pre-check that ran anyway would
    // reject with the Done copy instead of the no-project error.
    inColumn(DONE, '2026-10-29T23:17:16.630Z');

    await expect(resumeTaskSession(fakeContext(null), TASK_ID)).rejects.toThrow('No project is currently open');

    expect(repos.tasks.getById).not.toHaveBeenCalled();
    expect(repos.swimlanes.getById).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('never throws synchronously, even when the project lookup throws', async () => {
    inColumn(TESTING, null);
    mockResolveProjectContext.mockImplementationOnce(() => { throw new Error('project lookup failed'); });

    // Callers chain on the returned promise, so a failure must arrive as a
    // rejection. Red when the pre-check calls resolveProjectContext outside the
    // async body: the lookup then throws before there is a promise.
    let resume: Promise<Session | null> | null = null;
    expect(() => {
      resume = resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });
    }).not.toThrow();

    await expect(resume).rejects.toThrow('project lookup failed');
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });
});

/**
 * startTaskSession (src/main/ipc/handlers/session-start.ts) is the shared
 * body of the phone's start-session verb: spawn or resume a task's session in
 * the column it is already in, the bridge twin of the desktop's Resume button.
 *
 * What this file pins:
 *
 * 1. The stale-pointer reconcile runs FIRST, under the task lock. A natural
 *    agent exit leaves `task.session_id` pointing at an exited registry row,
 *    and `spawnAgent`'s `startAgent` bails on any `session_id`, so a start
 *    that skipped the reconcile would run the enter list and spawn nothing.
 * 2. A live session is an idempotent no-op: nothing is spawned.
 * 3. To Do, Done, and an archived task refuse with the desktop's own Resume
 *    copy (`resumeBlockMessage`), and nothing is spawned.
 * 4. The spawn routes through `autoSpawnForTask` with `explicitStart`, and
 *    the task lock is RELEASED before that call: `withTaskLock` is not
 *    reentrant and `autoSpawnForTask` takes its own.
 * 5. The result carries the spawn's `settled` promise rather than awaiting
 *    it, which is what lets the bridge answer inside the phone's budget.
 * 6. A PAUSED task (a `suspended` registry row) takes the desktop Resume
 *    button's path, `resumeTaskSession`, never `autoSpawnForTask`, and the
 *    answer follows that path's own Phase 1 (`live` or `starting`). An exited
 *    row, and a suspended Command Terminal row (`transient`), are not paused
 *    and still start the column.
 *
 * session-resume-eligibility.ts is deliberately left unmocked: the refusal
 * copy is exactly what a phone shows, so the test asserts the real strings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, Task } from '../../src/shared/types';

const mockReconcileTaskSessionRef = vi.fn();
const mockSwimlaneGetById = vi.fn();
const mockAutoSpawnForTask = vi.fn(async () => {});
type ResumeOptions = { projectId?: string | null; onAccepted?: (acceptance: 'live' | 'resuming') => void };
const mockResumeTaskSession = vi.fn(
  async (_context: unknown, _taskId: string, options: ResumeOptions): Promise<Session | null> => {
    options.onAccepted?.('resuming');
    return null;
  },
);

/** Lock nesting depth at the moment each autoSpawnForTask or resumeTaskSession call was made. */
const autoSpawnLockDepths: number[] = [];
const resumeLockDepths: number[] = [];
let lockDepth = 0;

vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn(async (_taskId: string, fn: () => Promise<unknown>) => {
    lockDepth += 1;
    try {
      return await fn();
    } finally {
      lockDepth -= 1;
    }
  }),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    swimlanes: { getById: (...args: unknown[]) => mockSwimlaneGetById(...args) },
  })),
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  autoSpawnForTask: (...args: unknown[]) => {
    autoSpawnLockDepths.push(lockDepth);
    return mockAutoSpawnForTask(...(args as []));
  },
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  reconcileTaskSessionRef: (...args: unknown[]) => mockReconcileTaskSessionRef(...args),
}));
vi.mock('../../src/main/ipc/handlers/session-resume', () => ({
  resumeTaskSession: (context: unknown, taskId: string, options: ResumeOptions) => {
    resumeLockDepths.push(lockDepth);
    return mockResumeTaskSession(context, taskId, options);
  },
}));

import { startTaskSession } from '../../src/main/ipc/handlers/session-start';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const PROJECT_ID = 'proj-1';
const TASK_ID = 'task-1';
const LANE_ID = 'lane-working';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'Ship the thing',
    swimlane_id: LANE_ID,
    session_id: null,
    archived_at: null,
    ...overrides,
  } as Task;
}

/** The registry rows `listSessions` reports; empty means the task has no session at all. */
let registryRows: Array<Pick<Session, 'id' | 'taskId' | 'status' | 'transient'>> = [];

function makeContext(): IpcContext {
  return { sessionManager: { listSessions: () => registryRows } } as unknown as IpcContext;
}

describe('startTaskSession', () => {
  beforeEach(() => {
    mockReconcileTaskSessionRef.mockReset();
    mockSwimlaneGetById.mockReset();
    mockAutoSpawnForTask.mockClear();
    mockResumeTaskSession.mockClear();
    autoSpawnLockDepths.length = 0;
    resumeLockDepths.length = 0;
    registryRows = [];
    lockDepth = 0;
    mockSwimlaneGetById.mockReturnValue({ id: LANE_ID, name: 'Working', role: null });
  });

  it('reconciles the stale session pointer under the lock before deciding anything', async () => {
    mockReconcileTaskSessionRef.mockImplementation(() => {
      expect(lockDepth).toBe(1);
      return { task: makeTask(), liveSession: null };
    });

    await startTaskSession(makeContext(), PROJECT_ID, TASK_ID);

    expect(mockReconcileTaskSessionRef).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, TASK_ID);
    expect(mockReconcileTaskSessionRef).toHaveBeenCalledTimes(1);
  });

  it('returns live and spawns nothing when the task already has a running session', async () => {
    const liveSession = { id: 'sess-live', taskId: TASK_ID, status: 'running' } as Session;
    mockReconcileTaskSessionRef.mockReturnValue({ task: makeTask({ session_id: 'sess-live' }), liveSession });

    const result = await startTaskSession(makeContext(), PROJECT_ID, TASK_ID);

    expect(result).toEqual({ outcome: 'live' });
    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
    // The eligibility gate never runs for a live session: handing back a
    // session that already exists spawns nothing, and it is the path that
    // re-attaches a drifted view, exactly as SESSION_RESUME's self-heal does.
    expect(mockSwimlaneGetById).not.toHaveBeenCalled();
  });

  it.each([
    ['todo', 'Cannot resume a session for a task in the To Do column'],
    ['done', 'This task is complete. Move it out of Done to continue working on it.'],
  ])('refuses a task in a %s column with the desktop Resume copy and spawns nothing', async (role, message) => {
    mockReconcileTaskSessionRef.mockReturnValue({ task: makeTask(), liveSession: null });
    mockSwimlaneGetById.mockReturnValue({ id: LANE_ID, name: 'Role lane', role });

    await expect(startTaskSession(makeContext(), PROJECT_ID, TASK_ID)).rejects.toThrow(message);
    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
  });

  it('refuses an archived task in a custom column and spawns nothing', async () => {
    mockReconcileTaskSessionRef.mockReturnValue({
      task: makeTask({ archived_at: '2026-09-01T00:00:00.000Z' }),
      liveSession: null,
    });

    await expect(startTaskSession(makeContext(), PROJECT_ID, TASK_ID)).rejects.toThrow(
      'This task is archived. Restore it to the board to continue working on it.',
    );
    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
  });

  it('throws naming the column and the task when the task\'s column no longer exists', async () => {
    mockReconcileTaskSessionRef.mockReturnValue({ task: makeTask(), liveSession: null });
    // resumeBlockReasonForTask with no lane role and no archived_at returns
    // null, so this is what reaches the `if (!lane) throw` line rather than
    // the archived/role refusal above it.
    mockSwimlaneGetById.mockReturnValue(undefined);

    await expect(startTaskSession(makeContext(), PROJECT_ID, TASK_ID)).rejects.toThrow(
      `Column ${LANE_ID} not found for task ${TASK_ID}`,
    );
    expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
  });

  it('treats a task assembled with archived_at undefined as not archived, since only null is the default', async () => {
    // The inline comment on the real `Boolean(task.archived_at)` call explains
    // why: a Task assembled without the column carries `undefined`, which a
    // `!== null` comparison would misread as archived.
    mockReconcileTaskSessionRef.mockReturnValue({
      task: makeTask({ archived_at: undefined }),
      liveSession: null,
    });

    const result = await startTaskSession(makeContext(), PROJECT_ID, TASK_ID);

    expect(result.outcome).toBe('starting');
    expect(mockAutoSpawnForTask).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      { id: TASK_ID, title: 'Ship the thing' },
      LANE_ID,
      { explicitStart: true },
    );
  });

  it('starts through autoSpawnForTask with explicitStart, in the current column, after releasing the lock', async () => {
    mockReconcileTaskSessionRef.mockReturnValue({ task: makeTask(), liveSession: null });

    const context = makeContext();
    const result = await startTaskSession(context, PROJECT_ID, TASK_ID);

    expect(result.outcome).toBe('starting');
    expect(mockAutoSpawnForTask).toHaveBeenCalledTimes(1);
    expect(mockAutoSpawnForTask).toHaveBeenCalledWith(
      context,
      PROJECT_ID,
      { id: TASK_ID, title: 'Ship the thing' },
      LANE_ID,
      { explicitStart: true },
    );
    // withTaskLock is not reentrant and autoSpawnForTask takes its own, so
    // the call must land OUTSIDE this function's lock. A nested call here
    // would deadlock in production.
    expect(autoSpawnLockDepths).toEqual([0]);
  });

  it('hands back the spawn as a settled promise instead of awaiting it', async () => {
    mockReconcileTaskSessionRef.mockReturnValue({ task: makeTask(), liveSession: null });
    // A spawn that never settles: the phone's budget is 10s and the worktree
    // ensure alone can outlast it. The result must still come back.
    mockAutoSpawnForTask.mockImplementationOnce(() => new Promise<void>(() => {}));

    const result = await startTaskSession(makeContext(), PROJECT_ID, TASK_ID);

    expect(result.outcome).toBe('starting');
    if (result.outcome !== 'starting') throw new Error('unreachable');
    expect(result.settled).toBeInstanceOf(Promise);
  });

  describe('a paused task takes the Resume button\'s path', () => {
    beforeEach(() => {
      mockReconcileTaskSessionRef.mockReturnValue({ task: makeTask(), liveSession: null });
    });

    it('resumes through resumeTaskSession, never autoSpawnForTask, after releasing the lock', async () => {
      // The suspended row survives the reconcile, which clears only the pointer.
      registryRows = [{ id: 'sess-paused', taskId: TASK_ID, status: 'suspended' }];
      const context = makeContext();

      const result = await startTaskSession(context, PROJECT_ID, TASK_ID);

      expect(result.outcome).toBe('starting');
      expect(mockResumeTaskSession).toHaveBeenCalledTimes(1);
      expect(mockResumeTaskSession).toHaveBeenCalledWith(context, TASK_ID, expect.objectContaining({ projectId: PROJECT_ID }));
      // No column start: that is the path that re-runs the enter automations.
      expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
      // resumeTaskSession takes its own lock, and withTaskLock is not reentrant.
      expect(resumeLockDepths).toEqual([0]);
    });

    it('answers live when the resume\'s own Phase 1 finds a live session', async () => {
      registryRows = [{ id: 'sess-paused', taskId: TASK_ID, status: 'suspended' }];
      mockResumeTaskSession.mockImplementationOnce(async (_context, _taskId, options) => {
        options.onAccepted?.('live');
        return { id: 'sess-live', taskId: TASK_ID, status: 'running' } as Session;
      });

      expect(await startTaskSession(makeContext(), PROJECT_ID, TASK_ID)).toEqual({ outcome: 'live' });
    });

    it('answers on acceptance while the resume\'s git phase is still running', async () => {
      registryRows = [{ id: 'sess-paused', taskId: TASK_ID, status: 'suspended' }];
      mockResumeTaskSession.mockImplementationOnce((_context, _taskId, options) => {
        options.onAccepted?.('resuming');
        return new Promise<Session | null>(() => {});
      });

      const result = await startTaskSession(makeContext(), PROJECT_ID, TASK_ID);

      expect(result.outcome).toBe('starting');
    });

    it('answers starting, and settled resolves, when a Pause or newer resume cancels the resume before it ever accepts', async () => {
      registryRows = [{ id: 'sess-paused', taskId: TASK_ID, status: 'suspended' }];
      // resumeTaskSession resolves null WITHOUT calling onAccepted when its
      // signal aborts while it waits for the task lock (the throwIfAborted at
      // the top of its Phase 1). Awaiting `accepted` alone would hang here
      // forever, so the short timeout below reads a hang as a failure.
      mockResumeTaskSession.mockImplementationOnce(async () => null);

      const result = await startTaskSession(makeContext(), PROJECT_ID, TASK_ID);

      expect(result.outcome).toBe('starting');
      if (result.outcome !== 'starting') throw new Error('unreachable');
      await expect(result.settled).resolves.toBeUndefined();
      // The resume path ran and no column start was made in its place.
      expect(mockResumeTaskSession).toHaveBeenCalledTimes(1);
      expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
    }, 2000);

    // The other half of that race, a resume that REJECTS before accepting, is
    // pinned by the test below and by start-session-resume-path.test.ts.
    it('rejects with the resume\'s own refusal when its Phase 1 throws before accepting', async () => {
      registryRows = [{ id: 'sess-paused', taskId: TASK_ID, status: 'suspended' }];
      mockResumeTaskSession.mockImplementationOnce(async () => {
        throw new Error('This task is complete. Move it out of Done to continue working on it.');
      });

      await expect(startTaskSession(makeContext(), PROJECT_ID, TASK_ID)).rejects.toThrow('Move it out of Done');
    });

    it('a paused task in Done is refused by the decision itself, before any resume', async () => {
      registryRows = [{ id: 'sess-paused', taskId: TASK_ID, status: 'suspended' }];
      mockSwimlaneGetById.mockReturnValue({ id: LANE_ID, name: 'Done', role: 'done' });

      await expect(startTaskSession(makeContext(), PROJECT_ID, TASK_ID)).rejects.toThrow('Move it out of Done');
      expect(mockResumeTaskSession).not.toHaveBeenCalled();
      expect(mockAutoSpawnForTask).not.toHaveBeenCalled();
    });

    it.each([
      ['an exited session', [{ id: 'sess-ended', taskId: TASK_ID, status: 'exited' as const }]],
      ['another task\'s paused session', [{ id: 'sess-other', taskId: 'task-other', status: 'suspended' as const }]],
      // Same task id and `suspended`, so only the transient flag keeps it from
      // being the task's paused session: a Command Terminal is never resumed.
      ['a suspended Command Terminal row carrying the same task id', [{ id: 'sess-terminal', taskId: TASK_ID, status: 'suspended' as const, transient: true }]],
      ['no session at all', []],
    ])('%s still starts the column through autoSpawnForTask', async (_label, rows) => {
      registryRows = rows;

      const result = await startTaskSession(makeContext(), PROJECT_ID, TASK_ID);

      expect(result.outcome).toBe('starting');
      expect(mockAutoSpawnForTask).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, { id: TASK_ID, title: 'Ship the thing' }, LANE_ID, { explicitStart: true });
      expect(mockResumeTaskSession).not.toHaveBeenCalled();
    });
  });
});

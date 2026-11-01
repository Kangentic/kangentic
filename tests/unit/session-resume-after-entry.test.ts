/**
 * `resumeTaskSession` (src/main/ipc/handlers/session-resume.ts) for a task that
 * entered its column after its agent was paused (#929).
 *
 * A move never starts a paused agent: it runs the column's enter rows that need
 * no agent and leaves the rest for the Resume. So a Resume whose paused
 * conversation predates the task's entry into its column does what that entry
 * would have done, through `spawnAgent` with `resumesEntry`: the column's own
 * session strategy (a fresh conversation in an isolated Code Review) and its
 * rows that need the agent (the `/code-review` message). #919's workflow was
 * paused in Code Review, its card was moved to Executing and back, and the
 * Resume reopened the old Code Review conversation with no message.
 *
 * A Resume of a task that has not changed column since its pause continues the
 * same conversation, as before, and so does one in a column that starts no
 * agent.
 *
 * Runs the REAL resumeTaskSession and its task lock; the repositories, the git
 * helpers, the engine and `spawnAgent` stand in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, Task } from '../../src/shared/types';

const TASK_ID = 'task-919';
const PROJECT_ID = 'proj-1';
const PAUSED_AT = '2026-10-28T13:00:37.505Z';
const ONE_MS_AFTER_PAUSE = '2026-10-28T13:00:37.506Z';
const ENTERED_BEFORE_PAUSE = '2026-10-28T03:17:55.817Z';
const ENTERED_AFTER_PAUSE = '2026-10-28T13:05:50.486Z';

interface TestLane {
  id: string;
  name: string;
  role: string | null;
  permission_mode: string | null;
  auto_spawn: boolean;
  is_ghost: boolean;
}
const CODE_REVIEW: TestLane = { id: 'lane-review', name: 'Code Review', role: null, permission_mode: null, auto_spawn: true, is_ghost: false };
const HUMAN_GATE: TestLane = { id: 'lane-gate', name: 'Sign-off', role: null, permission_mode: null, auto_spawn: false, is_ghost: false };
const EXECUTING: TestLane = { id: 'lane-executing', name: 'Executing', role: null, permission_mode: null, auto_spawn: true, is_ghost: false };
const DONE: TestLane = { id: 'lane-done', name: 'Done', role: 'done', permission_mode: null, auto_spawn: false, is_ghost: false };
const LANES = new Map([
  [EXECUTING.id, EXECUTING],
  [CODE_REVIEW.id, CODE_REVIEW],
  [HUMAN_GATE.id, HUMAN_GATE],
  [DONE.id, DONE],
]);

type RecordedEntry = { at: string; origin: string; from_swimlane_id: string | null } | null;

let storedTask: Task;
let pausedRecord: { status: string; suspended_at: string | null } | undefined;
let entry: RecordedEntry;

const engine = {
  resumeSuspendedSession: vi.fn(async (): Promise<void> => {
    storedTask = { ...storedTask, session_id: 'sess-resumed' };
  }),
};
const mockSpawnAgent = vi.fn(async (): Promise<void> => {
  storedTask = { ...storedTask, session_id: 'sess-resumed' };
});

const mockCurrentVisit = vi.fn<(taskId: string, swimlaneId: string) => RecordedEntry>(() => entry);

const repos = {
  tasks: { getById: vi.fn(() => storedTask), update: vi.fn() },
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
    getLatestForTask() { return pausedRecord; }
  },
}));
vi.mock('../../src/main/db/repositories/task-move-repository', () => ({
  TaskMoveRepository: class {
    currentVisit(taskId: string, swimlaneId: string) { return mockCurrentVisit(taskId, swimlaneId); }
  },
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: () => repos,
  ensureTaskWorktree: vi.fn(async (): Promise<void> => {}),
  createTransitionEngine: () => engine,
  resolveSpawnOverrides: () => ({ forceFresh: true }),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...(args as [])),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: (_context: unknown, projectId: string | null | undefined) => ({ projectId: projectId ?? null, projectPath: '/mock/project' }),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  reconcileTaskSessionRef: () => (storedTask.session_id === 'sess-resumed'
    ? { task: storedTask, liveSession: { id: 'sess-resumed', taskId: TASK_ID, status: 'running' } }
    : { task: { ...storedTask, session_id: null }, liveSession: null }),
}));
vi.mock('../../src/main/transition-engine/column-strategy', () => ({
  applyProfileToLane: (lane: unknown) => lane,
}));
vi.mock('../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: () => null,
}));

import { resumeTaskSession } from '../../src/main/ipc/handlers/session-resume';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function fakeContext(): IpcContext {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, path: '/mock/project' })) },
    sessionManager: {
      getSession: (id: string) => (id === 'sess-resumed' ? ({ id, taskId: TASK_ID, status: 'running' } as Session) : undefined),
    },
  } as unknown as IpcContext;
}

function inColumn(lane: TestLane): void {
  storedTask = { id: TASK_ID, title: 'Multiple languages', swimlane_id: lane.id, session_id: null, archived_at: null } as Task;
}

describe('resumeTaskSession after the task entered its column paused', () => {
  beforeEach(() => {
    engine.resumeSuspendedSession.mockClear();
    mockSpawnAgent.mockClear();
    mockCurrentVisit.mockClear();
    pausedRecord = { status: 'suspended', suspended_at: PAUSED_AT };
    entry = { at: ENTERED_AFTER_PAUSE, origin: 'mobile', from_swimlane_id: EXECUTING.id };
    inColumn(CODE_REVIEW);
  });

  it('starts the column as its entry would have, through spawnAgent with resumesEntry', async () => {
    const session = await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID, resumePrompt: 'Carry on.' });

    expect(session?.id).toBe('sess-resumed');
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      toLane: CODE_REVIEW,
      fromSwimlaneId: 'lane-executing',
      skipPromptTemplate: true,
      continuationPrompt: 'Carry on.',
      resumesEntry: true,
    }));
  });

  it('resolves null and reports nothing more when that start started no agent, since spawnAgent reports its own failure', async () => {
    mockSpawnAgent.mockImplementationOnce(async () => {});
    const onFailed = vi.fn();

    const session = await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID, onFailed });

    expect(session).toBeNull();
    expect(onFailed).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('continues the paused conversation when the task has not changed column since the pause', async () => {
    entry = { at: ENTERED_BEFORE_PAUSE, origin: 'agent', from_swimlane_id: 'lane-executing' };

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    // Argument 8 is the spawn overrides: an always-new column's fresh start is for entry only.
    const overrides = (engine.resumeSuspendedSession.mock.calls[0] as unknown[])[7];
    expect(overrides).toMatchObject({ forceFresh: false });
  });

  it('continues the paused conversation in a column that starts no agent', async () => {
    inColumn(HUMAN_GATE);

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('continues the paused conversation when no entry into the column was recorded', async () => {
    entry = null;

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('continues the conversation when the latest record is not a paused one', async () => {
    pausedRecord = { status: 'exited', suspended_at: null };

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('continues the conversation when the latest record is not a paused one even though it carries a pause time', async () => {
    pausedRecord = { status: 'exited', suspended_at: PAUSED_AT };

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  it('continues the conversation when the paused record has no pause time to compare the entry against', async () => {
    pausedRecord = { status: 'suspended', suspended_at: null };

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
  });

  describe('looking up the entry', () => {
    it('asks for the visit that put this task in its current column', async () => {
      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(mockCurrentVisit).toHaveBeenCalledWith(TASK_ID, CODE_REVIEW.id);
    });

    it('does not count an entry recorded at the very moment of the pause as one made while paused', async () => {
      entry = { at: PAUSED_AT, origin: 'agent', from_swimlane_id: EXECUTING.id };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(mockSpawnAgent).not.toHaveBeenCalled();
      expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    });

    it('counts an entry recorded one millisecond after the pause', async () => {
      entry = { at: ONE_MS_AFTER_PAUSE, origin: 'agent', from_swimlane_id: EXECUTING.id };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    });

    it('hands spawnAgent the wildcard source column when the entry has no recorded source', async () => {
      entry = { at: ENTERED_AFTER_PAUSE, origin: 'agent', from_swimlane_id: null };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        toLane: CODE_REVIEW,
        fromSwimlaneId: '*',
        resumesEntry: true,
      }));
    });
  });

  describe('an entry out of Done is a recovery move', () => {
    it('suppresses the column auto command when the entry came out of the Done column', async () => {
      entry = { at: ENTERED_AFTER_PAUSE, origin: 'agent', from_swimlane_id: DONE.id };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        fromSwimlaneId: DONE.id,
        suppressAutoCommand: true,
      }));
    });

    it('keeps the column auto command when the entry came out of an ordinary column', async () => {
      entry = { at: ENTERED_AFTER_PAUSE, origin: 'agent', from_swimlane_id: EXECUTING.id };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        fromSwimlaneId: EXECUTING.id,
        suppressAutoCommand: false,
      }));
    });

    it('keeps the column auto command when the entry has no recorded source', async () => {
      entry = { at: ENTERED_AFTER_PAUSE, origin: 'agent', from_swimlane_id: null };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({ suppressAutoCommand: false }));
    });

    it('keeps the column auto command when the entry came out of a column no longer on the board', async () => {
      entry = { at: ENTERED_AFTER_PAUSE, origin: 'agent', from_swimlane_id: 'lane-deleted' };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        fromSwimlaneId: 'lane-deleted',
        suppressAutoCommand: false,
      }));
    });
  });

  // Task #952. A resume Kangentic makes for the workflow's memory pause names
  // itself (`resumedBy: 'memory'`), which rides the resumed session's
  // 'session-resumed' event so workflow recovery hands the turn to its unblock
  // pass at once. Both branches of the resume must carry it: the plain resume,
  // through the engine's spawn overrides, and the resume after an entry while
  // paused, through `spawnAgent` (which forwards it into the same overrides).
  // The second was missed once, so the branch that went through `spawnAgent`
  // resumed as a person.
  //
  // Red-green: drop `resumedBy` from the `spawnAgent({...})` call and the first
  // test fails; drop it from the plain branch's `overrides` and the third fails.
  describe('who resumed it', () => {
    it('names the resumer on the resume after an entry while paused, through spawnAgent', async () => {
      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID, resumedBy: 'memory' });

      expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        resumesEntry: true,
        resumedBy: 'memory',
      }));
    });

    it('names nobody on that resume when a person asked for it', async () => {
      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      const spawnArguments = (mockSpawnAgent.mock.calls[0] as unknown[])[0];
      expect(spawnArguments).not.toHaveProperty('resumedBy');
    });

    it('names the resumer on the plain resume, in the engine\'s spawn overrides', async () => {
      entry = { at: ENTERED_BEFORE_PAUSE, origin: 'agent', from_swimlane_id: 'lane-executing' };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID, resumedBy: 'memory' });

      expect(mockSpawnAgent).not.toHaveBeenCalled();
      expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
      // Argument 8 is the spawn overrides.
      const overrides = (engine.resumeSuspendedSession.mock.calls[0] as unknown[])[7];
      expect(overrides).toMatchObject({ forceFresh: false, resumedBy: 'memory' });
    });

    it('names nobody on the plain resume when a person asked for it', async () => {
      entry = { at: ENTERED_BEFORE_PAUSE, origin: 'agent', from_swimlane_id: 'lane-executing' };

      await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

      expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
      const overrides = (engine.resumeSuspendedSession.mock.calls[0] as unknown[])[7];
      expect(overrides).not.toHaveProperty('resumedBy');
    });
  });
});

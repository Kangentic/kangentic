/**
 * `resumeTaskOnOpen` (src/main/ipc/handlers/session-resume-on-open.ts): opening
 * a task the idle timeout paused resumes it, and nothing else about opening a
 * task does anything. Without these a user's own Pause, or a paused workflow's
 * task, starts running because someone looked at the card, and an open can spend
 * a paid turn on a message nobody asked to send.
 *
 * Runs the REAL resumeTaskOnOpen, resumeTaskSession and task lock; the
 * repositories, the git helpers and the engine stand in. What the engine itself
 * declines is `transition-engine-expired-recap.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session, SuspendedBy, Task } from '../../src/shared/types';
import type { SpawnOutcome } from '../../src/main/transition-engine/transition-engine';

const TASK_ID = 'task-open';
const PROJECT_ID = 'proj-1';
const PAUSED_AT = '2026-11-07T12:00:00.000Z';
const ENTERED_BEFORE_PAUSE = '2026-11-07T11:00:00.000Z';
const ENTERED_AFTER_PAUSE = '2026-11-07T12:30:00.000Z';

const EXECUTING = { id: 'lane-executing', name: 'Executing', role: null, permission_mode: null, auto_spawn: true, is_ghost: false };
const DONE = { id: 'lane-done', name: 'Done', role: 'done', permission_mode: null, auto_spawn: false, is_ghost: false };
const LANES = new Map([[EXECUTING.id, EXECUTING], [DONE.id, DONE]]);

let storedTask: Task;
let latestRecord: { id: string; status: string; suspended_by: SuspendedBy | null; suspended_at: string | null; agent_session_id: string; launch_failed_at?: string } | null;
let entry: { at: string; origin: string; from_swimlane_id: string | null };
let outcome: SpawnOutcome;
let workflowState: 'running' | 'paused' | null;
let workflowReadFails: boolean;
/** The session registry's rows, for the phone open's live check. */
let registryRows: Array<Pick<Session, 'id' | 'taskId' | 'status' | 'transient'>> = [];

const engine = {
  resumeSuspendedSession: vi.fn(async (): Promise<SpawnOutcome> => {
    if (!outcome.declined) storedTask = { ...storedTask, session_id: 'sess-resumed' };
    return outcome;
  }),
};

const repos = {
  tasks: { getById: vi.fn(() => storedTask), update: vi.fn() },
  swimlanes: { getById: vi.fn((laneId: string) => LANES.get(laneId)), list: vi.fn(() => [...LANES.values()]) },
  automations: {},
  automationRuns: {},
  attachments: {},
};

const mockEnsureTaskWorktree = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));
const mockNotifySpawnBlocked = vi.hoisted(() => vi.fn());
const mockClaimHeldMessages = vi.hoisted(() => vi.fn(() => null));
const mockDeferHeld = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask() { return latestRecord; }
    listForTaskNewestFirst() { return latestRecord ? [latestRecord] : []; }
  },
}));
vi.mock('../../src/main/db/repositories/task-move-repository', () => ({
  TaskMoveRepository: class {
    currentVisit() { return entry; }
  },
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: () => repos,
  ensureTaskWorktree: mockEnsureTaskWorktree,
  createTransitionEngine: () => engine,
  resolveSpawnOverrides: () => ({}),
  spawnAgent: vi.fn(),
  notifySpawnBlocked: mockNotifySpawnBlocked,
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  resolveInjectionVerifier: vi.fn(() => null),
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
vi.mock('../../src/main/workflows/workflow-home', () => ({
  workflowOfTask: () => {
    if (workflowReadFails) throw new Error('database is closed');
    return workflowState ? { state: workflowState } : null;
  },
}));
vi.mock('../../src/main/held-messages/held-messages', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/held-messages/held-messages')>();
  return {
    composeOpeningMessage: original.composeOpeningMessage,
    claimHeldMessages: mockClaimHeldMessages,
    deferHeldUntilTurnEnd: mockDeferHeld,
    deliverOpeningRemainder: vi.fn(),
  };
});

import { resetDeclinedOpensForTests, resumeTaskOnOpen } from '../../src/main/ipc/handlers/session-resume-on-open';
import { openTaskSession } from '../../src/main/ipc/handlers/session-start';
import { onSpawnProgressChange } from '../../src/main/transition-engine/spawn-progress';
import { resumeTaskSession } from '../../src/main/ipc/handlers/session-resume';
import { registerResumeController, releaseResumeController } from '../../src/main/ipc/handlers/session-resume-controllers';
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';
import { forgetWorkflowRecovery, setRecoveryEntry, type RecoveryEntry } from '../../src/main/workflows/workflow-recovery-state';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function fakeContext(): IpcContext {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, path: '/mock/project' })) },
    sessionManager: {
      getSession: (id: string) => (id === 'sess-resumed' ? ({ id, taskId: TASK_ID, status: 'running' } as Session) : undefined),
      listSessions: () => registryRows,
    },
  } as unknown as IpcContext;
}

/** The overrides the engine was asked to spawn with. */
function spawnOverrides(): Record<string, unknown> {
  return (engine.resumeSuspendedSession.mock.calls[0] as unknown[])[7] as Record<string, unknown>;
}

/** The prompt the engine was asked to resume with. */
function resumePrompt(): unknown {
  return (engine.resumeSuspendedSession.mock.calls[0] as unknown[])[3];
}

function expectNothingStarted(): void {
  expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
  expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
  expect(mockNotifySpawnBlocked).not.toHaveBeenCalled();
}

describe('resumeTaskOnOpen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    storedTask = { id: TASK_ID, title: 'Retry the sync', swimlane_id: EXECUTING.id, session_id: null, archived_at: null } as Task;
    latestRecord = { id: 'record-paused', status: 'suspended', suspended_by: 'auto', suspended_at: PAUSED_AT, agent_session_id: 'agent-1' };
    entry = { at: ENTERED_BEFORE_PAUSE, origin: 'user', from_swimlane_id: null };
    outcome = { startOver: null, recapOnly: false, unsentPrompt: null };
    workflowState = null;
    workflowReadFails = false;
    mockEnsureTaskWorktree.mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    forgetWorkflowRecovery(TASK_ID);
    resetDeclinedOpensForTests();
  });

  it('resumes a task the idle timeout paused, sending nothing', async () => {
    await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(spawnOverrides()).toMatchObject({ startPath: 'open', resumeOnly: true, forceFresh: false });
    expect(resumePrompt()).toBeUndefined();
  });

  it.each<[string, SuspendedBy | null]>([
    ['a user\'s Pause', 'user'],
    ['a system suspend', 'system'],
    ['an old low-memory pause', 'low_memory'],
    ['a record with no source', null],
  ])('leaves %s paused', async (_label, suspendedBy) => {
    if (latestRecord) latestRecord.suspended_by = suspendedBy;

    await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

    expectNothingStarted();
  });

  it('does nothing for a task with no paused record, which is most opens', async () => {
    latestRecord = null;

    await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

    expectNothingStarted();
  });

  it('does nothing for a task in Done, and raises no notice', async () => {
    storedTask = { ...storedTask, swimlane_id: DONE.id };

    await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

    expectNothingStarted();
  });

  it('leaves a card moved while paused to its Resume button: its column\'s message is a paid turn', async () => {
    entry = { at: ENTERED_AFTER_PAUSE, origin: 'user', from_swimlane_id: DONE.id };

    await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

    expectNothingStarted();
  });

  it('leaves a launch that never ran to its Resume button: it still owes its prompt', async () => {
    if (latestRecord) latestRecord.launch_failed_at = PAUSED_AT;

    await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

    expectNothingStarted();
  });

  it('leaves held messages held, and marks the session to take them after its next turn', async () => {
    await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

    expect(mockClaimHeldMessages).not.toHaveBeenCalled();
    expect(mockDeferHeld).toHaveBeenCalledWith('sess-resumed');
  });

  // The off side of `plainResume`: the Resume button and a phone pass none, and
  // must keep claiming held messages and may start a fresh conversation.
  it('a Resume with no plainResume claims held messages, may go fresh, and defers nothing', async () => {
    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(mockClaimHeldMessages).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, TASK_ID);
    // Left out entirely, so a Resume's overrides are what they were before this option.
    expect(spawnOverrides()).not.toHaveProperty('resumeOnly');
    expect(mockDeferHeld).not.toHaveBeenCalled();
  });

  describe('a workflow\'s task', () => {
    it('resumes in a running workflow, as Resume on the card does', async () => {
      workflowState = 'running';

      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    });

    // A member the idle timeout paused first never reached the workflow's Pause,
    // so its record still reads 'auto'. That Pause is the workflow's one stop.
    it('stays paused in a paused workflow', async () => {
      workflowState = 'paused';

      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      expectNothingStarted();
    });

    it('stays paused when its workflow cannot be read, since nobody asked for this start', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      workflowReadFails = true;

      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      expectNothingStarted();
    });

    it('leaves a task under recovery to its recovery', async () => {
      const timer = setTimeout(() => undefined, 60 * 60_000);
      setRecoveryEntry({ taskId: TASK_ID, timer, inFlight: false } as unknown as RecoveryEntry);

      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      expectNothingStarted();
    });
  });

  describe('racing another start', () => {
    it('never cancels a resume already in flight, which may carry the user\'s prompt', async () => {
      const inFlight = new AbortController();
      registerResumeController(TASK_ID, inFlight);
      try {
        await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);
      } finally {
        releaseResumeController(TASK_ID, inFlight);
      }

      expect(inFlight.signal.aborted).toBe(false);
      expectNothingStarted();
    });

    it('honors a Pause that lands before it gets the task lock', async () => {
      let release: () => void = () => undefined;
      const held = withTaskLock(TASK_ID, () => new Promise<void>((resolve) => { release = resolve; }));
      const resuming = resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      if (latestRecord) latestRecord.suspended_by = 'user';
      release();
      await held;
      await resuming;

      expectNothingStarted();
    });

    it('honors a Pause that lands during the unlocked git phase', async () => {
      mockEnsureTaskWorktree.mockImplementation(async () => {
        if (latestRecord) latestRecord.suspended_by = 'user';
      });

      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    });
  });

  describe('how it ends', () => {
    it('raises no notice when the engine declines: the card keeps its Resume button', async () => {
      outcome = { startOver: null, recapOnly: false, unsentPrompt: null, declined: true };

      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      expect(mockNotifySpawnBlocked).not.toHaveBeenCalled();
      expect(mockDeferHeld).not.toHaveBeenCalled();
    });

    it('asks the engine once for a record it declined: a later open costs no git phase or label', async () => {
      outcome = { startOver: null, recapOnly: false, unsentPrompt: null, declined: true };

      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);
      expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);

      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
      expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    });

    it('asks again for a newer record of the same task', async () => {
      outcome = { startOver: null, recapOnly: false, unsentPrompt: null, declined: true };
      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      outcome = { startOver: null, recapOnly: false, unsentPrompt: null };
      if (latestRecord) latestRecord = { ...latestRecord, id: 'record-paused-later' };
      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(2);
    });

    it('raises the spawn-blocked notice when the resume fails, and never rejects', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const failure = new Error('fatal: not a git repository');
      mockEnsureTaskWorktree.mockImplementation(async () => { throw failure; });

      await expect(resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID)).resolves.toBe('starting');

      expect(mockNotifySpawnBlocked).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: TASK_ID }), 'worktree', failure, PROJECT_ID, 'open');
    });

    it('does nothing with no project to read', async () => {
      const context = fakeContext();
      context.currentProjectId = null;

      await resumeTaskOnOpen(context, TASK_ID);

      expectNothingStarted();
    });
  });

  // A phone's open answers the person within its verb budget, so the outcome
  // must be known before the git phase, and every path must report one.
  describe('what it reports', () => {
    it('decides `starting` for an accepted resume before its git phase runs', async () => {
      let releaseGit: () => void = () => undefined;
      mockEnsureTaskWorktree.mockImplementation(() => new Promise<void>((resolve) => { releaseGit = resolve; }));
      const onDecided = vi.fn();

      const resuming = resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID, { onDecided });
      await vi.waitFor(() => expect(onDecided).toHaveBeenCalledWith('starting'));
      expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();

      releaseGit();
      await expect(resuming).resolves.toBe('starting');
      expect(onDecided).toHaveBeenCalledTimes(1);
    });

    it.each<[string, () => void]>([
      ["a user's Pause", () => { if (latestRecord) latestRecord.suspended_by = 'user'; }],
      ['a task in Done', () => { storedTask = { ...storedTask, swimlane_id: DONE.id }; }],
      ['a paused workflow', () => { workflowState = 'paused'; }],
      ['a column entered while paused', () => { entry = { at: ENTERED_AFTER_PAUSE, origin: 'user', from_swimlane_id: DONE.id }; }],
    ])('decides `not-eligible` for %s', async (_label, arrange) => {
      arrange();
      const onDecided = vi.fn();

      await expect(resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID, { onDecided })).resolves.toBe('not-eligible');

      expect(onDecided).toHaveBeenCalledWith('not-eligible');
      expectNothingStarted();
    });

    it('decides `not-eligible` for a record the engine already declined', async () => {
      outcome = { startOver: null, recapOnly: false, unsentPrompt: null, declined: true };
      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      await expect(resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID)).resolves.toBe('not-eligible');
    });

    it('decides `starting` for a resume already in flight, which is bringing the agent back', async () => {
      const inFlight = new AbortController();
      registerResumeController(TASK_ID, inFlight);
      try {
        await expect(resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID)).resolves.toBe('starting');
      } finally {
        releaseResumeController(TASK_ID, inFlight);
      }
      expectNothingStarted();
    });

    it('decides `live` for a task whose agent is already running', async () => {
      storedTask = { ...storedTask, session_id: 'sess-resumed' };

      await expect(resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID)).resolves.toBe('live');
      expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    });

    it('decides `not-eligible` when a Pause lands before the resume takes the task lock', async () => {
      let release: () => void = () => undefined;
      const held = withTaskLock(TASK_ID, () => new Promise<void>((resolve) => { release = resolve; }));
      const resuming = resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID);

      if (latestRecord) latestRecord.suspended_by = 'user';
      release();
      await held;

      await expect(resuming).resolves.toBe('not-eligible');
    });

    it('an onDecided hook that throws does not stop the resume, and is logged', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const onDecided = vi.fn(() => { throw new Error('phone gone'); });

      await expect(resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID, { onDecided })).resolves.toBe('starting');

      expect(onDecided).toHaveBeenCalledTimes(1);
      expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('onDecided hook threw'), expect.any(Error));
    });

    it('decides `not-eligible` exactly once when there is no project to read', async () => {
      const context = fakeContext();
      context.currentProjectId = null;
      const onDecided = vi.fn();

      await expect(resumeTaskOnOpen(context, TASK_ID, undefined, { onDecided })).resolves.toBe('not-eligible');

      expect(onDecided).toHaveBeenCalledTimes(1);
      expect(onDecided).toHaveBeenCalledWith('not-eligible');
    });

    it('decides `not-eligible` exactly once when reading the task throws before acceptance', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      repos.tasks.getById.mockImplementationOnce(() => { throw new Error('database is closed'); });
      const onDecided = vi.fn();

      await expect(resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID, { onDecided })).resolves.toBe('not-eligible');

      expect(onDecided).toHaveBeenCalledTimes(1);
      expect(onDecided).toHaveBeenCalledWith('not-eligible');
      expectNothingStarted();
    });

    it('tags the launch with the start path it is given', async () => {
      await resumeTaskOnOpen(fakeContext(), TASK_ID, PROJECT_ID, { startPath: 'phone_open' });

      expect(spawnOverrides()).toMatchObject({ startPath: 'phone_open', resumeOnly: true });
    });
  });
});

describe('openTaskSession (a phone opening the task)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    storedTask = { id: TASK_ID, title: 'Retry the sync', swimlane_id: EXECUTING.id, session_id: null, archived_at: null } as Task;
    latestRecord = { id: 'record-paused', status: 'suspended', suspended_by: 'auto', suspended_at: PAUSED_AT, agent_session_id: 'agent-1' };
    entry = { at: ENTERED_BEFORE_PAUSE, origin: 'user', from_swimlane_id: null };
    outcome = { startOver: null, recapOnly: false, unsentPrompt: null };
    workflowState = null;
    workflowReadFails = false;
    mockEnsureTaskWorktree.mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeclinedOpensForTests();
  });

  it('answers `starting` while the git phase still runs, and resumes on the phone\'s start path, sending nothing', async () => {
    let releaseGit: () => void = () => undefined;
    mockEnsureTaskWorktree.mockImplementation(() => new Promise<void>((resolve) => { releaseGit = resolve; }));

    const opened = await openTaskSession(fakeContext(), PROJECT_ID, TASK_ID);

    expect(opened.outcome).toBe('starting');
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    releaseGit();
    if (opened.outcome === 'starting') await opened.settled;
    expect(spawnOverrides()).toMatchObject({ startPath: 'phone_open', resumeOnly: true });
    expect(resumePrompt()).toBeUndefined();
  });

  it('answers `not-eligible`, never an error, for a task in Done and for a user\'s Pause', async () => {
    storedTask = { ...storedTask, swimlane_id: DONE.id };
    await expect(openTaskSession(fakeContext(), PROJECT_ID, TASK_ID)).resolves.toEqual({ outcome: 'not-eligible' });

    storedTask = { ...storedTask, swimlane_id: EXECUTING.id };
    if (latestRecord) latestRecord.suspended_by = 'user';
    await expect(openTaskSession(fakeContext(), PROJECT_ID, TASK_ID)).resolves.toEqual({ outcome: 'not-eligible' });

    expectNothingStarted();
  });

  // A phone on a stale screen still draws the task paused. Its latest record
  // reads running, which the desktop open answers as not eligible: `live` is
  // what tells the phone to re-read rather than keep a Resume button.
  it.each(['running', 'queued'] as const)('answers `live` for a task whose agent is already %s, and starts nothing', async (status) => {
    latestRecord = { id: 'record-live', status: 'running', suspended_by: null, suspended_at: null, agent_session_id: 'agent-1' };
    registryRows = [{ id: 'sess-live', taskId: TASK_ID, status, transient: false }];
    try {
      await expect(openTaskSession(fakeContext(), PROJECT_ID, TASK_ID)).resolves.toEqual({ outcome: 'live' });
    } finally {
      registryRows = [];
    }
    expectNothingStarted();
  });

  // The phone heard `starting` and waits for the board to change. A decline
  // after the git phase spawns nothing, so the label's release is the only
  // change it gets: the spawn-progress feed turns it into a task-updated.
  it('releases the Resuming label when the engine declines after the phone heard `starting`', async () => {
    outcome = { startOver: null, recapOnly: false, unsentPrompt: null, declined: true };
    const labels: Array<string | null> = [];
    const unsubscribe = onSpawnProgressChange((changedTaskId, label) => {
      if (changedTaskId === TASK_ID) labels.push(label);
    });
    try {
      const opened = await openTaskSession(fakeContext(), PROJECT_ID, TASK_ID);
      expect(opened.outcome).toBe('starting');
      if (opened.outcome === 'starting') await opened.settled;
    } finally {
      unsubscribe();
    }

    expect(labels.length).toBeGreaterThan(1);
    expect(labels[labels.length - 1]).toBeNull();
    expect(mockNotifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('reports a failure after acceptance on the phone\'s start path, and never rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new Error('fatal: not a git repository');
    mockEnsureTaskWorktree.mockImplementation(async () => { throw failure; });

    const opened = await openTaskSession(fakeContext(), PROJECT_ID, TASK_ID);
    expect(opened.outcome).toBe('starting');
    if (opened.outcome === 'starting') await expect(opened.settled).resolves.toBeUndefined();

    expect(mockNotifySpawnBlocked).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: TASK_ID }), 'worktree', failure, PROJECT_ID, 'phone_open');
  });
});

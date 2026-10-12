/**
 * The workflow engine opens only the databases a running workflow touches
 * (src/main/workflows/workflow-engine-host.ts).
 *
 * Its first pass used to call `getProjectDb` for every registered project,
 * which opened, migrated and kept each one, and created an empty database for
 * a registered project whose file was gone. Now it looks at an unopened
 * project once, on a throwaway connection with no migrations
 * (`probeWorkflowProject`), and opens it only when it homes a running or
 * paused workflow or holds a task of one.
 *
 * Real files here, in the per-file temp data directory, and the real
 * `getProjectDb`: whether a database got opened, migrated or created is the
 * thing under test. The move path is mocked as in the backoff test: a start
 * moves the task out of To Do. Fake timers drive the debounce and the
 * one-per-turn yields between looks.
 *
 * Also here: a board that cannot be read keeps every workflow from completing
 * until a pass reads it, since today's snapshot would otherwise drop that
 * board's tasks and complete a workflow whose readable tasks are all Done. It
 * also keeps a task from starting when a task on that board holds it up, and
 * keeps a failed start's backoff, and it is logged once a launch. A board is
 * unread when the look at it fails (a file that is not a database) or when a
 * read on its open connection throws, and each of those reads is pinned
 * separately. The engine stops reading once disposed, even between two looks.
 * The two database helpers the engine reads through (`peekProjectDb`,
 * `getExistingProjectDb`). And the Workflows view's cross-board reads, which
 * no longer create a database for a registered project whose file is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import Database from 'better-sqlite3';

interface MoveInput {
  taskId: string;
  targetSwimlaneId: string;
}

const harness = vi.hoisted(() => ({
  handleTaskMove: vi.fn(),
  announceWorkflowComplete: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: harness.handleTaskMove }));
vi.mock('../../src/main/git/fetch-throttle', () => ({ forgetRecentFetches: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  BranchCheckoutBlockedError: class BranchCheckoutBlockedError extends Error {},
  notifySpawnBlocked: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-agent', () => ({
  endWorkflowAgent: vi.fn(async () => undefined),
  workflowAgentSummary: vi.fn(() => null),
}));
vi.mock('../../src/main/workflows/workflow-complete', () => ({ announceWorkflowComplete: harness.announceWorkflowComplete }));
vi.mock('../../src/main/workflows/workflow-changed', () => ({
  notifyWorkflowChanged: vi.fn(),
  setWorkflowChangedWindow: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-runtime', () => ({ setWorkflowRuntimeContext: vi.fn() }));
// The real probe, recorded: which unopened projects the engine looked at is the
// thing a disposed engine must stop doing.
vi.mock('../../src/main/workflows/workflow-project-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-project-probe')>();
  return { ...actual, probeWorkflowProject: vi.fn(actual.probeWorkflowProject) };
});

const { PATHS } = await import('../../src/main/config/paths');
const { getProjectDb, getExistingProjectDb, peekProjectDb, closeAll, openProjectDbIds } = await import('../../src/main/db/database');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const { setHomeLinkRemover } = await import('../../src/main/db/repositories/workflow-home-links');
const { registerWorkflowEngine, getWorkflowEngine } = await import('../../src/main/workflows/workflow-engine-host');
const { probeWorkflowProject } = await import('../../src/main/workflows/workflow-project-probe');
const { setWorkflowWake } = await import('../../src/main/workflows/workflow-wake');
const { workflowTasks } = await import('../../src/main/workflows/workflow-tasks');
const { listWorkflowSummaries, listWorkflowSupersessions } = await import('../../src/main/workflows/workflow-view-service');

import type { IpcContext } from '../../src/main/ipc/ipc-context';

const DEBOUNCE_MS = 150;
const PROJECT_IDS = ['home', 'member', 'idle', 'missing', 'old', 'broken'];

const membership = (workflowId: string, homeProjectId: string) => ({
  workflow_id: workflowId,
  workflow_project_id: homeProjectId,
  route_start_swimlane_id: null,
  route_last_swimlane_id: null,
  skipped_swimlane_ids: [],
  canvas_x: null,
  canvas_y: null,
});

function laneOf(projectId: string, name: string): string {
  return new SwimlaneRepository(getProjectDb(projectId)).list().find((lane) => lane.name === name)!.id;
}

/** A task on `projectId`'s board, in `laneName`, a member of `workflowId` homed at `homeProjectId`. */
function workflowTask(projectId: string, laneName: string, workflowId: string, homeProjectId: string): string {
  return new TaskRepository(getProjectDb(projectId)).create({
    title: `${projectId} task`,
    description: '',
    swimlane_id: laneOf(projectId, laneName),
    workflow: membership(workflowId, homeProjectId),
  }).id;
}

/** A started workflow homed at `projectId`, in `state`. */
function workflowIn(projectId: string, state: 'running' | 'paused' | 'done' = 'running'): string {
  const workflows = new WorkflowRepository(getProjectDb(projectId));
  const workflow = workflows.create({ title: `${projectId} workflow` });
  workflows.markStarted(workflow.id);
  if (state !== 'running') workflows.setState(workflow.id, state);
  return workflow.id;
}

const dbFiles = (projectId: string) => ['', '-wal', '-shm'].map((suffix) => PATHS.projectDb(projectId) + suffix);
const filesPresent = (projectId: string) => dbFiles(projectId).filter((file) => fs.existsSync(file)).length;

/** The tables a database holds, read on a connection that writes nothing. */
function tablesOf(projectId: string): string[] {
  const db = new Database(PATHS.projectDb(projectId), { fileMustExist: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

/**
 * One read of an open board that stops working, and the statement that puts it
 * back. Each runs on the handle the engine finds open: reopening a board runs
 * its migrations again, which recreate whatever the break took away. Each
 * leaves every other read of the board working.
 */
const BREAKS = {
  /** `WorkflowRepository.hasActive` throws; the board's tasks still read. */
  activeWorkflows: {
    break: 'ALTER TABLE workflows RENAME TO workflows_broken',
    heal: 'ALTER TABLE workflows_broken RENAME TO workflows',
  },
  /** `TaskRepository.workflowIdsOnBoard` throws. */
  workflowsOnBoard: {
    break: 'ALTER TABLE tasks RENAME COLUMN workflow_id TO workflow_id_broken',
    heal: 'ALTER TABLE tasks RENAME COLUMN workflow_id_broken TO workflow_id',
  },
  /** `workflowIdsOnBoard` reads, and `TaskRepository.listByWorkflow` throws (its attachment count). */
  tasksOfWorkflow: {
    break: 'ALTER TABLE task_attachments RENAME TO task_attachments_broken',
    heal: 'ALTER TABLE task_attachments_broken RENAME TO task_attachments',
  },
  /** The tasks read, and the lane read after it throws. */
  lanes: {
    break: 'ALTER TABLE swimlanes RENAME TO swimlanes_broken',
    heal: 'ALTER TABLE swimlanes_broken RENAME TO swimlanes',
  },
} as const;

describe('the workflow engine at boot', () => {
  let context: IpcContext;
  let registered: Array<{ id: string; name: string; path: string }>;

  const advance = (milliseconds: number) => vi.advanceTimersByTimeAsync(milliseconds);
  const pass = () => advance(DEBOUNCE_MS + 50);
  const startedTaskIds = () => harness.handleTaskMove.mock.calls.map(([, input]) => (input as MoveInput).taskId);
  const unreadWarnings = () => vi.mocked(console.warn).mock.calls
    .filter(([message]) => typeof message === 'string' && message.includes('Could not read project'));
  const probedProjectIds = () => vi.mocked(probeWorkflowProject).mock.calls.map(([projectId]) => projectId);

  function register(projectIds: string[]): void {
    registered = projectIds.map((id) => ({ id, name: id, path: `/mock/${id}` }));
  }

  /** Close every handle, as a restart leaves them, and start the engine. */
  function boot(): ReturnType<typeof registerWorkflowEngine> {
    closeAll();
    return registerWorkflowEngine(context);
  }

  beforeEach(() => {
    closeAll();
    for (const projectId of PROJECT_IDS) {
      for (const file of dbFiles(projectId)) fs.rmSync(file, { force: true });
    }
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    harness.handleTaskMove.mockReset();
    harness.handleTaskMove.mockImplementation(async (_context: unknown, input: MoveInput, _origin: string, projectId: string) => {
      getProjectDb(projectId).prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(input.targetSwimlaneId, input.taskId);
    });
    harness.announceWorkflowComplete.mockReset();
    // Back to the real probe, with no calls recorded and no one-shot left over.
    vi.mocked(probeWorkflowProject).mockReset();
    register(PROJECT_IDS);
    context = {
      projectRepo: {
        list: () => registered,
        getById: (id: string) => registered.find((project) => project.id === id),
      },
      sessionManager: Object.assign(new EventEmitter(), { getFreeAgentSlots: () => 10 }),
      boardEvents: { onBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    getWorkflowEngine()?.dispose();
    setHomeLinkRemover(null);
    setWorkflowWake(null);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeAll();
  });

  it('opens only the boards a running workflow touches, creates no database, and migrates none it does not open', async () => {
    const running = workflowIn('home');
    workflowTask('home', 'Done', running, 'home');
    const memberTask = workflowTask('member', 'To Do', running, 'home');
    // A task of a finished workflow: nothing the engine has to read.
    const finished = workflowIn('idle', 'done');
    workflowTask('idle', 'Done', finished, 'idle');
    closeAll();
    // A database from before workflows existed.
    const old = new Database(PATHS.projectDb('old'));
    old.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    old.close();
    const oldTables = tablesOf('old');

    boot();
    await pass();

    expect(openProjectDbIds().sort()).toEqual(['home', 'member']);
    expect(filesPresent('missing')).toBe(0);
    // Looked at on a connection that is closed again, leaving no -wal or -shm behind.
    expect(filesPresent('idle')).toBe(1);
    expect(tablesOf('old')).toEqual(oldTables);
    // The member board was opened, so its ready task started.
    expect(harness.handleTaskMove.mock.calls.map(([, input]) => (input as MoveInput).taskId)).toEqual([memberTask]);
  });

  it('opens a member board once its home, looked at in the same pass, turns out to run its workflow', async () => {
    // Both boards are closed at boot; the member is opened only because the
    // home is, and the home's workflow is running.
    const running = workflowIn('home');
    workflowTask('home', 'Executing', running, 'home');
    const memberTask = workflowTask('member', 'To Do', running, 'home');
    const paused = workflowIn('idle', 'paused');
    workflowTask('idle', 'Executing', paused, 'idle');
    register(['member', 'home', 'idle']);

    boot();
    await pass();

    // A paused workflow is read too (it can still complete), so its home is open.
    expect(openProjectDbIds().sort()).toEqual(['home', 'idle', 'member']);
    expect(harness.handleTaskMove.mock.calls.map(([, input]) => (input as MoveInput).taskId)).toEqual([memberTask]);
  });

  it('completes no workflow while a registered board cannot be read, and completes it on the pass after the board reads', async () => {
    // Every task it can see is Done. The unreadable board may hold another.
    const running = workflowIn('home');
    workflowTask('home', 'Done', running, 'home');
    closeAll();
    fs.writeFileSync(PATHS.projectDb('broken'), 'not a database '.repeat(512));
    register(['home', 'broken']);

    const engine = boot();
    await pass();
    expect(harness.announceWorkflowComplete).not.toHaveBeenCalled();
    expect(new WorkflowRepository(getProjectDb('home')).getById(running)!.state).toBe('running');
    // A wake while it still cannot be read changes nothing.
    engine.wake();
    await pass();
    expect(harness.announceWorkflowComplete).not.toHaveBeenCalled();
    // Two passes could not read it, and the log says so once a launch.
    expect(unreadWarnings()).toHaveLength(1);
    expect(unreadWarnings()[0][0]).toContain('broken');

    // The board comes back as a real, readable database, not as a missing file.
    fs.rmSync(PATHS.projectDb('broken'), { force: true });
    const repaired = new Database(PATHS.projectDb('broken'));
    repaired.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    repaired.close();
    expect(filesPresent('broken')).toBe(1);
    engine.wake();
    await pass();

    expect(harness.announceWorkflowComplete).toHaveBeenCalledTimes(1);
    expect(new WorkflowRepository(getProjectDb('home')).getById(running)!.state).toBe('done');
    expect(unreadWarnings()).toHaveLength(1);
  });

  it('starts no task that waits on a task of a board it could not read, though that board still reads the Done blocker', async () => {
    register(['home', 'member']);
    const running = workflowIn('home');
    // The blocker is in Done on the member board. The task it holds up, and a
    // task with no link to that board, wait in To Do at home.
    const blocker = workflowTask('member', 'Done', running, 'home');
    const blocked = workflowTask('home', 'To Do', running, 'home');
    const unlinked = workflowTask('home', 'To Do', running, 'home');
    new TaskLinkRepository(getProjectDb('home')).insert({
      workflow_id: running,
      blocker_project_id: 'member',
      blocker_task_id: blocker,
      blocked_project_id: 'home',
      blocked_task_id: blocked,
    });

    const engine = boot();
    // Open, and unreadable for one read only: an unreadable file would read the
    // blocker as not done already, whatever the engine did about it.
    const memberDb = getProjectDb('member');
    memberDb.exec(BREAKS.activeWorkflows.break);
    expect(() => new WorkflowRepository(memberDb).hasActive()).toThrow();
    expect(new TaskRepository(memberDb).listByWorkflow(running).map((task) => task.id)).toEqual([blocker]);

    await pass();
    expect(startedTaskIds()).toEqual([unlinked]);
    // Another pass that still cannot read it starts nothing more.
    engine.wake();
    await pass();
    expect(startedTaskIds()).toEqual([unlinked]);

    // Read again, the Done blocker lets the task start.
    memberDb.exec(BREAKS.activeWorkflows.heal);
    engine.wake();
    await pass();
    expect(startedTaskIds()).toEqual([unlinked, blocked]);
  });

  it.each([
    ['its active-workflow read', 'activeWorkflows'],
    ['its read of which workflows it holds tasks of', 'workflowsOnBoard'],
    ['its read of the tasks of a workflow', 'tasksOfWorkflow'],
  ] as const)('completes no workflow while an open board fails %s, and completes it on the pass after the board reads', async (_description, breakKind) => {
    register(['home', 'member']);
    // Every task it can see is Done. The failing board may hold another.
    const running = workflowIn('home');
    workflowTask('home', 'Done', running, 'home');
    // The tasks read is only made of a board that holds one of the workflow's tasks.
    if (breakKind === 'tasksOfWorkflow') workflowTask('member', 'Done', running, 'home');

    const engine = boot();
    const memberDb = getProjectDb('member');
    memberDb.exec(BREAKS[breakKind].break);
    await pass();
    expect(harness.announceWorkflowComplete).not.toHaveBeenCalled();
    expect(new WorkflowRepository(getProjectDb('home')).getById(running)!.state).toBe('running');
    expect(unreadWarnings()).toHaveLength(1);
    expect(unreadWarnings()[0][0]).toContain('member');

    memberDb.exec(BREAKS[breakKind].heal);
    engine.wake();
    await pass();

    expect(harness.announceWorkflowComplete).toHaveBeenCalledTimes(1);
    expect(new WorkflowRepository(getProjectDb('home')).getById(running)!.state).toBe('done');
  });

  it('keeps a failed start\'s backoff through a pass that cannot read the task\'s board', async () => {
    register(['home', 'member']);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const running = workflowIn('home');
    const waiting = workflowTask('member', 'To Do', running, 'home');
    harness.handleTaskMove.mockImplementationOnce(async () => { throw new Error('git exploded'); });

    const engine = boot();
    await pass();
    // The pass the failed start woke runs next, on a board that reads.
    await pass();
    expect(harness.handleTaskMove).toHaveBeenCalledTimes(1);
    const backoff = engine.failedStart('member', waiting)!;
    expect(backoff.attempts).toBe(1);

    // The board's lane read throws, so this pass sees none of the workflow's tasks.
    const memberDb = getProjectDb('member');
    memberDb.exec(BREAKS.lanes.break);
    const evaluationsBefore = engine.stats().samples;
    engine.wake();
    await pass();
    expect(engine.stats().samples).toBeGreaterThan(evaluationsBefore);
    expect(unreadWarnings()).toHaveLength(1);
    expect(engine.failedStart('member', waiting)).toEqual(backoff);

    // Read again, the task still waits out the same backoff.
    memberDb.exec(BREAKS.lanes.heal);
    engine.wake();
    await pass();
    expect(harness.handleTaskMove).toHaveBeenCalledTimes(1);
    expect(engine.failedStart('member', waiting)).toEqual(backoff);
  });

  it('arms no timer when woken after dispose, and starts nothing', async () => {
    register(['home']);
    const running = workflowIn('home');
    workflowTask('home', 'To Do', running, 'home');

    const engine = boot();
    // Launch armed the debounce: a live engine does arm a timer.
    expect(vi.getTimerCount()).toBe(1);
    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);

    engine.wake();
    expect(vi.getTimerCount()).toBe(0);
    await pass();
    expect(harness.handleTaskMove).not.toHaveBeenCalled();
  });

  it('looks at no more unopened projects, and plans nothing, when disposed between two looks of its first pass', async () => {
    register(['home', 'idle', 'old']);
    // Home runs one workflow with a task ready to start and another that is all
    // Done: a pass that went on would start the one and complete the other.
    const running = workflowIn('home');
    workflowTask('home', 'To Do', running, 'home');
    const finished = workflowIn('home');
    workflowTask('home', 'Done', finished, 'home');
    getProjectDb('idle');
    getProjectDb('old');

    const engine = boot();
    // The engine is disposed as the look at home ends, so the pass is between two
    // looks: the next one waits a turn before it starts, and finds the engine gone.
    const realProbe = vi.mocked(probeWorkflowProject).getMockImplementation()!;
    vi.mocked(probeWorkflowProject).mockImplementationOnce((projectId) => {
      const probe = realProbe(projectId);
      engine.dispose();
      return probe;
    });

    await advance(60 * 1000);

    expect(probedProjectIds()).toEqual(['home']);
    expect(harness.handleTaskMove).not.toHaveBeenCalled();
    expect(harness.announceWorkflowComplete).not.toHaveBeenCalled();
    // Home was looked at and never opened, since the pass that would have opened it never ran.
    expect(openProjectDbIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads a board that joins a running workflow after the first pass, since the write that joins it opens it', async () => {
    const running = workflowIn('home');
    workflowTask('home', 'Executing', running, 'home');
    closeAll();
    register(['home', 'idle']);
    // A board with tasks and no workflow at boot.
    new TaskRepository(getProjectDb('idle')).create({ title: 'Ordinary', description: '', swimlane_id: laneOf('idle', 'To Do') });

    const engine = boot();
    await pass();
    expect(openProjectDbIds()).toEqual(['home']);

    // An added task: every write that brings a board into a workflow goes
    // through getProjectDb on main, which opens it.
    const joined = workflowTask('idle', 'To Do', running, 'home');
    engine.wake();
    await pass();

    expect(harness.handleTaskMove.mock.calls.map(([, input, , projectId]) => [projectId, (input as MoveInput).taskId])).toEqual([['idle', joined]]);
  });
});

describe('the Workflows view across boards', () => {
  beforeEach(() => {
    closeAll();
    for (const projectId of PROJECT_IDS) {
      for (const file of dbFiles(projectId)) fs.rmSync(file, { force: true });
    }
  });

  afterEach(() => closeAll());

  it('does not create a database for a registered project whose file is gone', () => {
    const running = workflowIn('home');
    const homeTask = workflowTask('home', 'To Do', running, 'home');
    const projects = ['home', 'missing'].map((id) => ({ id, name: id, path: `/mock/${id}` }));
    const context = { projectRepo: { list: () => projects } } as unknown as IpcContext;

    expect(workflowTasks(context, 'home', running).map(({ task }) => task.id)).toEqual([homeTask]);
    expect(listWorkflowSummaries(context, 'missing')).toEqual([]);
    expect(listWorkflowSupersessions('missing')).toEqual([]);
    expect(filesPresent('missing')).toBe(0);
  });
});

describe('reading a project database the process has not opened', () => {
  beforeEach(() => {
    closeAll();
    for (const projectId of PROJECT_IDS) {
      for (const file of dbFiles(projectId)) fs.rmSync(file, { force: true });
    }
  });

  afterEach(() => closeAll());

  /** A migrated database holding one workflow, on disk with no handle open. */
  function closedBoard(projectId: string): string {
    const workflowId = workflowIn(projectId);
    closeAll();
    expect(filesPresent(projectId)).toBe(1);
    return workflowId;
  }

  describe('peekProjectDb', () => {
    it('returns null for a missing file without reading and without creating one', () => {
      const read = vi.fn();

      expect(peekProjectDb('missing', read)).toBeNull();

      expect(read).not.toHaveBeenCalled();
      expect(filesPresent('missing')).toBe(0);
      expect(openProjectDbIds()).toEqual([]);
    });

    it('returns what the read returns, opens nothing, and leaves no -wal or -shm file behind', () => {
      const workflowId = closedBoard('home');

      const workflowIds = peekProjectDb('home', (db) => new WorkflowRepository(db).listOpen().map((workflow) => workflow.id));

      expect(workflowIds).toEqual([workflowId]);
      expect(openProjectDbIds()).toEqual([]);
      expect(filesPresent('home')).toBe(1);
    });

    it('closes the connection and rethrows when the read throws', () => {
      closedBoard('home');
      const connections: Database.Database[] = [];

      expect(() => peekProjectDb('home', (db) => {
        connections.push(db);
        db.prepare('SELECT COUNT(*) AS count FROM workflows').get();
        // The read reached the file, so a connection left open would still hold its -wal and -shm.
        expect(filesPresent('home')).toBeGreaterThan(1);
        throw new Error('the read failed');
      })).toThrow('the read failed');

      expect(connections).toHaveLength(1);
      expect(connections[0].open).toBe(false);
      expect(filesPresent('home')).toBe(1);
      expect(openProjectDbIds()).toEqual([]);
    });
  });

  describe('getExistingProjectDb', () => {
    it('returns null for a missing file and creates no file', () => {
      expect(getExistingProjectDb('missing')).toBeNull();

      expect(filesPresent('missing')).toBe(0);
      expect(openProjectDbIds()).toEqual([]);
    });

    it('opens an existing file and keeps the handle it opened', () => {
      closedBoard('home');

      const opened = getExistingProjectDb('home');

      expect(opened).not.toBeNull();
      expect(openProjectDbIds()).toEqual(['home']);
      expect(getExistingProjectDb('home')).toBe(opened);
      expect(getProjectDb('home')).toBe(opened);
    });

    it('returns the handle getProjectDb already holds', () => {
      const held = getProjectDb('home');

      expect(getExistingProjectDb('home')).toBe(held);
      expect(openProjectDbIds()).toEqual(['home']);
    });
  });
});

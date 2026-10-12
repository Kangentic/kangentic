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
 * keeps a failed start's backoff, and it is logged once a launch. While a board
 * stays unread the engine tries it again on a backoff, so a board that comes
 * back lets the workflow go on with no other event. The backoff's steps and
 * its 5 m cap, its single timer, its restart and its cancellation by a full
 * read or by dispose are each pinned. A board is
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
/** The fake clock runs a setImmediate scheduled during a tick 1 ms on, so a pass looks that long after its debounce fires. */
const YIELD_MS = 1;
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

  /** Make `broken` a file that is not a database, so every look at it fails. */
  function corruptBroken(): void {
    fs.mkdirSync(PATHS.projectsDir, { recursive: true });
    fs.writeFileSync(PATHS.projectDb('broken'), 'not a database '.repeat(512));
  }

  /** `broken` back as a real, readable database. */
  function repairBroken(): void {
    fs.rmSync(PATHS.projectDb('broken'), { force: true });
    const repaired = new Database(PATHS.projectDb('broken'));
    repaired.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    repaired.close();
  }

  /** The fake-clock time of each look at `broken`, oldest first. */
  function recordLooksAtBroken(): number[] {
    const looks: number[] = [];
    const realProbe = vi.mocked(probeWorkflowProject).getMockImplementation()!;
    vi.mocked(probeWorkflowProject).mockImplementation((projectId) => {
      if (projectId === 'broken') looks.push(Date.now());
      return realProbe(projectId);
    });
    return looks;
  }

  /**
   * The next look at `broken` after the pass that looked at `armedAt` comes
   * `waitMs` plus the debounce and the yield on (the retry timer, then the
   * wake, then the turn before the look), to the millisecond. A look 1 ms early
   * or late fails. Returns when it came.
   */
  async function nextLookAt(looks: number[], armedAt: number, waitMs: number, label: string): Promise<number> {
    const looksBefore = looks.length;
    await advance(armedAt + waitMs + DEBOUNCE_MS + YIELD_MS - 1 - Date.now());
    expect(looks.length, `${label}: looked 1 ms early`).toBe(looksBefore);
    await advance(1);
    expect(looks.length, `${label}: did not look on time`).toBe(looksBefore + 1);
    return looks[looksBefore];
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

  it('tries an unreadable board again on a backoff, completes the workflow once it reads with no other event, and then stops', async () => {
    const running = workflowIn('home');
    workflowTask('home', 'Done', running, 'home');
    closeAll();
    fs.writeFileSync(PATHS.projectDb('broken'), 'not a database '.repeat(512));
    register(['home', 'broken']);
    const looksAtBroken = () => probedProjectIds().filter((projectId) => projectId === 'broken').length;

    boot();
    await pass();
    expect(looksAtBroken()).toBe(1);

    // Tried again 5 s on, then 30 s after that. Nothing else wakes the engine.
    await advance(5_000 + DEBOUNCE_MS);
    expect(looksAtBroken()).toBe(2);
    await advance(29_000);
    expect(looksAtBroken()).toBe(2);
    await advance(1_000 + DEBOUNCE_MS);
    expect(looksAtBroken()).toBe(3);
    expect(harness.announceWorkflowComplete).not.toHaveBeenCalled();

    // Repaired between two tries: the next one, a minute on, reads it.
    fs.rmSync(PATHS.projectDb('broken'), { force: true });
    const repaired = new Database(PATHS.projectDb('broken'));
    repaired.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    repaired.close();
    await advance(60_000 + DEBOUNCE_MS);

    expect(harness.announceWorkflowComplete).toHaveBeenCalledTimes(1);
    expect(new WorkflowRepository(getProjectDb('home')).getById(running)!.state).toBe('done');
    // Every board read, so nothing is left to try.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits 5 s, 30 s, 1 m, 2 m and then 5 m between looks at an unreadable board, and stays at 5 m', async () => {
    register(['broken']);
    corruptBroken();
    const looks = recordLooksAtBroken();

    boot();
    await pass();
    expect(looks).toHaveLength(1);

    // The list ends at 5 m, so the step that reaches it and the two after it all wait 5 m.
    let lastLookAt = looks[0];
    const waitsMs = [5_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000];
    for (const [index, waitMs] of waitsMs.entries()) {
      lastLookAt = await nextLookAt(looks, lastLookAt, waitMs, `step ${index + 1} (${waitMs} ms)`);
    }
    expect(looks).toHaveLength(waitsMs.length + 1);
  });

  it('starts the backoff over at 5 s when a board goes unreadable again after a pass that read every board', async () => {
    register(['member']);
    const engine = boot();
    // Open, and broken and healed under the engine. A board it has read once is
    // not looked at again, so a file rewritten as garbage would go unnoticed.
    const memberDb = getProjectDb('member');
    memberDb.exec(BREAKS.activeWorkflows.break);
    const passes = () => engine.stats().samples;

    // The 5 s and 30 s retries run, and a 1 m one is left pending.
    await pass();
    await advance(5_000 + DEBOUNCE_MS);
    await advance(30_000 + DEBOUNCE_MS);
    expect(passes()).toBe(3);

    memberDb.exec(BREAKS.activeWorkflows.heal);
    engine.wake();
    await pass();
    expect(passes()).toBe(4);
    expect(vi.getTimerCount()).toBe(0);

    memberDb.exec(BREAKS.activeWorkflows.break);
    engine.wake();
    await pass();
    expect(passes()).toBe(5);

    // 5 s again, not the 2 m that the three tries before the repair would lead to.
    await advance(5_000 + DEBOUNCE_MS);
    expect(passes()).toBe(6);
  });

  it('arms one retry however many passes run while it is pending, and those passes do not move the backoff on', async () => {
    register(['broken']);
    corruptBroken();
    const looks = recordLooksAtBroken();

    const engine = boot();
    await pass();
    const armedAt = looks[0];
    expect(vi.getTimerCount()).toBe(1);

    // Other events wake the engine inside the 5 s wait. Each pass finds the board
    // still unread, and neither adds a timer nor takes a step of the backoff.
    for (let extraPass = 0; extraPass < 3; extraPass += 1) {
      engine.wake();
      await pass();
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(looks).toHaveLength(4);

    // The retry is still the one the first pass armed, and the next waits 30 s.
    const firstRetryAt = await nextLookAt(looks, armedAt, 5_000, 'first retry');
    await nextLookAt(looks, firstRetryAt, 30_000, 'second retry');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('cancels a pending retry of an unreadable board when the engine is disposed', async () => {
    register(['broken']);
    corruptBroken();
    const looks = recordLooksAtBroken();

    const engine = boot();
    await pass();
    expect(looks).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
    // Well past the 5 s the retry waits. A disposed engine ignores a wake, so the
    // timer count above is what shows the retry was cancelled.
    await advance(60_000);
    expect(looks).toHaveLength(1);
  });

  it('cancels a pending retry when a pass that reads every board runs before it fires', async () => {
    register(['broken']);
    corruptBroken();

    const engine = boot();
    await pass();
    expect(vi.getTimerCount()).toBe(1);

    repairBroken();
    engine.wake();
    await pass();
    expect(vi.getTimerCount()).toBe(0);

    // The 5 s retry would have woken a pass by now.
    const passesBefore = engine.stats().samples;
    await advance(5_000 + DEBOUNCE_MS);
    expect(engine.stats().samples).toBe(passesBefore);
  });

  it('ends the pass on a read failure that is no database error, rather than reading the board as unread', async () => {
    const running = workflowIn('home');
    workflowTask('home', 'Done', running, 'home');
    closeAll();
    register(['home', 'member']);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(probeWorkflowProject).mockImplementationOnce(() => {
      throw new TypeError('probeWorkflowProject is not a function');
    });

    boot();
    await pass();

    const evaluationFailures = vi.mocked(console.error).mock.calls.filter(([message]) => String(message).includes('Evaluation failed'));
    expect(evaluationFailures).toHaveLength(1);
    expect(evaluationFailures[0][1]).toBeInstanceOf(TypeError);
    expect(unreadWarnings()).toEqual([]);
    // Not a board to try again on a backoff.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms no retry when every registered board reads', async () => {
    register(['home']);
    const running = workflowIn('home');
    workflowTask('home', 'Executing', running, 'home');

    boot();
    await pass();

    expect(vi.getTimerCount()).toBe(0);
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

  it('starts a task held by a blocker on a board it could not read once that board reads, with no other event', async () => {
    register(['home', 'member']);
    const running = workflowIn('home');
    const blocker = workflowTask('member', 'Done', running, 'home');
    const blocked = workflowTask('home', 'To Do', running, 'home');
    new TaskLinkRepository(getProjectDb('home')).insert({
      workflow_id: running,
      blocker_project_id: 'member',
      blocker_task_id: blocker,
      blocked_project_id: 'home',
      blocked_task_id: blocked,
    });

    boot();
    const memberDb = getProjectDb('member');
    memberDb.exec(BREAKS.activeWorkflows.break);
    await pass();
    expect(startedTaskIds()).toEqual([]);

    // The lock clears. No move, slot or write follows; the retry 5 s on reads it.
    memberDb.exec(BREAKS.activeWorkflows.heal);
    await advance(5_000 + DEBOUNCE_MS);

    expect(startedTaskIds()).toEqual([blocked]);
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

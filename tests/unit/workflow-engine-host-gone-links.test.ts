/**
 * The engine drops a link whose task is provably gone (src/main/workflows/workflow-engine-host.ts,
 * `linkEndState` in workflow-tasks.ts).
 *
 * A delete removes a task's links, but the removal can fail (a cross-board
 * delete whose home write threw is only logged), and a project delete can miss
 * a board. Such a link used to hold its task in To Do forever. Now a pass
 * checks each link with an end missing from its read: provably gone (the
 * project is no longer registered, or its database opens and the row is not
 * there, or is in another workflow) drops the link and lets the task start;
 * anything else (the project's database would not open, or the row is still in
 * this workflow) keeps it holding.
 *
 * Real, migrated SQLite for a home project and a second board; the move is
 * mocked to move the task out of To Do, as the real one does. A project whose
 * database is left out of the harness reads as one that would not open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';

interface MoveInput {
  taskId: string;
  targetSwimlaneId: string;
}

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  opened: [] as string[],
  handleTaskMove: vi.fn(),
  notifyWorkflowChanged: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    harness.opened.push(projectId);
    const projectDatabase = harness.dbs.get(projectId);
    if (!projectDatabase) throw new Error(`No database for ${projectId}`);
    return projectDatabase;
  },
  // A project left out of the harness has no file, as the real one answers.
  getExistingProjectDb: (projectId: string) => {
    harness.opened.push(projectId);
    return harness.dbs.get(projectId) ?? null;
  },
  // A project in the harness is open. One left out is a project that would not
  // open, as a locked database is: the engine's look at it throws. Neither
  // records an open, since only a read that would create or migrate does.
  getOpenProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  peekProjectDb: (projectId: string) => {
    // What better-sqlite3 throws for a locked file: an error carrying its SQLite code.
    if (!harness.dbs.has(projectId)) throw Object.assign(new Error(`database for ${projectId} is locked`), { code: 'SQLITE_BUSY' });
    return null;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: harness.handleTaskMove }));
vi.mock('../../src/main/git/fetch-throttle', () => ({ forgetRecentFetches: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  BranchCheckoutBlockedError: class BranchCheckoutBlockedError extends Error {},
  notifySpawnBlocked: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-agent', () => ({ endWorkflowAgent: vi.fn(async () => undefined) }));
vi.mock('../../src/main/workflows/workflow-complete', () => ({ announceWorkflowComplete: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', () => ({
  notifyWorkflowChanged: harness.notifyWorkflowChanged,
  setWorkflowChangedWindow: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-runtime', () => ({ setWorkflowRuntimeContext: vi.fn() }));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const { setHomeLinkRemover } = await import('../../src/main/db/repositories/workflow-home-links');
const { registerWorkflowEngine, getWorkflowEngine } = await import('../../src/main/workflows/workflow-engine-host');
const { setWorkflowWake } = await import('../../src/main/workflows/workflow-wake');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const DEBOUNCE_MS = 150;

describe('the workflow engine host and links to gone tasks', () => {
  let engine: ReturnType<typeof registerWorkflowEngine>;
  let projects: Array<{ id: string; name: string; path: string }>;
  let emitBoardChanged: ReturnType<typeof vi.fn>;

  function database(projectId: string): Database.Database {
    const projectDatabase = openTestDatabase();
    projectDatabase.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(projectDatabase);
    harness.dbs.set(projectId, projectDatabase);
    return projectDatabase;
  }

  const dbOf = (projectId: string) => harness.dbs.get(projectId) as Database.Database;
  const laneOf = (projectId: string, match: (lane: { role: string | null; name: string }) => boolean) =>
    new SwimlaneRepository(dbOf(projectId)).list().find(match)!;
  const todoOf = (projectId: string) => laneOf(projectId, (lane) => lane.role === 'todo');
  const planningOf = (projectId: string) => laneOf(projectId, (lane) => lane.name === 'Planning');
  const advance = (milliseconds: number) => vi.advanceTimersByTimeAsync(milliseconds);

  function createTask(projectId: string, workflowId: string, title: string, swimlaneId: string, homeProjectId = 'home'): string {
    return new TaskRepository(dbOf(projectId)).create({
      title,
      description: '',
      swimlane_id: swimlaneId,
      workflow: {
        workflow_id: workflowId,
        workflow_project_id: homeProjectId,
        route_start_swimlane_id: null,
        route_last_swimlane_id: null,
        skipped_swimlane_ids: [],
        canvas_x: null,
        canvas_y: null,
      },
    }).id;
  }

  /**
   * A running workflow homed in `home`: a blocker in Planning on the mobile
   * board, and a task in To Do on the home board that waits for it.
   */
  function workflowAcrossBoards(): { workflowId: string; blockerId: string; dependentId: string } {
    const workflows = new WorkflowRepository(dbOf('home'));
    const workflowId = workflows.create({ title: 'Usage budgets' }).id;
    const blockerId = createTask('mobile', workflowId, 'Budget API', planningOf('mobile').id);
    const dependentId = createTask('home', workflowId, 'Budget page', todoOf('home').id);
    new TaskLinkRepository(dbOf('home')).insert({
      workflow_id: workflowId,
      blocker_project_id: 'mobile',
      blocker_task_id: blockerId,
      blocked_project_id: 'home',
      blocked_task_id: dependentId,
    });
    workflows.markStarted(workflowId);
    return { workflowId, blockerId, dependentId };
  }

  const linksOf = (workflowId: string) => new TaskLinkRepository(dbOf('home')).listForWorkflow(workflowId);
  const startsOf = (taskId: string) => harness.handleTaskMove.mock.calls.filter(([, input]) => (input as MoveInput).taskId === taskId);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    harness.handleTaskMove.mockReset();
    harness.handleTaskMove.mockImplementation(async (_context: unknown, input: MoveInput, _origin: string, projectId: string) => {
      dbOf(projectId).prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(input.targetSwimlaneId, input.taskId);
    });
    harness.notifyWorkflowChanged.mockReset();
    harness.opened.length = 0;
    harness.dbs.clear();
    database('home');
    database('mobile');
    projects = [
      { id: 'home', name: 'kangentic', path: '/mock/home' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/mock/mobile' },
    ];
    emitBoardChanged = vi.fn();
    const context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      sessionManager: Object.assign(new EventEmitter(), { getFreeAgentSlots: () => 10 }),
      boardEvents: { onBoardChanged: vi.fn(), emitBoardChanged },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    engine = registerWorkflowEngine(context);
  });

  afterEach(() => {
    getWorkflowEngine()?.dispose();
    setHomeLinkRemover(null);
    setWorkflowWake(null);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
  });

  it('holds a task while its blocker is on a board and not done', async () => {
    const { workflowId, dependentId } = workflowAcrossBoards();
    await advance(DEBOUNCE_MS);
    expect(linksOf(workflowId)).toHaveLength(1);
    expect(startsOf(dependentId)).toHaveLength(0);
  });

  it('drops the link of a blocker whose row is gone, and starts the task that waited for it', async () => {
    const { workflowId, blockerId, dependentId } = workflowAcrossBoards();
    // Deleted without the remover: what a delete whose home write threw leaves.
    dbOf('mobile').prepare('DELETE FROM tasks WHERE id = ?').run(blockerId);
    const revisionBefore = new WorkflowRepository(dbOf('home')).getById(workflowId)!.revision;

    await advance(DEBOUNCE_MS);

    expect(linksOf(workflowId)).toEqual([]);
    expect(startsOf(dependentId)).toHaveLength(1);
    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: 'home', change: 'task-updated', ids: [] });
    expect(harness.notifyWorkflowChanged).toHaveBeenCalledWith('home', workflowId);
    // Finishing a delete is not a plan change: the revision stays, as a delete's does.
    expect(new WorkflowRepository(dbOf('home')).getById(workflowId)!.revision).toBe(revisionBefore);
  });

  it('still drops a provably gone link, and starts its task, in a pass that cannot read some other board', async () => {
    // The unread board withholds completions and starts that wait on a task
    // there. A link to a task provably gone from a readable board is neither.
    projects.push({ id: 'locked', name: 'locked-board', path: '/mock/locked' });
    const { workflowId, blockerId, dependentId } = workflowAcrossBoards();
    dbOf('mobile').prepare('DELETE FROM tasks WHERE id = ?').run(blockerId);

    // Past the debounce, for the turn the pass yields between two looks at
    // unopened boards.
    await advance(DEBOUNCE_MS + 50);

    expect(linksOf(workflowId)).toEqual([]);
    expect(startsOf(dependentId)).toHaveLength(1);
  });

  it('drops the link of a blocker whose task moved to another workflow', async () => {
    const { workflowId, blockerId, dependentId } = workflowAcrossBoards();
    dbOf('mobile').prepare("UPDATE tasks SET workflow_id = 'another-workflow' WHERE id = ?").run(blockerId);

    await advance(DEBOUNCE_MS);

    expect(linksOf(workflowId)).toEqual([]);
    expect(startsOf(dependentId)).toHaveLength(1);
  });

  it('drops the link of a blocker whose project was removed, without opening that project', async () => {
    const { workflowId, dependentId } = workflowAcrossBoards();
    projects = projects.filter((project) => project.id !== 'mobile');
    harness.opened.length = 0;

    await advance(DEBOUNCE_MS);

    expect(linksOf(workflowId)).toEqual([]);
    expect(startsOf(dependentId)).toHaveLength(1);
    expect(harness.opened).not.toContain('mobile');
  });

  it('keeps holding a task whose blocker\'s project will not open, and opens that project once a pass', async () => {
    const { workflowId, dependentId } = workflowAcrossBoards();
    // A second task waiting on another task of the same unreadable board.
    const secondBlocker = createTask('mobile', workflowId, 'Budget alerts', planningOf('mobile').id);
    const secondDependent = createTask('home', workflowId, 'Alert settings', todoOf('home').id);
    new TaskLinkRepository(dbOf('home')).insert({
      workflow_id: workflowId,
      blocker_project_id: 'mobile',
      blocker_task_id: secondBlocker,
      blocked_project_id: 'home',
      blocked_task_id: secondDependent,
    });
    (harness.dbs.get('mobile') as Database.Database).close();
    harness.dbs.delete('mobile');
    harness.opened.length = 0;

    await advance(DEBOUNCE_MS);

    expect(linksOf(workflowId)).toHaveLength(2);
    expect(startsOf(dependentId)).toHaveLength(0);
    expect(startsOf(secondDependent)).toHaveLength(0);
    // A pass looks at the project once (the engine's look, which fails here) and
    // opens it not at all. The link checks reuse that failure, since a fresh open
    // per link would wait out the busy timeout each time.
    expect(harness.opened.filter((projectId) => projectId === 'mobile')).toHaveLength(0);
    expect(emitBoardChanged).not.toHaveBeenCalled();
  });

  it('keeps holding a task whose blocker is still in this workflow but missing from the read', async () => {
    const { workflowId, blockerId, dependentId } = workflowAcrossBoards();
    // Still this workflow's id, but no longer counted as its task (the read
    // filters by home): the shape of a task the read raced.
    dbOf('mobile').prepare("UPDATE tasks SET workflow_project_id = 'elsewhere' WHERE id = ?").run(blockerId);

    await advance(DEBOUNCE_MS);

    expect(linksOf(workflowId)).toHaveLength(1);
    expect(startsOf(dependentId)).toHaveLength(0);
  });

  it('logs a drop that keeps failing once, announces nothing, and still starts the task', async () => {
    const { workflowId, blockerId, dependentId } = workflowAcrossBoards();
    dbOf('mobile').prepare('DELETE FROM tasks WHERE id = ?').run(blockerId);
    vi.spyOn(TaskLinkRepository.prototype, 'delete').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await advance(DEBOUNCE_MS);
    engine.wake();
    await advance(DEBOUNCE_MS);

    const dropFailures = vi.mocked(console.error).mock.calls.filter(([message]) => String(message).includes('Could not drop'));
    expect(dropFailures).toHaveLength(1);
    expect(emitBoardChanged).not.toHaveBeenCalled();
    expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();
    expect(linksOf(workflowId)).toHaveLength(1);
    expect(startsOf(dependentId)).toHaveLength(1);
  });

  it('logs a failing drop again once a drop of the same workflow went through in between', async () => {
    const { workflowId, blockerId } = workflowAcrossBoards();
    dbOf('mobile').prepare('DELETE FROM tasks WHERE id = ?').run(blockerId);
    // Throws on the first call only; every call after it runs the real delete.
    const deleteSpy = vi.spyOn(TaskLinkRepository.prototype, 'delete').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const dropFailures = () => vi.mocked(console.error).mock.calls.filter(([message]) => String(message).includes('Could not drop'));

    await advance(DEBOUNCE_MS);
    expect(dropFailures()).toHaveLength(1);
    expect(linksOf(workflowId)).toHaveLength(1);

    // The next pass goes through, which re-arms the once-only log for this workflow.
    engine.wake();
    await advance(DEBOUNCE_MS);
    expect(linksOf(workflowId)).toEqual([]);
    expect(dropFailures()).toHaveLength(1);

    // A new gone link in the same workflow, whose drop fails again.
    const secondBlockerId = createTask('mobile', workflowId, 'Budget alerts', planningOf('mobile').id);
    const secondDependentId = createTask('home', workflowId, 'Alert settings', todoOf('home').id);
    new TaskLinkRepository(dbOf('home')).insert({
      workflow_id: workflowId,
      blocker_project_id: 'mobile',
      blocker_task_id: secondBlockerId,
      blocked_project_id: 'home',
      blocked_task_id: secondDependentId,
    });
    dbOf('mobile').prepare('DELETE FROM tasks WHERE id = ?').run(secondBlockerId);
    deleteSpy.mockImplementation(() => {
      throw new Error('database is locked');
    });

    engine.wake();
    await advance(DEBOUNCE_MS);

    expect(dropFailures()).toHaveLength(2);
    expect(linksOf(workflowId)).toHaveLength(1);
  });

  it('drops the link of a blocked task whose row is gone, and announces the board of that task', async () => {
    const { workflowId, dependentId } = workflowAcrossBoards();
    // The blocker stays alive on the mobile board. Only the blocked end is gone,
    // deleted without the remover: what a delete whose link write threw leaves.
    dbOf('home').prepare('DELETE FROM tasks WHERE id = ?').run(dependentId);

    await advance(DEBOUNCE_MS);

    expect(linksOf(workflowId)).toEqual([]);
    expect(emitBoardChanged).toHaveBeenCalledTimes(1);
    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: 'home', change: 'task-updated', ids: [] });
    expect(harness.notifyWorkflowChanged).toHaveBeenCalledWith('home', workflowId);
  });

  it('announces nothing for a link that is already gone when the drop runs', async () => {
    const { blockerId } = workflowAcrossBoards();
    dbOf('mobile').prepare('DELETE FROM tasks WHERE id = ?').run(blockerId);
    // What a concurrent remover that got there first leaves: nothing to delete.
    const deleteSpy = vi.spyOn(TaskLinkRepository.prototype, 'delete').mockReturnValue(false);

    await advance(DEBOUNCE_MS);

    // The drop ran and found nothing to delete, so there is nothing to announce.
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(emitBoardChanged).not.toHaveBeenCalled();
    expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.filter(([message]) => String(message).includes('Dropped'))).toEqual([]);
  });
});

/**
 * A start that fails is retried with a backoff (src/main/workflows/workflow-engine-host.ts).
 *
 * The host reads each running workflow from real, migrated SQLite (a home
 * project and a second board), plans with the real core, and carries a start out
 * through `handleTaskMove`, which is mocked: it either moves the task out of To
 * Do, as the real move does, or rejects with a chosen error. Fake timers drive
 * the debounce and the one-shot retry timers; every wait is a number of
 * simulated milliseconds, never a real sleep.
 *
 * The backoff is 30 s, 60 s, 120 s, then 300 s after each further failure. A
 * wake before the backoff ends starts nothing. A success, a task that leaves To
 * Do, a workflow that is done, or a deleted task drops it; Resume (through
 * `wakeWorkflowEngine(workflowId)`) clears that workflow's entries so the next
 * pass retries at once; Pause keeps them. The failure toast is `notifySpawnBlocked`
 * once per reason, with the step the error names.
 *
 * Also here: the home-link remover `registerWorkflowEngine` installs, so a task
 * deleted on another board takes its links out of the home project's database.
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
  handleTaskMove: vi.fn(),
  notifySpawnBlocked: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: harness.handleTaskMove }));
vi.mock('../../src/main/git/fetch-throttle', () => ({ forgetRecentFetches: vi.fn() }));
// Mocked whole rather than through importOriginal, which would load the git
// helpers. The class only has to be one `instanceof` can tell apart.
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  BranchCheckoutBlockedError: class BranchCheckoutBlockedError extends Error {},
  notifySpawnBlocked: harness.notifySpawnBlocked,
}));
vi.mock('../../src/main/workflows/workflow-agent', () => ({ endWorkflowAgent: vi.fn(async () => undefined) }));
vi.mock('../../src/main/workflows/workflow-complete', () => ({ announceWorkflowComplete: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', () => ({
  notifyWorkflowChanged: vi.fn(),
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
const { setWorkflowWake, wakeWorkflowEngine } = await import('../../src/main/workflows/workflow-wake');
const { BranchCheckoutBlockedError } = await import('../../src/main/ipc/helpers/task-git');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const DEBOUNCE_MS = 150;

describe('the workflow engine host', () => {
  let context: IpcContext;
  let engine: ReturnType<typeof registerWorkflowEngine>;
  /** The simulated time of each start the mocked move was asked for. */
  let startTimes: number[];

  function database(projectId: string): Database.Database {
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set(projectId, db);
    return db;
  }

  const dbOf = (projectId: string) => harness.dbs.get(projectId) as Database.Database;
  const lanesOf = (projectId: string) => new SwimlaneRepository(dbOf(projectId)).list();
  const todoOf = (projectId: string) => lanesOf(projectId).find((lane) => lane.role === 'todo')!;
  const planningOf = (projectId: string) => lanesOf(projectId).find((lane) => lane.name === 'Planning')!;

  /** A running workflow in the home project, with `count` tasks waiting in its To Do. */
  function runningWorkflow(title: string, count = 1): { workflowId: string; taskIds: string[] } {
    const workflows = new WorkflowRepository(dbOf('home'));
    const workflow = workflows.create({ title });
    const tasks = new TaskRepository(dbOf('home'));
    const taskIds = Array.from({ length: count }, (_unused, index) => tasks.create({
      title: `${title} ${index}`,
      description: '',
      swimlane_id: todoOf('home').id,
      workflow: {
        workflow_id: workflow.id,
        workflow_project_id: 'home',
        route_start_swimlane_id: null,
        route_last_swimlane_id: null,
        skipped_swimlane_ids: [],
        canvas_x: null,
        canvas_y: null,
      },
    }).id);
    workflows.markStarted(workflow.id);
    return { workflowId: workflow.id, taskIds };
  }

  const advance = (milliseconds: number) => vi.advanceTimersByTimeAsync(milliseconds);

  /** The mocked move: records when it was asked and moves the task out of To Do. */
  function moveSucceeds(): void {
    harness.handleTaskMove.mockImplementation(async (_context: unknown, input: MoveInput, _origin: string, projectId: string) => {
      startTimes.push(Date.now());
      dbOf(projectId).prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(input.targetSwimlaneId, input.taskId);
    });
  }

  function moveFails(error: unknown = new Error('git exploded')): void {
    harness.handleTaskMove.mockImplementation(async () => {
      startTimes.push(Date.now());
      throw error;
    });
  }

  const movesOf = (taskId: string) => harness.handleTaskMove.mock.calls.filter(([, input]) => (input as MoveInput).taskId === taskId);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    harness.handleTaskMove.mockReset();
    harness.notifySpawnBlocked.mockReset();
    startTimes = [];
    harness.dbs.clear();
    database('home');
    database('mobile');
    const projects = [
      { id: 'home', name: 'kangentic', path: '/mock/home' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/mock/mobile' },
    ];
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      sessionManager: Object.assign(new EventEmitter(), { getFreeAgentSlots: () => 10 }),
      boardEvents: { onBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false },
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
  });

  describe('a start that fails', () => {
    it('is retried after 30 s, 60 s, 120 s and then every 300 s, and a wake before the backoff ends starts nothing', async () => {
      const { taskIds: [taskId] } = runningWorkflow('Usage budgets');
      moveFails();
      const delays = [30_000, 60_000, 120_000, 300_000, 300_000, 300_000];

      // The boot wake's debounce, then the first pass.
      await advance(DEBOUNCE_MS);

      for (let attempt = 1; attempt <= delays.length; attempt += 1) {
        expect(startTimes).toHaveLength(attempt);
        const failure = engine.failedStart('home', taskId)!;
        expect(failure.attempts).toBe(attempt);
        expect(failure.retryAt).toBe(startTimes[attempt - 1] + delays[attempt - 1]);

        // A board change well inside the backoff: the pass runs and starts nothing.
        await advance(delays[attempt - 1] - 1_000);
        engine.wake();
        await advance(DEBOUNCE_MS + 100);
        expect(startTimes).toHaveLength(attempt);

        // Across the backoff: the retry timer wakes the engine, and the start is tried again.
        if (attempt < delays.length) {
          await advance(failure.retryAt - Date.now() + DEBOUNCE_MS);
          expect(startTimes).toHaveLength(attempt + 1);
        }
      }
    });

    it('is cleared by a later success, which starts the task once and leaves nothing to retry', async () => {
      const { taskIds: [taskId] } = runningWorkflow('Usage budgets');
      moveFails();
      await advance(DEBOUNCE_MS);
      const failure = engine.failedStart('home', taskId)!;
      expect(failure.attempts).toBe(1);

      moveSucceeds();
      await advance(failure.retryAt - Date.now() + DEBOUNCE_MS);

      expect(movesOf(taskId)).toHaveLength(2);
      expect(engine.failedStart('home', taskId)).toBeNull();
      expect(new TaskRepository(dbOf('home')).getById(taskId)!.swimlane_id).toBe(planningOf('home').id);
      // The settled start wakes the engine once more (a debounce), and after
      // that pass no timer is left to start it again.
      await advance(DEBOUNCE_MS);
      expect(vi.getTimerCount()).toBe(0);
      await advance(10 * 60_000);
      expect(movesOf(taskId)).toHaveLength(2);
    });

    it('is retried by a one-shot timer that never keeps the app from quitting, and dispose clears it', async () => {
      const { taskIds: [taskId] } = runningWorkflow('Usage budgets');
      moveFails();
      await advance(DEBOUNCE_MS * 2);

      // One pending retry for the one failed task, and nothing polling.
      expect(vi.getTimerCount()).toBe(1);
      const failedStarts = (engine as unknown as { failedStarts: Map<string, { timer: { hasRef(): boolean } | null }> }).failedStarts;
      const [failure] = [...failedStarts.values()];
      expect(failure.timer?.hasRef()).toBe(false);

      // The retry fires once and leaves one timer for the next, not an accumulation.
      await advance(30_000);
      expect(movesOf(taskId)).toHaveLength(2);
      await advance(DEBOUNCE_MS * 2);
      expect(vi.getTimerCount()).toBe(1);

      engine.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('the failure toast', () => {
    it('shows once for the first failure and not again for the same message, and again for a different one', async () => {
      const { taskIds: [taskId] } = runningWorkflow('Usage budgets');
      harness.handleTaskMove
        .mockImplementationOnce(async () => { throw new Error('git exploded'); })
        .mockImplementationOnce(async () => { throw new Error('git exploded'); })
        .mockImplementationOnce(async () => { throw new Error('the disk is full'); });

      await advance(DEBOUNCE_MS);
      expect(harness.notifySpawnBlocked).toHaveBeenCalledTimes(1);
      expect(harness.notifySpawnBlocked).toHaveBeenCalledWith(
        context, expect.objectContaining({ id: taskId }), 'agent', expect.objectContaining({ message: 'git exploded' }), 'home',
      );

      // Second failure, same message: no new toast.
      await advance(engine.failedStart('home', taskId)!.retryAt - Date.now() + DEBOUNCE_MS);
      expect(harness.handleTaskMove).toHaveBeenCalledTimes(2);
      expect(harness.notifySpawnBlocked).toHaveBeenCalledTimes(1);

      // Third failure, a different message: toasts again.
      await advance(engine.failedStart('home', taskId)!.retryAt - Date.now() + DEBOUNCE_MS);
      expect(harness.handleTaskMove).toHaveBeenCalledTimes(3);
      expect(harness.notifySpawnBlocked).toHaveBeenCalledTimes(2);
      expect(harness.notifySpawnBlocked).toHaveBeenLastCalledWith(
        context, expect.objectContaining({ id: taskId }), 'agent', expect.objectContaining({ message: 'the disk is full' }), 'home',
      );
    });

    it('names the worktree step and passes the cause for a "Worktree setup failed: " error', async () => {
      runningWorkflow('Usage budgets');
      const cause = new Error('fatal: a branch named that already exists');
      moveFails(new Error('Worktree setup failed: fatal: a branch named that already exists', { cause }));

      await advance(DEBOUNCE_MS);

      expect(harness.notifySpawnBlocked).toHaveBeenCalledTimes(1);
      expect(harness.notifySpawnBlocked.mock.calls[0].slice(2)).toEqual(['worktree', cause, 'home']);
    });

    it('passes the error itself as the cause of a worktree failure that carries none', async () => {
      runningWorkflow('Usage budgets');
      const error = new Error('Worktree setup failed: no space left');
      moveFails(error);

      await advance(DEBOUNCE_MS);

      expect(harness.notifySpawnBlocked.mock.calls[0].slice(2)).toEqual(['worktree', error, 'home']);
    });

    it('names the checkout step for a BranchCheckoutBlockedError', async () => {
      runningWorkflow('Usage budgets');
      const error = new BranchCheckoutBlockedError('Cannot switch branches: another task is running there.');
      moveFails(error);

      await advance(DEBOUNCE_MS);

      expect(harness.notifySpawnBlocked.mock.calls[0].slice(2)).toEqual(['checkout', error, 'home']);
    });

    it('names the agent step for any other failure, a thrown string included', async () => {
      runningWorkflow('Usage budgets');
      moveFails('the spawn queue is gone');

      await advance(DEBOUNCE_MS);

      expect(harness.notifySpawnBlocked.mock.calls[0].slice(2)).toEqual(['agent', 'the spawn queue is gone', 'home']);
    });
  });

  describe('the backoff is dropped', () => {
    async function failOnce(): Promise<{ workflowId: string; taskId: string }> {
      const { workflowId, taskIds: [taskId] } = runningWorkflow('Usage budgets');
      moveFails();
      await advance(DEBOUNCE_MS * 2);
      expect(engine.failedStart('home', taskId)?.attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      return { workflowId, taskId };
    }

    it('when the task no longer waits in To Do', async () => {
      const { taskId } = await failOnce();

      dbOf('home').prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(planningOf('home').id, taskId);
      engine.wake();
      await advance(DEBOUNCE_MS);

      expect(engine.failedStart('home', taskId)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('when the task is deleted', async () => {
      const { taskId } = await failOnce();

      new TaskRepository(dbOf('home')).delete(taskId);
      engine.wake();
      await advance(DEBOUNCE_MS);

      expect(engine.failedStart('home', taskId)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('when the task is taken out of its workflow', async () => {
      const { taskId } = await failOnce();

      new TaskRepository(dbOf('home')).setWorkflowMembership(taskId, null);
      engine.wake();
      await advance(DEBOUNCE_MS);

      expect(engine.failedStart('home', taskId)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('when its workflow is done', async () => {
      const { workflowId, taskId } = await failOnce();

      new WorkflowRepository(dbOf('home')).setState(workflowId, 'done');
      engine.wake();
      await advance(DEBOUNCE_MS);

      expect(engine.failedStart('home', taskId)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('not when its workflow is only paused: the backoff holds, and a resume inside it still waits', async () => {
      const { workflowId, taskId } = await failOnce();
      const failure = engine.failedStart('home', taskId)!;
      const workflows = new WorkflowRepository(dbOf('home'));

      workflows.setState(workflowId, 'paused');
      engine.wake();
      await advance(DEBOUNCE_MS);
      expect(engine.failedStart('home', taskId)).toEqual(failure);

      // Resumed by the repository alone (not through the wake that retries at
      // once), so the backoff still has to run out.
      workflows.setState(workflowId, 'running');
      engine.wake();
      await advance(DEBOUNCE_MS);
      expect(movesOf(taskId)).toHaveLength(1);
      expect(engine.failedStart('home', taskId)).toEqual(failure);
    });
  });

  describe('a resume', () => {
    it('clears that workflow\'s backoff through wakeWorkflowEngine(workflowId), so the next pass retries at once', async () => {
      const first = runningWorkflow('Usage budgets');
      const second = runningWorkflow('Phone app');
      moveFails();
      await advance(DEBOUNCE_MS * 2);
      expect(engine.failedStart('home', first.taskIds[0])?.attempts).toBe(1);
      expect(engine.failedStart('home', second.taskIds[0])?.attempts).toBe(1);

      wakeWorkflowEngine(first.workflowId);

      // The first workflow's entry is gone at once, and its task is tried on
      // the next pass, well inside the 30 s the backoff had left.
      expect(engine.failedStart('home', first.taskIds[0])).toBeNull();
      expect(engine.failedStart('home', second.taskIds[0])?.attempts).toBe(1);
      await advance(DEBOUNCE_MS);
      expect(movesOf(first.taskIds[0])).toHaveLength(2);
      expect(movesOf(second.taskIds[0])).toHaveLength(1);
    });

    it('is not a retry for a wake that names no workflow', async () => {
      const { taskIds: [taskId] } = runningWorkflow('Usage budgets');
      moveFails();
      await advance(DEBOUNCE_MS * 2);

      wakeWorkflowEngine();
      await advance(DEBOUNCE_MS);

      expect(engine.failedStart('home', taskId)?.attempts).toBe(1);
      expect(movesOf(taskId)).toHaveLength(1);
    });

    it('retries every failed task of the workflow, and none of another', async () => {
      const first = runningWorkflow('Usage budgets', 2);
      const second = runningWorkflow('Phone app');
      moveFails();
      await advance(DEBOUNCE_MS * 2);

      engine.retryFailedStarts(first.workflowId);

      for (const taskId of first.taskIds) expect(engine.failedStart('home', taskId)).toBeNull();
      expect(engine.failedStart('home', second.taskIds[0])).not.toBeNull();
    });
  });

  describe('a task deleted on another board', () => {
    function taskOnMobile(workflowId: string, title: string): string {
      return new TaskRepository(dbOf('mobile')).create({
        title,
        description: '',
        swimlane_id: todoOf('mobile').id,
        workflow: {
          workflow_id: workflowId,
          workflow_project_id: 'home',
          route_start_swimlane_id: null,
          route_last_swimlane_id: null,
          skipped_swimlane_ids: [],
          canvas_x: null,
          canvas_y: null,
        },
      }).id;
    }

    it('takes its links out of the home project\'s database, and leaves every other link', async () => {
      const { workflowId, taskIds: [homeTaskId] } = runningWorkflow('Usage budgets');
      const phoneTaskId = taskOnMobile(workflowId, 'Budgets on the phone');
      const otherPhoneTaskId = taskOnMobile(workflowId, 'Another phone task');
      const links = new TaskLinkRepository(dbOf('home'));
      links.insert({ workflow_id: workflowId, blocker_project_id: 'home', blocker_task_id: homeTaskId, blocked_project_id: 'mobile', blocked_task_id: phoneTaskId });
      links.insert({ workflow_id: workflowId, blocker_project_id: 'mobile', blocker_task_id: phoneTaskId, blocked_project_id: 'mobile', blocked_task_id: otherPhoneTaskId });
      links.insert({ workflow_id: workflowId, blocker_project_id: 'home', blocker_task_id: homeTaskId, blocked_project_id: 'mobile', blocked_task_id: otherPhoneTaskId });

      new TaskRepository(dbOf('mobile')).delete(phoneTaskId);

      const remaining = links.listForWorkflow(workflowId);
      expect(remaining.map((link) => [link.blocker_task_id, link.blocked_task_id])).toEqual([[homeTaskId, otherPhoneTaskId]]);
      expect(new TaskRepository(dbOf('mobile')).getById(phoneTaskId)).toBeUndefined();
    });
  });
});

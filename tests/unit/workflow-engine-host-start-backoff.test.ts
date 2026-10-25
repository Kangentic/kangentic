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
 * wake before the backoff ends starts nothing, but the retry timer's own wake
 * counts as the backoff ended, even when the clock has not quite reached the
 * stored retry time. A success, a task that leaves To Do, a workflow that is
 * done, or a deleted task drops it, except that a retry still in flight keeps
 * it: the move commits the task into its target column and announces that before
 * the slow work that can still fail and roll it back, so a pass in between must
 * not start the count over. Resume (through `wakeWorkflowEngine(workflowId)`)
 * clears that workflow's entries so the next pass retries at once; Pause keeps
 * them. The failure toast is `notifySpawnBlocked` once per reason, with the step
 * the error names.
 *
 * Also here: the home-link remover `registerWorkflowEngine` installs, so a task
 * deleted on another board takes its links out of the home project's database,
 * and the agent slots a start still in flight holds back: its session counts
 * against the free slots only once its spawn registers, so until its move
 * settles the host takes one slot off the count for it, and only when its start
 * column runs an agent.
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
  /** Every project `getProjectDb` was asked for: on main it creates a database that is not there. */
  getProjectDbCalls: [] as string[],
  /** Every project `getExistingProjectDb` was asked for: it opens none that is not there. */
  getExistingProjectDbCalls: [] as string[],
  handleTaskMove: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  announceWorkflowStall: vi.fn(),
}));

// Every database here is open, so the engine never looks at an unopened one.
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => {
    harness.getExistingProjectDbCalls.push(projectId);
    return harness.dbs.get(projectId) ?? null;
  },
  getProjectDb: (projectId: string) => {
    harness.getProjectDbCalls.push(projectId);
    const projectDatabase = harness.dbs.get(projectId);
    if (!projectDatabase) throw new Error(`No database for ${projectId}`);
    return projectDatabase;
  },
  getOpenProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  peekProjectDb: () => null,
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
vi.mock('../../src/main/workflows/workflow-recovery', () => ({ announceWorkflowStall: harness.announceWorkflowStall }));

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
  /** What the session manager reports as the free agent slots, which a test sets per pass. */
  let freeAgentSlots: number;

  function database(projectId: string): Database.Database {
    const projectDatabase = openTestDatabase();
    projectDatabase.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(projectDatabase);
    harness.dbs.set(projectId, projectDatabase);
    return projectDatabase;
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
    harness.announceWorkflowStall.mockReset();
    startTimes = [];
    freeAgentSlots = 10;
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
      sessionManager: Object.assign(new EventEmitter(), { getFreeAgentSlots: () => freeAgentSlots }),
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
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
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

    // A toast reaches no one overnight. A start still failing after 30 minutes
    // is a stalled workflow, said once, while the retries go on.
    it('says the workflow stalled once the start has kept failing for 30 minutes, once, and keeps retrying', async () => {
      const { workflowId, taskIds: [taskId] } = runningWorkflow('Usage budgets');
      moveFails(new Error('Worktree setup failed: disk full'));
      await advance(DEBOUNCE_MS);

      // 30 s, 60 s, 120 s, then every 300 s: about 28 minutes in, still quiet.
      await advance(28 * 60_000);
      expect(harness.announceWorkflowStall).not.toHaveBeenCalled();

      await advance(10 * 60_000);
      expect(harness.announceWorkflowStall).toHaveBeenCalledTimes(1);
      expect(harness.announceWorkflowStall).toHaveBeenCalledWith(context, expect.objectContaining({
        projectId: 'home',
        taskId,
        workflowId,
        columnId: todoOf('home').id,
        reason: 'it could not start: Worktree setup failed: disk full',
      }));

      // The retries go on, and say nothing more.
      const startsBefore = startTimes.length;
      await advance(30 * 60_000);
      expect(startTimes.length).toBeGreaterThan(startsBefore);
      expect(harness.announceWorkflowStall).toHaveBeenCalledTimes(1);
    });

    it('is retried when its timer fires before the clock reaches the stored retry time, because the timer\'s own wake treats the retry as due', async () => {
      const { taskIds: [taskId] } = runningWorkflow('Usage budgets');
      moveFails();
      await advance(DEBOUNCE_MS * 2);
      expect(startTimes).toHaveLength(1);
      // Only the retry timer is pending, so the clock step below moves nothing else.
      expect(vi.getTimerCount()).toBe(1);
      const originalRetryAt = engine.failedStart('home', taskId)!.retryAt;
      const remainingMs = originalRetryAt - Date.now();

      // The system clock steps back. Pending timers keep their remaining time, so
      // the retry timer now fires with Date.now() clockStepMs short of the stored
      // retry time. The step is larger than DEBOUNCE_MS on purpose: the wake the
      // timer arms evaluates that long after it fires, so a smaller step would be
      // absorbed by the debounce and the stored time would be reached anyway.
      const clockStepMs = 1_000;
      expect(clockStepMs).toBeGreaterThan(DEBOUNCE_MS);
      vi.setSystemTime(Date.now() - clockStepMs);
      await advance(remainingMs + DEBOUNCE_MS);

      // The start was tried again by that wake. With the stored time left alone,
      // the pass would find the task still backing off, plan nothing, and arm
      // no timer, leaving the task in To Do until an unrelated wake.
      expect(startTimes).toHaveLength(2);
      expect(startTimes[1]).toBeLessThan(originalRetryAt);
      expect(engine.failedStart('home', taskId)?.attempts).toBe(2);
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

    it('keeps its backoff while a retry is in flight, so a move that left To Do and rolls back is the next attempt, not a first one', async () => {
      // The real move commits the task into its target column and announces it on
      // the board bus BEFORE its slow work (worktree, spawn), and that announcement
      // wakes the host. The pass the wake causes runs while the task is outside To
      // Do and the move is still in flight. If the move then fails, it puts the task
      // back in To Do. A pass that forgot the backoff mid-move would count the
      // failure as a first one: always the 30 s delay, and a toast on every retry.
      const { taskIds: [taskId] } = runningWorkflow('Usage budgets');
      const announceBoardChange = vi.mocked(context.boardEvents.onBoardChanged).mock.calls[0][0];
      // Longer than the debounce, so the pass the announcement wakes runs before the move settles.
      const midMoveMs = DEBOUNCE_MS + 100;
      const failedAt: number[] = [];
      const evaluationsDuringMove: number[] = [];
      const backoffDuringMove: Array<number | null> = [];
      harness.handleTaskMove.mockImplementation(async (_context: unknown, input: MoveInput, _origin: string, projectId: string) => {
        startTimes.push(Date.now());
        const projectDatabase = dbOf(projectId);
        projectDatabase.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(input.targetSwimlaneId, input.taskId);
        const evaluationsBefore = engine.stats().samples;
        announceBoardChange({ projectId, change: 'task-updated', ids: [input.taskId] });
        await new Promise<void>((resolve) => { setTimeout(resolve, midMoveMs); });
        // Slow work done, still failing: what the host made of the task meanwhile.
        evaluationsDuringMove.push(engine.stats().samples - evaluationsBefore);
        backoffDuringMove.push(engine.failedStart(projectId, input.taskId)?.attempts ?? null);
        projectDatabase.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(todoOf(projectId).id, input.taskId);
        failedAt.push(Date.now());
        throw new Error('git exploded');
      });
      const delays = [30_000, 60_000, 120_000];

      await advance(DEBOUNCE_MS + midMoveMs);

      for (let attempt = 1; attempt <= delays.length; attempt += 1) {
        expect(startTimes).toHaveLength(attempt);
        const failure = engine.failedStart('home', taskId)!;
        expect(failure.attempts).toBe(attempt);
        expect(failure.retryAt).toBe(failedAt[attempt - 1] + delays[attempt - 1]);
        if (attempt < delays.length) {
          await advance(failure.retryAt - Date.now() + DEBOUNCE_MS + midMoveMs);
        }
      }

      // Every move was overtaken by a pass while the task sat outside To Do, and
      // from the second move on that pass found the earlier failure still recorded.
      expect(evaluationsDuringMove.every((evaluations) => evaluations >= 1)).toBe(true);
      expect(backoffDuringMove).toEqual([null, 1, 2]);
      // The same reason each time, so one toast.
      expect(harness.notifySpawnBlocked).toHaveBeenCalledTimes(1);
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

    it('shows nothing, and does not open the database, for a start whose project was deleted while the move ran', async () => {
      // A workflow homed on `home` with its one task on `mobile`. The toast reads the
      // task after the move failed, by which time `mobile` may be deleted, and
      // `getProjectDb` on main would create an empty database for it again.
      const { workflowId } = runningWorkflow('Usage budgets', 0);
      const taskId = new TaskRepository(dbOf('mobile')).create({
        title: 'Budgets on the phone',
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
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      harness.handleTaskMove.mockImplementation(async () => {
        startTimes.push(Date.now());
        // The project goes while its move runs: its database is closed and gone.
        dbOf('mobile').close();
        harness.dbs.delete('mobile');
        // After the start's own reads of it, so what is recorded from here is the toast's.
        harness.getProjectDbCalls.length = 0;
        harness.getExistingProjectDbCalls.length = 0;
        throw new Error('git exploded');
      });

      // The pass, the move, and the failure recorded; the wake that failure arms has not run.
      await advance(DEBOUNCE_MS);

      // The failed start reached the toast, which looked for the task and found no
      // database: without this, "no toast" would prove nothing.
      expect(startTimes).toHaveLength(1);
      expect(engine.failedStart('mobile', taskId)?.attempts).toBe(1);
      expect(harness.getExistingProjectDbCalls).toContain('mobile');
      expect(harness.notifySpawnBlocked).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Could not report a failed start'), expect.anything());
      expect(harness.getProjectDbCalls).not.toContain('mobile');
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

  describe('the agent slots a start in flight holds back', () => {
    /**
     * Moves that stay in flight until the test ends one, the way a start does
     * while its worktree is set up and before its session registers. `fail(index)`
     * rejects the index-th move, as a worktree failure does: no session was
     * registered, so the free slot count does not change either.
     */
    function holdMoves(): { fail: (index: number) => void } {
      const rejectors: Array<(error: Error) => void> = [];
      harness.handleTaskMove.mockImplementation(() => new Promise<void>((_resolve, reject) => {
        rejectors.push(reject);
      }));
      return { fail: (index) => rejectors[index](new Error('git exploded')) };
    }

    const movedTaskIds = () => harness.handleTaskMove.mock.calls.map(([, input]) => (input as MoveInput).taskId);

    it('starts 2, not 3, when 3 slots are free and 1 start into an agent column is still in flight', async () => {
      runningWorkflow('Usage budgets', 6);
      holdMoves();
      freeAgentSlots = 1;
      await advance(DEBOUNCE_MS);
      expect(harness.handleTaskMove).toHaveBeenCalledTimes(1);

      // The count says 3 are free, but the start in flight has not registered its
      // session, so one of the 3 is already spoken for.
      freeAgentSlots = 3;
      engine.wake();
      await advance(DEBOUNCE_MS);

      expect(harness.handleTaskMove).toHaveBeenCalledTimes(3);
      expect(new Set(movedTaskIds()).size).toBe(3);
    });

    it('holds nothing back for a start into a column that runs no agent', async () => {
      const { taskIds } = runningWorkflow('Usage budgets', 5);
      const executing = lanesOf('home').find((lane) => lane.name === 'Executing')!;
      dbOf('home').prepare('UPDATE swimlanes SET auto_spawn = 0 WHERE id = ?').run(executing.id);
      expect(lanesOf('home').find((lane) => lane.id === executing.id)!.auto_spawn).toBe(false);
      // The first task starts in Executing, which runs no agent; the others in Planning, which does.
      new TaskRepository(dbOf('home')).setRoute(taskIds[0], {
        route_start_swimlane_id: executing.id,
        route_last_swimlane_id: null,
        skipped_swimlane_ids: [],
      });
      holdMoves();

      // With no slot free, only the start that needs none can run.
      freeAgentSlots = 0;
      await advance(DEBOUNCE_MS);
      expect(movedTaskIds()).toEqual([taskIds[0]]);

      // It is still in flight, and it spends no slot: all 3 free ones go to the others.
      freeAgentSlots = 3;
      engine.wake();
      await advance(DEBOUNCE_MS);

      expect(harness.handleTaskMove).toHaveBeenCalledTimes(4);
      expect(new Set(movedTaskIds()).size).toBe(4);
    });

    it('gives the slot back when the start settles, so the next pass can use it', async () => {
      runningWorkflow('Usage budgets', 6);
      const moves = holdMoves();
      freeAgentSlots = 1;
      await advance(DEBOUNCE_MS);
      freeAgentSlots = 3;
      engine.wake();
      await advance(DEBOUNCE_MS);
      // Three starts in flight hold all three free slots.
      expect(harness.handleTaskMove).toHaveBeenCalledTimes(3);

      // The first fails, so no session took its slot: the count stays 3, and 1 is free again.
      moves.fail(0);
      await advance(DEBOUNCE_MS);

      expect(harness.handleTaskMove).toHaveBeenCalledTimes(4);
      expect(new Set(movedTaskIds()).size).toBe(4);
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

    it('deletes a task whose workflow home was deleted, without opening a database for that home', () => {
      // A home whose project was deleted took its links with it. Opening it
      // through getProjectDb would create an empty database file for it on main.
      const taskId = new TaskRepository(dbOf('mobile')).create({
        title: 'Orphaned phone task',
        description: '',
        swimlane_id: todoOf('mobile').id,
        workflow: {
          workflow_id: 'workflow-of-a-deleted-project',
          workflow_project_id: 'deleted-project',
          route_start_swimlane_id: null,
          route_last_swimlane_id: null,
          skipped_swimlane_ids: [],
          canvas_x: null,
          canvas_y: null,
        },
      }).id;
      harness.getProjectDbCalls.length = 0;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      new TaskRepository(dbOf('mobile')).delete(taskId);

      expect(new TaskRepository(dbOf('mobile')).getById(taskId)).toBeUndefined();
      expect(harness.getProjectDbCalls).not.toContain('deleted-project');
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

import { performance } from 'node:perf_hooks';
import type { Swimlane, Task, Workflow } from '../../shared/types';
import { startColumn } from '../../shared/workflow-route';
import { getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { setHomeLinkRemover } from '../db/repositories/workflow-home-links';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { TaskLinkRepository } from '../db/repositories/task-link-repository';
import { forgetRecentFetches } from '../git/fetch-throttle';
import { handleTaskMove } from '../ipc/handlers/task-move';
import { BranchCheckoutBlockedError, notifySpawnBlocked, type SpawnFailureStep } from '../ipc/helpers/task-git';
import type { IpcContext } from '../ipc/ipc-context';
import {
  inFlightKey,
  planPass,
  type CoreIntent,
  type CorePlace,
  type CoreTask,
  type CoreWorkflow,
} from './engine/workflow-engine-core';
import { announceWorkflowComplete } from './workflow-complete';
import { endWorkflowAgent } from './workflow-agent';
import { notifyWorkflowChanged, setWorkflowChangedWindow } from './workflow-changed';
import { setWorkflowWake } from './workflow-wake';
import { setWorkflowRuntimeContext } from './workflow-runtime';

/**
 * The workflow engine's host on main: it wakes on events, reads each running
 * workflow into the core's plain shape, asks the core what to do
 * (`planPass`), and carries the answer out through the one move path.
 *
 * - **Never a timer of its own beyond a debounce.** It wakes on a board change,
 *   a freed agent slot, a turn end, a start or resume, and project open, and a
 *   burst of those coalesces into one pass after `DEBOUNCE_MS`. A pass that
 *   finds nothing running costs one indexed query per project, once every
 *   project's database is open. The first pass after launch opens, and
 *   migrates, each registered project's database that is not open yet.
 * - **Never awaits a whole move.** A start is `handleTaskMove` with origin
 *   `'workflow'`; the host tracks it as in flight until it settles, so a pass in
 *   the meantime never issues it twice, and the next pass sees where it landed.
 *   A move to Done suspends, reaps and removes the worktree inside the task
 *   lock, which can take seconds; nothing here waits on that.
 * - **Measured.** Each evaluation (the synchronous read and plan) is timed, and
 *   `stats()` reports its p95 against the 2 ms budget (#732, Open questions 2).
 * - **A start that fails is retried, with backoff, until it starts** (user's
 *   call, 2026-10-04: one retry is not enough for a network or git blip). A
 *   worktree or git failure has already put the task back in To Do; each retry
 *   is a one-shot timer for that one task, never a polling loop. Pause stops
 *   it (a paused workflow starts nothing), Resume retries at once, and a task
 *   that leaves To Do or its workflow drops its backoff. The user sees the
 *   toast a failed move shows, once per reason, and nothing new on the card.
 */

const DEBOUNCE_MS = 150;
/** The waits between retries of a start that failed: 30 s, 1 m, 2 m, then every 5 m. */
const START_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const TIMING_WINDOW = 200;

interface FailedStart {
  workflowId: string;
  attempts: number;
  retryAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The last failure's message: a new reason toasts again, the same one does not. */
  reason: string;
}

export class WorkflowEngineHost {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private evaluating = false;
  private dirtyAgain = false;
  private readonly inFlight = new Set<string>();
  /**
   * The in-flight starts that spend an agent slot. A start's session counts
   * against the free slots only once its spawn registers, after the worktree is
   * set up, so each one holds a slot back until its move settles. A start whose
   * spawn has already registered is held back twice for that moment, which
   * under-starts briefly; the wake after every start corrects it.
   */
  private readonly inFlightSlots = new Set<string>();
  private readonly failedStarts = new Map<string, FailedStart>();
  private readonly durationsMs: number[] = [];

  constructor(private readonly context: IpcContext) {}

  /**
   * Something that can change what runs next happened. Every running workflow
   * is re-read on the next pass, across every project: a task on one board can
   * hold up a task on another, and the read is cheap.
   */
  wake(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /** p95 and max of the last evaluations, in milliseconds. */
  stats(): { samples: number; p95Ms: number; maxMs: number } {
    if (this.durationsMs.length === 0) return { samples: 0, p95Ms: 0, maxMs: 0 };
    const sorted = this.durationsMs.slice().sort((left, right) => left - right);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return { samples: sorted.length, p95Ms: p95, maxMs: sorted[sorted.length - 1] };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const failure of this.failedStarts.values()) {
      if (failure.timer) clearTimeout(failure.timer);
    }
    this.failedStarts.clear();
  }

  /** A resume: the workflow's failed starts are tried on the next pass, not when their backoff runs out. */
  retryFailedStarts(workflowId: string): void {
    for (const [key, failure] of this.failedStarts) {
      if (failure.workflowId === workflowId) this.forgetFailedStart(key);
    }
  }

  /** How many times a task's start has failed in a row, and when it is next tried. Null when it has not failed. */
  failedStart(projectId: string, taskId: string): { attempts: number; retryAt: number } | null {
    const failure = this.failedStarts.get(inFlightKey(projectId, taskId));
    return failure ? { attempts: failure.attempts, retryAt: failure.retryAt } : null;
  }

  private forgetFailedStart(key: string): void {
    const failure = this.failedStarts.get(key);
    if (failure?.timer) clearTimeout(failure.timer);
    this.failedStarts.delete(key);
  }

  private recordFailedStart(key: string, intent: Extract<CoreIntent, { kind: 'start' }>, error: unknown): void {
    const previous = this.failedStarts.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delayMs = START_RETRY_DELAYS_MS[Math.min(attempts, START_RETRY_DELAYS_MS.length) - 1];
    const reason = error instanceof Error ? error.message : String(error);
    const failure: FailedStart = { workflowId: intent.workflowId, attempts, retryAt: Date.now() + delayMs, timer: null, reason };
    failure.timer = setTimeout(() => {
      failure.timer = null;
      // Due now. A timer can fire a little before `Date.now()` reaches the
      // `retryAt` read above (libuv times it from its cached loop clock), and
      // a wake that still finds the task backing off plans nothing and arms
      // nothing, so the task would wait in To Do for an unrelated wake.
      failure.retryAt = Date.now();
      this.wake();
    }, delayMs);
    // A pending retry never keeps the app from quitting.
    failure.timer.unref?.();
    this.failedStarts.set(key, failure);
    console.error(`[WORKFLOW] Start of task ${intent.taskId.slice(0, 8)} failed (attempt ${attempts}, retrying in ${Math.round(delayMs / 1000)}s):`, error);
    if (previous?.reason !== reason) this.toastFailedStart(intent, error);
  }

  /** The toast a failed move shows the user, for a start nobody dragged. */
  private toastFailedStart(intent: Extract<CoreIntent, { kind: 'start' }>, error: unknown): void {
    try {
      const task = new TaskRepository(getProjectDb(intent.projectId)).getById(intent.taskId);
      if (!task) return;
      const { step, cause } = spawnFailureOf(error);
      notifySpawnBlocked(this.context, task, step, cause, intent.projectId);
    } catch (toastError) {
      console.warn('[WORKFLOW] Could not report a failed start:', toastError);
    }
  }

  private async flush(): Promise<void> {
    if (this.evaluating) {
      this.dirtyAgain = true;
      return;
    }
    this.evaluating = true;
    try {
      const startedAt = performance.now();
      const { intents, titles, taskCounts } = this.evaluate();
      this.recordDuration(performance.now() - startedAt);
      for (const intent of intents) this.carryOut(intent, titles, taskCounts);
    } catch (error) {
      console.error('[WORKFLOW] Evaluation failed:', error);
    } finally {
      this.evaluating = false;
      if (this.dirtyAgain) {
        this.dirtyAgain = false;
        this.wake();
      }
    }
  }

  private recordDuration(durationMs: number): void {
    this.durationsMs.push(durationMs);
    if (this.durationsMs.length > TIMING_WINDOW) this.durationsMs.shift();
  }

  /** Read every running or paused workflow, and plan. Synchronous: this is the timed part. */
  private evaluate(): { intents: CoreIntent[]; titles: Map<string, string>; taskCounts: Map<string, number> } {
    const projectIds = this.context.projectRepo.list().map((project) => project.id);
    const snapshots: CoreWorkflow[] = [];
    const titles = new Map<string, string>();
    const taskCounts = new Map<string, number>();
    for (const homeProjectId of projectIds) {
      let workflows: Workflow[];
      try {
        const repository = new WorkflowRepository(getProjectDb(homeProjectId));
        // The fast path: one indexed probe for the common board with none.
        if (!repository.hasActive()) continue;
        workflows = repository.listOpen().filter((workflow) => workflow.state === 'running' || workflow.state === 'paused');
      } catch {
        continue;
      }
      for (const workflow of workflows) {
        titles.set(workflow.id, workflow.title);
        const snapshot = this.snapshot(homeProjectId, workflow, projectIds);
        taskCounts.set(workflow.id, snapshot.tasks.length);
        snapshots.push(snapshot);
      }
    }
    // A backoff lasts only while its task still waits in To Do of an open workflow.
    // A retry in flight keeps it: the move announces the task in its new column
    // before the slow work that can still fail and roll it back, and a backoff
    // dropped then would start the count over on every retry.
    const waiting = new Set<string>();
    for (const snapshot of snapshots) {
      for (const task of snapshot.tasks) {
        if (task.place === 'todo') waiting.add(inFlightKey(task.projectId, task.taskId));
      }
    }
    for (const key of [...this.failedStarts.keys()]) {
      if (!waiting.has(key) && !this.inFlight.has(key)) this.forgetFailedStart(key);
    }
    if (snapshots.length === 0) return { intents: [], titles, taskCounts };
    const now = Date.now();
    const blocked = new Set(this.inFlight);
    for (const [key, failure] of this.failedStarts) {
      if (now < failure.retryAt) blocked.add(key);
    }
    const freeSlots = this.context.sessionManager.getFreeAgentSlots() - this.inFlightSlots.size;
    return { intents: planPass(snapshots, freeSlots, blocked), titles, taskCounts };
  }

  private snapshot(homeProjectId: string, workflow: Workflow, projectIds: string[]): CoreWorkflow {
    const tasks: CoreTask[] = [];
    for (const projectId of projectIds) {
      let projectTasks: Task[];
      let lanes: Swimlane[];
      try {
        const db = getProjectDb(projectId);
        projectTasks = new TaskRepository(db).listByWorkflow(workflow.id)
          .filter((task) => (task.workflow_project_id ?? projectId) === homeProjectId);
        if (projectTasks.length === 0) continue;
        lanes = new SwimlaneRepository(db).list();
      } catch {
        continue;
      }
      for (const task of projectTasks) tasks.push(coreTask(projectId, task, lanes));
    }
    const links = new TaskLinkRepository(getProjectDb(homeProjectId)).listForWorkflow(workflow.id).map((link) => ({
      blockerProjectId: link.blocker_project_id,
      blockerTaskId: link.blocker_task_id,
      blockedProjectId: link.blocked_project_id,
      blockedTaskId: link.blocked_task_id,
    }));
    return {
      workflowId: workflow.id,
      homeProjectId,
      state: workflow.state,
      startedAt: workflow.started_at,
      tasks,
      links,
    };
  }

  private carryOut(intent: CoreIntent, titles: Map<string, string>, taskCounts: Map<string, number>): void {
    if (intent.kind === 'complete') {
      try {
        new WorkflowRepository(getProjectDb(intent.homeProjectId)).setState(intent.workflowId, 'done');
        // A finished workflow leaves the view, and its agent's session ends with
        // it. Its conversation stays recorded on the workflow.
        endWorkflowAgent(this.context, intent.workflowId).catch((error: unknown) => {
          console.error(`[WORKFLOW] Could not end the agent of ${intent.workflowId.slice(0, 8)}:`, error);
        });
        announceWorkflowComplete(this.context, intent.homeProjectId, intent.workflowId, taskCounts.get(intent.workflowId) ?? 0);
        notifyWorkflowChanged(intent.homeProjectId, intent.workflowId);
      } catch (error) {
        console.error(`[WORKFLOW] Could not complete workflow ${intent.workflowId.slice(0, 8)}:`, error);
      }
      return;
    }
    const key = inFlightKey(intent.projectId, intent.taskId);
    this.inFlight.add(key);
    if (intent.takesSlot) this.inFlightSlots.add(key);
    void this.startTask(intent, titles.get(intent.workflowId) ?? 'its workflow')
      .then(() => this.forgetFailedStart(key))
      .catch((error: unknown) => this.recordFailedStart(key, intent, error))
      .finally(() => {
        this.inFlight.delete(key);
        this.inFlightSlots.delete(key);
        this.wake();
      });
  }

  private async startTask(intent: Extract<CoreIntent, { kind: 'start' }>, workflowTitle: string): Promise<void> {
    const db = getProjectDb(intent.projectId);
    const tasks = new TaskRepository(db);
    const task = tasks.getById(intent.taskId);
    // Re-checked here, not trusted from the plan: a person may have removed it
    // from the workflow, or the workflow may have paused, since the pass read it.
    if (!task || task.workflow_id !== intent.workflowId || task.archived_at) return;
    const lanes = new SwimlaneRepository(db).list();
    if (lanes.find((lane) => lane.id === task.swimlane_id)?.role !== 'todo') return;
    const workflow = new WorkflowRepository(getProjectDb(intent.homeProjectId)).getById(intent.workflowId);
    if (workflow?.state !== 'running') return;

    const projectPath = this.context.projectRepo.getById(intent.projectId)?.path ?? null;
    // Cut from the blocker's merged code, not from a base fetched before it.
    if (projectPath) forgetRecentFetches(projectPath);
    await handleTaskMove(
      this.context,
      { taskId: task.id, targetSwimlaneId: intent.toSwimlaneId, targetPosition: tasks.list(intent.toSwimlaneId).length },
      'workflow',
      intent.projectId,
      projectPath,
      { moveReason: `Started by ${workflowTitle}` },
    );
  }
}

function coreTask(projectId: string, task: Task, lanes: Swimlane[]): CoreTask {
  const lane = lanes.find((candidate) => candidate.id === task.swimlane_id) ?? null;
  const place: CorePlace = task.archived_at || lane?.role === 'done' ? 'done' : lane?.role === 'todo' ? 'todo' : 'working';
  const start = place === 'todo' ? startColumn(lanes, task) : null;
  return {
    projectId,
    taskId: task.id,
    displayId: task.display_id,
    place,
    todoPosition: task.position,
    startColumnId: start?.id ?? null,
    startTakesSlot: start?.auto_spawn ?? false,
  };
}

let host: WorkflowEngineHost | null = null;

/** Start the engine and wire its wake-ups. Called once, from `register-all.ts`. */
export function registerWorkflowEngine(context: IpcContext): WorkflowEngineHost {
  host?.dispose();
  const engine = new WorkflowEngineHost(context);
  host = engine;
  setWorkflowRuntimeContext(context);
  setWorkflowChangedWindow(() => context.mainWindow);
  const wake = (): void => engine.wake();
  // Every move announces on the board bus, whatever its origin: a blocker
  // reaching Done, a workflow task moving on, a start landing.
  context.boardEvents.onBoardChanged((event) => {
    wake();
    // An agent's delete announces after the row is gone, so which workflow it
    // was in is no longer readable: every open workflow of that board reloads.
    // Deletes are rare; a move names its own workflow at commit (task-move.ts).
    if (event.change === 'task-deleted') notifyOpenWorkflows(event.projectId);
  });
  // A slot freed.
  context.sessionManager.on('session-removed', wake);
  context.sessionManager.on('exit', wake);
  // A task deleted on another board takes its links with it, in the home
  // database that holds them, as a delete on the home board does.
  setHomeLinkRemover((task) => {
    new TaskLinkRepository(getProjectDb(task.workflow_project_id!)).deleteForTask(task.id);
  });
  setWorkflowWake((retryWorkflowId) => {
    if (retryWorkflowId) engine.retryFailedStarts(retryWorkflowId);
    wake();
  });
  // Boot: recover what a restart interrupted.
  wake();
  return engine;
}

export function getWorkflowEngine(): WorkflowEngineHost | null {
  return host;
}

/**
 * Which step a failed start died in, for the toast's wording. The move wraps a
 * worktree failure as "Worktree setup failed: ...", so the toast gets its cause
 * and adds that label itself, once.
 */
function spawnFailureOf(error: unknown): { step: SpawnFailureStep; cause: unknown } {
  if (error instanceof Error && error.message.startsWith('Worktree setup failed: ')) return { step: 'worktree', cause: error.cause ?? error };
  if (error instanceof BranchCheckoutBlockedError) return { step: 'checkout', cause: error };
  return { step: 'agent', cause: error };
}

function notifyOpenWorkflows(projectId: string): void {
  try {
    for (const workflow of new WorkflowRepository(getProjectDb(projectId)).listOpen()) {
      notifyWorkflowChanged(projectId, workflow.id);
    }
  } catch {
    // A board whose database cannot be read has no view to refresh.
  }
}

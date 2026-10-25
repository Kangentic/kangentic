import { performance } from 'node:perf_hooks';
import type { Swimlane, Task, Workflow } from '../../shared/types';
import { startColumn } from '../../shared/workflow-route';
import { getExistingProjectDb, getOpenProjectDb, getProjectDb } from '../db/database';
import { isSqliteError } from '../db/sqlite-error';
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
  type CoreLink,
  type CorePlace,
  type CoreTask,
  type CoreWorkflow,
} from './engine/workflow-engine-core';
import { announceBoardChange } from './workflow-board-announce';
import { linkEndState } from './workflow-tasks';
import { announceWorkflowComplete } from './workflow-complete';
import { endWorkflowAgent } from './workflow-agent';
import { notifyWorkflowChanged, setWorkflowChangedWindow } from './workflow-changed';
import { probeWorkflowProject, type WorkflowProjectProbe } from './workflow-project-probe';
import { announceWorkflowStall } from './workflow-recovery';
import { setWorkflowWake } from './workflow-wake';
import { setWorkflowRuntimeContext } from './workflow-runtime';

/**
 * The workflow engine's host on main: it wakes on events, reads each running
 * workflow into the core's plain shape, asks the core what to do
 * (`planPass`), and carries the answer out through the one move path.
 *
 * - **Never polls.** It wakes on a board change, a freed agent slot, a turn
 *   end, a start or resume, and launch, and a burst of those coalesces into one
 *   pass after `DEBOUNCE_MS`. A pass that finds nothing running costs one
 *   indexed query per open project. Its only other timers are one-shot retries
 *   on a backoff: of a start that failed, and of a board it could not read
 *   (both below).
 * - **Reads only open databases, and opens only what a workflow touches.** A
 *   registered project whose database is not open is looked at once, on a
 *   throwaway connection with no migrations (`probeWorkflowProject`), one per
 *   event-loop turn. It is opened only when it homes a running or paused
 *   workflow or holds a task of one. Every later write that brings a project
 *   into a workflow (a start, an added task, a resume) opens it on main, and
 *   main closes a database only when its project is deleted, so "open" stays
 *   complete.
 * - **Completes nothing it could not read in full.** A pass that could not read
 *   a registered board plans no completion (that board's tasks may not be
 *   Done) and no start that waits on a task there, until a pass reads it.
 *   While a board stays unread the engine wakes itself on a backoff (5 s,
 *   30 s, 1 m, 2 m, then every 5 m), one timer at a time, so a lock that clears
 *   or a board that is repaired or removed lets the workflows go on with no
 *   other event and nothing shown to the user. The first pass that reads every
 *   registered board stops it.
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
 *   toast a failed move shows, once per reason. A start still failing after
 *   30 minutes is a stalled workflow: one notice on desktop and phone, and a
 *   "Stalled" mark on the card (`announceWorkflowStall`), while the retries go on.
 */

const DEBOUNCE_MS = 150;
/** The waits between retries of a start that failed: 30 s, 1 m, 2 m, then every 5 m. */
const START_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
/**
 * The waits between passes while a registered board cannot be read: 5 s, since
 * a lock usually clears within a second, then 30 s, 1 m, 2 m, and every 5 m.
 */
const UNREAD_RETRY_DELAYS_MS = [5_000, 30_000, 60_000, 120_000, 300_000];
const TIMING_WINDOW = 200;

/**
 * How long a start may keep failing before the user is told the workflow
 * stalled on it. The retries go on after the notice.
 */
const START_STALL_NOTICE_MS = 30 * 60_000;

interface FailedStart {
  workflowId: string;
  /** The task's own board, so a pass that could not read it keeps the backoff. */
  projectId: string;
  attempts: number;
  retryAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The last failure's message: a new reason toasts again, the same one does not. */
  reason: string;
  /** When this run of failures began (epoch ms). */
  firstFailedAt: number;
  /** The stall notice went out for this run of failures. */
  stallNoticeSent: boolean;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  /** Workflows whose gone links would not delete, logged once until a delete goes through. */
  private readonly failedDrops = new Set<string>();
  private readonly durationsMs: number[] = [];
  /**
   * Registered projects looked at without opening them, and what the look
   * found. What they hold cannot change while they stay closed, since every
   * write in this process opens the database first, so each is looked at once.
   * Another instance sharing the config dir can write one unseen, until
   * activation opens every registered project a few seconds after launch. An
   * entry goes when its project is opened, by this engine or anything else.
   */
  private readonly unopened = new Map<string, WorkflowProjectProbe>();
  /** Projects whose failed read has been logged, so a broken one logs once a launch. */
  private readonly unreadReported = new Set<string>();
  /** The pass that tries an unread board again, armed while one stays unread. */
  private unreadRetry: ReturnType<typeof setTimeout> | null = null;
  /** How many of those passes have been armed since every board last read. */
  private unreadRetries = 0;
  private disposed = false;

  constructor(private readonly context: IpcContext) {}

  /**
   * Something that can change what runs next happened. Every running workflow
   * is re-read on the next pass, across every open project: a task on one board
   * can hold up a task on another, and the read is cheap.
   */
  wake(): void {
    if (this.timer || this.disposed) return;
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
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.unreadRetry) clearTimeout(this.unreadRetry);
    this.unreadRetry = null;
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
    const failure: FailedStart = {
      workflowId: intent.workflowId,
      projectId: intent.projectId,
      attempts,
      retryAt: Date.now() + delayMs,
      timer: null,
      reason,
      firstFailedAt: previous?.firstFailedAt ?? Date.now(),
      stallNoticeSent: previous?.stallNoticeSent ?? false,
    };
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
    if (!failure.stallNoticeSent && Date.now() - failure.firstFailedAt >= START_STALL_NOTICE_MS) {
      failure.stallNoticeSent = true;
      this.announceStalledStart(intent, reason);
    }
  }

  /**
   * A start that kept failing for `START_STALL_NOTICE_MS`: the workflow is
   * stalled on it, and the toast, which reaches no one overnight, is not
   * enough. One notice a run of failures, through the same path a recovery
   * that ran out takes. The retries go on.
   */
  private announceStalledStart(intent: Extract<CoreIntent, { kind: 'start' }>, reason: string): void {
    try {
      const db = getExistingProjectDb(intent.projectId);
      const task = db ? new TaskRepository(db).getById(intent.taskId) : undefined;
      if (!task) return;
      announceWorkflowStall(this.context, {
        projectId: intent.projectId,
        taskId: intent.taskId,
        workflowId: intent.workflowId,
        columnId: task.swimlane_id,
        reason: `it could not start: ${reason}`,
        countedNudges: 0,
      });
    } catch (error) {
      console.warn('[WORKFLOW] Could not report a start that keeps failing:', error);
    }
  }

  /** The toast a failed move shows the user, for a start nobody dragged. */
  private toastFailedStart(intent: Extract<CoreIntent, { kind: 'start' }>, error: unknown): void {
    try {
      // Read after the move failed, by which time its project may be deleted.
      const db = getExistingProjectDb(intent.projectId);
      const task = db ? new TaskRepository(db).getById(intent.taskId) : undefined;
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
      const projectIds = this.context.projectRepo.list().map((project) => project.id);
      const unreadProjectIds = await this.lookAtUnopenedProjects(projectIds);
      if (this.disposed) return;
      const startedAt = performance.now();
      const { intents, titles, taskCounts } = this.evaluate(projectIds, unreadProjectIds);
      this.recordDuration(performance.now() - startedAt);
      for (const intent of intents) this.carryOut(intent, titles, taskCounts);
      this.retryUnreadLater(unreadProjectIds.size > 0);
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

  /**
   * After a pass, while a registered board could not be read, arm one pass to
   * try it again, on the backoff. Keyed on any unread board, not only on a
   * running workflow the pass could see, since the board that would not read
   * may be the home of one. Nothing else wakes the engine when the board comes
   * back (activation opening it, a lock clearing, a repaired file), so without
   * this a finished workflow stayed running until some unrelated board change.
   * A pass that reads every board clears it and starts the backoff over.
   */
  private retryUnreadLater(anyUnread: boolean): void {
    if (!anyUnread) {
      if (this.unreadRetry) clearTimeout(this.unreadRetry);
      this.unreadRetry = null;
      this.unreadRetries = 0;
      return;
    }
    if (this.unreadRetry || this.disposed) return;
    const delayMs = UNREAD_RETRY_DELAYS_MS[Math.min(this.unreadRetries, UNREAD_RETRY_DELAYS_MS.length - 1)];
    this.unreadRetries += 1;
    this.unreadRetry = setTimeout(() => {
      this.unreadRetry = null;
      this.wake();
    }, delayMs);
    // A pending retry never keeps the app from quitting.
    this.unreadRetry.unref?.();
  }

  private recordDuration(durationMs: number): void {
    this.durationsMs.push(durationMs);
    if (this.durationsMs.length > TIMING_WINDOW) this.durationsMs.shift();
  }

  /**
   * Look at each registered project that is neither open nor looked at yet,
   * one per event-loop turn so the first pass after launch never holds main for
   * the whole list. Returns the ones that could not be read, which are looked
   * at again on the next pass.
   */
  private async lookAtUnopenedProjects(projectIds: string[]): Promise<Set<string>> {
    const unreadProjectIds = new Set<string>();
    for (const projectId of projectIds) {
      if (getOpenProjectDb(projectId) || this.unopened.has(projectId)) continue;
      await yieldToEventLoop();
      if (this.disposed) break;
      if (getOpenProjectDb(projectId)) continue;
      try {
        this.unopened.set(projectId, probeWorkflowProject(projectId));
      } catch (error) {
        this.noteUnread(unreadProjectIds, projectId, error);
      }
    }
    return unreadProjectIds;
  }

  /** Open a looked-at project the engine has to read. Never creates a database whose file has gone. */
  private openForReading(projectId: string, unreadProjectIds: Set<string>): void {
    try {
      getExistingProjectDb(projectId);
      this.unopened.delete(projectId);
    } catch (error) {
      this.noteUnread(unreadProjectIds, projectId, error);
    }
  }

  /**
   * A read of `projectId` failed. A SQLite failure (locked, corrupt, half
   * migrated) makes the board unread for this pass. Anything else is a bug and
   * is rethrown, ending the pass with "Evaluation failed". Read as unread, a
   * bug would hold every workflow from completing and retry every 5 minutes
   * behind one warning a launch.
   */
  private noteUnread(unreadProjectIds: Set<string>, projectId: string, error: unknown): void {
    if (!isSqliteError(error)) throw error;
    unreadProjectIds.add(projectId);
    if (this.unreadReported.has(projectId)) return;
    this.unreadReported.add(projectId);
    console.warn(`[WORKFLOW] Could not read project ${projectId.slice(0, 8)}; no workflow completes until it can be read, and the engine keeps trying:`, error);
  }

  /**
   * Read every running or paused workflow in the open databases, and plan.
   * Synchronous: this is the timed part. `unreadProjectIds` holds the projects
   * that could not be read this pass, and gains any that fail here.
   */
  private evaluate(
    projectIds: string[],
    unreadProjectIds: Set<string>,
  ): { intents: CoreIntent[]; titles: Map<string, string>; taskCounts: Map<string, number> } {
    const registered = new Set(projectIds);
    // A looked-at project that was opened since, by anything, is read like any
    // open one; one that homes a running or paused workflow is opened now.
    for (const [projectId, probe] of this.unopened) {
      if (!registered.has(projectId) || getOpenProjectDb(projectId)) this.unopened.delete(projectId);
      else if (probe.homesActive) this.openForReading(projectId, unreadProjectIds);
    }
    const activeWorkflows: Array<{ homeProjectId: string; workflow: Workflow }> = [];
    for (const homeProjectId of projectIds) {
      const db = getOpenProjectDb(homeProjectId);
      if (!db) continue;
      try {
        const repository = new WorkflowRepository(db);
        // The fast path: one indexed probe for the common board with none.
        if (!repository.hasActive()) continue;
        for (const workflow of repository.listOpen()) {
          if (workflow.state === 'running' || workflow.state === 'paused') activeWorkflows.push({ homeProjectId, workflow });
        }
      } catch (error) {
        this.noteUnread(unreadProjectIds, homeProjectId, error);
      }
    }
    const workflowIdsByBoard = new Map<string, Set<string>>();
    if (activeWorkflows.length > 0) {
      // A looked-at project holding a task of one of those workflows is opened too.
      const activeWorkflowIds = new Set(activeWorkflows.map(({ workflow }) => workflow.id));
      for (const [projectId, probe] of this.unopened) {
        if (sharesAny(probe.memberOf, activeWorkflowIds)) this.openForReading(projectId, unreadProjectIds);
      }
      // Which workflows each open board holds tasks of: one covering read per
      // board, so the full task read runs only on the boards that hold a running
      // workflow's tasks, not on every open board for every workflow.
      for (const projectId of projectIds) {
        const db = getOpenProjectDb(projectId);
        if (!db) continue;
        try {
          workflowIdsByBoard.set(projectId, new TaskRepository(db).workflowIdsOnBoard());
        } catch (error) {
          this.noteUnread(unreadProjectIds, projectId, error);
        }
      }
    }
    const snapshots: CoreWorkflow[] = [];
    const titles = new Map<string, string>();
    const taskCounts = new Map<string, number>();
    for (const { homeProjectId, workflow } of activeWorkflows) {
      titles.set(workflow.id, workflow.title);
      const boards = [...workflowIdsByBoard].filter(([, workflowIds]) => workflowIds.has(workflow.id)).map(([projectId]) => projectId);
      const snapshot = this.snapshot(homeProjectId, workflow, boards, unreadProjectIds);
      taskCounts.set(workflow.id, snapshot.tasks.length);
      snapshots.push(snapshot);
    }
    // A backoff lasts only while its task still waits in To Do of an open workflow.
    // A retry in flight keeps it: the move announces the task in its new column
    // before the slow work that can still fail and roll it back, and a backoff
    // dropped then would start the count over on every retry. So does a task
    // on a board this pass could not read.
    const waiting = new Set<string>();
    for (const snapshot of snapshots) {
      for (const task of snapshot.tasks) {
        if (task.place === 'todo') waiting.add(inFlightKey(task.projectId, task.taskId));
      }
    }
    for (const [key, failure] of [...this.failedStarts]) {
      if (!waiting.has(key) && !this.inFlight.has(key) && !unreadProjectIds.has(failure.projectId)) this.forgetFailedStart(key);
    }
    if (snapshots.length === 0) return { intents: [], titles, taskCounts };
    const now = Date.now();
    const blocked = new Set(this.inFlight);
    for (const [key, failure] of this.failedStarts) {
      if (now < failure.retryAt) blocked.add(key);
    }
    const freeSlots = this.context.sessionManager.getFreeAgentSlots() - this.inFlightSlots.size;
    const intents = planPass(snapshots, freeSlots, blocked);
    return {
      intents: unreadProjectIds.size > 0 ? withoutUnreadOutcomes(intents, snapshots, unreadProjectIds) : intents,
      titles,
      taskCounts,
    };
  }

  /** `boards`: the open boards holding at least one of the workflow's tasks. */
  private snapshot(homeProjectId: string, workflow: Workflow, boards: string[], unreadProjectIds: Set<string>): CoreWorkflow {
    const tasks: CoreTask[] = [];
    for (const projectId of boards) {
      let projectTasks: Task[];
      let lanes: Swimlane[];
      try {
        const db = getOpenProjectDb(projectId);
        if (!db) continue;
        projectTasks = new TaskRepository(db).listByWorkflow(workflow.id)
          .filter((task) => (task.workflow_project_id ?? projectId) === homeProjectId);
        if (projectTasks.length === 0) continue;
        lanes = new SwimlaneRepository(db).list();
      } catch (error) {
        this.noteUnread(unreadProjectIds, projectId, error);
        continue;
      }
      for (const task of projectTasks) tasks.push(coreTask(projectId, task, lanes));
    }
    // A link with an end missing from the read is checked once more: provably
    // gone goes to `goneLinks` to be dropped, anything else keeps holding.
    // Usually there is none, so the check costs a set lookup per link end.
    const presentTaskIds = new Set(tasks.map((task) => task.taskId));
    const links: CoreLink[] = [];
    const goneLinks: CoreLink[] = [];
    for (const link of new TaskLinkRepository(getProjectDb(homeProjectId)).listForWorkflow(workflow.id)) {
      const ends = [
        { projectId: link.blocker_project_id, taskId: link.blocker_task_id },
        { projectId: link.blocked_project_id, taskId: link.blocked_task_id },
      ];
      const gone = ends.some((end) => linkEndState(this.context, end, workflow.id, presentTaskIds, unreadProjectIds) === 'gone');
      (gone ? goneLinks : links).push({
        blockerProjectId: link.blocker_project_id,
        blockerTaskId: link.blocker_task_id,
        blockedProjectId: link.blocked_project_id,
        blockedTaskId: link.blocked_task_id,
      });
    }
    return {
      workflowId: workflow.id,
      homeProjectId,
      state: workflow.state,
      startedAt: workflow.started_at,
      tasks,
      links,
      goneLinks,
    };
  }

  /**
   * Drop links whose task is gone, finishing the delete that left them. No
   * revision bump, as `TaskRepository.delete` removes links without one: a
   * workflow agent's save built on its last read still goes through. Announced
   * only for what was deleted, since an announce wakes the engine: a write that
   * keeps failing logs once and then stays quiet, rather than waking every pass.
   */
  private dropLinks(intent: Extract<CoreIntent, { kind: 'drop-links' }>): void {
    const blockedProjectIds = new Set<string>();
    let dropped = 0;
    try {
      const repository = new TaskLinkRepository(getProjectDb(intent.homeProjectId));
      for (const link of intent.links) {
        if (!repository.delete(link.blockerTaskId, link.blockedTaskId)) continue;
        dropped += 1;
        blockedProjectIds.add(link.blockedProjectId);
      }
      this.failedDrops.delete(intent.workflowId);
    } catch (error) {
      if (!this.failedDrops.has(intent.workflowId)) {
        this.failedDrops.add(intent.workflowId);
        console.error(`[WORKFLOW] Could not drop the links to removed tasks of workflow ${intent.workflowId.slice(0, 8)}:`, error);
      }
    }
    if (dropped === 0) return;
    console.log(`[WORKFLOW] Dropped ${dropped} ${dropped === 1 ? 'link' : 'links'} to removed tasks of workflow ${intent.workflowId.slice(0, 8)}`);
    for (const projectId of blockedProjectIds) announceBoardChange(this.context, projectId);
    notifyWorkflowChanged(intent.homeProjectId, intent.workflowId);
  }

  private carryOut(intent: CoreIntent, titles: Map<string, string>, taskCounts: Map<string, number>): void {
    if (intent.kind === 'drop-links') {
      this.dropLinks(intent);
      return;
    }
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

/**
 * The plan for a pass that could not read every registered board. No workflow
 * completes, since the unread board may hold its unfinished tasks and nothing
 * says which workflows those are. No task starts that waits on a task there:
 * today the core reads a blocker it cannot see as not done, and this keeps
 * that true whatever the core comes to say about a vanished blocker. A drop of
 * links goes through: it names only links whose end is provably gone, and
 * `linkEndState` holds any end on a board that could not be read.
 */
function withoutUnreadOutcomes(intents: CoreIntent[], snapshots: CoreWorkflow[], unreadProjectIds: ReadonlySet<string>): CoreIntent[] {
  const linksByWorkflow = new Map(snapshots.map((snapshot) => [snapshot.workflowId, snapshot.links]));
  return intents.filter((intent) => {
    if (intent.kind === 'complete') return false;
    if (intent.kind === 'drop-links') return true;
    return !(linksByWorkflow.get(intent.workflowId) ?? []).some((link) => (
      link.blockedProjectId === intent.projectId
      && link.blockedTaskId === intent.taskId
      && unreadProjectIds.has(link.blockerProjectId)
    ));
  });
}

function sharesAny(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
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
    // A delete (an agent's, or a desktop one through announceTaskWrite)
    // announces after the row is gone, so which workflow it was in is no longer
    // readable: every open workflow of that board reloads. Deletes are rare; a
    // move names its own workflow at commit (task-move.ts).
    if (event.change === 'task-deleted') notifyOpenWorkflows(event.projectId);
  });
  // A slot freed.
  context.sessionManager.on('session-removed', wake);
  context.sessionManager.on('exit', wake);
  // A task deleted on another board takes its links with it, in the home
  // database that holds them, as a delete on the home board does. A home that
  // is gone took its links with it, and its database is not created again.
  setHomeLinkRemover((task) => {
    const homeDb = getExistingProjectDb(task.workflow_project_id!);
    if (homeDb) new TaskLinkRepository(homeDb).deleteForTask(task.id);
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

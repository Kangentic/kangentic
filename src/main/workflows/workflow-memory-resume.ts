import type { Task } from '../../shared/types';
import { getOpenProjectDb } from '../db/database';
import { AutomationRunRepository } from '../db/repositories/automation-run-repository';
import { SessionRepository } from '../db/repositories/session-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { TaskMoveRepository } from '../db/repositories/task-move-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { resumeTaskSession, type ResumeAcceptance } from '../ipc/handlers/session-resume';
import { isResumeInFlight } from '../ipc/handlers/session-resume-controllers';
import type { IpcContext } from '../ipc/ipc-context';
import { workflowMemoryGate } from './workflow-memory-gate';
import { announceWorkflowStall, workflowTaskGateKey } from './workflow-recovery';
import { workflowStepApplies } from './workflow-step';

/**
 * Bring a running workflow's memory-paused tasks back once memory recovers,
 * one at a time (owner's decision, 2026-10-31). #873 decided a low-memory
 * pause lasts until the user resumes it; that still holds for a task outside a
 * workflow. Overnight, two workflow tasks whose agents really were idle were
 * paused at 01:39 and 04:05 and sat until morning with memory long recovered.
 *
 * - **Only what a nudge will reach.** A task in a running workflow, in a
 *   column that works (not To Do or Done), whose latest session is a
 *   `'low_memory'` pause. A task waiting on the owner stays paused: it would
 *   only idle again, and its notice already went out. A task a person is
 *   resuming right now is theirs: this never cancels their Resume.
 * - **One at a time, through the workflow's memory gate**
 *   (`workflow-memory-gate.ts`): none while memory reads low, and the next one
 *   only once the last one's turn is under way and memory still reads fine.
 *   Recovery's nudges wait in the same queue, so a place this no longer asks
 *   for leaves the line at once.
 * - **Within the agent limits.** Never past the app's free agent slots. When
 *   the per-column agent limit lands (#953), its check belongs here too.
 * - **Through the Resume button's own path** (`resumeTaskSession`), marked
 *   `'memory'`: the resume's catch-up then hands the agent's turn to the
 *   workflow's unblock pass at once.
 * - **No pause and resume loop.** Each resume reloads the conversation, one
 *   overnight resume read 73M tokens before its first tool call. A task paused
 *   again soon after an auto-resume waits longer each time, and after
 *   `MAX_AUTO_RESUMES_PER_DAY` in a day it stays paused for the user, with one
 *   notice. Only a resume that ran counts. One that failed waits
 *   `FAILED_RESUME_RETRY_MS`, doubled for each failure in a row.
 *
 * Called on every memory sampler tick (`src/main/index.ts`). Cheap when there
 * is nothing to do: one indexed query per open project.
 */

/** A pause this soon after an auto-resume is the same low spell coming back. */
const REPAUSE_WINDOW_MS = 30 * 60_000;
/** The first wait after such a pause, doubled for each auto-resume since. */
const REPAUSE_BACKOFF_BASE_MS = 30 * 60_000;
/** After this many auto-resumes of one task in a day, it waits for the user. */
export const MAX_AUTO_RESUMES_PER_DAY = 3;
/** After a resume that failed, the next try waits this long, doubled for each failure in a row. */
const FAILED_RESUME_RETRY_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

interface AutoResumeHistory {
  /** When each auto-resume that ran in the last day ran. */
  resumedAt: number[];
  /** Resumes that failed in a row, and when the last one did. */
  failuresInRow: number;
  lastFailedAt: number | null;
  /** The owner was told it stays paused, until a day's resumes age out. */
  gaveUp: boolean;
}

/** Each task's auto-resumes, for the backoff. Main-process memory only. */
const autoResumes = new Map<string, AutoResumeHistory>();
let resumeInFlight = false;
/** The task place this resume asked the gate for and was told to wait, still in line. */
let waitingGateKey: string | null = null;

interface ResumeCandidate {
  projectId: string;
  task: Task;
  columnId: string;
  suspendedAt: number;
}

export async function resumeMemoryPausedWorkflowTasks(context: IpcContext, now: number = Date.now()): Promise<void> {
  if (resumeInFlight || workflowMemoryGate.reading().low) return;
  pruneAutoResumes(now);
  const candidate = nextCandidate(context, now);
  const gateKey = candidate && context.sessionManager.getFreeAgentSlots() > 0
    // The task's own place, which its nudge then continues (`workflowTaskGateKey`).
    ? workflowTaskGateKey(candidate.task.id)
    : null;
  // A place this no longer asks for (the user resumed the task, it moved, the
  // slots filled) leaves the line, so it never holds a nudge behind it.
  if (waitingGateKey !== null && waitingGateKey !== gateKey) workflowMemoryGate.withdraw(waitingGateKey);
  waitingGateKey = null;
  if (candidate === null || gateKey === null) return;
  if (!workflowMemoryGate.tryAcquire(gateKey).go) {
    waitingGateKey = gateKey;
    return;
  }

  resumeInFlight = true;
  const taskId = candidate.task.id;
  const history = autoResumes.get(taskId) ?? { resumedAt: [], failuresInRow: 0, lastFailedAt: null, gaveUp: false };
  autoResumes.set(taskId, history);
  let acceptance = null as ResumeAcceptance | null;
  console.log(`[WORKFLOW] Memory recovered: resuming task ${taskId.slice(0, 8)}, paused for memory.`);
  try {
    const session = await resumeTaskSession(context, taskId, {
      projectId: candidate.projectId,
      resumedBy: 'memory',
      onAccepted: (accepted) => {
        acceptance = accepted;
      },
      onFailed: (step, error) => {
        console.warn(`[WORKFLOW] The memory resume of task ${taskId.slice(0, 8)} failed at its ${step} step:`, error);
      },
    });
    if (session && acceptance !== 'live') {
      // A resume that ran: it counts toward the day's limit, and the gate
      // waits for its turn to be under way.
      history.resumedAt.push(now);
      history.failuresInRow = 0;
      history.lastFailedAt = null;
      workflowMemoryGate.begin(gateKey, session.id);
    } else {
      // A session already live started nothing; a null resume was cancelled
      // or started no agent, and waits before the next try.
      workflowMemoryGate.release(gateKey);
      if (!session) noteFailedResume(history, now);
    }
  } catch (error) {
    workflowMemoryGate.release(gateKey);
    noteFailedResume(history, now);
    console.warn(`[WORKFLOW] Could not resume task ${taskId.slice(0, 8)} after memory recovered:`, error);
  } finally {
    resumeInFlight = false;
  }
}

function noteFailedResume(history: AutoResumeHistory, now: number): void {
  history.failuresInRow += 1;
  history.lastFailedAt = now;
}

/**
 * Age out the day's resumes: a task past the day's count may come back again
 * once its oldest resume is a day old, and a task with nothing left to count
 * is forgotten.
 */
function pruneAutoResumes(now: number): void {
  for (const [taskId, history] of autoResumes) {
    history.resumedAt = history.resumedAt.filter((resumedAtMs) => now - resumedAtMs < DAY_MS);
    if (history.resumedAt.length < MAX_AUTO_RESUMES_PER_DAY) history.gaveUp = false;
    const failureIsOld = history.lastFailedAt === null || now - history.lastFailedAt >= DAY_MS;
    if (history.resumedAt.length === 0 && failureIsOld) autoResumes.delete(taskId);
  }
}

/** The memory-paused workflow task paused longest that may come back now, or null. */
function nextCandidate(context: IpcContext, now: number): ResumeCandidate | null {
  let chosen: ResumeCandidate | null = null;
  for (const project of context.projectRepo.list()) {
    const projectDatabase = getOpenProjectDb(project.id);
    if (!projectDatabase) continue;
    let paused: Array<{ taskId: string; suspendedAt: string | null }>;
    try {
      paused = new SessionRepository(projectDatabase).listMemoryPausedTasks();
    } catch (error) {
      console.warn(`[WORKFLOW] Could not read the memory-paused tasks of project ${project.id.slice(0, 8)}:`, error);
      continue;
    }
    if (paused.length === 0) continue;
    const tasks = new TaskRepository(projectDatabase);
    const swimlanes = new SwimlaneRepository(projectDatabase);
    const runs = new AutomationRunRepository(projectDatabase);
    const moves = new TaskMoveRepository(projectDatabase);
    for (const pause of paused) {
      // A person's Resume under way is theirs; starting this one would cancel it.
      if (isResumeInFlight(pause.taskId)) continue;
      const task = tasks.getById(pause.taskId);
      if (!task || task.archived_at || !workflowStepApplies(task, project.id)) continue;
      const column = swimlanes.getById(task.swimlane_id);
      if (!column || column.role === 'todo' || column.role === 'done') continue;
      // Its question was already told; it would only idle again.
      if (runs.isWaitingOnUser(task.id, column.id, moves.visitStartedAt(task.id, column.id))) continue;
      const suspendedAt = pause.suspendedAt ? Date.parse(pause.suspendedAt) : now;
      if (!mayResumeNow(context, project.id, task, column.id, suspendedAt, now)) continue;
      if (!chosen || suspendedAt < chosen.suspendedAt) chosen = { projectId: project.id, task, columnId: column.id, suspendedAt };
    }
  }
  return chosen;
}

/**
 * Whether the backoff lets this task come back now. A pause soon after an
 * auto-resume waits `REPAUSE_BACKOFF_BASE_MS`, doubled for each auto-resume
 * in the last day; past `MAX_AUTO_RESUMES_PER_DAY` the task stays paused for
 * the user, who is told once. A resume that failed waits before the next try.
 */
function mayResumeNow(context: IpcContext, projectId: string, task: Task, columnId: string, suspendedAt: number, now: number): boolean {
  const history = autoResumes.get(task.id);
  if (!history) return true;
  if (history.lastFailedAt !== null && now - history.lastFailedAt < FAILED_RESUME_RETRY_MS * 2 ** (history.failuresInRow - 1)) return false;
  if (history.resumedAt.length >= MAX_AUTO_RESUMES_PER_DAY) {
    if (!history.gaveUp && task.workflow_id) {
      announceWorkflowStall(context, {
        projectId,
        taskId: task.id,
        columnId,
        workflowId: task.workflow_id,
        reason: `its agent was paused to free memory ${MAX_AUTO_RESUMES_PER_DAY} times today, so it stays paused until you resume it.`,
        countedNudges: 0,
      });
    }
    history.gaveUp = true;
    return false;
  }
  const lastResumedAt = history.resumedAt[history.resumedAt.length - 1];
  if (lastResumedAt === undefined || suspendedAt - lastResumedAt >= REPAUSE_WINDOW_MS) return true;
  const wait = REPAUSE_BACKOFF_BASE_MS * 2 ** (history.resumedAt.length - 1);
  return now - suspendedAt >= wait;
}

/** Test-only: forget every task's auto-resumes. */
export function resetWorkflowMemoryResumeForTests(): void {
  autoResumes.clear();
  resumeInFlight = false;
  waitingGateKey = null;
}

import type { Swimlane, Task, WorkflowStalledEvent } from '../../shared/types';
import { IPC } from '../../shared/ipc-channels';
import { canTaskRunAutomations } from '../../shared/automation-manifest';
import type { IpcContext } from '../ipc/ipc-context';
import { sendToRenderer } from '../ipc/send-to-renderer';
import type { TurnEndedPayload } from '../pty/session-manager';
import { getProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { resolveInjectionVerifier } from '../ipc/helpers/agent-spawn';
import { deliverMessageToSession } from '../automations/turn-end/deliver-message';
import { tryReadSessionFinalReply } from '../automations/turn-end/final-reply-reader';
import { hasPendingMessageDelivery } from '../automations/turn-end/turn-end-passes';
import { notifyWorkflowChanged } from './workflow-changed';
import { runWorkflowStep, workflowStepApplies, type WorkflowStepResult } from './workflow-step';
import {
  forgetWorkflowRecovery,
  getRecoveryEntry,
  recoveryEntryForSession,
  setRecoveryEntry,
  type RecoveryEntry,
  type RecoveryVerdict,
} from './workflow-recovery-state';

/**
 * Recovery for a running workflow task whose turn ended without its step done:
 * within a bounded time, with nobody watching, the task moves on or the user
 * gets one notice saying why it cannot.
 *
 * - **On a schedule that ends.** Attempts come 5, 15, 30 and 60 minutes after
 *   the agent last stopped (`RECOVERY_DELAYS_MS`), never the start backoff's
 *   every 5 minutes forever: a nudge is a paid agent turn.
 * - **Each attempt judges first.** The step check is re-run on the session's
 *   current turn, unless a verdict for that same turn is in hand. Done moves
 *   the task with no nudge. A check that failed, or a restart that lost the
 *   verdict, is covered by the same re-run.
 * - **A stall is nudged, a question is not.** Stopped before done (the step
 *   check's second ask) gets one line in its terminal asking it to carry on.
 *   Waiting on the user gets the notice at once. Work the agent left running
 *   (a gate in the background) gets one long wait first, `WORKING_WAIT_MS`.
 * - **It yields to the user.** No nudge while there is a draft, the terminal is
 *   on screen, a message is on its way, or the agent is not idle on that turn.
 *   A hold delays the nudge, never the schedule. Pausing the workflow cancels
 *   it all (`cancelWorkflowRecovery`), and so does a move.
 * - **Only a nudge that did something counts.** A check that could not run, or
 *   a nudged turn the engine reports failed, spends nothing toward the 4
 *   nudges (`MAX_COUNTED_NUDGES`). After the schedule the notice goes out on
 *   time and an outage is retried hourly (`OUTAGE_RETRY_MS`) for up to a day,
 *   so a service that comes back at night moves the task on by morning.
 * - **The run log is the record.** Each attempt, the stall notice and each
 *   wait on the user write a row, and a restart rebuilds the count from them
 *   (`ensureEntry`). The stall row latches the notice until another nudge runs.
 */

export const RECOVERY_DELAYS_MS: readonly number[] = [5, 15, 30, 60].map((minutes) => minutes * 60_000);
/** The most nudges whose turn ran, per recovery. */
const MAX_COUNTED_NUDGES = RECOVERY_DELAYS_MS.length;
/**
 * How long a turn that left its own work running is left alone: nearly twice
 * the longest such wait seen ending by itself (37 minutes).
 */
export const WORKING_WAIT_MS = 60 * 60_000;
/** The cadence after the schedule, while nudges are still to spend. */
export const OUTAGE_RETRY_MS = 60 * 60_000;
/** How often a held attempt looks at the user again, and how soon a deferred one runs. */
export const HOLD_RECHECK_MS = 60_000;
/** How long one recovery runs before it stops for good. */
const RECOVERY_LIMIT_MS = 24 * 60 * 60_000;
/** How long a nudge may take to land. A cancelled burst must not hang the attempt. */
const NUDGE_DELIVERY_TIMEOUT_MS = 120_000;

/** Which task a verdict is for, and where. */
export interface RecoveryTarget {
  projectId: string;
  taskId: string;
  sessionId: string;
  columnId: string;
  workflowId: string;
}

/** How a timer's attempt reaches the turn-end runner, which runs it one pass per task. */
let requestAttempt: ((projectId: string, taskId: string, sessionId: string) => void) | null = null;

/** Set by the turn-end runner when it registers. */
export function setRecoveryAttemptRunner(runner: ((projectId: string, taskId: string, sessionId: string) => void) | null): void {
  requestAttempt = runner;
}

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

/**
 * A step check gave its verdict on a turn end or a resume. Done, a question
 * and a human gate end recovery; anything else arms the next attempt.
 * `turnStartedAt` is the judged turn's start (a turn end's), null for a resume.
 */
export function afterWorkflowStep(
  context: IpcContext,
  target: RecoveryTarget,
  result: WorkflowStepResult,
  turnStartedAt: number | null = null,
): void {
  try {
    handleVerdict(context, target, result, turnStartedAt);
  } catch (error) {
    console.error(`[WORKFLOW] Recovery could not take task ${target.taskId.slice(0, 8)}'s step verdict:`, error);
  }
}

function handleVerdict(context: IpcContext, target: RecoveryTarget, result: WorkflowStepResult, turnStartedAt: number | null = null): void {
  const parked = result.verdict === 'working' || result.verdict === 'stopped'
    || result.verdict === 'check-failed' || result.verdict === 'move-failed';
  if (parked && startsNewRecovery(context, target, turnStartedAt)) startWorkflowRecoveryOver(context, target);
  switch (result.verdict) {
    case 'done':
      forgetWorkflowRecovery(target.taskId);
      return;
    case 'waiting':
      forgetWorkflowRecovery(target.taskId);
      noticeWaiting(context, target, result.reason ?? 'the agent asked something.');
      return;
    case 'human-gate':
      forgetWorkflowRecovery(target.taskId);
      if (result.firstThisVisit) noticeWaiting(context, target, 'no Automation agent can judge this step, so drag the card on when it is done.');
      return;
    case 'working': {
      const entry = ensureEntry(context, target);
      if (!entry) return;
      takeVerdict(entry, result);
      armWorkingWait(entry);
      return;
    }
    case 'stopped':
    case 'check-failed':
    case 'move-failed': {
      const entry = ensureEntry(context, target);
      if (!entry) return;
      takeVerdict(entry, result);
      entry.workingWait = false;
      armNext(context, entry);
      return;
    }
  }
}

/**
 * The verdict a new turn gave. A hold belonged to the turn before it, so the
 * next attempt holds from its own start.
 */
function takeVerdict(entry: RecoveryEntry, result: WorkflowStepResult): RecoveryVerdict {
  entry.verdict = { workSerial: result.workSerial, verdict: result.verdict, reason: result.reason };
  entry.holdUntil = null;
  return entry.verdict;
}

/** A `'working'` verdict's one long wait. */
function armWorkingWait(entry: RecoveryEntry): void {
  entry.workingWait = true;
  entry.holdUntil = null;
  arm(entry, WORKING_WAIT_MS);
}

/**
 * After a stall, a turn that recovery did not start (the user typed, a column
 * message, a background job's wake) is a new stall if it stops again, with its
 * own nudges and its own notice. Without this, a task that stalled once would
 * never be recovered or noticed again in that column. A nudge's own turn
 * carries its recovery on. In memory that is known (`lastTurnFromNudge`);
 * after a restart, a turn is the user's only when no nudge ran since the stall.
 */
function startsNewRecovery(context: IpcContext, target: RecoveryTarget, turnStartedAt: number | null): boolean {
  if (turnStartedAt === null) return false;
  const entry = getRecoveryEntry(target.taskId);
  if (entry?.lastTurnFromNudge) return false;
  const repos = getProjectRepos(context, target.projectId);
  const history = repos.automationRuns.workflowRecoverySince(target.taskId, target.columnId, recoverySince(repos, target));
  if (!history.lastStall || Date.parse(history.lastStall.at) >= turnStartedAt) return false;
  return entry !== undefined || history.countedNudges === 0;
}

/**
 * Start the task's recovery over: a run-log row the next rebuild counts from,
 * so the next stop gets the schedule's first step and a notice of its own.
 * Also the hang check's, after it ends a hung turn or tells the user it could
 * not, since the turn that comes back would otherwise find its recovery spent
 * and wait an hour. `after` puts the row past a stall row just written.
 */
export function startWorkflowRecoveryOver(
  context: IpcContext,
  target: Omit<RecoveryTarget, 'sessionId'>,
  options: { after?: Date; detail?: string } = {},
): void {
  forgetWorkflowRecovery(target.taskId);
  try {
    getProjectRepos(context, target.projectId).automationRuns.recordWorkflowRecoveryStart({
      taskId: target.taskId,
      swimlaneId: target.columnId,
      workflowId: target.workflowId,
      at: options.after,
      detail: options.detail,
    });
  } catch (error) {
    console.warn('[WORKFLOW] Could not record a new recovery:', error);
  }
}

/**
 * Where the task's current recovery begins in the run log: the later of the
 * visit's start, the last wait on the user it was told of, and the last time
 * recovery started over.
 */
function recoverySince(repos: ReturnType<typeof getProjectRepos>, target: RecoveryTarget): string | null {
  const visitStartedAt = repos.taskMoves.visitStartedAt(target.taskId, target.columnId);
  const boundaryAt = repos.automationRuns.latestWorkflowRecoveryBoundaryAt(target.taskId, target.columnId, visitStartedAt);
  return boundaryAt !== null && (visitStartedAt === null || boundaryAt > visitStartedAt) ? boundaryAt : visitStartedAt;
}

/**
 * A resumed session whose reply a step check already judged (a restart, or a
 * Resume): pick the recovery up from the run log. Not for a task that waits
 * on the user, whose question was already told.
 */
export function resumeWorkflowRecovery(context: IpcContext, target: RecoveryTarget): void {
  try {
    const repos = getProjectRepos(context, target.projectId);
    const visitStartedAt = repos.taskMoves.visitStartedAt(target.taskId, target.columnId);
    if (repos.automationRuns.isWaitingOnUser(target.taskId, target.columnId, visitStartedAt)) return;
    const entry = ensureEntry(context, target);
    if (entry && entry.timer === null && !entry.inFlight) armNext(context, entry);
  } catch (error) {
    console.error(`[WORKFLOW] Could not resume task ${target.taskId.slice(0, 8)}'s recovery:`, error);
  }
}

/**
 * A session committed to idle. A running workflow task in a working column
 * with nothing armed is armed here, so a turn that ended with no Stop (a
 * failed turn, an interrupt) still gets recovered. Its own turn end, when one
 * comes, replaces this with its verdict.
 */
export function armWorkflowRecoveryOnIdle(context: IpcContext, sessionId: string): void {
  // Runs in an immediate of its own: nothing here may throw past it.
  try {
    const existing = recoveryEntryForSession(sessionId);
    if (existing && (existing.timer !== null || existing.inFlight)) return;
    const session = context.sessionManager.getSession(sessionId);
    if (!session || session.transient || session.workflowId) return;
    // Every session's every idle comes here: a board that cannot be read is
    // left alone quietly, as the turn-end runner leaves it.
    let repos: ReturnType<typeof getProjectRepos>;
    try {
      repos = getProjectRepos(context, session.projectId);
    } catch {
      return;
    }
    const task = repos.tasks.getById(session.taskId);
    if (!task || task.archived_at || !task.workflow_id || task.session_id !== sessionId) return;
    const column = repos.swimlanes.getById(task.swimlane_id);
    if (!column || column.role === 'todo' || column.role === 'done') return;
    if (!workflowStepApplies(task, session.projectId)) return;
    const visitStartedAt = repos.taskMoves.visitStartedAt(task.id, column.id);
    if (repos.automationRuns.isWaitingOnUser(task.id, column.id, visitStartedAt)) return;
    const entry = ensureEntry(context, { projectId: session.projectId, taskId: task.id, sessionId, columnId: column.id, workflowId: task.workflow_id });
    if (!entry) return;
    // A verdict for this very turn already decided: a question or a done step
    // left nothing to arm.
    const workSerial = context.sessionManager.currentWorkSerial(sessionId);
    if (entry.verdict && entry.verdict.workSerial === workSerial && entry.timer === null) return;
    armNext(context, entry);
  } catch (error) {
    console.warn(`[WORKFLOW] Could not arm recovery for session ${sessionId.slice(0, 8)}:`, error);
  }
}

/** Arm the next attempt, or send the stall notice and stop when the recovery is spent. */
function armNext(context: IpcContext, entry: RecoveryEntry): void {
  if (noticeAndStopIfSpent(context, entry)) return;
  arm(entry, nextDelay(entry));
}

/** Send the stall notice when it is due, and stop the recovery once it is spent. True when it stopped. */
function noticeAndStopIfSpent(context: IpcContext, entry: RecoveryEntry): boolean {
  maybeNoticeStall(context, entry);
  if (!isSpent(entry)) return false;
  forgetWorkflowRecovery(entry.taskId);
  return true;
}

function nextDelay(entry: RecoveryEntry): number {
  return RECOVERY_DELAYS_MS[entry.attemptIndex] ?? OUTAGE_RETRY_MS;
}

/** The wait from attempt `attemptIndex` to the one after it. */
function delayAfter(attemptIndex: number): number {
  return RECOVERY_DELAYS_MS[attemptIndex + 1] ?? OUTAGE_RETRY_MS;
}

function isSpent(entry: RecoveryEntry): boolean {
  return entry.countedNudges >= MAX_COUNTED_NUDGES || Date.now() - entry.startedAt >= RECOVERY_LIMIT_MS;
}

function arm(entry: RecoveryEntry, delayMs: number): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.inFlight = false;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (getRecoveryEntry(entry.taskId) !== entry) return;
    // Counted as under recovery while it waits for the runner's turn.
    entry.inFlight = true;
    if (requestAttempt) requestAttempt(entry.projectId, entry.taskId, entry.sessionId);
    else entry.inFlight = false;
  }, delayMs);
  // A pending attempt never keeps the app from quitting.
  entry.timer.unref?.();
}

/**
 * The task's entry, made from the run log when there is none (a first
 * parking, or a restart). Its recovery so far is everything since
 * `recoverySince`; after a stall row it resumes on the hourly cadence, with
 * its notice already sent.
 */
function ensureEntry(context: IpcContext, target: RecoveryTarget): RecoveryEntry | null {
  const existing = getRecoveryEntry(target.taskId);
  if (existing && existing.columnId === target.columnId && existing.projectId === target.projectId) {
    bindSession(existing, target.sessionId);
    return existing;
  }
  if (existing) forgetWorkflowRecovery(target.taskId);
  const repos = getProjectRepos(context, target.projectId);
  const history = repos.automationRuns.workflowRecoverySince(target.taskId, target.columnId, recoverySince(repos, target));
  const entry: RecoveryEntry = {
    ...target,
    attemptIndex: history.lastStall ? RECOVERY_DELAYS_MS.length : history.attempts,
    countedNudges: (history.lastStall?.countedNudges ?? 0) + history.countedNudges,
    countedSinceNotice: history.lastStall ? history.countedNudges : 0,
    noticeSent: history.lastStall !== null,
    startedAt: history.firstAt ? Date.parse(history.firstAt) : Date.now(),
    workingWait: false,
    holdUntil: null,
    verdict: null,
    pendingNudge: null,
    lastTurnFromNudge: false,
    timer: null,
    inFlight: false,
  };
  setRecoveryEntry(entry);
  return entry;
}

/**
 * Point the entry at the task's session now. A new session (a respawn, a
 * resume) counts its turns from the start again, so what the entry knew of
 * the old one's turns no longer names a turn of this one.
 */
function bindSession(entry: RecoveryEntry, sessionId: string): void {
  if (entry.sessionId === sessionId) return;
  entry.sessionId = sessionId;
  entry.verdict = null;
  entry.pendingNudge = null;
  entry.lastTurnFromNudge = false;
}

// ---------------------------------------------------------------------------
// Turn events the runner hands on
// ---------------------------------------------------------------------------

/**
 * The session ended a turn with its own Stop: a nudge sent before it ran, and
 * counts. Whether this turn was the nudge's decides whether its verdict carries
 * the recovery on, or starts a new one (`startsNewRecovery`).
 */
export function noteRecoveryTurnEnded(sessionId: string): void {
  const entry = recoveryEntryForSession(sessionId);
  if (!entry) return;
  entry.lastTurnFromNudge = entry.pendingNudge !== null;
  entry.pendingNudge = null;
}

/**
 * The session's turn failed or was interrupted. A nudge waiting on that turn
 * did nothing, so it is marked so in the log and spends nothing.
 */
export function noteRecoveryTurnFailed(context: IpcContext, sessionId: string): void {
  const entry = recoveryEntryForSession(sessionId);
  if (!entry?.pendingNudge) return;
  const { rowId } = entry.pendingNudge;
  entry.pendingNudge = null;
  entry.countedNudges = Math.max(0, entry.countedNudges - 1);
  entry.countedSinceNotice = Math.max(0, entry.countedSinceNotice - 1);
  try {
    getProjectRepos(context, entry.projectId).automationRuns.finish(
      rowId,
      'failed',
      'Asked the agent to carry on, but its turn failed, so it does not count.',
    );
  } catch (error) {
    console.warn('[WORKFLOW] Could not mark a recovery nudge whose turn failed:', error);
  }
}

/**
 * Low memory paused this task's agent. A task under recovery has nobody left
 * to nudge it, so its recovery stops here and the user is told.
 */
export function noteWorkflowTaskPaused(context: IpcContext, taskId: string): void {
  const entry = getRecoveryEntry(taskId);
  if (!entry) return;
  forgetWorkflowRecovery(taskId);
  noticeStall(context, entry, 'its agent was paused to free memory, so its step cannot finish until you resume it.');
}

// ---------------------------------------------------------------------------
// An attempt
// ---------------------------------------------------------------------------

/**
 * One attempt, run by the turn-end runner inside its one pass per task, so it
 * never overlaps a turn end's own pass. `signal` aborts when the task moves.
 */
export async function runRecoveryAttempt(context: IpcContext, taskId: string, signal: AbortSignal): Promise<void> {
  const entry = getRecoveryEntry(taskId);
  // A turn end re-armed it meanwhile, or recovery stopped.
  if (!entry || entry.timer !== null) return;
  entry.inFlight = true;
  try {
    await attempt(context, entry, signal);
  } catch (error) {
    console.error(`[WORKFLOW] A recovery attempt for task ${taskId.slice(0, 8)} failed:`, error);
    // It spends the schedule's step, as a check that could not run does, so
    // an attempt that keeps throwing still reaches the notice and the end.
    if (getRecoveryEntry(taskId) === entry && entry.timer === null) {
      entry.attemptIndex += 1;
      arm(entry, nextDelay(entry));
    }
  } finally {
    entry.inFlight = false;
  }
}

/** A queued attempt the runner dropped for a turn end: armed again, in case that turn end arms nothing. */
export function noteRecoveryAttemptDropped(taskId: string): void {
  const entry = getRecoveryEntry(taskId);
  if (entry && entry.timer === null) arm(entry, HOLD_RECHECK_MS);
}

async function attempt(context: IpcContext, entry: RecoveryEntry, signal: AbortSignal): Promise<void> {
  const subject = readSubject(context, entry);
  if (!subject) {
    forgetWorkflowRecovery(entry.taskId);
    return;
  }
  const { task, column } = subject;
  const sessionId = task.session_id!;
  bindSession(entry, sessionId);
  const session = context.sessionManager.getSession(sessionId);
  // No live agent: a pause, an exit. A low-memory pause says so itself.
  if (!session || session.status !== 'running') {
    forgetWorkflowRecovery(entry.taskId);
    return;
  }
  // activity-state-ok: granular, a permission prompt waits on the user and
  // notifies by itself; only an idle agent's turn is over.
  const activity = context.sessionManager.getActivityCache()[sessionId];
  if (activity === 'permission') {
    forgetWorkflowRecovery(entry.taskId);
    return;
  }
  if (activity !== 'idle') {
    // Working on something; its own turn end arms what comes next. A turn that
    // never ends does not keep recovery alive past its limit: the hang check
    // handles that turn, and the user was told when the schedule ran out.
    if (isSpent(entry)) {
      forgetWorkflowRecovery(entry.taskId);
      return;
    }
    arm(entry, nextDelay(entry));
    return;
  }

  // A working wait that ran out stays run out through a hold, and ends only
  // when the nudge goes out: a hold is a minute, never another long wait.
  const waitRanOut = entry.workingWait;
  if (noticeAndStopIfSpent(context, entry)) return;

  const workSerial = context.sessionManager.currentWorkSerial(sessionId);
  if (workSerial === undefined) {
    forgetWorkflowRecovery(entry.taskId);
    return;
  }
  const cached = entry.verdict && entry.verdict.workSerial === workSerial
    && (entry.verdict.verdict === 'stopped' || entry.verdict.verdict === 'working')
    ? entry.verdict
    : null;
  let verdict = cached;
  if (!verdict) {
    const judged = await judgeCurrentTurn(context, entry, subject, { sessionId, workSerial, signal });
    if (signal.aborted || getRecoveryEntry(entry.taskId) !== entry) return;
    if (judged === 'unjudged') {
      if (readSubject(context, entry)) arm(entry, nextDelay(entry));
      else forgetWorkflowRecovery(entry.taskId);
      return;
    }
    verdict = takeVerdict(entry, { ...judged, workSerial });
    switch (judged.verdict) {
      case 'done':
        forgetWorkflowRecovery(entry.taskId);
        return;
      case 'waiting':
      case 'human-gate':
        handleVerdict(context, recoveryTargetOf(entry), judged);
        return;
      case 'check-failed':
      case 'move-failed':
        // Nothing was nudged, so nothing is spent but the schedule's step.
        entry.workingWait = false;
        entry.attemptIndex += 1;
        armNext(context, entry);
        return;
      case 'working':
        // A newer turn said its work is still running: a fresh wait.
        armWorkingWait(entry);
        return;
      case 'stopped':
        break;
    }
  } else if (verdict.verdict === 'working' && !waitRanOut) {
    armWorkingWait(entry);
    return;
  }

  // Stopped, or working past its wait: nudge, unless the user is there.
  const presence = userPresence(context, sessionId, entry.taskId);
  if (presence) {
    const now = Date.now();
    entry.holdUntil ??= now + delayAfter(entry.attemptIndex);
    if (now < entry.holdUntil) {
      arm(entry, HOLD_RECHECK_MS);
      return;
    }
    // Held through to the next attempt: this one is spent, and the next one,
    // due now, holds from that moment, so holds add nothing to the schedule.
    recordAttempt(context, entry, 'skipped', `${attemptLabel(entry)}: held off, ${presence}.`);
    entry.attemptIndex += 1;
    entry.holdUntil += delayAfter(entry.attemptIndex);
    if (noticeAndStopIfSpent(context, entry)) return;
    arm(entry, HOLD_RECHECK_MS);
    return;
  }
  entry.holdUntil = null;
  entry.workingWait = false;

  // A permission prompt that opened since would take the nudge's Enter as yes.
  // activity-state-ok: granular, only an idle agent on the judged turn is nudged.
  if (context.sessionManager.getActivityCache()[sessionId] !== 'idle' || !context.sessionManager.isLatestTurn(sessionId, workSerial)) {
    arm(entry, HOLD_RECHECK_MS);
    return;
  }

  const label = attemptLabel(entry);
  const leftRunning = verdict.verdict === 'working';
  const message = nudgeMessage(column.name, verdict.reason, leftRunning);
  try {
    await deliverMessageToSession(context, {
      taskId: entry.taskId,
      sessionId,
      message,
      mode: 'immediate',
      verifier: resolveInjectionVerifier(task.agent, new SessionRepository(getProjectDb(entry.projectId)), entry.taskId),
      signal: AbortSignal.any([signal, AbortSignal.timeout(NUDGE_DELIVERY_TIMEOUT_MS)]),
    });
  } catch (error) {
    // A move meanwhile: the move owns what happens next.
    if (signal.aborted || getRecoveryEntry(entry.taskId) !== entry) return;
    const detail = error instanceof Error ? error.message : String(error);
    recordAttempt(context, entry, 'failed', `${label}: the nudge was not delivered: ${detail}`);
    entry.attemptIndex += 1;
    armNext(context, entry);
    return;
  }
  if (getRecoveryEntry(entry.taskId) !== entry) return;
  const rowId = recordAttempt(context, entry, 'succeeded', `${label}: asked the agent to carry on.`);
  entry.attemptIndex += 1;
  entry.countedNudges += 1;
  entry.countedSinceNotice += 1;
  entry.pendingNudge = rowId ? { rowId } : null;
  // The nudged turn's own end replaces this. A turn that fails with no turn
  // end still gets its next attempt from it.
  arm(entry, nextDelay(entry));
}

interface AttemptSubject {
  task: Task;
  column: Swimlane;
}

/** The task as it stands: still in the column, with a live session, in a running workflow. */
function readSubject(context: IpcContext, entry: RecoveryEntry): AttemptSubject | null {
  let repos: ReturnType<typeof getProjectRepos>;
  try {
    repos = getProjectRepos(context, entry.projectId);
  } catch {
    return null;
  }
  const task = repos.tasks.getById(entry.taskId);
  if (!task || task.archived_at || !task.workflow_id || !task.session_id) return null;
  if (task.swimlane_id !== entry.columnId || task.workflow_id !== entry.workflowId) return null;
  if (!workflowStepApplies(task, entry.projectId)) return null;
  const column = repos.swimlanes.getById(task.swimlane_id);
  return column ? { task, column } : null;
}

/**
 * Run the step check on the session's current turn: its reply read from where
 * that turn began. A reply that could not be read is not read as none, since
 * that would judge a question as a stall.
 */
async function judgeCurrentTurn(
  context: IpcContext,
  entry: RecoveryEntry,
  subject: AttemptSubject,
  turn: { sessionId: string; workSerial: number; signal: AbortSignal },
): Promise<WorkflowStepResult | 'unjudged'> {
  const session = context.sessionManager.getSession(turn.sessionId);
  const payload: TurnEndedPayload = {
    sessionId: turn.sessionId,
    taskId: entry.taskId,
    projectId: entry.projectId,
    agentSessionId: session?.agentSessionId ?? null,
    isolatedSwimlaneId: session?.isolatedSwimlaneId ?? null,
    turnStartedAt: null,
    workSerial: turn.workSerial,
    transcriptAnchor: context.sessionManager.currentTurnAnchor(turn.sessionId),
  };
  const read = await tryReadSessionFinalReply(payload, new SessionRepository(getProjectDb(entry.projectId)));
  if (turn.signal.aborted) return 'unjudged';
  if (!read.ok) {
    return { verdict: 'check-failed', reason: 'the agent\'s reply could not be read.', workSerial: turn.workSerial };
  }
  // A reply written before the task entered this column was the last column's,
  // as the resume catch-up reads it. Judged as this column's, a reply that said
  // its work was done would move the card past work it never did: a card a
  // person dragged on, then resumed. Nothing has been done here yet, so it is a
  // stall to nudge, with no check to pay for.
  const visitStartedAt = getProjectRepos(context, entry.projectId).taskMoves.visitStartedAt(entry.taskId, subject.column.id);
  if (read.reply && visitStartedAt && read.reply.ts < Date.parse(visitStartedAt)) {
    return {
      verdict: 'stopped',
      reason: `your last reply was written before this task moved to ${subject.column.name}`,
      workSerial: turn.workSerial,
    };
  }
  const step = await runWorkflowStep(context, {
    payload,
    columnId: subject.column.id,
    signal: turn.signal,
    readAgentReply: async () => read.reply?.text ?? null,
  });
  return step === undefined || step === 'newer-turn' ? 'unjudged' : step;
}

/** Why the user looks to be at this agent, or null when nobody is. */
function userPresence(context: IpcContext, sessionId: string, taskId: string): string | null {
  if ((context.sessionManager.getPendingDraft(sessionId) ?? '').trim() !== '') return 'you had text typed';
  if (context.sessionManager.getFocusedSessions().has(sessionId)) return 'its terminal was on screen';
  if (context.terminalSubmitScheduler.hasPending(taskId) || hasPendingMessageDelivery(taskId)) return 'a message was on its way to it';
  return null;
}

function attemptLabel(entry: RecoveryEntry): string {
  const number = entry.attemptIndex + 1;
  return number <= RECOVERY_DELAYS_MS.length ? `Recovery ${number} of ${RECOVERY_DELAYS_MS.length}` : `Recovery ${number}`;
}

/**
 * One line, so it types as keystrokes: the step, why it is not done, and what
 * to do. It answers an agent that stopped to ask whether to go on with its own
 * work, rather than inviting the question: on the board this was measured on,
 * every message a person typed into a stopped workflow task told it to keep
 * going, and none answered a decision.
 */
export function nudgeMessage(columnName: string, reason: string | null, leftRunning: boolean): string {
  const why = sentence(reason);
  const head = `The ${typeable(columnName)} step is not done yet${why ? `: ${why}` : '.'}`;
  const ask = leftRunning
    ? 'Check on the work you left running and carry on from where you stopped.'
    : 'Carry on from where you stopped.';
  return `${head} ${ask} Go ahead with this step's own work, such as committing or running the gate, without asking first. `
    + 'Stop only for a decision, information or access that only the user can give.';
}

function sentence(text: string | null): string {
  const collapsed = typeable(text ?? '').replace(/[.!\s]+$/, '');
  return collapsed ? `${collapsed}.` : '';
}

/**
 * Text that is safe to type as keystrokes: one line, with no control
 * character. The reason is the Automation agent's words about a reply that
 * can quote anything, and an Esc, a Ctrl+C or a paste marker typed into the
 * agent would act on it rather than be read.
 */
function typeable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function recordAttempt(
  context: IpcContext,
  entry: RecoveryEntry,
  status: 'succeeded' | 'skipped' | 'failed',
  detail: string,
): string | null {
  try {
    return getProjectRepos(context, entry.projectId).automationRuns.recordWorkflowRecovery({
      taskId: entry.taskId,
      swimlaneId: entry.columnId,
      workflowId: entry.workflowId,
      status,
      detail,
    });
  } catch (error) {
    console.warn('[WORKFLOW] Could not record a recovery attempt:', error);
    return null;
  }
}

function recoveryTargetOf(entry: RecoveryEntry): RecoveryTarget {
  return { projectId: entry.projectId, taskId: entry.taskId, sessionId: entry.sessionId, columnId: entry.columnId, workflowId: entry.workflowId };
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/**
 * Send the stall notice when the recovery is spent: its schedule ran out, or
 * its nudges did. Once a recovery, and again only when a nudge ran since, so a
 * long outage tells the user once.
 */
function maybeNoticeStall(context: IpcContext, entry: RecoveryEntry): void {
  const scheduleDone = entry.attemptIndex >= RECOVERY_DELAYS_MS.length;
  const nudgesSpent = entry.countedNudges >= MAX_COUNTED_NUDGES;
  if (!scheduleDone && !nudgesSpent) return;
  if (entry.noticeSent && entry.countedSinceNotice === 0) return;
  noticeStall(context, entry, stallReason(entry));
}

function stallReason(entry: RecoveryEntry): string {
  const reason = entry.verdict?.reason?.trim();
  if (entry.verdict?.verdict === 'check-failed') return `the step check could not run${reason ? ` (${reason})` : ''}.`;
  return reason || 'the agent stopped before its step was done.';
}

function noticeStall(context: IpcContext, entry: RecoveryEntry, reason: string): void {
  entry.noticeSent = true;
  entry.countedSinceNotice = 0;
  announceWorkflowStall(context, { ...recoveryTargetOf(entry), reason, countedNudges: entry.countedNudges });
}

/**
 * A running workflow stalled on this task: write the stall row (the notice's
 * latch and the task's mark), then tell the user on desktop, phone and the
 * in-app toast, and refresh the workflow's view. Recovery calls it when it
 * runs out, and the engine host when a start keeps failing. A task whose
 * automations are paused gets none of it: a person is working it by hand.
 */
export function announceWorkflowStall(
  context: IpcContext,
  stall: Omit<RecoveryTarget, 'sessionId'> & { reason: string; countedNudges: number },
): void {
  let homeProjectId = stall.projectId;
  let taskTitle = '';
  try {
    const repos = getProjectRepos(context, stall.projectId);
    const task = repos.tasks.getById(stall.taskId);
    if (task && !canTaskRunAutomations(task).ok) {
      console.log(`[WORKFLOW] Task ${stall.taskId.slice(0, 8)} would have stalled (${stall.reason}), but its automations are paused.`);
      return;
    }
    repos.automationRuns.recordWorkflowStall({
      taskId: stall.taskId,
      swimlaneId: stall.columnId,
      workflowId: stall.workflowId,
      reason: stall.reason,
      countedNudges: stall.countedNudges,
    });
    homeProjectId = task?.workflow_project_id ?? stall.projectId;
    taskTitle = task?.title ?? '';
  } catch (error) {
    // No latch: the notice still goes out, and a restart may send it once more.
    console.warn('[WORKFLOW] Could not record a stall:', error);
  }
  console.warn(`[WORKFLOW] Task ${stall.taskId.slice(0, 8)} stalled: ${stall.reason}`);
  sendNotice(context, { projectId: stall.projectId, taskId: stall.taskId, kind: 'stalled', reason: stall.reason });
  const event: WorkflowStalledEvent = { workflowId: stall.workflowId, projectId: stall.projectId, taskId: stall.taskId, taskTitle, reason: stall.reason };
  sendToRenderer(context.mainWindow, IPC.WORKFLOW_STALLED, event);
  notifyWorkflowChanged(homeProjectId, stall.workflowId);
}

/** A wait on the user: its row, then the notice, which stands in for the idle one. */
function noticeWaiting(context: IpcContext, target: RecoveryTarget, reason: string): void {
  try {
    getProjectRepos(context, target.projectId).automationRuns.recordWorkflowWaiting({
      taskId: target.taskId,
      swimlaneId: target.columnId,
      workflowId: target.workflowId,
      reason,
    });
  } catch (error) {
    console.warn('[WORKFLOW] Could not record a wait on the user:', error);
  }
  sendNotice(context, { projectId: target.projectId, taskId: target.taskId, sessionId: target.sessionId, kind: 'waiting', reason });
}

function sendNotice(
  context: IpcContext,
  notice: { projectId: string; taskId: string; sessionId?: string; kind: 'stalled' | 'waiting'; reason: string },
): void {
  try {
    context.desktopNotifier.notifyWorkflowTask(notice);
  } catch (error) {
    console.warn('[WORKFLOW] Could not show the desktop notice:', error);
  }
  try {
    const detail = notice.kind === 'stalled' ? `Workflow stalled: ${notice.reason}` : `Waiting on you: ${notice.reason}`;
    context.mobileBridgeService?.notifyWorkflowTask({ projectId: notice.projectId, taskId: notice.taskId, detail });
  } catch (error) {
    console.warn('[WORKFLOW] Could not send the phone notice:', error);
  }
}

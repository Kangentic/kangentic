import type { SessionResumer, Swimlane, Task, WorkflowStalledEvent } from '../../shared/types';
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
import { refreshStoppedMark } from '../automations/stopped-mark';
import { isSessionInOwnCall } from '../ipc/handlers/own-call-turn-wait';
import { automatedKeysRefusal, KeysReachedPermissionPromptError } from '../pty/automated-keys-guard';
import { isTurnSettled } from '../pty/turn-settled';
import { notifyWorkflowChanged } from './workflow-changed';
import { heldBackgroundShells, runWorkflowStep, shortCommand, taskBaseBranch, workflowStepApplies, type WorkflowStepResult } from './workflow-step';
import type { WorkflowBlocker } from './workflow-step-condition';
import { workflowMemoryGate, type GateMemoryReading } from './workflow-memory-gate';
import { workflowTasks } from './workflow-tasks';
import { WORKFLOW_NEEDS_OWNER_LINE } from '../../shared/workflow-needs-owner';
import { MARK_BACKGROUND_SERVICE_TOOL } from '../../shared/background-shell-hold';
import {
  forgetWorkflowRecovery,
  getHeldMove,
  getRecoveryEntry,
  recoveryEntryForSession,
  setHeldMove,
  setRecoveryEntry,
  setRecoveryForgetListener,
  WORKING_WAIT_MS,
  type HeldMove,
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
 * - **A stall is unblocked, and only the agent's own word stops it.** Stopped
 *   before done gets one line in its terminal aimed at what it is stuck on
 *   (`nudgeMessage`): memory is back so run it again, the base branch fails
 *   the same tests so check that on a separate checkout, record those and fix
 *   the rest, Kangentic restarted so start the background commands again, and
 *   a sibling's PR landed, said as a fact for the agent to weigh and never as
 *   an order to merge. Every nudge tells the agent to end on the `Needs owner:`
 *   line only for a change from the plan, something the owner must weigh in
 *   on, or a decision to make, and to act otherwise. That line is the one wait that gets the
 *   notice (owner's decision, 2026-10-31). Work the agent left running, by its
 *   hook events, gets one long wait first, `WORKING_WAIT_MS`.
 * - **After Kangentic restarts the agents, at once.** A session Kangentic
 *   resumed after a quit, a crash or a pty host loss had its background
 *   commands stopped with the old process, so its recovery starts over and its
 *   first attempt comes at once, saying so (`resumeWorkflowRecovery`). Before
 *   this, each mid-step task kept its pre-quit "work left running" verdict and
 *   waited an hour on a gate that no longer existed.
 * - **One at a time, and never into low memory.** Every nudge waits its turn in
 *   the workflow's memory gate (`workflow-memory-gate.ts`): none while memory
 *   reads low, and one at a time otherwise. A hold for memory spends nothing.
 * - **It yields to the user.** No nudge while there is a draft, the user typed
 *   into it lately, a message is on its way, the agent is not idle on that
 *   turn, or it cannot take keys (`automated-keys-guard.ts`). A terminal left on
 *   screen is not the user: one held a task an hour overnight with nobody
 *   there. A hold delays the nudge, never the schedule. Pausing the workflow
 *   cancels it all (`cancelWorkflowRecovery`), and so does a move.
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
/** The cadence after the schedule, while nudges are still to spend. */
export const OUTAGE_RETRY_MS = 60 * 60_000;
/** How often a held attempt looks at the user again, and how soon a deferred one runs. */
export const HOLD_RECHECK_MS = 60_000;
/** How long one recovery runs before it stops for good. */
const RECOVERY_LIMIT_MS = 24 * 60 * 60_000;
/** How long a nudge may take to land. A cancelled burst must not hang the attempt. */
const NUDGE_DELIVERY_TIMEOUT_MS = 120_000;
/** Input the user typed into an agent this recently means the user is there. */
export const PRESENCE_WINDOW_MS = 5 * 60_000;

/**
 * A task's one place in the memory gate (`workflow-memory-gate.ts`).
 */
export function workflowTaskGateKey(taskId: string): string {
  return `task:${taskId}`;
}

// A recovery that stops leaves its place in the gate, so nothing waits on it.
setRecoveryForgetListener((taskId) => workflowMemoryGate.drop(workflowTaskGateKey(taskId)));

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
 * `resumedBy` is who resumed the session, for a resume: Kangentic after a quit,
 * a crash or a pty host loss (`'recovery'`), whose stall's recovery starts over
 * with its first attempt at once.
 */
export function afterWorkflowStep(
  context: IpcContext,
  target: RecoveryTarget,
  result: WorkflowStepResult,
  turnStartedAt: number | null = null,
  options: { resumedBy?: SessionResumer } = {},
): void {
  try {
    handleVerdict(context, target, result, turnStartedAt, options);
  } catch (error) {
    console.error(`[WORKFLOW] Recovery could not take task ${target.taskId.slice(0, 8)}'s step verdict:`, error);
  }
}

function handleVerdict(
  context: IpcContext,
  target: RecoveryTarget,
  result: WorkflowStepResult,
  turnStartedAt: number | null = null,
  options: { resumedBy?: SessionResumer } = {},
): void {
  const parked = result.verdict === 'working' || result.verdict === 'stopped'
    || result.verdict === 'check-failed' || result.verdict === 'move-failed' || result.verdict === 'move-held';
  const restarted = options.resumedBy === 'recovery';
  if (parked && restarted) {
    startWorkflowRecoveryOver(context, target, { detail: RESTART_RECOVERY_DETAIL });
  } else if (parked && startsNewRecovery(context, target, turnStartedAt)) {
    startWorkflowRecoveryOver(context, target);
  }
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
      armWorkingWait(context, entry);
      return;
    }
    case 'move-held': {
      const entry = ensureEntry(context, target);
      if (!entry) return;
      takeVerdict(entry, result);
      holdMove(entry, { columnId: target.columnId, sessionId: target.sessionId, kind: 'step', rowId: null, targetName: result.heldMoveTo ?? null });
      return;
    }
    case 'stopped':
    case 'check-failed':
    case 'move-failed': {
      const entry = ensureEntry(context, target);
      if (!entry) return;
      takeVerdict(entry, result);
      endWorkingWait(entry);
      if (options.resumedBy === 'recovery') {
        attemptAtOnceAfterRestart(entry);
        return;
      }
      armNext(context, entry);
      return;
    }
  }
}

/**
 * A restarted agent's first attempt comes at once, not a schedule step later:
 * its background commands died with the old process and nothing it waited on
 * will wake it, so the nudge says so now. It replaces a timer the resumed
 * session's first idle may have armed (`armWorkflowRecoveryOnIdle`): kept, the
 * nudge came five minutes after the agent was back.
 */
function attemptAtOnceAfterRestart(entry: RecoveryEntry): void {
  entry.restartedAt = Date.now();
  arm(entry, 0);
}

/** The run-log row a recovery starts over with after Kangentic restarted its agent. */
const RESTART_RECOVERY_DETAIL = 'Kangentic started this agent again after a restart, so its recovery starts over.';

/**
 * The verdict a new turn gave. A hold belonged to the turn before it, so the
 * next attempt holds from its own start.
 */
function takeVerdict(entry: RecoveryEntry, result: WorkflowStepResult): RecoveryVerdict {
  entry.verdict = {
    workSerial: result.workSerial,
    verdict: result.verdict,
    reason: result.reason,
    blockers: result.blockers ?? [],
    finalLine: result.finalLine ?? null,
  };
  entry.holdUntil = null;
  return entry.verdict;
}

/**
 * A `'working'` verdict's one long wait, counted from when the oldest work
 * still open started, not from the verdict. A new turn on the same work (a
 * background job's wake, an idle compaction) gives a new verdict, and counted
 * from each, one task's wait restarted and ran a second full hour on the same
 * dead holders.
 */
function armWorkingWait(context: IpcContext, entry: RecoveryEntry): void {
  const now = Date.now();
  const since = Math.min(now, oldestOpenWorkSince(context, entry.sessionId) ?? now);
  entry.workingWait = true;
  entry.holdUntil = null;
  arm(entry, Math.max(0, WORKING_WAIT_MS - (now - since)));
}

/** When the oldest background work the session still has open started, or null when none is open. */
function oldestOpenWorkSince(context: IpcContext, sessionId: string): number | null {
  const openWork = context.sessionManager.getOpenWork(sessionId);
  const starts = [...openWork.backgroundShells, ...openWork.backgroundSubagents].map((work) => work.since);
  return starts.length > 0 ? Math.min(...starts) : null;
}

/**
 * A `working` verdict whose background work has ended since is a stall:
 * nothing left will wake the agent. Made `stopped`; true when it was.
 */
function demoteWorkingIfWorkEnded(context: IpcContext, entry: RecoveryEntry, sessionId: string): boolean {
  if (entry.verdict?.verdict !== 'working' || oldestOpenWorkSince(context, sessionId) !== null) return false;
  entry.verdict = { ...entry.verdict, verdict: 'stopped' };
  return true;
}

/**
 * Hold a move the task earned while background work its agent left is still
 * open (`HeldMove`), and nudge at once: the agent is asked to stop the work or
 * mark it a service, and the move runs at its next turn end with none open.
 */
function holdMove(entry: RecoveryEntry, move: HeldMove): void {
  setHeldMove(entry.taskId, move);
  endWorkingWait(entry);
  entry.holdUntil = null;
  arm(entry, 0);
}

/**
 * A Move to column row whose move was held at a turn end (`heldMoveRowId`):
 * the same hold as the step's own move, from the turn-end runner.
 */
export function holdRowMoveForBackgroundWork(
  context: IpcContext,
  target: RecoveryTarget,
  move: { rowId: string; targetName: string | null; workSerial: number },
): void {
  try {
    const entry = ensureEntry(context, target);
    if (!entry) return;
    entry.verdict = { workSerial: move.workSerial, verdict: 'move-held', reason: null, blockers: [] };
    holdMove(entry, { columnId: target.columnId, sessionId: target.sessionId, kind: 'row', rowId: move.rowId, targetName: move.targetName });
  } catch (error) {
    console.error(`[WORKFLOW] Could not hold task ${target.taskId.slice(0, 8)}'s move:`, error);
  }
}

/**
 * A held turn end that only repeats a `working` verdict this visit already
 * has: the same final line, with background work still open. A background
 * job's every event wakes the agent for a turn of its own. A notification
 * that reaches an idle CLI fires its prompt hook (measured on Claude Code
 * 2.1.289, a `prompt` event 126 ms after the task-notification turn), so each
 * wake ends in a held Stop at a new `workSerial`. A Monitor that delivered 19
 * events would otherwise pay for 19 step checks that can only answer the
 * same. The wait is unchanged too: it counts from the work's start. A
 * different final line, an exit line included, is judged.
 */
export function repeatsWorkingVerdict(taskId: string, columnId: string, finalLine: string | null): boolean {
  const entry = getRecoveryEntry(taskId);
  return entry !== undefined
    && entry.columnId === columnId
    && entry.verdict?.verdict === 'working'
    && finalLine !== null
    && entry.verdict.finalLine === finalLine;
}

/**
 * The drain's turn end of a turn whose held end was already judged. A
 * `'working'` verdict for that turn whose work has now ended is a stall: the
 * cached verdict would otherwise keep the full wait past work that is gone.
 * No paid check: the reply is the one already judged not done.
 */
export function noteHeldTurnDrained(context: IpcContext, target: RecoveryTarget): void {
  try {
    const entry = getRecoveryEntry(target.taskId);
    // Any turn's `working` verdict this visit: a wake that repeated it kept
    // the older verdict (`repeatsWorkingVerdict`), so the serials can differ.
    if (!entry || entry.inFlight || entry.columnId !== target.columnId) return;
    if (!demoteWorkingIfWorkEnded(context, entry, target.sessionId)) return;
    endWorkingWait(entry);
    armNext(context, entry);
  } catch (error) {
    console.error(`[WORKFLOW] Could not take task ${target.taskId.slice(0, 8)}'s drained work:`, error);
  }
}

/** The working wait is over: ran out, or a newer verdict replaced it. */
function endWorkingWait(entry: RecoveryEntry): void {
  entry.workingWait = false;
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
export function resumeWorkflowRecovery(context: IpcContext, target: RecoveryTarget, options: { resumedBy?: SessionResumer } = {}): void {
  try {
    const repos = getProjectRepos(context, target.projectId);
    const visitStartedAt = repos.taskMoves.visitStartedAt(target.taskId, target.columnId);
    if (repos.automationRuns.isWaitingOnUser(target.taskId, target.columnId, visitStartedAt)) return;
    if (options.resumedBy === 'recovery') {
      // Kangentic started this agent again after a quit, a crash or a pty
      // host loss. Whatever its last verdict said was running died with the
      // old process, so the old verdict and the old count go: the recovery
      // starts over, judges the reply again on the new session, whose open
      // work starts empty, and its first attempt comes at once.
      startWorkflowRecoveryOver(context, target, { detail: RESTART_RECOVERY_DETAIL });
      const restartedEntry = ensureEntry(context, target);
      if (!restartedEntry) return;
      attemptAtOnceAfterRestart(restartedEntry);
      return;
    }
    const entry = ensureEntry(context, target);
    if (!entry || entry.inFlight) return;
    if (entry.timer !== null) return;
    armNext(context, entry);
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
    // Idle at the end of the turn that moved its own task or paused its own
    // workflow: that call ends or re-homes the session next, so there is no
    // step here to recover.
    if (isSessionInOwnCall(sessionId)) return;
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
    restartedAt: null,
    memoryHoldNoted: false,
    siblingsToldThrough: null,
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
  // No live agent: a pause, an exit.
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
  // A turn the agent ended with only background work it left holding the
  // session is over too: its agent sits at its prompt and takes a nudge.
  if (!isTurnSettled(context.sessionManager, sessionId, { acceptHeld: true })) {
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
  // A held move is not judged again: it was judged done. It waits on the
  // background work, which the nudge names.
  const heldMove = getHeldMove(entry.taskId);
  const holding = heldMove !== undefined && heldMove.columnId === entry.columnId && heldMove.sessionId === sessionId;
  demoteWorkingIfWorkEnded(context, entry, sessionId);
  const cached = entry.verdict && entry.verdict.workSerial === workSerial
    && (entry.verdict.verdict === 'stopped' || entry.verdict.verdict === 'working')
    ? entry.verdict
    : null;
  let verdict = holding
    ? { workSerial, verdict: 'move-held' as const, reason: null, blockers: [] }
    : cached;
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
        endWorkingWait(entry);
        entry.attemptIndex += 1;
        armNext(context, entry);
        return;
      case 'working':
        // A newer turn said its work is still running: the wait, counted from
        // that work's start.
        armWorkingWait(context, entry);
        return;
      case 'move-held':
        // Judged done with its work still open: the hold nudges at once.
        handleVerdict(context, recoveryTargetOf(entry), judged);
        return;
      case 'stopped':
        break;
    }
  } else if (verdict.verdict === 'working' && !waitRanOut) {
    armWorkingWait(context, entry);
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

  // A permission prompt that opened since would take the nudge's Enter as yes,
  // and so would one the engine lost track of: the guard also refuses while a
  // tool call has no end (`automated-keys-guard.ts`).
  // Only an agent whose judged turn is over is nudged: idle, or held by
  // background work alone, which the nudge is about.
  if (!isTurnSettled(context.sessionManager, sessionId, { acceptHeld: true }) || !context.sessionManager.isLatestTurn(sessionId, workSerial)) {
    arm(entry, HOLD_RECHECK_MS);
    return;
  }
  const keysBlocker = automatedKeysRefusal(context.sessionManager, sessionId, `workflow-recovery:${entry.taskId.slice(0, 8)}`);
  if (keysBlocker !== null) {
    // A call that has sat open this long on an idle agent is most likely a
    // prompt the engine lost: tell the owner, as a prompt it saw would have,
    // and stop. Nothing is typed into it either way.
    const openCall = context.sessionManager.getOpenWork(sessionId).toolCalls[0];
    if (openCall && Date.now() - openCall.since >= OPEN_CALL_NOTICE_MS) {
      forgetWorkflowRecovery(entry.taskId);
      noticeWaiting(context, recoveryTargetOf(entry), `it may be waiting on a permission prompt for ${openCall.tool}, which nothing has answered.`);
      return;
    }
    arm(entry, HOLD_RECHECK_MS);
    return;
  }

  // Read before the gate: past it, only the delivery's own catch releases it.
  const now = Date.now();
  const namesShells = verdict.verdict === 'working' || verdict.verdict === 'move-held';
  const openShells = namesShells ? await openShellFacts(context, sessionId, now, holding) : [];
  if (signal.aborted || getRecoveryEntry(entry.taskId) !== entry) return;

  // Its turn in the workflow's memory gate: one load-making action at a time,
  // and none while memory reads low. A hold for memory spends nothing.
  const gateKey = workflowTaskGateKey(entry.taskId);
  const gate = workflowMemoryGate.tryAcquire(gateKey);
  if (!gate.go) {
    if (gate.why === 'memory-low' && !entry.memoryHoldNoted) {
      entry.memoryHoldNoted = true;
      recordAttempt(context, entry, 'skipped', `${attemptLabel(entry)}: held while memory is low; it goes once memory recovers.`);
    }
    arm(entry, HOLD_RECHECK_MS);
    return;
  }
  entry.memoryHoldNoted = false;

  const label = attemptLabel(entry);
  const message = nudgeMessage({
    columnName: column.name,
    reason: verdict.reason,
    leftRunning: verdict.verdict === 'working',
    blockers: verdict.blockers,
    restarted: entry.restartedAt !== null,
    memory: workflowMemoryGate.reading(),
    landedSiblings: landedSiblings(context, entry, task),
    baseBranch: taskBaseBranch(task),
    openShells,
    heldMove: holding ? { targetName: heldMove.targetName } : null,
  });
  try {
    await deliverMessageToSession(context, {
      taskId: entry.taskId,
      sessionId,
      message,
      mode: 'immediate',
      verifier: resolveInjectionVerifier(task.agent, new SessionRepository(getProjectDb(entry.projectId)), entry.taskId),
      signal: AbortSignal.any([signal, AbortSignal.timeout(NUDGE_DELIVERY_TIMEOUT_MS)]),
      acceptHeld: true,
    });
  } catch (error) {
    // Nothing started, so the gate moves on at once.
    workflowMemoryGate.release(gateKey);
    // A move meanwhile: the move owns what happens next.
    if (signal.aborted || getRecoveryEntry(entry.taskId) !== entry) return;
    if (error instanceof KeysReachedPermissionPromptError) {
      // Its own outcome: the keys may have answered a prompt nobody saw. It
      // spends nothing, and the next try waits for the session to settle.
      recordAttempt(context, entry, 'failed', `${label}: the nudge's keys reached a permission prompt, so they may have answered it. It does not count.`);
      arm(entry, HOLD_RECHECK_MS);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    recordAttempt(context, entry, 'failed', `${label}: the nudge was not delivered: ${detail}`);
    entry.attemptIndex += 1;
    armNext(context, entry);
    return;
  }
  // The queue moves on once this turn is under way (`noteWorkflowSessionActivity`).
  workflowMemoryGate.begin(gateKey, sessionId);
  // Only now: a working wait that ran out stays run out through every hold
  // above, so the next try nudges instead of waiting another hour.
  endWorkingWait(entry);
  if (getRecoveryEntry(entry.taskId) !== entry) return;
  const rowId = recordAttempt(context, entry, 'succeeded', `${label}: asked the agent to carry on.`);
  entry.attemptIndex += 1;
  entry.countedNudges += 1;
  entry.countedSinceNotice += 1;
  entry.pendingNudge = rowId ? { rowId } : null;
  // Said once: the restart line and the siblings it named.
  entry.restartedAt = null;
  entry.siblingsToldThrough = now;
  // The nudged turn's own end replaces this. A turn that fails with no turn
  // end still gets its next attempt from it.
  arm(entry, nextDelay(entry));
}

/** How long an idle agent's open tool call holds the nudge before the owner is told it may be a prompt. */
const OPEN_CALL_NOTICE_MS = 10 * 60_000;

/**
 * Tasks of the same workflow whose PR merged into this task's base branch since
 * this visit began (or since the last nudge named them): reaching Done alone is
 * not enough, since some routes end at Done with no PR and some siblings target
 * another base. Never throws: a board that cannot be read names no sibling.
 */
function landedSiblings(context: IpcContext, entry: RecoveryEntry, task: Task): Array<{ number: number; title: string }> {
  try {
    const repos = getProjectRepos(context, entry.projectId);
    const visitStartedAt = repos.taskMoves.visitStartedAt(entry.taskId, entry.columnId);
    const since = Math.max(visitStartedAt ? Date.parse(visitStartedAt) : 0, entry.siblingsToldThrough ?? 0);
    const base = taskBaseBranch(task);
    return workflowTasks(context, task.workflow_project_id ?? entry.projectId, entry.workflowId)
      .map((found) => found.task)
      .filter((sibling) => sibling.id !== task.id
        && sibling.pr_state === 'merged'
        && sibling.archived_at !== null
        && Date.parse(sibling.archived_at) > since
        && taskBaseBranch(sibling) === base)
      .map((sibling) => ({ number: sibling.display_id, title: sibling.title }));
  } catch (error) {
    console.warn(`[WORKFLOW] Could not read task ${entry.taskId.slice(0, 8)}'s workflow siblings:`, error);
    return [];
  }
}

/**
 * The session went thinking: a nudge waiting on its turn has it under way,
 * and the gate lets the next one go. Called for every
 * session's activity by the turn-end runner, so it is one comparison.
 */
export function noteWorkflowSessionActivity(sessionId: string, activity: string): void {
  // activity-state-ok: granular, only a turn under way frees the gate.
  if (activity === 'thinking') workflowMemoryGate.noteThinking(sessionId);
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
    // The attempt runs only on a turn that is over: idle, or held by the
    // background work it left.
    acceptHeld: true,
  });
  return step === undefined || step === 'newer-turn' ? 'unjudged' : step;
}

/**
 * Why the user looks to be at this agent, or null when nobody is: text typed
 * into its prompt, input typed into it lately, or a message on its way. A
 * terminal on screen is not a person: one left on screen held a task an hour
 * overnight with nobody typing.
 */
function userPresence(context: IpcContext, sessionId: string, taskId: string): string | null {
  if ((context.sessionManager.getPendingDraft(sessionId) ?? '').trim() !== '') return 'you had text typed';
  const lastInputAt = context.sessionManager.getLastUserInputAt(sessionId);
  if (lastInputAt !== null && Date.now() - lastInputAt < PRESENCE_WINDOW_MS) return 'you typed into it in the last few minutes';
  if (context.terminalSubmitScheduler.hasPending(taskId) || hasPendingMessageDelivery(taskId)) return 'a message was on its way to it';
  return null;
}

function attemptLabel(entry: RecoveryEntry): string {
  const number = entry.attemptIndex + 1;
  return number <= RECOVERY_DELAYS_MS.length ? `Recovery ${number} of ${RECOVERY_DELAYS_MS.length}` : `Recovery ${number}`;
}

/** What a nudge is built from: the verdict, and the facts Kangentic knows at the moment it goes. */
export interface NudgeInput {
  columnName: string;
  /** The step check's reason it is not done, quoted only when nothing more specific is known. */
  reason: string | null;
  /** The working wait ran out on work the agent left running. */
  leftRunning: boolean;
  /** What the reply says the agent is stuck on (`workflowBlockerConditions`). */
  blockers: readonly WorkflowBlocker[];
  /** Kangentic restarted the agent since its last turn: its background commands died. */
  restarted: boolean;
  /** Memory as the workflow's gate reads it now (a nudge never goes while it reads low). */
  memory: GateMemoryReading;
  /** Siblings whose PR landed on the base branch since this step began. */
  landedSiblings: ReadonlyArray<{ number: number; title: string }>;
  baseBranch: string;
  /**
   * The background commands the agent left running, named in the nudge, for a
   * wait that ran out or a held move. Empty otherwise.
   */
  openShells?: ReadonlyArray<OpenShellFact>;
  /** The step's move, or a Move to column row's, is held on those commands. */
  heldMove?: { targetName: string | null } | null;
}

/** A background command as the nudge names it. */
export interface OpenShellFact {
  id: string;
  command: string | null;
  /** How long it has run (ms). */
  ageMs: number;
  /** Its output file's size, a hint only, or null when not known. */
  outputBytes: number | null;
}

/**
 * The background commands to name, oldest first, with their output sizes: for
 * a held move the ones the engine holds it on (`heldBackgroundShells`), for a
 * working wait the ones the step check read as open.
 */
async function openShellFacts(context: IpcContext, sessionId: string, now: number, heldOnly: boolean): Promise<OpenShellFact[]> {
  const source = heldOnly ? heldBackgroundShells(context, sessionId) : context.sessionManager.getOpenWork(sessionId).backgroundShells;
  const shells = [...source].sort((first, second) => first.since - second.since);
  // Only the commands the nudge names get their output looked up: finding the
  // file lists the agent's temp directory synchronously, and one task held 30.
  return Promise.all(shells.map(async (shell, index) => ({
    id: shell.id,
    command: shell.command,
    ageMs: Math.max(0, now - shell.since),
    outputBytes: index < NUDGE_SHELLS_NAMED
      ? await context.sessionManager.getBackgroundShellOutputBytes(sessionId, shell.id).catch(() => null)
      : null,
  })));
}

/** The longest nudge typed as keystrokes. Past 1000 characters a message goes as a paste, which waits for an idle turn. */
const NUDGE_MAX_CHARS = 960;
/** How many background commands a nudge names one by one. */
const NUDGE_SHELLS_NAMED = 2;
/** How much of a command a nudge quotes. */
const NUDGE_COMMAND_CHARS = 80;

const GIBIBYTE = 1024 * 1024 * 1024;

/**
 * One line, so it types as keystrokes, written to the agent: what it is stuck
 * on, what to do about it, and the one way to stop.
 *
 * - Each blocker gets its own instruction, never the check's words about the
 *   reply: a reason written for the run log ("which is the bare 'waiting for
 *   the gate'") reads as nonsense to the agent it is typed to.
 * - It answers an agent that stopped to ask whether to go on with its own
 *   work, rather than inviting the question: on the board this was measured
 *   on, every message a person typed into a stopped workflow task told it to
 *   keep going, and none answered a decision.
 * - It never says "run the gate" into low memory: the gate holds such a nudge
 *   until memory recovers, and then it says memory is back. Claude Code's
 *   memory reaper tells an agent not to restart a gate on its own, and a nudge
 *   that said to anyway sent one back to 3.7 GB free to be killed again.
 * - It ends on the `Needs owner:` line: the agent's own call whether only the
 *   owner can settle it, for the three things that stop a workflow and nothing
 *   else (owner's decision, 2026-10-31).
 */
export function nudgeMessage(input: NudgeInput): string {
  // One line under the keystroke limit. The commands give way first, then
  // the background commands and the siblings, and a line still too long (a
  // column or branch with a long name) is cut, so it never goes as a paste.
  const tiers = [
    () => composeNudge(input, true),
    () => composeNudge(input, false),
    () => composeNudge({ ...input, openShells: [], landedSiblings: [] }, false),
  ];
  let message = '';
  for (const tier of tiers) {
    message = tier();
    if (message.length <= NUDGE_MAX_CHARS) return message;
  }
  return Array.from(message).slice(0, NUDGE_MAX_CHARS).join('');
}

/**
 * The background commands, named so the agent can find them and told whose
 * they are. One task's agent saw its hung `python3 -` and left it, because a
 * subagent had started it and it "looked like someone else's"; a bare
 * "continue" moved it nowhere, where another agent told only to carry on
 * found and stopped its own in 40 seconds.
 */
function shellSentences(shells: ReadonlyArray<OpenShellFact>, withCommands: boolean): string[] {
  if (shells.length === 0) return [];
  const named = shells.slice(0, NUDGE_SHELLS_NAMED).map((shell) => {
    const command = withCommands && shell.command
      ? `, ${quoteCommand(shell.command)}`
      : '';
    const output = shell.outputBytes === null ? '' : `, output file ${shell.outputBytes} bytes`;
    return `${typeable(shell.id)}${command} (running ${describeAge(shell.ageMs)}${output})`;
  });
  const more = shells.length > NUDGE_SHELLS_NAMED ? ` and ${shells.length - NUDGE_SHELLS_NAMED} more` : '';
  const subject = shells.length === 1 ? 'Your background command' : 'Your background commands';
  const verb = shells.length === 1 ? 'is' : 'are';
  return [
    `${subject} ${named.join('; ')}${more} ${verb} still running.`,
    'It is this session\'s own work, even if a subagent started it.',
    `If it waits on input or is no longer needed, stop it. If it is a service meant to keep running, mark it with ${MARK_BACKGROUND_SERVICE_TOOL}.`,
  ];
}

/** A command, quoted and cut to fit a nudge. */
function quoteCommand(command: string): string {
  return `"${shortCommand(typeable(command), NUDGE_COMMAND_CHARS).replace(/"/g, '\'')}"`;
}

/** How long, in whole minutes or hours and minutes. */
function describeAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function composeNudge(input: NudgeInput, withCommands: boolean): string {
  const base = typeable(input.baseBranch);
  const column = typeable(input.columnName);
  const shells = shellSentences(input.openShells ?? [], withCommands);
  const ownerLine = 'If only the owner can settle what you are stuck on (a change from the plan, something the owner must weigh in on, or a '
    + `decision between options), end your reply with the line "${WORKFLOW_NEEDS_OWNER_LINE}". Otherwise act on it.`;
  if (input.heldMove) {
    // Done, and only the background work holds the move: the agent is asked
    // about that work and nothing else, so it ends its turn when it is done.
    const target = input.heldMove.targetName ? ` to ${typeable(input.heldMove.targetName)}` : '';
    return [
      `The ${column} step is done, and the task moves on${target} at your next turn end with no background command of yours running.`,
      ...shells,
      'Then end your turn.',
      ownerLine,
    ].join(' ');
  }
  const instructions: string[] = [];
  if (input.restarted) {
    instructions.push('Kangentic restarted, so the background commands you started before it (such as a gate run) were stopped. Start them again.');
  }
  if (input.blockers.includes('resource')) {
    const free = input.memory.freeBytes !== null ? ` (${(input.memory.freeBytes / GIBIBYTE).toFixed(1)} GB free)` : '';
    instructions.push(`The machine has memory to spare again${free}. Run what was stopped or failed on load again, one run at a time.`);
  }
  if (input.blockers.includes('main-fails-too')) {
    // The agent's own claim, so the nudge has it checked rather than taking
    // it: a wrong claim would otherwise be told to leave a regression it made.
    // A separate checkout, so the check never switches the step's own branch.
    instructions.push(`Run the failing tests on a separate clean checkout of ${base} to check, leaving this branch as it is. Record the ones that fail there too, and that ${base} fails them: those are not this step's to fix. Fix any that pass on ${base}, then carry on.`);
  }
  // A fact the agent weighs, not an order: a sibling's merge may have nothing
  // to do with this step. So it never stands in for an instruction, and a
  // nudge with only this to say still carries the general one.
  const siblingFacts = input.landedSiblings.map((sibling) =>
    `Task #${sibling.number} (${typeable(sibling.title)}) merged into ${base} since this step began.`);
  const parts: string[] = [];
  if (instructions.length === 0) {
    // Nothing more specific to say: the check's own reason, cut at a word
    // boundary (`parseConditionReply`), and the general instruction.
    const why = sentence(input.reason);
    parts.push(`The ${column} step is not done yet${why ? `: ${why}` : '.'}`);
    parts.push(...siblingFacts);
    parts.push(...shells);
    parts.push(input.leftRunning
      ? 'Check on the work you left running and carry on from where you stopped.'
      : 'Carry on from where you stopped.');
  } else {
    parts.push(`The ${column} step is not done yet.`, ...instructions, ...siblingFacts, ...shells);
  }
  parts.push('Go ahead with this step\'s own work without asking first.');
  parts.push(ownerLine);
  return parts.join(' ');
}

/** The text as one sentence: a closing ellipsis kept, any other end punctuation made one period. */
function sentence(text: string | null): string {
  const collapsed = typeable(text ?? '');
  if (!collapsed) return '';
  if (collapsed.endsWith('...')) return collapsed;
  const trimmed = collapsed.replace(/[.!\s]+$/, '');
  return trimmed ? `${trimmed}.` : '';
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
  refreshStoppedMark(context, stall.projectId, stall.taskId);
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
  refreshStoppedMark(context, target.projectId, target.taskId);
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

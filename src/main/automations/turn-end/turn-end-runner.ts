import { randomUUID } from 'node:crypto';
import { automationMoveTargetName, canColumnRun, canTaskRunAutomations } from '../../../shared/automation-manifest';
import { englishText } from '../../../shared/i18n/english';
import type { ColumnAutomation, Swimlane, Task, TaskMoveRecordOrigin } from '../../../shared/types';
import type { IpcContext } from '../../ipc/ipc-context';
import type { SessionResumedPayload, TurnEndedPayload } from '../../pty/session-manager';
import { isTurnSettled } from '../../pty/turn-settled';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { planExitTargetFor } from '../../ipc/helpers/plan-exit-target';
import { createTransitionEngine, resolveInjectionVerifier } from '../../ipc/helpers/agent-spawn';
import { reportAutomationFailures } from '../../ipc/helpers/automation-failures';
import { showAutomationNotification } from '../shared/show-automation-notification';
import { createProgressCallback, clearSpawnProgress } from '../../transition-engine/spawn-progress';
import { waitForTurnCompletion, type TurnCompletionResult } from '../../transition-engine/turn-completion';
import { frequencyLimitReason } from '../automation-runner';
import { hasCondition, hasFinalLine, needsAgentReply } from '../row-guards';
import { automationRegistry } from '../automation-registry';
import { resolveMoveTarget, routeOf } from '../move-target';
import { heldMoveReason, runWorkflowStep, workflowStepApplies, type WorkflowStepResult } from '../../workflows/workflow-step';
import { isTaskWorkflowPaused } from '../../workflows/workflow-home';
import {
  afterWorkflowStep,
  armWorkflowRecoveryOnIdle,
  holdRowMoveForBackgroundWork,
  noteHeldTurnDrained,
  noteRecoveryAttemptDropped,
  noteRecoveryTurnEnded,
  noteRecoveryTurnFailed,
  noteWorkflowSessionActivity,
  repeatsWorkingVerdict,
  resumeWorkflowRecovery,
  runRecoveryAttempt,
  setRecoveryAttemptRunner,
  startWorkflowRecoveryOver,
} from '../../workflows/workflow-recovery';
import { clearHeldMove, getHeldMove, getRecoveryEntry, setHeldMove, type HeldMove } from '../../workflows/workflow-recovery-state';
import { needsOwnerQuestion } from '../../../shared/workflow-needs-owner';
import { finalMatchLine } from '../../../shared/final-line-match';
import { setHoldReleaseRecoveryStart } from '../../workflows/workflow-task-hold';
import { setWorkflowCatchUp } from '../../workflows/workflow-catch-up';
import type { AutomationRunRepository, RunConditionAnswer } from '../../db/repositories/automation-run-repository';
import type { TaskVisit } from '../../db/repositories/task-move-repository';
import type { ConditionCheckOutcome } from '../condition-check/condition-check';
import { refreshStoppedMark } from '../stopped-mark';
import { judgeColumnStop, NEEDS_A_PERSON_CHECK_ID, NEEDS_A_PERSON_CONDITION } from './column-stop';
import { deliverMessageToSession } from './deliver-message';
import { moveTaskFromRow } from './move-from-row';
import { readSessionFinalReply, tryReadSessionFinalReply } from './final-reply-reader';
import { trackTurnEndGroup } from './turn-end-passes';
import { isSessionInOwnCall } from '../../ipc/handlers/own-call-turn-wait';
import { forgetRecapSession, isRecapTurn, noteRecapSessionIdle, noteRecapSessionPrompt, recapKindOf } from './recap-turns';
import {
  forgetAbandonedTurnSession,
  hasAbandonedTurn,
  noteAbandonedTurn,
  noteTurnEnded,
  noteUserWork,
  takeAbandonedTurn,
  turnEndMark,
  userWorkMark,
  type AbandonedTurn,
} from './abandoned-turns';
import { dispositionOf } from '../../../shared/activity-state';
import { EventType, PromptReason } from '../../../shared/types';
import type { ActivityState, SessionEvent, SessionResumer } from '../../../shared/types';
import type { TranscriptAnchor } from '../../agent/shared/transcript-anchor';

/**
 * A column's On agent turn end automations: what runs when the agent working a
 * task finishes a turn.
 *
 * The rule (#732, the Code Review loop), and why each part is here:
 *
 * - **A turn end is the agent's own,** the activity engine's `'turn-ended'`:
 *   a Stop, settled past any background work, never an interrupt, a failed
 *   turn or a watchdog guess. Then 1.5 s of PTY silence (`waitForTurnCompletion`),
 *   or the wait's whole 120 s with the session idle throughout: a CLI that
 *   paints a status line for its own background work never goes quiet, and
 *   the turn is over all the same (`turnSettled`). Either give-up logs a
 *   warning. A session still not idle at the give-up, on the same turn, also
 *   leaves each pending row a skip saying so.
 * - **Only a turn that began in this visit counts.** A task dragged in while
 *   its agent was mid-turn ends that turn here, but the turn did the last
 *   column's work, and `{{agentReply}}` would carry the wrong reply. Each
 *   pending row records that skip once a visit, and the next turn end still
 *   runs it. A plan exit is the exception: the agent implements in the turn
 *   that planned, so the rest of the turn is this column's work and its reply
 *   is the one to judge (`countsAsThisColumnsTurn`). The engine re-stamps the
 *   turn's start at an approved ExitPlanMode, which covers a task dragged in
 *   before its plan was approved. Its own move (`auto-move`) is exempt as
 *   well, because under a busy task lock that move can be written after the
 *   approval's stamp. So is a drag into the last column's plan exit target
 *   once the agent had left plan mode, a plan left in the conversation with no
 *   approval to re-stamp the turn.
 * - **The reply is the turn's own.** It is read from where the turn began in
 *   the transcript (`transcriptAnchor`, a byte offset the session manager
 *   copies from the message trail when the session goes idle), so a turn that
 *   wrote no text has no reply. The walk back to the last prompt cannot do
 *   that alone: a turn a background job's `<task-notification>` opened, or an
 *   `isMeta` peer hand-back or `/loop` wakeup, has no prompt it stops at, and
 *   would hand on the message the last turn ended on, such as `Findings:
 *   applied`. An offset, not the reply's time: the CLI stamps its transcript
 *   with its own clock, which a WSL guest lets drift from the app's. With no
 *   anchor (an agent with no window read, a fresh spawn) the read is the
 *   newest reply, as before.
 * - **Rows run top to bottom, each at most once per visit, and only a row that
 *   executes counts.** A Condition that answers no has not run, so the next
 *   turn end checks it again. A Move to column row that runs ends the group:
 *   the task has left. A row whose Frequency is spent (counted since a person
 *   last moved the task, or it last left Done) is skipped with its limit,
 *   recorded once per visit.
 * - **Outside the task lock.** A row can take minutes, and a Move to column
 *   row's own move takes that lock (`withTaskLock` is not reentrant). A move
 *   made meanwhile supersedes the group instead (`supersedeTurnEndWork`).
 * - **One pass per task at a time.** "Has it run this visit" is read before the
 *   run row is written, so two passes would both run the same row. A turn end
 *   that arrives during a pass (a background job restarting the agent while a
 *   check is out) runs once more after it.
 * - **Nothing acts on a turn that is no longer the latest.** The pass judges
 *   the turn its payload names (`workSerial`), and before the check and again
 *   before the rows it asks whether that turn is still the session's latest
 *   (`isLatestTurn`). Being idle is not enough: a turn the user started
 *   meanwhile can fail (`turn_failed`) or be interrupted back to idle with no
 *   turn end of its own, and acting then would act on the old turn's reply.
 *   A newer turn abandons the pass and writes nothing more. A spent
 *   Frequency's skip is written before the wait: it is about the row, not the
 *   turn. The same turn with the session not idle at the re-check writes a
 *   skip for each row it holds back: no turn end may follow it.
 * - **An abandoned turn end is judged after all when the newer work ends with
 *   no turn end of its own,** no prompt or reported interrupt since, and no
 *   reply of its own (`reclaimAbandonedTurn`; `abandoned-turns.ts` says which
 *   interrupts it cannot see). Some newer work never gets a Stop: a turn whose
 *   Stop was lost ends by a watchdog or an idle hint, and before the engine
 *   logged an internal CLI agent's tool events only, such an agent's tool
 *   start after a Stop reopened the turn and never ended. Waiting on that
 *   work's own turn end lost the rows for good, and the card sat in the column.
 * - **A pass off a workflow ends by asking whether the board stopped the card**
 *   (`column-stop.ts`), once no row moved the task or messaged the agent. That
 *   read is why a column whose rows are all spent still reads the reply. A
 *   column with no rows never gets here, by the fast path below.
 * - **A turn the column waited on says why its rows did not run; the rest stay
 *   silent.** Silent: the task left the column or the session is not its own
 *   (`resolveSubject`), a move superseded the pass, a newer turn began, every
 *   row already ran or cannot run here, and the recap turn, which asks the
 *   user to act next.
 * - **Cheap when there is nothing to do.** Every hook agent's every turn ends
 *   here; a column with no turn-end rows costs one indexed query.
 * - **A resume catches up the workflow step, never the rows.** A session that
 *   comes back from a Pause, a restart or a crash comes back idle with no turn
 *   end, so a reply whose step check a Pause abandoned, or a quit cut short,
 *   would sit unjudged until the user typed. The resume judges that reply once
 *   (`catchUpAfterResume`). The rows stay with real turn ends.
 * - **The turn that answers an expired conversation's recap runs nothing.**
 *   The recap asks the agent to summarize and wait (`recap-turns.ts`), so its
 *   reply is a report for the user, not the column's work.
 * - **A running workflow's turn is judged at its Stop, even with background
 *   work still running.** A turn end waits for the work the turn left to
 *   drain, and a hung command never drains: one held a finished workflow task
 *   nearly nine hours, its exit line unread. So a workflow task's held turn
 *   end (`'turn-ended-held'`) runs the `Needs owner:` read, the step check and
 *   the rows behind a Text match at once; the rows with no Text match wait for
 *   the drain, whose pass runs only them (`drainOfHeld`). Off a workflow
 *   nothing changes. A move either would make waits while that work is open
 *   (`heldMoveReason`), recovery nudges at once naming it, and the move runs at
 *   the next turn end with none open (`settleHeldMove`).
 * - **A workflow step that does not move the task on is recovered**
 *   (`workflow-recovery.ts`). Its verdict arms the recovery, and so does a
 *   resume whose reply was already judged (a restart) and a commit to idle
 *   with nothing armed (a turn that ended with no Stop). Each attempt runs
 *   here as a pass of its own (`recovery`), so it never overlaps a turn end's.
 */

interface PassRequest {
  payload: TurnEndedPayload;
  /** A resume's catch-up: the workflow step alone, on the reply no check judged. */
  catchUp: boolean;
  /** A catch-up's: who resumed the session (a person, or Kangentic after a restart). */
  resumedBy?: SessionResumer;
  /**
   * A workflow recovery attempt (`runRecoveryAttempt`): the step judged again
   * on the session's current turn, then a nudge or a notice. Ranks like a
   * catch-up: a turn end replaces it, and it never replaces a turn end.
   */
  recovery?: boolean;
  /**
   * The session's user-work count when the turn ended (`userWorkMark`). A pass
   * that newer work abandons keeps it, so a later reclaim can tell whether the
   * user prompted or interrupted since.
   */
  userWorkMarkAtTurnEnd: number;
  /**
   * The session's turn-end count when the turn ended (`turnEndMark`). A later
   * turn end moves it, and then that turn's own pass judges: a pass still
   * running for this one keeps nothing (`abandonForNewerWork`).
   */
  turnEndMarkAtTurnEnd: number;
  /**
   * A reclaim's: the column the abandoned pass judged for. The pass runs only
   * while the task is still there.
   */
  reclaimedForColumnId?: string;
  /**
   * A held turn end (`'turn-ended-held'`): the agent's Stop landed and only
   * background work it left keeps the session thinking. Runs for a running
   * workflow's task only: the `Needs owner:` read, the step check and the rows
   * behind a Text match. The rest wait for the drain.
   */
  held?: boolean;
}

interface TaskPassState {
  /** A request that arrived while a pass was running, run once more after it. */
  pending: PassRequest | null;
}

const passes = new Map<string, TaskPassState>();

/**
 * The turn each session's held pass judged (its `workSerial`), so the drain's
 * turn end of that same turn runs only what the held pass left. Recorded at
 * the end of a held pass that judged the turn, never at its start: a pass that
 * found the agent busy, was abandoned or threw judged nothing, and its drain
 * judges the turn in full. Read by the drain's own pass, which runs after the
 * held one (`schedulePass` runs a task's passes one at a time).
 */
const heldPassesServed = new Map<string, number>();

/** Is this turn end the drain of a turn its held pass judged? Takes the record. */
function takeHeldPassServed(payload: TurnEndedPayload): boolean {
  if (payload.heldReported !== true) return false;
  const served = heldPassesServed.get(payload.sessionId) === payload.workSerial;
  heldPassesServed.delete(payload.sessionId);
  return served;
}

export function registerTurnEndAutomations(context: IpcContext): void {
  context.sessionManager.on('turn-ended', (payload: TurnEndedPayload) => {
    // Synchronous, ahead of the immediate: the engine emits the idle's
    // 'activity' first in the same commit, and the reclaim that listener
    // schedules must find a turn that ended with its own Stop already judged.
    // A pass for an older turn that resumes before this one is scheduled
    // must find the count moved too.
    noteTurnEnded(payload.sessionId);
    // A drain of a held turn keeps the held pass's record for its own pass to
    // read: that pass runs after the held one, which records the turn only once
    // it has judged it. Any other turn end leaves no held turn to drain.
    const heldReported = payload.heldReported === true;
    if (!heldReported) heldPassesServed.delete(payload.sessionId);
    // A recovery nudge waiting on this turn ran, so it counts. Said once per
    // turn: the held turn end already said it for this one.
    if (!heldReported) noteRecoveryTurnEnded(payload.sessionId);
    const marks = {
      userWorkMarkAtTurnEnd: userWorkMark(payload.sessionId),
      turnEndMarkAtTurnEnd: turnEndMark(payload.sessionId),
    };
    // Off the engine's commit stack: this fires inside `commitTransition`, and
    // even a DB read belongs after it has unwound.
    setImmediate(() => {
      void schedulePass(context, { payload, catchUp: false, ...marks });
    });
  });
  // A turn the agent ended, held by background work it left (a hung command
  // that never drains held one finished workflow task nearly nine hours). A
  // running workflow's step reads the reply now; everything else waits for
  // the drain, as before. The turn-end count is the drain's to move, so the
  // drain's own pass is never taken for older work.
  context.sessionManager.on('turn-ended-held', (payload: TurnEndedPayload) => {
    noteRecoveryTurnEnded(payload.sessionId);
    const marks = {
      userWorkMarkAtTurnEnd: userWorkMark(payload.sessionId),
      turnEndMarkAtTurnEnd: turnEndMark(payload.sessionId),
    };
    setImmediate(() => {
      void schedulePass(context, { payload, catchUp: false, held: true, ...marks });
    });
  });
  // Off the spawn's stack too: the resume writes the task's session id after
  // the spawn returns.
  context.sessionManager.on('session-resumed', (resumed: SessionResumedPayload) => {
    setImmediate(() => {
      // A restart emptied the stopped set, and the run log still holds the stop.
      refreshStoppedMark(context, resumed.projectId, resumed.taskId);
      void catchUpAfterResume(context, resumed);
    });
  });
  // A workflow's Resume, or a task's automations resumed, found the agent
  // already live: judge the reply it left, as a resume does. Off the caller's
  // stack, as the resume's is.
  setWorkflowCatchUp((resumed) => {
    setImmediate(() => {
      void catchUpAfterResume(context, resumed);
    });
  });
  // Where a recap's turn ends (`recap-turns.ts`): a map lookup for any other session.
  context.sessionManager.on('activity', (sessionId: string, activity: ActivityState) => {
    if (dispositionOf(activity) === 'idle') noteRecapSessionIdle(sessionId, Date.now());
    // activity-state-ok: granular, only a commit to idle ends work; a
    // permission prompt is the same work waiting on the user.
    if (activity === 'idle' && hasAbandonedTurn(sessionId)) scheduleReclaim(context, sessionId);
    // A running workflow task idle with nothing armed gets a recovery, so a
    // turn that ended with no Stop of its own is not left parked. Off the
    // engine's commit stack, as the passes are.
    // activity-state-ok: granular, only a commit to idle ends work.
    if (activity === 'idle') {
      setImmediate(() => armWorkflowRecoveryOnIdle(context, sessionId));
    }
    // A nudge waiting on this session's turn has it under way: the workflow's
    // memory gate lets the next one go.
    noteWorkflowSessionActivity(sessionId, activity);
  });
  context.sessionManager.on('event', (sessionId: string, event: SessionEvent) => {
    // A prompt the agent received, not PTY output standing in for one: after
    // the first idle it starts the turn that follows the recap's.
    if (event.type === EventType.Prompt && event.detail !== PromptReason.PtyActivity) {
      noteRecapSessionPrompt(sessionId);
      noteUserWork(sessionId);
    }
    // An interrupt or a failed turn ends the work by the user's hand or the
    // service's, never by the agent's choice, so an abandoned reply is not
    // judged after one. An internal CLI agent's interrupted tool is the one
    // exception: nobody sees that work, and the engine only logs it.
    if (
      (event.type === EventType.Interrupted && !context.sessionManager.isInternalAgentEvent(sessionId, event))
      || event.type === EventType.TurnFailed
    ) {
      noteUserWork(sessionId);
      // A recovery nudge whose turn failed or was cut short did nothing.
      noteRecoveryTurnFailed(context, sessionId);
    }
  });
  setRecoveryAttemptRunner((projectId, taskId, sessionId) => {
    void schedulePass(context, {
      payload: { sessionId, taskId, projectId, agentSessionId: null, isolatedSwimlaneId: null, turnStartedAt: null, workSerial: 0, transcriptAnchor: null },
      catchUp: false,
      recovery: true,
      userWorkMarkAtTurnEnd: userWorkMark(sessionId),
      turnEndMarkAtTurnEnd: turnEndMark(sessionId),
    });
  });
  setHoldReleaseRecoveryStart(startWorkflowRecoveryOver);
  context.sessionManager.on('session-removed', (sessionId: string) => {
    // Gone before its recap turn ended: what waited on it is not sent.
    forgetRecapSession(sessionId, false);
    forgetAbandonedTurnSession(sessionId);
    heldPassesServed.delete(sessionId);
  });
}

/** Judge the reply a resumed session's step check never judged. Exported for its test. */
export function catchUpAfterResume(context: IpcContext, resumed: SessionResumedPayload): Promise<void> {
  const { resumedBy, ...turn } = resumed;
  return schedulePass(context, {
    payload: { ...turn, turnStartedAt: null, transcriptAnchor: null },
    catchUp: true,
    resumedBy,
    userWorkMarkAtTurnEnd: userWorkMark(resumed.sessionId),
    turnEndMarkAtTurnEnd: turnEndMark(resumed.sessionId),
  });
}

/**
 * Keep a turn end whose pass gave up because newer work began, so the reply
 * is judged after all if that work ends with no turn end of its own
 * (`abandoned-turns.ts`). Not when a turn end of the session's own arrived
 * since, queued behind this pass or not yet scheduled: that turn's pass judges
 * it. Not for a session that left the registry, which has no newer work and
 * no later idle. When the session is idle already, the newer work ended
 * before the pass gave up, and no later idle would come for it, so the
 * reclaim is scheduled now.
 */
function abandonForNewerWork(context: IpcContext, request: PassRequest, columnId: string): void {
  const { sessionId } = request.payload;
  if (context.sessionManager.currentWorkSerial(sessionId) === undefined) return;
  if (turnEndMark(sessionId) !== request.turnEndMarkAtTurnEnd) return;
  const queued = passes.get(request.payload.taskId)?.pending;
  if (queued && !queued.catchUp) return;
  noteAbandonedTurn({
    payload: request.payload,
    columnId,
    userWorkMarkAtTurnEnd: request.userWorkMarkAtTurnEnd,
    turnEndMarkAtTurnEnd: request.turnEndMarkAtTurnEnd,
  });
  // activity-state-ok: granular, only an idle session's newer work has ended.
  if (context.sessionManager.getActivityCache()[sessionId] === 'idle') {
    scheduleReclaim(context, sessionId);
  }
}

/**
 * The newer work as it stood at a commit to idle: where it began in the
 * transcript, and the session's work serial then.
 */
interface NewerWork {
  anchor: TranscriptAnchor | null;
  workSerial: number | undefined;
}

/**
 * Judge a session's abandoned turn end at a commit to idle. The newer work is
 * read now, inside that commit: the next turn start replaces its anchor, and
 * the reclaim judges only if no work came after it.
 */
function scheduleReclaim(context: IpcContext, sessionId: string): void {
  const newerWork: NewerWork = {
    anchor: context.sessionManager.currentTurnAnchor(sessionId),
    workSerial: context.sessionManager.currentWorkSerial(sessionId),
  };
  setImmediate(() => {
    reclaimAbandonedTurn(context, sessionId, newerWork).catch((error: unknown) => {
      console.error(`[turn-end] Could not judge session ${sessionId.slice(0, 8)}'s earlier turn end:`, error);
    });
  });
}

/**
 * The newer work that abandoned a turn end is over, and no turn end of its own
 * came (one would have forgotten the entry first). Judge the earlier reply
 * when that work wrote none and nobody prompted or interrupted since. Exported
 * for its test.
 */
export async function reclaimAbandonedTurn(
  context: IpcContext,
  sessionId: string,
  newerWork: NewerWork,
): Promise<void> {
  // Taken, so a second idle never judges it twice.
  const abandoned = takeAbandonedTurn(sessionId);
  if (!abandoned) return;
  if (reclaimSerial(context, sessionId, abandoned, newerWork) === null) return;
  const { payload } = abandoned;
  const taskLabel = payload.taskId.slice(0, 8);
  if (!newerWork.anchor) {
    console.log(
      `[turn-end] Left task ${taskLabel}'s earlier turn end unjudged: the work after it ended with no turn end, `
      + 'and where that work began in the transcript is unknown.',
    );
    return;
  }
  const newerReply = await tryReadSessionFinalReply(
    { sessionId, agentSessionId: payload.agentSessionId, transcriptAnchor: newerWork.anchor },
    new SessionRepository(getProjectDb(payload.projectId)),
  );
  if (!newerReply.ok) {
    // Fails closed: a reply the read could not see may be the one to judge.
    console.log(
      `[turn-end] Left task ${taskLabel}'s earlier turn end unjudged: the work after it ended with no turn end, `
      + 'and its reply could not be read.',
    );
    return;
  }
  if (newerReply.reply && newerReply.reply.text.trim().length > 0) {
    console.log(
      `[turn-end] Left task ${taskLabel}'s earlier turn end unjudged: the work after it wrote a reply of its own `
      + 'and ended with no turn end.',
    );
    return;
  }
  // The read takes a moment. Judge only the newer work it read.
  const workSerial = reclaimSerial(context, sessionId, abandoned, newerWork);
  if (workSerial === null) return;
  console.log(
    `[turn-end] Judging task ${taskLabel}'s earlier turn end: the work after it ended with no turn end `
    + 'and wrote no reply of its own.',
  );
  await schedulePass(context, {
    payload: { ...payload, workSerial },
    catchUp: false,
    userWorkMarkAtTurnEnd: abandoned.userWorkMarkAtTurnEnd,
    turnEndMarkAtTurnEnd: abandoned.turnEndMarkAtTurnEnd,
    reclaimedForColumnId: abandoned.columnId,
  });
}

/**
 * The work serial a taken abandoned turn end may still be judged under: the
 * session's own, while it is idle on `newerWork` and nothing came after. Null
 * and silent when the user acted, a turn end of the session's own arrived, or
 * the session is gone: the turn after it owns what comes next. Null when work
 * began after `newerWork` too, but the entry is kept for that work's end, and
 * an idle session gets a fresh reclaim, because that work ended before this
 * one ran.
 */
function reclaimSerial(
  context: IpcContext,
  sessionId: string,
  abandoned: AbandonedTurn,
  newerWork: NewerWork,
): number | null {
  if (userWorkMark(sessionId) !== abandoned.userWorkMarkAtTurnEnd) return null;
  if (turnEndMark(sessionId) !== abandoned.turnEndMarkAtTurnEnd) return null;
  const workSerial = context.sessionManager.currentWorkSerial(sessionId);
  if (workSerial === undefined || newerWork.workSerial === undefined) return null;
  // activity-state-ok: granular, only an idle session's newer work has ended.
  const idle = context.sessionManager.getActivityCache()[sessionId] === 'idle';
  if (idle && workSerial === newerWork.workSerial) return workSerial;
  noteAbandonedTurn(abandoned);
  if (idle) scheduleReclaim(context, sessionId);
  return null;
}

async function schedulePass(context: IpcContext, request: PassRequest): Promise<void> {
  const existing = passes.get(request.payload.taskId);
  if (existing) {
    // A turn end outranks a pending catch-up or recovery: it judges a newer
    // turn, and either behind one would find that turn's reply already judged.
    const background = request.catchUp || request.recovery === true;
    if (!background || existing.pending === null) {
      // A recovery attempt a turn end replaced is armed again, in case that
      // turn end arms nothing of its own.
      if (existing.pending?.recovery && !request.recovery) noteRecoveryAttemptDropped(request.payload.taskId);
      existing.pending = request;
    } else if (request.recovery && !existing.pending?.recovery) {
      // An attempt already queued runs this one's attempt, so only a recovery
      // a turn end or catch-up kept from queuing is armed again.
      noteRecoveryAttemptDropped(request.payload.taskId);
    }
    return;
  }
  const state: TaskPassState = { pending: null };
  passes.set(request.payload.taskId, state);
  try {
    let next: PassRequest | null = request;
    while (next) {
      state.pending = null;
      try {
        if (next.recovery) await runRecovery(context, next.payload);
        else await (next.catchUp ? runCatchUp(context, next.payload, next.resumedBy ?? 'user') : runPass(context, next));
      } catch (error) {
        console.error(`[turn-end] Pass failed for task ${next.payload.taskId.slice(0, 8)}:`, error);
      }
      next = state.pending;
    }
  } finally {
    passes.delete(request.payload.taskId);
  }
}

/** A row's skip when the turn that ended began before the task entered the column. */
export const CARRIED_IN_TURN_REASON = 'The agent\'s turn began before the task entered this column.';

/** A row's skip when the session was not idle on the same turn when the rows were due. */
export const AGENT_NOT_IDLE_REASON = 'The agent was not idle when this was due to run.';

/**
 * Record why a row did not run, once per visit: the same reason written at
 * every turn end of a long chat would bury the runs that matter.
 */
function recordSkipOncePerVisit(
  runs: AutomationRunRepository,
  row: ColumnAutomation,
  taskId: string,
  visitStartedAt: string | null,
  reason: string,
): void {
  if (runs.hasSkipSince(row.id, taskId, visitStartedAt, reason)) return;
  runs.recordSkipped({ id: randomUUID(), automation: row, taskId }, reason);
}

/** The task a turn end is for, the column it is in, and that project's repositories. */
interface TurnEndSubject {
  task: Task;
  column: Swimlane;
  repos: ReturnType<typeof getProjectRepos>;
}

/** The task and column a turn end is for, or null when it no longer applies. */
function resolveSubject(
  context: IpcContext,
  payload: TurnEndedPayload,
): TurnEndSubject | null {
  let repos: ReturnType<typeof getProjectRepos>;
  try {
    repos = getProjectRepos(context, payload.projectId);
  } catch {
    return null;
  }
  const task = repos.tasks.getById(payload.taskId);
  if (!task || task.archived_at) return null;
  // The session that ended its turn must still be the task's live one: the
  // agent may have moved its own task, or the session been suspended for
  // another column's.
  if (task.session_id !== payload.sessionId) return null;
  // Its own call is still taking effect: the turn that moved its task belongs
  // to the column the task left, the turn that paused its workflow to a
  // workflow that is now paused, and the call is waiting on this very turn end
  // to end the session (`own-call-turn-wait.ts`).
  if (isSessionInOwnCall(payload.sessionId)) return null;
  // An isolated column's session belongs to that column alone.
  if (payload.isolatedSwimlaneId && payload.isolatedSwimlaneId !== task.swimlane_id) return null;
  const column = repos.swimlanes.getById(task.swimlane_id);
  if (!column) return null;
  return { task, column, repos };
}

async function runPass(context: IpcContext, request: PassRequest): Promise<void> {
  const { payload } = request;
  const held = request.held === true;
  // The drain of a turn its held pass judged: only the rows with no Text match
  // run. The step and the Text match rows were the held pass's.
  const drainOfHeld = !held && takeHeldPassServed(payload);
  const recapTurn = isRecapTurn(payload.sessionId, payload.turnStartedAt);
  // A held pass never reads a recap turn; the drain's pass does, and ends the
  // mark with the one turn it was for. Judged before any other early return.
  if (held && recapTurn) return;
  const recapKind = recapTurn ? recapKindOf(payload.sessionId) : null;
  if (recapTurn) forgetRecapSession(payload.sessionId);
  const subject = resolveSubject(context, payload);
  if (!subject) return;
  const { task, column, repos } = subject;
  // A reclaim judges only for the column it was abandoned in: a move made while
  // it read found no entry to forget.
  if (request.reclaimedForColumnId !== undefined && request.reclaimedForColumnId !== column.id) return;

  // The fast path: most columns have no turn-end rows, and most tasks are in
  // no workflow.
  const rows = repos.automations.getForTrigger(column.id, 'turn_end');
  const stepApplies = workflowStepApplies(task, payload.projectId);
  if (rows.length === 0 && !stepApplies) return;
  // Off a running workflow, a held turn end runs nothing: the column's rows
  // wait for the background work to drain, as they always have.
  if (held && !stepApplies) return;

  // A move this visit held on background work goes before anything else. One
  // held by another session's work is gone with that session: the reply is
  // judged as any other.
  const heldMove = stepApplies ? getHeldMove(task.id) : undefined;
  if (heldMove && heldMove.sessionId !== payload.sessionId) clearHeldMove(task.id);
  else if (heldMove && heldMove.columnId === column.id) {
    const released = await settleHeldMove(context, request, subject, heldMove);
    if (released !== 'judge') return;
  }

  if (recapTurn) {
    // No run record. An expired recap asks the agent to wait for the user, so
    // the user acts next and the turn that answers runs the rows. A return
    // recap is answered in a line, and the column's own message, sent once this
    // turn ended, starts the turn that does. Logged so the skip can be traced.
    console.log(
      `[turn-end] Skipped the recap turn for task ${task.id.slice(0, 8)} in ${column.name}: `
      + (recapKind === 'return'
        ? 'it answered the recap of the column session that ran while its conversation was away; the column\'s message follows.'
        : 'it answered an expired conversation\'s recap, which asks the agent to wait for the user.'),
    );
    return;
  }

  const visit = repos.taskMoves.currentVisit(task.id, column.id);
  const visitStartedAt = visit?.at ?? null;
  const facts = { autoSpawn: column.auto_spawn, role: column.role };
  const runs = repos.automationRuns;
  // A task whose automations are disabled runs none of the column's rows. It is
  // decided here, ahead of the Frequency records, the paint wait and the paid
  // Condition check, so a held task never waits for the paint or pays for a check.
  const taskRunnability = canTaskRunAutomations(task);
  // The rows still pending this visit. A row that already ran, or that the
  // column cannot run, is left out without a record: a record at every turn end
  // of a long chat would bury the ones that matter. A row held by the task's
  // switch, or that has spent its Frequency, is left out too, but says so once
  // per visit, or a gate that stopped moving the task looks like a failure with
  // no reason.
  const pending: ColumnAutomation[] = [];
  for (const row of rows) {
    // A held turn end runs the rows behind a Text match, which read the reply
    // it ended on. The rest keep waiting for the drain, which runs only them.
    if (held && !hasFinalLine(row)) continue;
    if (drainOfHeld && hasFinalLine(row)) continue;
    if (automationRegistry.get(row.type) === undefined
      || !canColumnRun(row.type, facts, 'turn_end').ok
      || runs.hasRunSince(row.id, task.id, visitStartedAt)) continue;
    if (!taskRunnability.ok) {
      recordSkipOncePerVisit(runs, row, task.id, visitStartedAt, englishText(taskRunnability.reason));
      continue;
    }
    const spent = frequencyLimitReason(row, runs, task.id);
    if (spent === null) {
      pending.push(row);
    } else {
      recordSkipOncePerVisit(runs, row, task.id, visitStartedAt, spent);
    }
  }

  if (visit && payload.turnStartedAt !== null && payload.turnStartedAt < Date.parse(visit.at)
    && !countsAsThisColumnsTurn(context, payload, subject, visit)) {
    // A turn the task carried in from its last column, which the column was
    // waiting on, so each pending row says why it did not run. A skip is not a
    // run: the next turn end of the visit still runs them. The workflow step
    // gets the console line only, since its log row is a check's answer. The
    // times go in the line, never the reason, which has to match exactly to
    // be written once a visit.
    for (const row of pending) recordSkipOncePerVisit(runs, row, task.id, visitStartedAt, CARRIED_IN_TURN_REASON);
    console.log(
      `[turn-end] Skipped a carried-in turn for task ${task.id.slice(0, 8)} in ${column.name}: `
      + `the turn began ${new Date(payload.turnStartedAt).toISOString()}, before the ${visit.origin} move at ${visit.at}.`,
    );
    return;
  }
  // The drain of a turn the held pass judged: the step was the held pass's.
  const stepRuns = stepApplies && !drainOfHeld;
  if (drainOfHeld && stepApplies && task.workflow_id) {
    noteHeldTurnDrained(
      context,
      { projectId: payload.projectId, taskId: task.id, sessionId: payload.sessionId, columnId: column.id, workflowId: task.workflow_id },
    );
  }
  // Off a workflow, the pass ends by asking whether the board stopped the card,
  // even with no row left to run: a spent row is exactly that case. A paused
  // task's rows are off by a person's choice, so nothing stopped it. A paused
  // workflow's task is no exception to the workflow's own rule: its step and
  // recovery read it again at the Resume, so a stop written here would outlast it.
  const judgesStop = !stepApplies && taskRunnability.ok && !isTaskWorkflowPaused(task, payload.projectId);
  if (pending.length === 0 && !stepRuns && !judgesStop) return;

  const controller = new AbortController();
  const releaseGroup = trackTurnEndGroup(task.id, controller);
  try {
    // The turn's bytes may still be landing: wait out the CLI's last paint.
    const settled = await waitForTurnCompletion(context.sessionManager, payload.sessionId, { signal: controller.signal, acceptHeld: held });
    const outcome = turnSettled(context, payload, settled, `in ${column.name}`, held);
    if (outcome === 'busy') {
      for (const row of pending) recordSkipOncePerVisit(runs, row, task.id, visitStartedAt, AGENT_NOT_IDLE_REASON);
      return;
    }
    if (outcome === 'newer') {
      abandonForNewerWork(context, request, column.id);
      return;
    }
    if (outcome === 'stop') return;

    // One read of the agent's final reply, shared by the rows and the step.
    const sessionRepo = new SessionRepository(getProjectDb(payload.projectId));
    let replyRead: Promise<string | null> | null = null;
    const readReply = (): Promise<string | null> => {
      replyRead ??= readAgentReply(payload, sessionRepo);
      return replyRead;
    };

    const rowsOutcome = pending.length > 0
      ? await runRows(context, payload, {
        task, column, repos, sessionRepo, pending, visitStartedAt, controller, readReply,
        acceptHeld: held,
        holdMovesForBackgroundWork: stepApplies,
      })
      : { messagedAgent: false, newerTurn: false, heldMove: false };
    // The workflow's own step comes after the column's rows: a row that moved
    // the task leaves the step nothing to do, and the step reads where the task
    // is now. A row that gave the agent a message started its next turn, so this
    // turn end gets no workflow decision; the turn that answers the message does.
    // A newer turn abandons the whole pass, the step's paid check included.
    // Rows that ran are not run again if the pass is judged after all: each
    // runs once a visit.
    // A row whose move was held stands in for the move: the step has nothing
    // to add, and recovery nudges about the work that holds it.
    // A held wake that only repeats this visit's `working` verdict (a
    // background job's event answered with the same last line) pays for no
    // second check: it could only answer the same.
    const repeatsWorking = held && stepRuns
      && repeatsWorkingVerdict(task.id, column.id, finalMatchLine(await readReply()));
    if (repeatsWorking) {
      console.log(`[turn-end] Task ${task.id.slice(0, 8)}'s held turn repeats its working verdict in ${column.name}; not judged again.`);
    }
    // A held pass that got this far judged the turn, unless the step it owed
    // went unanswered (the turn busy again, the pass aborted).
    let judgedHeldTurn = held;
    if (rowsOutcome.newerTurn) {
      abandonForNewerWork(context, request, column.id);
    } else if (stepRuns && !repeatsWorking && !rowsOutcome.messagedAgent && !rowsOutcome.heldMove) {
      judgedHeldTurn = false;
      if (!controller.signal.aborted) {
        const step = await runWorkflowStep(context, {
          payload,
          columnId: column.id,
          signal: controller.signal,
          readAgentReply: readReply,
          acceptHeld: held,
        });
        if (step === 'newer-turn') abandonForNewerWork(context, request, column.id);
        else if (step) {
          judgedHeldTurn = held;
          handOnStepVerdict(context, payload, task, column.id, step);
        }
      }
    } else if (judgesStop && !rowsOutcome.messagedAgent && !controller.signal.aborted) {
      await judgeColumnStop({
        taskId: task.id,
        swimlaneId: column.id,
        rows: rows.filter((row) => automationRegistry.get(row.type) !== undefined && canColumnRun(row.type, facts, 'turn_end').ok),
        runs,
        visitStartedAt,
        readReply,
        check: (conditionRows, askNeedsAPerson) => checkColumnStop(context, payload, subject, readReply(), conditionRows, askNeedsAPerson, controller.signal),
        stillCurrent: () => isTurnStillCurrent(context, payload, column.id) && !controller.signal.aborted,
      });
    }
    if (judgedHeldTurn) heldPassesServed.set(payload.sessionId, payload.workSerial);
  } finally {
    releaseGroup();
    clearSpawnProgress(context.mainWindow, task.id);
    refreshStoppedMark(context, payload.projectId, task.id);
  }
}

/** Is this the session's latest turn, settled, with the task still in the column? */
function isTurnStillCurrent(context: IpcContext, payload: TurnEndedPayload, columnId: string): boolean {
  return resolveSubject(context, payload)?.column.id === columnId
    && context.sessionManager.isLatestTurn(payload.sessionId, payload.workSerial)
    && isTurnSettled(context.sessionManager, payload.sessionId);
}

/** The one model call `judgeColumnStop` makes: a spent row's Conditions and the built-in question. */
async function checkColumnStop(
  context: IpcContext,
  payload: TurnEndedPayload,
  subject: TurnEndSubject,
  reply: Promise<string | null>,
  conditionRows: ColumnAutomation[],
  askNeedsAPerson: boolean,
  signal: AbortSignal,
): Promise<ConditionCheckOutcome> {
  const { task, column, repos } = subject;
  const projectPath = context.projectRepo.getById(payload.projectId)?.path ?? null;
  const engine = createTransitionEngine(
    context, repos.automations, repos.automationRuns, repos.tasks, new SessionRepository(getProjectDb(payload.projectId)), repos.attachments,
    payload.projectId, projectPath,
  );
  const agentReply = await reply;
  const templateVars = engine.resolveGroupTemplateVars(task, column, 'turn_end', { agentReply });
  const input = engine.conditionCheckInput(task, column, 'turn_end', conditionRows, templateVars, { agentReply });
  const rows = askNeedsAPerson
    ? [...input.rows, { automationId: NEEDS_A_PERSON_CHECK_ID, name: 'Needs a person', condition: NEEDS_A_PERSON_CONDITION }]
    : input.rows;
  return engine.checkConditions({ ...input, rows }, { signal }, engine.conditionCheckCall(task, column));
}

/** Hold a released move again, unless a newer hold or a stopped recovery replaced it. */
function restoreHeldMove(taskId: string, heldMove: HeldMove): void {
  if (getHeldMove(taskId) === undefined && getRecoveryEntry(taskId) !== undefined) setHeldMove(taskId, heldMove);
}

/**
 * A move this visit held on background work its agent left (`HeldMove`). At a
 * turn end with that work still open it stays held, and recovery's schedule
 * nudges again. With none open it runs now, whatever the reply says: the
 * reply answers the nudge about that work and need not repeat the exit line.
 * A reply that ends on `Needs owner:` is the one exception: the held move is
 * dropped and the step judges the reply, which waits on the owner.
 * `'judge'` hands the turn end to the ordinary pass.
 */
async function settleHeldMove(
  context: IpcContext,
  request: PassRequest,
  subject: TurnEndSubject,
  heldMove: HeldMove,
): Promise<'judge' | 'handled'> {
  const { payload } = request;
  const { task, column, repos } = subject;
  if (heldMoveReason(context, payload.sessionId) !== null) return 'handled';
  const acceptHeld = request.held === true;
  const controller = new AbortController();
  const releaseGroup = trackTurnEndGroup(task.id, controller);
  try {
    const settled = await waitForTurnCompletion(context.sessionManager, payload.sessionId, { signal: controller.signal, acceptHeld });
    const outcome = turnSettled(context, payload, settled, `in ${column.name}`, acceptHeld);
    if (outcome === 'newer') abandonForNewerWork(context, request, column.id);
    if (outcome !== 'go') return 'handled';
    const sessionRepo = new SessionRepository(getProjectDb(payload.projectId));
    const reply = await readAgentReply(payload, sessionRepo);
    if (controller.signal.aborted) return 'handled';
    clearHeldMove(task.id);
    if (needsOwnerQuestion(reply) !== null) return 'judge';
    console.log(`[turn-end] Running task ${task.id.slice(0, 8)}'s held move in ${column.name}: the background work that held it has ended.`);
    try {
      if (heldMove.kind === 'step') {
        const step = await runWorkflowStep(context, {
          payload,
          columnId: column.id,
          signal: controller.signal,
          readAgentReply: async () => reply,
          acceptHeld,
          releaseHeldMove: true,
        });
        if (step === 'newer-turn') abandonForNewerWork(context, request, column.id);
        else if (step) handOnStepVerdict(context, payload, task, column.id, step);
        // A release that did not run the move (the turn busy again, the move
        // failed) holds it again: judged anew, a reply that answered the nudge
        // and did not repeat the exit line reads as not done.
        if (step === undefined || (step !== 'newer-turn' && step.verdict === 'move-failed')) restoreHeldMove(task.id, heldMove);
        return 'handled';
      }
      const row = repos.automations.getForTrigger(column.id, 'turn_end').find((candidate) => candidate.id === heldMove.rowId);
      // The row was deleted since: the ordinary pass judges the reply.
      if (!row) return 'judge';
      const outcomeOfRows = await runRows(context, payload, {
        task,
        column,
        repos,
        sessionRepo,
        pending: [row],
        visitStartedAt: repos.taskMoves.visitStartedAt(task.id, column.id),
        controller,
        readReply: async () => reply,
        acceptHeld,
        holdMovesForBackgroundWork: true,
        releaseHeldMoves: new Set([row.id]),
      });
      if (outcomeOfRows.newerTurn) abandonForNewerWork(context, request, column.id);
      // The row did not move the task (skipped, or its move failed): held again.
      else if (repos.tasks.getById(task.id)?.swimlane_id === column.id) restoreHeldMove(task.id, heldMove);
      return 'handled';
    } catch (error) {
      restoreHeldMove(task.id, heldMove);
      throw error;
    }
  } finally {
    releaseGroup();
    clearSpawnProgress(context.mainWindow, task.id);
  }
}

/**
 * A resume's catch-up: the workflow step on the reply no step check judged. A
 * check that answered wrote its row after the reply, so the reply is unjudged
 * when it is from this visit and no step row follows it. Never the column's
 * rows: they answer a turn end, and a resume ends no turn.
 */
async function runCatchUp(context: IpcContext, payload: TurnEndedPayload, resumedBy: SessionResumer): Promise<void> {
  // The cheap gate first: most resumed tasks are in no workflow.
  let repos: ReturnType<typeof getProjectRepos>;
  try {
    repos = getProjectRepos(context, payload.projectId);
  } catch {
    return;
  }
  const resumedTask = repos.tasks.getById(payload.taskId);
  if (!resumedTask || resumedTask.archived_at || !workflowStepApplies(resumedTask, payload.projectId)) return;

  const controller = new AbortController();
  const releaseGroup = trackTurnEndGroup(payload.taskId, controller);
  try {
    // The resume repaints the conversation: wait for it to settle idle. Work
    // begun since the resume is a turn of its own, which its turn end judges,
    // and a session still busy at the give-up has nothing for the step to judge.
    const settled = await waitForTurnCompletion(context.sessionManager, payload.sessionId, { signal: controller.signal });
    if (turnSettled(context, payload, settled, 'after its resume') !== 'go') return;
    // Read only now: the resume writes the task's session id after its spawn.
    const subject = resolveSubject(context, payload);
    if (!subject) return;
    const { task, column } = subject;

    const reply = await readSessionFinalReply(payload, new SessionRepository(getProjectDb(payload.projectId)));
    if (!reply || controller.signal.aborted) return;
    // A reply from before the task entered this column was the last column's.
    // This gates on the reply, not the turn, so a plan approval needs no
    // exception here: the implementation reply follows the move, and the plan
    // that precedes it stays out.
    //
    // Both checks below compare the CLI's transcript clock with the app's, the
    // comparison the turn end avoids with its anchor. A resume begins no turn,
    // so it has no anchor to read from. The comparison holds while the CLI
    // writes its transcript on the app's own clock. A transcript locator that
    // reads a WSL guest's home, whose clock can drift minutes, needs these two
    // checks replaced.
    const visitStartedAt = subject.repos.taskMoves.visitStartedAt(task.id, column.id);
    if (visitStartedAt && reply.ts < Date.parse(visitStartedAt)) return;
    if (subject.repos.automationRuns.hasWorkflowStepSince(task.id, column.id, new Date(reply.ts).toISOString())) {
      // Judged before the session went away, and parked since: a restart
      // would otherwise leave it parked for good. Recovery picks up from the
      // run log and judges it again within one step of its schedule, or at
      // once when Kangentic itself brought the agent back.
      if (task.workflow_id) {
        resumeWorkflowRecovery(
          context,
          { projectId: payload.projectId, taskId: task.id, sessionId: payload.sessionId, columnId: column.id, workflowId: task.workflow_id },
          { resumedBy },
        );
      }
      return;
    }

    const step = await runWorkflowStep(context, { payload, columnId: column.id, signal: controller.signal, readAgentReply: async () => reply.text });
    if (step && step !== 'newer-turn') handOnStepVerdict(context, payload, task, column.id, step, resumedBy);
  } finally {
    releaseGroup();
  }
}

/** A recovery attempt, as a pass of its own: a move made meanwhile stops it. */
async function runRecovery(context: IpcContext, payload: TurnEndedPayload): Promise<void> {
  const controller = new AbortController();
  const releaseGroup = trackTurnEndGroup(payload.taskId, controller);
  try {
    await runRecoveryAttempt(context, payload.taskId, controller.signal);
  } finally {
    releaseGroup();
  }
}

/** Hand a step's verdict to recovery, which arms, notifies or stops. */
function handOnStepVerdict(
  context: IpcContext,
  payload: TurnEndedPayload,
  task: Task,
  columnId: string,
  step: WorkflowStepResult,
  resumedBy: SessionResumer = 'user',
): void {
  if (!task.workflow_id) return;
  afterWorkflowStep(
    context,
    { projectId: payload.projectId, taskId: task.id, sessionId: payload.sessionId, columnId, workflowId: task.workflow_id },
    step,
    payload.turnStartedAt,
    { resumedBy },
  );
}

/** The column's pending turn-end rows: one Condition check, a re-check, then the rows. */
async function runRows(
  context: IpcContext,
  payload: TurnEndedPayload,
  input: {
    task: Task;
    column: Swimlane;
    repos: ReturnType<typeof getProjectRepos>;
    sessionRepo: SessionRepository;
    pending: ColumnAutomation[];
    visitStartedAt: string | null;
    controller: AbortController;
    readReply: () => Promise<string | null>;
    /** A held turn end's rows: the session may still be held by the background work its turn left. */
    acceptHeld?: boolean;
    /** A running workflow's task: a move waits while background work its agent left is open. */
    holdMovesForBackgroundWork?: boolean;
    /** Held moves of this visit to run now (`RunAutomationsOptions.releaseHeldMoves`). */
    releaseHeldMoves?: ReadonlySet<string>;
  },
): Promise<{ messagedAgent: boolean; newerTurn: boolean; heldMove: boolean }> {
  const { task, column, repos, sessionRepo, pending, visitStartedAt, controller } = input;
  const none = { messagedAgent: false, newerTurn: false, heldMove: false };
  const runs = repos.automationRuns;
  const project = context.projectRepo.getById(payload.projectId);
  const projectPath = project?.path ?? null;
  const engine = createTransitionEngine(
    context, repos.automations, repos.automationRuns, repos.tasks, sessionRepo, repos.attachments,
    payload.projectId, projectPath,
  );

  // Disabled during the paint wait: decided before the paid check, not after
  // it. The engine's own gate covers a switch thrown during the check itself.
  const latestTaskRunnability = canTaskRunAutomations(repos.tasks.getById(task.id) ?? task);
  if (!latestTaskRunnability.ok) {
    for (const row of pending) recordSkipOncePerVisit(runs, row, task.id, visitStartedAt, englishText(latestTaskRunnability.reason));
    return none;
  }

  const needsReply = pending.some(needsAgentReply);
  const agentReply = needsReply ? await input.readReply() : null;

  // Conditions: one paid check for every pending row whose Condition an agent
  // evaluates. A Text match row never joins it: the runner matches it in code
  // against `agentReply`, so a column of Text match rows makes no call at all.
  const conditional = pending.filter((row) => hasCondition(row));
  const answers = new Map<string, RunConditionAnswer>();
  let conditionUnavailableReason: string | undefined;
  let conditionUnavailableCallId: string | null = null;
  let runnable = pending;
  if (conditional.length > 0) {
    const templateVars = engine.resolveGroupTemplateVars(task, column, 'turn_end', { agentReply });
    // No time limit, since a turn end holds no lock, but a move that supersedes
    // this pass stops the check, so it does not hold a check slot for nothing.
    // Each answer names the call that gave it, so its run row links to it.
    const outcome = await engine.checkConditions(
      engine.conditionCheckInput(task, column, 'turn_end', conditional, templateVars, { agentReply }),
      { signal: controller.signal },
      engine.conditionCheckCall(task, column),
    );
    if (outcome.ok) {
      for (const [automationId, answer] of outcome.answers) answers.set(automationId, answer);
    } else {
      conditionUnavailableReason = outcome.reason;
      conditionUnavailableCallId = outcome.callId ?? null;
      // Recorded once per visit, not at every turn end of a long chat.
      runnable = pending.filter((row) => !hasCondition(row)
        || !runs.hasSkipSince(row.id, task.id, visitStartedAt, outcome.reason));
    }
  }
  if (runnable.length === 0 || controller.signal.aborted) return none;

  // The check can take a while. Run nothing unless the turn it judged is
  // still the latest: same session, same column, no turn begun since, and the
  // agent still idle. Idle alone passes a turn the user began meanwhile that
  // failed or was interrupted back to idle, since neither emits a turn end.
  // The task leaving and a newer turn are silent: the visit is over, or that
  // turn's own end judges it.
  const current = resolveSubject(context, payload);
  if (!current || current.column.id !== column.id) return none;
  if (!context.sessionManager.isLatestTurn(payload.sessionId, payload.workSerial)) {
    return { messagedAgent: false, newerTurn: true, heldMove: false };
  }
  // A row must not land on a running turn or a permission prompt. On the same
  // turn this is the session leaving idle with no work reported, as a
  // permission prompt with no tool hook before it does, and no turn end may
  // follow it, so the rows say why they did not run. A held turn end is over:
  // its agent's Stop landed.
  if (!isTurnSettled(context.sessionManager, payload.sessionId, { acceptHeld: input.acceptHeld })) {
    for (const row of runnable) recordSkipOncePerVisit(runs, row, task.id, visitStartedAt, AGENT_NOT_IDLE_REASON);
    return none;
  }
  // Read now, next to the rows: a move waits while background work is open.
  const holdMoves = input.holdMovesForBackgroundWork ? heldMoveReason(context, payload.sessionId) ?? undefined : undefined;

  let messagedAgent = false;
  const summary = await engine.executeTransition(current.task, column, 'turn_end', {
    // Classified in spawn-entry-point-parity.test.ts: no `startAgent`, so a
    // turn end never spawns; it acts on the agent that just finished.
    signal: controller.signal,
    onlyIds: new Set(runnable.map((row) => row.id)),
    agentReply,
    conditionAnswers: answers,
    conditionUnavailableReason,
    conditionUnavailableCallId,
    deliverToAgent: async (message, mode, runSignal) => {
      await deliverMessageToSession(context, {
        taskId: task.id,
        sessionId: payload.sessionId,
        message,
        mode,
        verifier: resolveInjectionVerifier(current.task.agent, sessionRepo, task.id),
        signal: runSignal,
        acceptHeld: input.acceptHeld,
      });
      // Counted once it landed: a delivery that failed starts no turn.
      messagedAgent = true;
    },
    moveTask: (move) => moveTaskFromRow(context, {
      projectId: payload.projectId,
      projectPath,
      task: current.task,
      fromColumn: column,
      move,
      fromTurnEndGroup: true,
    }),
    showNotification: (notification) => showAutomationNotification(context, notification),
    onProgress: createProgressCallback(context.mainWindow, task.id),
    holdMoves,
    releaseHeldMoves: input.releaseHeldMoves,
  });
  reportAutomationFailures(context, summary, current.task, payload.projectId);
  const heldRow = summary.heldMoveRowId ? runnable.find((row) => row.id === summary.heldMoveRowId) : undefined;
  if (heldRow && current.task.workflow_id) {
    const target = resolveMoveTarget(repos.swimlanes.list(), column.id, automationMoveTargetName(heldRow.type, heldRow.config), routeOf(current.task));
    holdRowMoveForBackgroundWork(
      context,
      { projectId: payload.projectId, taskId: task.id, sessionId: payload.sessionId, columnId: column.id, workflowId: current.task.workflow_id },
      { rowId: heldRow.id, targetName: target.ok ? target.column.name : null, workSerial: payload.workSerial },
    );
  }
  return { messagedAgent, newerTurn: false, heldMove: heldRow !== undefined };
}

/**
 * Whether a pass goes on after its settle wait: `'go'`, `'stop'` with nothing
 * to record, `'newer'` for newer work begun since this turn end, or `'busy'`,
 * which stops it on a turn the column was waiting on.
 *
 * A move that superseded the wait, or a session that exited, stops it. So does
 * work begun since this turn end, settled or not (`'newer'`): its own turn end
 * judges it, and when that work ends with none, the runner may judge this
 * reply after all (`abandonForNewerWork`). That is cheap, so it runs ahead of
 * the paid check, and ahead of the give-up warning, which newer work still
 * running at the give-up would otherwise trip.
 *
 * A wait that ran out with the session idle goes on: the agent's own Stop
 * ended the turn, and what keeps the terminal from staying quiet is the CLI
 * painting, not the turn. The CLI repaints its status line while its own
 * background agents run, and those can run for minutes after the Stop with no
 * `SubagentStart` and no transcript. The repaint rate is measured in
 * docs/architecture/automations/triggers.md, under the turn-end trigger. A pass that dropped
 * the turn there left the rows for a user prompt to bring. Nothing here writes
 * to the terminal: a Condition check reads the transcript, a move needs no
 * terminal, and a message's own delivery waits for its own quiet window and
 * fails loudly.
 *
 * A wait that ran out with the session not idle, on the same turn, is `'busy'`:
 * the session left idle without reporting work, which a permission prompt with
 * no tool hook before it does. Both give-ups write one warning, so they reach
 * the log file without Persist Console Logs.
 */
function turnSettled(
  context: IpcContext,
  payload: TurnEndedPayload,
  settled: TurnCompletionResult,
  where: string,
  acceptHeld = false,
): 'go' | 'stop' | 'newer' | 'busy' {
  if (settled === 'aborted' || settled === 'exited') return 'stop';
  if (!context.sessionManager.isLatestTurn(payload.sessionId, payload.workSerial)) return 'newer';
  if (settled === 'completed') return 'go';
  const activity = context.sessionManager.getActivityCache()[payload.sessionId] ?? 'unknown';
  // A running turn or a permission prompt must stop the pass. A held turn end,
  // for a pass that asked, is over: a CLI painting its background work's status
  // never goes quiet, as below.
  const turnOver = isTurnSettled(context.sessionManager, payload.sessionId, { acceptHeld });
  console.warn(
    `[turn-end] Gave up waiting for task ${payload.taskId.slice(0, 8)}'s turn to settle ${where} `
    + `(session ${payload.sessionId.slice(0, 8)}, activity ${activity}), so `
    + (turnOver ? 'the pass goes on without a quiet terminal.' : 'nothing ran.'),
  );
  return turnOver ? 'go' : 'busy';
}

/**
 * Who moves a task by hand: a drag, a phone, or the agent moving its own task.
 * Wider than a person's move (`isMoveByAPerson`) on purpose, since the agent
 * that planned is the one implementing.
 */
const PLAN_EXIT_MOVE_ORIGINS: ReadonlySet<TaskMoveRecordOrigin> = new Set<TaskMoveRecordOrigin>(['renderer', 'mobile', 'agent']);

/**
 * Whether a turn that began before the task entered this column is this
 * column's work all the same. Two moves make it so, both because the agent
 * implements in the turn that planned:
 *
 * - A plan approval's own move (`auto-move`). The engine re-stamps the turn's
 *   start at the approval, which covers a task dragged in before its plan was
 *   approved, and under a busy task lock the move can be written after that
 *   stamp.
 * - A move by hand from a column into that column's plan exit target, made once
 *   the agent had left plan mode. That is the same plan exit, done by a drag
 *   (kangentic-mobile #119): a plan left in the conversation, not through an
 *   approved ExitPlanMode, gets no re-stamp, so the turn the user started with
 *   "looks good" in Planning ends in Executing. A move made while the agent was still
 *   planning stays carried in: its turn ends on a plan reply, which this
 *   column's rows must not judge. So does a session whose agent reports no mode.
 *
 * The alternative was to exempt the drag whatever the mode. That needs no
 * plumbing, but a drag made mid-plan whose plan the user then rejects would run
 * unconditional rows on that plan reply.
 */
function countsAsThisColumnsTurn(
  context: IpcContext,
  payload: TurnEndedPayload,
  subject: TurnEndSubject,
  visit: TaskVisit,
): boolean {
  const { task, column, repos } = subject;
  if (visit.origin === 'auto-move') return true;
  if (!PLAN_EXIT_MOVE_ORIGINS.has(visit.origin) || visit.from_swimlane_id === null) return false;
  const projectPath = context.projectRepo.getById(payload.projectId)?.path ?? null;
  const target = planExitTargetFor(context, task, visit.from_swimlane_id, repos.swimlanes, projectPath);
  if (target?.id !== column.id) return false;
  return context.sessionManager.hadLeftPlanModeBy(payload.sessionId, Date.parse(visit.at));
}

/**
 * The final reply of the turn that ended, read in the retrieval worker from
 * where the turn began (`payload.transcriptAnchor`) when that is known. Empty
 * on any failure, and when the turn wrote no text of its own.
 */
async function readAgentReply(payload: TurnEndedPayload, sessionRepo: SessionRepository): Promise<string | null> {
  return (await readSessionFinalReply(payload, sessionRepo))?.text ?? null;
}


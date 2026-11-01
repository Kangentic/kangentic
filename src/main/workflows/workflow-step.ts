import type { AutomationRunStatus, Swimlane, Task } from '../../shared/types';
import { automationMovesTask, automationMoveTargetName, canColumnRun, canTaskRunAutomations } from '../../shared/automation-manifest';
import { nextOnRoute } from '../../shared/workflow-route';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { conditionCheckDeps } from '../ipc/helpers/agent-spawn';
import { handleTaskMove } from '../ipc/handlers/task-move';
import type { IpcContext } from '../ipc/ipc-context';
import type { TurnEndedPayload } from '../pty/session-manager';
import { checkAutomationConditions, type ConditionCheckCall } from '../automations/condition-check/condition-check';
import type { ConditionPromptInput, ConditionPromptRow } from '../automations/condition-check/condition-prompt';
import { resolveMoveTarget, routeOf } from '../automations/move-target';
import { hasFinalLine } from '../automations/row-guards';
import {
  describeStepRoute,
  stepExitVerdict,
  workflowBlockerConditions,
  workflowStepCondition,
  type StepExitRow,
  type WorkflowBlocker,
} from './workflow-step-condition';
import { workflowOfTask } from './workflow-home';
import { needsOwnerQuestion } from '../../shared/workflow-needs-owner';

/**
 * A workflow task's own step, at a turn end, after the column's turn-end rows.
 *
 * The column's work is judged by what the agent's turn ended with, never by the
 * column's name, so any board works: the Automation agent answers one built-in
 * condition ("this step's work is done, and the agent is not waiting on the
 * user"), the same check a row's Condition gets. Done moves the task to the next
 * column on its route, through the one move path with origin `'workflow'`. Not
 * done moves nothing: the task stays, idle, which is the board's own Needs you.
 *
 * - It reads where the task is NOW: a row, the agent or a person that already
 *   moved it leaves nothing to do, so a step never moves a task twice.
 * - It runs after every turn end until the task moves (not once per visit, as a
 *   row does): the user can keep talking to the agent, and the turn that
 *   finishes the work is the one that counts.
 * - With no Automation agent set up there is no one to judge, and the column is
 *   a human gate: a person drags the card on (the lock lets that drag through).
 *   It says so in the run log once a visit.
 * - A reply that ends on the `Needs owner:` line waits on the owner, with no
 *   check to pay for (`needsOwnerQuestion`). Whether a stall needs the owner
 *   is the agent's own call (owner's decision, 2026-10-31), and this line is
 *   the only way a workflow task stops and notifies the owner: a change from
 *   the plan, something the owner must weigh in on, or a decision to make.
 * - Not done, with work of the agent's own still open by the hook events (a
 *   background shell it holds, a subagent past its turn end), is still
 *   working. It comes from `SessionManager.getOpenWork`, never from the
 *   reply's wording: one gate read as still running at 04:47 and as not done
 *   at 07:33, with nothing changed but the sentence.
 * - Anything else not done is a stall the caller nudges. A second ask names
 *   what the reply says it is stuck on (`workflowBlockerConditions`), so the
 *   nudge can aim at it. The first ask is never changed by it: it is the
 *   measured one, and only its yes moves the task.
 * - The answer goes to the run log either way (`recordWorkflowStep`), and so
 *   does a check that could not run, which judged nothing and is tried again.
 * - It returns its verdict, so the caller can recover the task when it does not
 *   move on (`workflow-recovery.ts`).
 * - The check is told the route, and at the route's last column it asks only
 *   whether the agent still needs the user (`workflow-step-condition.ts`).
 * - A column's own exit rows (turn-end Move to column rows behind a Text match)
 *   outrank the check's yes (`stepExitVerdict`). A reply whose final line no
 *   forward row matches, or that only a send-back row matches, is not done, and
 *   goes on to the second ask like any other. Task 916 left Code Review on "No
 *   changes to review.", which neither row matched, and the check moved it on.
 *   This holds where no row ran: a resume's catch-up, recovery, a spent row.
 * - It judges the turn its payload names, and acts only while that turn is
 *   still the session's latest (`isLatestTurn`), checked before the check and
 *   again after it. A turn the user began meanwhile can fail or be interrupted
 *   back to idle without a turn end, so idle alone would move the task on the
 *   old turn's answer. A newer turn writes nothing, and the step says so
 *   (`'newer-turn'`), so the runner can judge the reply again if that newer
 *   work ends with no turn end and no reply of its own (`abandoned-turns.ts`).
 */
export const WORKFLOW_STEP_CHECK_ID = 'workflow-step';
/** The second ask's rows, one per blocker it can name (`workflowBlockerConditions`). */
const WORKFLOW_BLOCKER_ROW_ID_PREFIX = 'workflow-step-blocker:';

/**
 * What a step check made of a finished turn.
 * - `done`: judged done, and moved on (or with nowhere left to go, or already
 *   moved elsewhere).
 * - `move-failed`: judged done, but the move threw.
 * - `working`: not done, and work the agent started is still open by its hook
 *   events (a background shell it holds, a background subagent).
 * - `stopped`: not done, with nothing of its own running: the agent is nudged,
 *   at what `blockers` names when the reply named something.
 * - `waiting`: the reply ends on the `Needs owner:` line: only the owner can
 *   settle it.
 * - `check-failed`: the check could not run this time.
 * - `human-gate`: no Automation agent can judge it, so a person moves the card.
 */
export type WorkflowStepVerdict = 'done' | 'move-failed' | 'working' | 'stopped' | 'waiting' | 'check-failed' | 'human-gate';

export interface WorkflowStepResult {
  verdict: WorkflowStepVerdict;
  /** The check's reason, which a nudge or a notice repeats. */
  reason: string | null;
  /** The turn the verdict judged (`TurnEndedPayload.workSerial`). */
  workSerial: number;
  /** A human gate's first word this visit, which is when it gets its notice. */
  firstThisVisit?: boolean;
  /** On `stopped`: what the reply says the agent is stuck on, for the nudge to aim at. */
  blockers?: WorkflowBlocker[];
}

/** The base branch a task's agent compares against, as the nudge and the blocker row name it. */
export function taskBaseBranch(task: Pick<Task, 'resolved_base_branch' | 'base_branch'>): string {
  return task.resolved_base_branch ?? task.base_branch ?? 'the base branch';
}

/**
 * Work the agent left running that it will come back to, by its hook events:
 * a held background shell, or a subagent still running past its turn end.
 * A one-line description for the run log, or null when there is none.
 */
function openBackgroundWork(context: IpcContext, sessionId: string): string | null {
  const openWork = context.sessionManager.getOpenWork(sessionId);
  const shell = openWork.backgroundShells[0];
  if (shell) {
    const command = shell.command ? `: ${shell.command.replace(/\s+/g, ' ').slice(0, 120)}` : '';
    return `a background command is still running${command}`;
  }
  const subagent = openWork.backgroundSubagents[0];
  if (subagent) return `a background ${subagent.type ?? 'subagent'} is still running`;
  return null;
}

/**
 * Does this task's turn end get a workflow step check? Cheap: one row read. Not
 * while the task's own automations are paused: a person is working it by hand,
 * so its workflow neither judges, nudges nor moves it, and its recovery stops.
 */
export function workflowStepApplies(task: Pick<Task, 'workflow_id' | 'workflow_project_id' | 'automations_disabled'>, projectId: string): boolean {
  if (!task.workflow_id || !canTaskRunAutomations(task).ok) return false;
  try {
    return workflowOfTask(task, projectId)?.state === 'running';
  } catch {
    return false;
  }
}

/**
 * The column's exit rows: its enabled turn-end rows that move the task behind a
 * Text match, each with the column it sends the task to, resolved as the row's
 * own move resolves it (`move-from-row.ts`). The filter is the turn-end
 * runner's own (`automation-runner.ts`: a Text match, `canColumnRun`), less
 * Frequency and Condition, which decide whether a row runs, not where it sends
 * the task. A spent forward row still says what finishes the step, and the step
 * is what moves the task on once the row no longer can.
 */
function columnExitRows(repos: ReturnType<typeof getProjectRepos>, columns: readonly Swimlane[], column: Swimlane, task: Task): StepExitRow[] {
  const facts = { autoSpawn: column.auto_spawn, role: column.role };
  const exitRows: StepExitRow[] = [];
  for (const row of repos.automations.getForTrigger(column.id, 'turn_end')) {
    if (!hasFinalLine(row) || !automationMovesTask(row.type) || !canColumnRun(row.type, facts, 'turn_end').ok) continue;
    const target = resolveMoveTarget(columns, column.id, automationMoveTargetName(row.type, row.config), routeOf(task));
    exitRows.push({ finalLine: row.final_line, target: target.ok ? target.column : null });
  }
  return exitRows;
}

export async function runWorkflowStep(
  context: IpcContext,
  input: {
    payload: TurnEndedPayload;
    columnId: string;
    signal: AbortSignal;
    /** The agent's final reply: what the turn-end rows already read, or read now. */
    readAgentReply: () => Promise<string | null>;
  },
): Promise<WorkflowStepResult | 'newer-turn' | undefined> {
  const { payload } = input;
  const current = (): { task: Task; column: Swimlane } | null => {
    const repos = getProjectRepos(context, payload.projectId);
    const task = repos.tasks.getById(payload.taskId);
    if (!task || task.archived_at || !task.workflow_id) return null;
    if (task.session_id !== payload.sessionId || task.swimlane_id !== input.columnId) return null;
    const column = repos.swimlanes.getById(task.swimlane_id);
    return column ? { task, column } : null;
  };

  /**
   * Where the turn this step judges stands: still the session's latest with
   * the agent idle on it, still the latest but not idle, or overtaken by
   * newer work.
   */
  const turnState = (): 'idle' | 'busy' | 'newer-turn' => {
    if (!context.sessionManager.isLatestTurn(payload.sessionId, payload.workSerial)) return 'newer-turn';
    // activity-state-ok: granular, the step judges a finished turn, never a
    // running one or a permission prompt.
    return context.sessionManager.getActivityCache()[payload.sessionId] === 'idle' ? 'idle' : 'busy';
  };

  const subject = current();
  if (!subject || !workflowStepApplies(subject.task, payload.projectId)) return;
  const before = turnState();
  if (before === 'newer-turn') return before;
  if (before === 'busy') return;

  const agentReply = await input.readAgentReply();
  if (input.signal.aborted) return;
  const { task, column } = subject;
  const repos = getProjectRepos(context, payload.projectId);
  const route = describeStepRoute(repos.swimlanes.list(), task, column.id);
  const deps = conditionCheckDeps(context, context.projectRepo.getById(payload.projectId)?.path ?? null);
  const call: ConditionCheckCall = { projectId: payload.projectId, taskId: task.id, swimlaneId: column.id, job: 'workflow_step' };
  const ask = (rows: ConditionPromptRow[]): ConditionPromptInput => ({
    task: { title: task.title, description: task.description, labels: task.labels, prUrl: task.pr_url, prState: task.pr_state, prMergeReadiness: task.pr_merge_readiness },
    column: column.name,
    trigger: 'turn_end',
    move: null,
    agentReply,
    rows,
  });
  const result = (verdict: WorkflowStepVerdict, reason: string | null, extra: Pick<WorkflowStepResult, 'firstThisVisit' | 'blockers'> = {}): WorkflowStepResult => (
    { verdict, reason, workSerial: payload.workSerial, ...extra }
  );
  const record = (row: {
    met: boolean | null;
    reason: string | null;
    detail: string;
    backgroundCallId?: string | null;
    unjudgedStatus?: Extract<AutomationRunStatus, 'failed' | 'skipped'>;
  }): void => {
    try {
      repos.automationRuns.recordWorkflowStep({ taskId: task.id, swimlaneId: column.id, workflowId: task.workflow_id!, ...row });
    } catch (error) {
      console.warn('[WORKFLOW] Could not record the step check:', error);
    }
  };

  /**
   * After a check, which takes a while: act only if the turn it judged is
   * still the latest, the task is still in the column and the workflow still
   * running. A Pause pressed meanwhile stops the move.
   */
  const settled = (): { task: Task } | 'newer-turn' | null => {
    const after = current();
    if (!after || after.column.id !== column.id) return null;
    if (!workflowStepApplies(after.task, payload.projectId)) return null;
    const afterCheck = turnState();
    if (afterCheck === 'newer-turn') return afterCheck;
    if (afterCheck === 'busy') return null;
    return { task: after.task };
  };

  // The agent's own word that only the owner can settle it: the one wait that
  // stops a workflow task and notifies the owner. Read in code, so it costs no
  // check and no check can overrule it.
  const ownerQuestion = needsOwnerQuestion(agentReply);
  if (ownerQuestion !== null) {
    // The reply read can take a while: a turn the user started meanwhile, a
    // move or a Pause owns what happens next, as after a check.
    const afterRead = settled();
    if (afterRead === null) return;
    if (afterRead === 'newer-turn') return afterRead;
    const waitingReason = ownerQuestion || 'the agent needs the owner to decide something.';
    record({ met: false, reason: null, detail: `Waiting on you: ${waitingReason}` });
    return result('waiting', waitingReason);
  }

  const outcome = await checkAutomationConditions(
    deps,
    ask([{ automationId: WORKFLOW_STEP_CHECK_ID, name: 'Step done', condition: workflowStepCondition(column, route) }]),
    { signal: input.signal },
    call,
  );
  if (input.signal.aborted) return;
  const after = settled();
  if (after === null) return;
  if (after === 'newer-turn') return after;

  if (!outcome.ok) {
    // The task moved on, and the move owns what happens next.
    if (outcome.cause === 'stopped') return;
    const detail = `The step check could not run: ${outcome.reason}`;
    if (outcome.cause === 'unavailable') {
      // No Automation agent: a human gate. Said once a visit, not at every
      // turn end of a long chat.
      const visitStartedAt = repos.taskMoves.visitStartedAt(task.id, column.id);
      const firstThisVisit = !repos.automationRuns.hasWorkflowStepDetailSince(task.id, column.id, visitStartedAt, detail);
      if (firstThisVisit) record({ met: null, reason: outcome.reason, detail, unjudgedStatus: 'skipped' });
      return result('human-gate', outcome.reason, { firstThisVisit });
    }
    record({ met: null, reason: outcome.reason, detail, backgroundCallId: outcome.callId ?? null, unjudgedStatus: 'failed' });
    return result('check-failed', outcome.reason);
  }

  const checked = outcome.answers.get(WORKFLOW_STEP_CHECK_ID) ?? { met: false, reason: 'No answer.' };
  // Read after the check, so a column added or renamed during it counts, and
  // only on a yes: a no never moves the task. The exit rows and the move share it.
  const columns = checked.met ? repos.swimlanes.list() : [];
  // The column's own exit rows outrank the check's yes: a reply none of them
  // moves forward is not done, whatever the check made of it.
  const exits = checked.met ? stepExitVerdict(column, columnExitRows(repos, columns, column, after.task), agentReply) : null;
  const answer = exits && !exits.accepted ? { ...checked, met: false, reason: exits.reason } : checked;
  // The call that gave this answer: a retry's, when the first reply skipped it.
  const answerCallId = answer.callId ?? outcome.callId;
  if (!answer.met) return judgeWhyNotDone();

  const next = nextOnRoute(columns, after.task, column.id);
  if (!next) {
    record({ met: true, reason: answer.reason, detail: 'Done, with nowhere left to go on this board.', backgroundCallId: answerCallId });
    return result('done', answer.reason);
  }
  const projectPath = context.projectRepo.getById(payload.projectId)?.path ?? null;
  // Recorded once the move has an outcome, so the log never says a task moved
  // when the move was refused. Either way the row marks this reply as judged.
  try {
    await handleTaskMove(
      context,
      { taskId: task.id, targetSwimlaneId: next.id, targetPosition: repos.tasks.list(next.id).length },
      'workflow',
      payload.projectId,
      projectPath,
      // The step runs inside the turn-end group, which its own move must not stop.
      { moveReason: 'Step done', fromTurnEndGroup: true },
    );
  } catch (error) {
    // Paused while the move waited for the task lock, which then refused the
    // workflow's own move: the Pause working, as `settled` reads one pressed
    // during the check. Nothing is recorded, so the reply is judged again
    // after Resume.
    if (!workflowStepApplies(task, payload.projectId)) return;
    const message = error instanceof Error ? error.message : String(error);
    record({ met: true, reason: answer.reason, detail: `Step done, but the move to ${next.name} failed: ${message}`, backgroundCallId: answerCallId });
    // Logged here, not thrown: the caller retries the move on recovery's schedule.
    console.error(`[WORKFLOW] Task ${task.id.slice(0, 8)}'s step was done, but its move to ${next.name} failed:`, error);
    return result('move-failed', `the move to ${next.name} failed: ${message}`);
  }
  // A move a newer one superseded returns without moving the task.
  if (repos.tasks.getById(task.id)?.swimlane_id !== next.id) {
    record({ met: true, reason: answer.reason, detail: `Step done, but the task was moved elsewhere before it reached ${next.name}.`, backgroundCallId: answerCallId });
    return result('done', answer.reason);
  }
  record({
    met: true,
    reason: answer.reason,
    detail: next.role === 'done' ? 'Step done. The route is finished, so the task moved to Done.' : `Step done. Moved on to ${next.name}.`,
    backgroundCallId: answerCallId,
  });
  return result('done', answer.reason);

  /**
   * Not done. Work of the agent's own still open by its hook events is still
   * working, with no second call. Anything else is a stall the caller nudges,
   * and a second ask names what the reply says it is stuck on, so the nudge can
   * aim at it. A turn that wrote no reply named nothing (a failed turn, a crash
   * mid-tool), so it is a plain stall, with no second call either.
   */
  async function judgeWhyNotDone(): Promise<WorkflowStepResult | 'newer-turn' | undefined> {
    const notDone = answer.reason ?? 'the agent is not finished.';
    const stillRunning = openBackgroundWork(context, payload.sessionId);
    if (stillRunning) {
      record({ met: false, reason: answer.reason, detail: `Not done yet, still working: ${stillRunning}.`, backgroundCallId: answerCallId });
      return result('working', answer.reason);
    }
    if (!agentReply?.trim()) {
      record({ met: false, reason: answer.reason, detail: `Not done yet: ${notDone}`, backgroundCallId: answerCallId });
      return result('stopped', answer.reason, { blockers: [] });
    }
    const blockerRows = workflowBlockerConditions(column, taskBaseBranch(task));
    const why = await checkAutomationConditions(deps, ask(blockerRows.map((row) => ({
      automationId: `${WORKFLOW_BLOCKER_ROW_ID_PREFIX}${row.blocker}`,
      name: `Blocker: ${row.blocker}`,
      condition: row.condition,
    }))), { signal: input.signal }, call);
    if (input.signal.aborted) return;
    const afterWhy = settled();
    if (afterWhy === null) return;
    if (afterWhy === 'newer-turn') return afterWhy;
    // A blocker check that could not run still leaves a stall to nudge: the
    // general nudge, rather than no nudge at all.
    const blockers = why.ok
      ? blockerRows.filter((row) => why.answers.get(`${WORKFLOW_BLOCKER_ROW_ID_PREFIX}${row.blocker}`)?.met).map((row) => row.blocker)
      : [];
    if (!why.ok && why.cause === 'stopped') return;
    const named = blockers.length > 0 ? ` Stuck on: ${blockers.join(', ')}.` : '';
    record({ met: false, reason: answer.reason, detail: `Not done yet: ${notDone}${named}`, backgroundCallId: answerCallId });
    return result('stopped', answer.reason, { blockers });
  }
}

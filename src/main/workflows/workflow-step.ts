import type { AutomationRunStatus, Swimlane, Task } from '../../shared/types';
import { canTaskRunAutomations } from '../../shared/automation-manifest';
import { nextOnRoute } from '../../shared/workflow-route';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { conditionCheckDeps } from '../ipc/helpers/agent-spawn';
import { handleTaskMove } from '../ipc/handlers/task-move';
import type { IpcContext } from '../ipc/ipc-context';
import type { TurnEndedPayload } from '../pty/session-manager';
import { checkAutomationConditions, type ConditionCheckCall } from '../automations/condition-check/condition-check';
import type { ConditionPromptInput, ConditionPromptRow } from '../automations/condition-check/condition-prompt';
import {
  describeStepRoute,
  workflowStepCondition,
  workflowStepNeedsUserCondition,
  workflowStepRunningCondition,
} from './workflow-step-condition';
import { workflowOfTask } from './workflow-home';

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
 * - Not done gets a second ask, of why the agent stopped
 *   (`workflowStepNeedsUserCondition`, `workflowStepRunningCondition`): a wait
 *   on the user, work still running, or, when it is neither or the check is
 *   unsure, a stall the caller nudges. The workflow stops only on the first.
 *   The first ask is never changed by it: it is the measured one, and only its
 *   yes moves the task.
 * - The answer goes to the run log either way (`recordWorkflowStep`), and so
 *   does a check that could not run, which judged nothing and is tried again.
 * - It returns its verdict, so the caller can recover the task when it does not
 *   move on (`workflow-recovery.ts`).
 * - The check is told the route, and at the route's last column it asks only
 *   whether the agent still needs the user (`workflow-step-condition.ts`).
 * - It judges the turn its payload names, and acts only while that turn is
 *   still the session's latest (`isLatestTurn`), checked before the check and
 *   again after it. A turn the user began meanwhile can fail or be interrupted
 *   back to idle without a turn end, so idle alone would move the task on the
 *   old turn's answer. A newer turn writes nothing, and the step says so
 *   (`'newer-turn'`), so the runner can judge the reply again if that newer
 *   work ends with no turn end and no reply of its own (`abandoned-turns.ts`).
 */
export const WORKFLOW_STEP_CHECK_ID = 'workflow-step';
const WORKFLOW_STEP_NEEDS_USER_ID = 'workflow-step-needs-user';
const WORKFLOW_STEP_RUNNING_ID = 'workflow-step-running';

/**
 * What a step check made of a finished turn.
 * - `done`: judged done, and moved on (or with nowhere left to go, or already
 *   moved elsewhere).
 * - `move-failed`: judged done, but the move threw.
 * - `working`: not done, and work the agent started is still running.
 * - `stopped`: not done, with nothing shown to wait on: the agent is nudged.
 * - `waiting`: not done, and the agent needs a decision, information or access
 *   only the user can give.
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
  const result = (verdict: WorkflowStepVerdict, reason: string | null, extra: Pick<WorkflowStepResult, 'firstThisVisit'> = {}): WorkflowStepResult => (
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

  const answer = outcome.answers.get(WORKFLOW_STEP_CHECK_ID) ?? { met: false, reason: 'No answer.' };
  // The call that gave this answer: a retry's, when the first reply skipped it.
  const answerCallId = answer.callId ?? outcome.callId;
  if (!answer.met) return judgeWhyNotDone();

  const next = nextOnRoute(repos.swimlanes.list(), after.task, column.id);
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
   * Not done: ask why it stopped, so the caller can tell work still running,
   * a stall it can nudge, and a wait on the user apart. A turn that wrote no
   * reply asked nothing (a failed turn, a crash mid-tool), so it is a stall,
   * with no second call.
   */
  async function judgeWhyNotDone(): Promise<WorkflowStepResult | 'newer-turn' | undefined> {
    const notDone = answer.reason ?? 'the agent is not finished.';
    if (!agentReply?.trim()) {
      record({ met: false, reason: answer.reason, detail: `Not done yet: ${notDone}`, backgroundCallId: answerCallId });
      return result('stopped', answer.reason);
    }
    const why = await checkAutomationConditions(deps, ask([
      { automationId: WORKFLOW_STEP_NEEDS_USER_ID, name: 'Needs the user', condition: workflowStepNeedsUserCondition(column) },
      { automationId: WORKFLOW_STEP_RUNNING_ID, name: 'Still running', condition: workflowStepRunningCondition(column) },
    ]), { signal: input.signal }, call);
    if (input.signal.aborted) return;
    const afterWhy = settled();
    if (afterWhy === null) return;
    if (afterWhy === 'newer-turn') return afterWhy;
    if (!why.ok) {
      if (why.cause === 'stopped') return;
      // The step is judged not done, so the reply is judged; why it stopped is
      // asked again on recovery's next try.
      record({
        met: false,
        reason: answer.reason,
        detail: `Not done yet: ${notDone} Why it stopped could not be checked: ${why.reason}`,
        backgroundCallId: answerCallId,
      });
      return result('check-failed', why.reason);
    }
    const needsUser = why.answers.get(WORKFLOW_STEP_NEEDS_USER_ID);
    if (needsUser?.met) {
      const waitingReason = needsUser.reason ?? answer.reason;
      record({ met: false, reason: answer.reason, detail: `Waiting on you: ${waitingReason ?? 'the agent asked something.'}`, backgroundCallId: answerCallId });
      return result('waiting', waitingReason);
    }
    const running = why.answers.get(WORKFLOW_STEP_RUNNING_ID);
    if (running?.met) {
      record({ met: false, reason: answer.reason, detail: `Not done yet, still working: ${running.reason ?? notDone}`, backgroundCallId: answerCallId });
      return result('working', running.reason ?? answer.reason);
    }
    // Anything the check could not show as a wait on the user or on running
    // work is a stall: unsure, it carries on.
    record({ met: false, reason: answer.reason, detail: `Not done yet: ${notDone}`, backgroundCallId: answerCallId });
    return result('stopped', answer.reason);
  }
}

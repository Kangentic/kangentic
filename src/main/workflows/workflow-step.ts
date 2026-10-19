import type { Swimlane, Task } from '../../shared/types';
import { nextOnRoute } from '../../shared/workflow-route';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { conditionCheckDeps } from '../ipc/helpers/agent-spawn';
import { handleTaskMove } from '../ipc/handlers/task-move';
import type { IpcContext } from '../ipc/ipc-context';
import type { TurnEndedPayload } from '../pty/session-manager';
import { checkAutomationConditions } from '../automations/condition-check/condition-check';
import { describeStepRoute, workflowStepCondition } from './workflow-step-condition';
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
 * - The answer goes to the run log either way (`recordWorkflowStep`).
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

/** Does this task's turn end get a workflow step check? Cheap: one row read. */
export function workflowStepApplies(task: Pick<Task, 'workflow_id' | 'workflow_project_id'>, projectId: string): boolean {
  if (!task.workflow_id) return false;
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
): Promise<'newer-turn' | undefined> {
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
  const route = describeStepRoute(getProjectRepos(context, payload.projectId).swimlanes.list(), task, column.id);
  const outcome = await checkAutomationConditions(conditionCheckDeps(context), {
    task: { title: task.title, description: task.description, labels: task.labels, prUrl: task.pr_url, prState: task.pr_state, prMergeReadiness: task.pr_merge_readiness },
    column: column.name,
    trigger: 'turn_end',
    move: null,
    agentReply,
    rows: [{ automationId: WORKFLOW_STEP_CHECK_ID, name: 'Step done', condition: workflowStepCondition(column, route) }],
  }, { signal: input.signal }, { projectId: payload.projectId, taskId: task.id, swimlaneId: column.id, job: 'workflow_step' });
  // No Automation agent, or it could not run: a human gate until one can.
  if (!outcome.ok) return;
  if (input.signal.aborted) return;

  // The check took a while. Act only if the turn it judged is still the latest,
  // and the workflow is still running: a Pause pressed meanwhile stops the move.
  const after = current();
  if (!after || after.column.id !== column.id) return;
  if (!workflowStepApplies(after.task, payload.projectId)) return;
  const afterCheck = turnState();
  if (afterCheck === 'newer-turn') return afterCheck;
  if (afterCheck === 'busy') return;

  const answer = outcome.answers.get(WORKFLOW_STEP_CHECK_ID) ?? { met: false, reason: 'No answer.' };
  const repos = getProjectRepos(context, payload.projectId);
  const record = (met: boolean, detail: string): void => {
    try {
      repos.automationRuns.recordWorkflowStep({
        taskId: task.id,
        swimlaneId: column.id,
        workflowId: task.workflow_id!,
        met,
        reason: answer.reason,
        detail,
        // The call that gave this answer: a retry's, when the first reply skipped it.
        backgroundCallId: answer.callId ?? outcome.callId,
      });
    } catch (error) {
      console.warn('[WORKFLOW] Could not record the step check:', error);
    }
  };
  if (!answer.met) {
    record(false, route.isLast
      ? `Waiting on you: ${answer.reason ?? 'the agent asked something.'}`
      : `Not done yet: ${answer.reason ?? 'the agent is not finished.'}`);
    return;
  }

  const next = nextOnRoute(repos.swimlanes.list(), after.task, column.id);
  if (!next) {
    record(true, 'Done, with nowhere left to go on this board.');
    return;
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
    record(true, `Step done, but the move to ${next.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  // A move a newer one superseded returns without moving the task.
  if (repos.tasks.getById(task.id)?.swimlane_id !== next.id) {
    record(true, `Step done, but the task was moved elsewhere before it reached ${next.name}.`);
    return;
  }
  record(true, next.role === 'done' ? 'Step done. The route is finished, so the task moved to Done.' : `Step done. Moved on to ${next.name}.`);
}

import type { Swimlane, Task } from '../../shared/types';
import { nextOnRoute } from '../../shared/workflow-route';
import { getProjectDb } from '../db/database';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { conditionCheckDeps } from '../ipc/helpers/agent-spawn';
import { handleTaskMove } from '../ipc/handlers/task-move';
import type { IpcContext } from '../ipc/ipc-context';
import type { TurnEndedPayload } from '../pty/session-manager';
import { checkAutomationConditions } from '../automations/condition-check/condition-check';
import { describeStepRoute, workflowStepCondition } from './workflow-step-condition';

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
 */
export const WORKFLOW_STEP_CHECK_ID = 'workflow-step';

/** Does this task's turn end get a workflow step check? Cheap: one row read. */
export function workflowStepApplies(task: Pick<Task, 'workflow_id' | 'workflow_project_id'>, projectId: string): boolean {
  if (!task.workflow_id) return false;
  try {
    const workflow = new WorkflowRepository(getProjectDb(task.workflow_project_id ?? projectId)).getById(task.workflow_id);
    return workflow?.state === 'running';
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
): Promise<void> {
  const { payload } = input;
  const current = (): { task: Task; column: Swimlane } | null => {
    const repos = getProjectRepos(context, payload.projectId);
    const task = repos.tasks.getById(payload.taskId);
    if (!task || task.archived_at || !task.workflow_id) return null;
    if (task.session_id !== payload.sessionId || task.swimlane_id !== input.columnId) return null;
    const column = repos.swimlanes.getById(task.swimlane_id);
    return column ? { task, column } : null;
  };

  const subject = current();
  if (!subject || !workflowStepApplies(subject.task, payload.projectId)) return;
  // activity-state-ok: granular, the step judges a finished turn, never a
  // running one or a permission prompt.
  if (context.sessionManager.getActivityCache()[payload.sessionId] !== 'idle') return;

  const agentReply = await input.readAgentReply();
  if (input.signal.aborted) return;
  const { task, column } = subject;
  const route = describeStepRoute(getProjectRepos(context, payload.projectId).swimlanes.list(), task, column.id);
  const outcome = await checkAutomationConditions(conditionCheckDeps(context), {
    task: { title: task.title, description: task.description, labels: task.labels, prUrl: task.pr_url, prState: task.pr_state },
    column: column.name,
    trigger: 'turn_end',
    move: null,
    agentReply,
    rows: [{ automationId: WORKFLOW_STEP_CHECK_ID, name: 'Step done', condition: workflowStepCondition(column, route) }],
  });
  // No Automation agent, or it could not run: a human gate until one can.
  if (!outcome.ok) return;
  if (input.signal.aborted) return;

  // The check took a while. Act only if the turn it judged is still the latest.
  const after = current();
  if (!after || after.column.id !== column.id) return;
  // activity-state-ok: granular, as above.
  if (context.sessionManager.getActivityCache()[payload.sessionId] !== 'idle') return;

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
  record(true, next.role === 'done' ? 'Step done. The route is finished, so the task moves to Done.' : `Step done. Moving on to ${next.name}.`);
  const projectPath = context.projectRepo.getById(payload.projectId)?.path ?? null;
  await handleTaskMove(
    context,
    { taskId: task.id, targetSwimlaneId: next.id, targetPosition: repos.tasks.list(next.id).length },
    'workflow',
    payload.projectId,
    projectPath,
    // The step runs inside the turn-end group, which its own move must not stop.
    { moveReason: 'Step done', fromTurnEndGroup: true },
  );
}

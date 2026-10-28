import { canTaskRunAutomations } from '../../shared/automation-manifest';
import type { Task } from '../../shared/types';
import type { IpcContext } from '../ipc/ipc-context';
import type { SessionResumedPayload } from '../pty/session-manager';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { supersedeTurnEndWork } from '../automations/turn-end/turn-end-passes';
import type { startWorkflowRecoveryOver } from './workflow-recovery';
import { notifyWorkflowOfTask } from './workflow-changed';

/**
 * A workflow task's own hold: its automations switch (`automations_disabled`),
 * which a person turns on to work the task by hand while the rest of its
 * workflow runs. While it is on, the workflow neither judges, nudges, moves nor
 * starts the task (`workflowStepApplies`, the engine's start filter), and a hand
 * may move its card (`workflowMoveRefusal`). This module does what the flip
 * itself must do, after the write, for the two paths that make it: the task
 * update IPC and the `update_task` command (the MCP tool and the phone).
 *
 * Point forward only: taking the hold off replays nothing the hold skipped. A
 * column's enter rows that a hand move skipped stay skipped (Run again runs
 * them), and a reply from before that move is the last column's.
 */

/** How a release reaches the turn-end runner's resume catch-up. */
let requestCatchUp: ((resumed: SessionResumedPayload) => void) | null = null;

/** Set by the turn-end runner when it registers. */
export function setHoldReleaseCatchUp(runner: ((resumed: SessionResumedPayload) => void) | null): void {
  requestCatchUp = runner;
}

/**
 * How a release starts the task's recovery over. Late-bound, as the catch-up is:
 * `workflow-recovery` reaches the agent spawn path and the desktop notifier, and
 * the two writers of the flag (the task update IPC and the MCP task command)
 * must not load them just to import this module.
 */
let requestRecoveryStart: typeof startWorkflowRecoveryOver | null = null;

/** Set by the turn-end runner when it registers. */
export function setHoldReleaseRecoveryStart(starter: typeof startWorkflowRecoveryOver | null): void {
  requestRecoveryStart = starter;
}

/** Recorded on the run log row a release writes, which starts the task's recovery over. */
export const HOLD_RELEASE_RECOVERY_DETAIL = 'Recovery starts over: automations resumed.';

/**
 * Act on a workflow task whose automations switch just changed. `before` is the
 * row as it stood before the write, `task` the row after it.
 *
 * - Both ways: the workflow's views re-read, so the canvas card, the inspector
 *   and the card's Stalled mark follow (coalesced with any other notice).
 * - On: stop the task's turn-end work, which aborts a step check or a nudge in
 *   flight and forgets its recovery.
 * - Off, in a working column: start its recovery over, so a task held while it
 *   was stalled comes back with a fresh schedule and notice rather than a spent
 *   one. Then, with a live agent, judge the reply this visit's turn left (the
 *   resume catch-up), so a task the person finished and left idle moves on. A
 *   paused agent stays paused; its next resume runs the same catch-up.
 */
export function applyAutomationsHoldChange(
  context: IpcContext,
  projectId: string,
  before: Pick<Task, 'automations_disabled'>,
  task: Task,
): void {
  if (!task.workflow_id) return;
  const wasHeld = !canTaskRunAutomations(before).ok;
  const held = !canTaskRunAutomations(task).ok;
  if (wasHeld === held) return;
  try {
    notifyWorkflowOfTask(task, projectId);
    if (held) {
      supersedeTurnEndWork(task.id);
      return;
    }
    releaseHold(context, projectId, task, task.workflow_id);
  } catch (error) {
    console.warn(`[WORKFLOW] Could not apply the automations switch on task ${task.id.slice(0, 8)}:`, error);
  }
}

function releaseHold(context: IpcContext, projectId: string, task: Task, workflowId: string): void {
  if (task.archived_at) return;
  const column = getProjectRepos(context, projectId).swimlanes.getById(task.swimlane_id);
  if (!column || column.role === 'todo' || column.role === 'done') return;
  requestRecoveryStart?.(context, { projectId, taskId: task.id, columnId: column.id, workflowId }, { detail: HOLD_RELEASE_RECOVERY_DETAIL });

  if (!task.session_id) return;
  const session = context.sessionManager.getSession(task.session_id);
  if (!session || session.status !== 'running') return;
  // The session's own serial, so a turn the user starts meanwhile reads as newer.
  const workSerial = context.sessionManager.currentWorkSerial(session.id);
  if (workSerial === undefined) return;
  requestCatchUp?.({
    sessionId: session.id,
    taskId: task.id,
    projectId,
    agentSessionId: session.agentSessionId ?? null,
    isolatedSwimlaneId: session.isolatedSwimlaneId ?? null,
    workSerial,
  });
}

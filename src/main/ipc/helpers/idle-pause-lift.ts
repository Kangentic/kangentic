/**
 * Whether the owner's own gesture may lift a pause the idle timeout made.
 *
 * Two gestures do: opening the task (`resumeTaskOnOpen`) and moving it into a
 * column that starts an agent (`handleTaskMove`, Priority 4, through
 * `spawnAgent`'s `liftsIdlePause`). The idle pause is Kangentic freeing memory,
 * not the user's choice, so the owner coming back to the task ends it.
 *
 * What keeps it held, on both paths:
 * - Any pause but `'auto'`. The user's own Pause (`'user'`, and `'low_memory'`,
 *   which only an earlier version wrote) waits for Resume.
 * - A start that never reached an agent (`launch_failed_at`): it keeps its
 *   Resume button and the reason the card shows.
 * - A workflow recovery armed or running for the task: it owns the next start.
 * - A paused workflow. Its Pause records `'user'` only for agents still
 *   running, so a member the idle timeout paused first still reads `'auto'`.
 *   A workflow that cannot be read counts as paused: nobody asked for a start.
 *
 * A read. Callers re-ask it under the task lock before they start anything.
 */
import { createChokepointReporter } from '../../analytics/handled-report';
import { workflowOfTask } from '../../workflows/workflow-home';
import { isUnderWorkflowRecovery } from '../../workflows/workflow-recovery-state';
import type { SessionRecord, Task } from '../../../shared/types';

/**
 * Reports a failure while lifting an idle pause: a workflow home that exists
 * and could not be read (the pause stays held), or the enter rows a move runs
 * with the agent still paused after `spawnAgent` declined the lift.
 */
export const idlePauseLiftReporter = createChokepointReporter('idle_pause_lift');

/** Whether a workflow's Pause holds this task. Unreadable reads as held. */
function isHeldByWorkflow(task: Task, projectId: string): boolean {
  try {
    return workflowOfTask(task, projectId)?.state === 'paused';
  } catch (error) {
    console.warn(`[IDLE_PAUSE] Could not read the workflow of task ${task.id.slice(0, 8)}:`, error);
    idlePauseLiftReporter.report(error);
    return true;
  }
}

export function isLiftableIdlePause(
  task: Task,
  projectId: string,
  record: Pick<SessionRecord, 'status' | 'suspended_by' | 'launch_failed_at'> | null | undefined,
): boolean {
  if (record?.status !== 'suspended' || record.suspended_by !== 'auto') return false;
  if (record.launch_failed_at) return false;
  if (isUnderWorkflowRecovery(task.id)) return false;
  return !isHeldByWorkflow(task, projectId);
}

import type { Swimlane, Task } from '../../shared/types';
import { getExistingProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { TaskMoveRepository } from '../db/repositories/task-move-repository';
import { safeLanes } from './workflow-lanes';

/**
 * Whether a workflow's task never started: it is in To Do, has never had a
 * session, has no worktree, and has never been in another column. Such a task
 * is a brief and nothing else, so a workflow delete may take it along when
 * asked to (`deleteNeverStartedTasks`). The Delete confirm counts the same
 * tasks (`WorkflowSummary.neverStartedCount`).
 *
 * The move check is what keeps a task that ran: a move back to To Do resets
 * it, which removes its worktree and its session records, but the moves stay.
 * Moves are recorded only since the table came with workflows, so a task that
 * ran before then and was moved back to To Do has nothing left that says it
 * ran, and reads as never started.
 *
 * `lanes` is the task's board's columns when the caller already read them. A
 * board that cannot be read answers false, so nothing is deleted on a guess.
 */
export function isNeverStarted(projectId: string, task: Task, lanes: Swimlane[] = safeLanes(projectId)): boolean {
  if (task.archived_at || task.session_id || task.worktree_path) return false;
  const lane = lanes.find((candidate) => candidate.id === task.swimlane_id);
  if (lane?.role !== 'todo') return false;
  try {
    const db = getExistingProjectDb(projectId);
    if (!db) return false;
    if (new SessionRepository(db).getLatestForTask(task.id)) return false;
    return !new TaskMoveRepository(db).hasEnteredOtherLane(task.id, lane.id);
  } catch {
    return false;
  }
}

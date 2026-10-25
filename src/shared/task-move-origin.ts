import type { TaskMoveRecordOrigin } from './types';

/**
 * Whether a move by this origin is a person's: a drag on the desktop board, or
 * a move from the phone. Every other origin is the board's own mover (an
 * agent, an automation, a plan approval's auto-move, a workflow) or a write
 * that places a task without a move (a rollback, an unarchive, a create).
 *
 * A `Record` over the whole union, so a new origin is classified here before
 * anything compiles. Every reader of "a move by hand" asks this one table: the
 * workflow lock (`workflowMoveRefusal`, `checkWorkflowMove`) and where a row's
 * Frequency starts counting (`AutomationRunRepository.countRuns`).
 */
export const MOVED_BY_A_PERSON: Record<TaskMoveRecordOrigin, boolean> = {
  renderer: true,
  mobile: true,
  agent: false,
  'auto-move': false,
  workflow: false,
  automation: false,
  rollback: false,
  unarchive: false,
  create: false,
};

export function isMoveByAPerson(origin: TaskMoveRecordOrigin): boolean {
  return MOVED_BY_A_PERSON[origin];
}

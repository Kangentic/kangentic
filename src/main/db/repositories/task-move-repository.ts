import type Database from 'better-sqlite3';
import type { TaskMoveRecord, TaskMoveRecordOrigin } from '../../../shared/types';

/**
 * Reads of `task_moves`, the record of every column a task entered.
 *
 * The rows are WRITTEN by `TaskRepository` inside the same transaction as the
 * move, never here, so a move cannot land without its record. This class only
 * answers questions about them:
 *
 * - when the task's current visit to a column began (`visitStartedAt`), which
 *   is the boundary a turn-end automation's "has it run this visit" counts
 *   from;
 * - the task's step history (`listForTask`), for a workflow task's route.
 */
interface TaskMoveRow {
  id: string;
  task_id: string;
  from_swimlane_id: string | null;
  to_swimlane_id: string;
  origin: string;
  reason: string | null;
  at: string;
}

export class TaskMoveRepository {
  constructor(private db: Database.Database) {}

  /**
   * When the task last entered this column, or null when no move into it was
   * recorded (a task placed there before moves were recorded). Null means the
   * caller has no visit boundary, which counts every earlier run as this visit's.
   */
  visitStartedAt(taskId: string, swimlaneId: string): string | null {
    const row = this.db
      // rowid breaks a tie between two moves stamped in the same millisecond.
      .prepare('SELECT at FROM task_moves WHERE task_id = ? AND to_swimlane_id = ? ORDER BY at DESC, rowid DESC LIMIT 1')
      .get(taskId, swimlaneId) as { at: string } | undefined;
    return row?.at ?? null;
  }

  /** Every recorded move of one task, oldest first. */
  listForTask(taskId: string): TaskMoveRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM task_moves WHERE task_id = ? ORDER BY at ASC, rowid ASC')
      .all(taskId) as TaskMoveRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: TaskMoveRow): TaskMoveRecord {
  return {
    id: row.id,
    task_id: row.task_id,
    from_swimlane_id: row.from_swimlane_id,
    to_swimlane_id: row.to_swimlane_id,
    origin: row.origin as TaskMoveRecordOrigin,
    reason: row.reason,
    at: row.at,
  };
}

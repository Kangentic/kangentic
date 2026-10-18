import type Database from 'better-sqlite3';
import type { TaskMoveRecord, TaskMoveRecordOrigin } from '../../../shared/types';

/** The move that opened a task's current visit to a column (`currentVisit`). */
export type TaskVisit = Pick<TaskMoveRecord, 'at' | 'origin' | 'from_swimlane_id'>;

/**
 * Reads of `task_moves`, the record of every column a task entered.
 *
 * The rows are WRITTEN by `TaskRepository` inside the same transaction as the
 * move, never here, so a move cannot land without its record. This class only
 * answers questions about them:
 *
 * - when the task's current visit to a column began (`visitStartedAt`), which
 *   is the boundary a turn-end automation's "has it run this visit" counts
 *   from, and which move opened it (`currentVisit`);
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
    return this.currentVisit(taskId, swimlaneId)?.at ?? null;
  }

  /**
   * The move that opened the task's current visit to this column: when, who
   * made it, and the column it came from. Null under the same condition as
   * `visitStartedAt`.
   */
  currentVisit(taskId: string, swimlaneId: string): TaskVisit | null {
    const row = this.db
      // rowid breaks a tie between two moves stamped in the same millisecond.
      .prepare('SELECT at, origin, from_swimlane_id FROM task_moves WHERE task_id = ? AND to_swimlane_id = ? ORDER BY at DESC, rowid DESC LIMIT 1')
      .get(taskId, swimlaneId) as { at: string; origin: string; from_swimlane_id: string | null } | undefined;
    return row ? { at: row.at, origin: row.origin as TaskMoveRecordOrigin, from_swimlane_id: row.from_swimlane_id } : null;
  }

  /**
   * For the `limit` tasks that most recently entered `doneSwimlaneId`, how many
   * of them entered each column on the way: what a workflow's agent is told about
   * how work moves through this board (`{{columns}}`).
   */
  recentFinishedColumnVisits(doneSwimlaneId: string, limit: number): { finished: number; visits: Map<string, number> } {
    const finishedRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT task_id FROM task_moves WHERE to_swimlane_id = ? GROUP BY task_id ORDER BY MAX(at) DESC LIMIT ?
      )
    `).get(doneSwimlaneId, limit) as { count: number };
    const visitRows = this.db.prepare(`
      WITH finished AS (
        SELECT task_id FROM task_moves WHERE to_swimlane_id = ? GROUP BY task_id ORDER BY MAX(at) DESC LIMIT ?
      )
      SELECT moves.to_swimlane_id AS swimlane_id, COUNT(DISTINCT moves.task_id) AS tasks
      FROM task_moves moves JOIN finished ON finished.task_id = moves.task_id
      GROUP BY moves.to_swimlane_id
    `).all(doneSwimlaneId, limit) as Array<{ swimlane_id: string; tasks: number }>;
    return { finished: finishedRow.count, visits: new Map(visitRows.map((row) => [row.swimlane_id, row.tasks])) };
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

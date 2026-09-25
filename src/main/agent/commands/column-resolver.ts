import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import type Database from 'better-sqlite3';
import type { Swimlane } from '../../../shared/types';

interface ColumnResolution {
  swimlane: Swimlane;
  allSwimlanes: Swimlane[];
}

/**
 * List all non-archived swimlanes from the database.
 */
export function listActiveSwimlanes(db: Database.Database): Swimlane[] {
  return listResolvableSwimlanes(db, false);
}

/**
 * Every column a human sees on the board: the active lanes PLUS the done lane,
 * which is persisted archived by construction (the board renders it as the
 * collapsed DoneSwimlane rather than a normal column, so it carries the flag
 * even though nobody archived it).
 *
 * This is what the READ tools report. Listing only the active lanes hid Done
 * from kangentic_list_columns on every board, and an agent looking for where
 * finished work goes picked the last column it could see - which is Merge, an
 * auto_spawn column running /merge-pull-request.
 */
export function listBoardColumns(db: Database.Database): Swimlane[] {
  return listResolvableSwimlanes(db, true);
}

/**
 * The predicate behind listBoardColumns, for a caller that already holds the
 * full swimlane list and only needs to narrow it.
 *
 * The carve-out is `role === 'done'`, never "any archived lane": a lane a user
 * archived deliberately stays hidden. tests/unit/mcp-move-task-to-done.test.ts
 * pins that distinction.
 */
export function isBoardColumn(swimlane: Swimlane): boolean {
  return !swimlane.is_archived || swimlane.role === 'done';
}

/**
 * The refusal a caller gets for naming the done column somewhere a task cannot
 * be PLACED directly (created, promoted, relocated across projects).
 *
 * Naming it is not the same as failing to resolve it: kangentic_list_columns
 * prints the done column, so a bare "Column not found" flatly contradicts what
 * the agent just read and reads as a typo rather than a limitation.
 * handleDeleteColumn already answers this way for its own refusal.
 *
 * `whatCannotHappen` is a CLAUSE, not a sentence: lowercase, no trailing
 * punctuation, completing "... so <clause>.". A caller that passes a full
 * sentence produces a run-on with no compile-time or test signal.
 */
function doneColumnRefusal(doneColumnName: string, whatCannotHappen: string): string {
  return `"${doneColumnName}" is the completed column. A task moved there is archived off the board, so ${whatCannotHappen}. Put it on the board first, then move it with kangentic_move_task.`;
}

/**
 * List swimlanes eligible for name/role resolution. The Done lane is always
 * persisted archived (it is collapsed in the board UI by design), so it is
 * excluded unless includeArchivedDone is set - letting an agent resolve
 * "Done" as a genuine move target without exposing other archived lanes,
 * which a user archived deliberately to hide them.
 */
function listResolvableSwimlanes(db: Database.Database, includeArchivedDone: boolean): Swimlane[] {
  const swimlaneRepo = new SwimlaneRepository(db);
  return swimlaneRepo
    .list()
    .filter((swimlane) => (includeArchivedDone ? isBoardColumn(swimlane) : !swimlane.is_archived));
}

/**
 * Resolve a column name to a swimlane. If columnName is null, returns the
 * default 'todo' column. Returns an error response if the column is not found.
 *
 * Two ways to handle the Done lane, and every caller wants one of them:
 *
 * - `includeArchivedDone` matches it by name as a genuine target (move_task,
 *   reorder_tasks, update_column, a plan-exit target). Other archived lanes stay
 *   hidden, since a user archived those deliberately.
 * - `refuseDone` matches it by name and then REFUSES it, with the given clause
 *   folded into an explanation (see doneColumnRefusal for the clause's shape).
 *   For a caller that PLACES a task (create, promote, relocate), where Done is
 *   not a legal destination. Prefer this over leaving the name unresolvable:
 *   kangentic_list_columns prints Done, so "not found" contradicts what the
 *   caller just read. It implies includeArchivedDone, so passing
 *   `includeArchivedDone: false` alongside it does not narrow anything.
 *
 * With neither, Done does not resolve at all.
 */
export function resolveColumn(
  db: Database.Database,
  columnName: string | null,
  defaultRole: 'todo' | 'done' = 'todo',
  options: { includeArchivedDone?: boolean; refuseDone?: string } = {},
): ColumnResolution | { error: string } {
  const allSwimlanes = listResolvableSwimlanes(
    db,
    (options.includeArchivedDone ?? false) || options.refuseDone !== undefined,
  );
  let swimlane = allSwimlanes.find((lane) => lane.role === defaultRole);

  if (columnName) {
    const matched = allSwimlanes.find(
      (lane) => lane.name.toLowerCase() === columnName.toLowerCase(),
    );
    if (!matched) {
      const available = allSwimlanes.map((lane) => lane.name).join(', ');
      return {
        error: `Column "${columnName}" not found. Available columns: ${available}. (Backlog is not a board column - pass column: "Backlog" to create_task to create a backlog item.)`,
      };
    }
    swimlane = matched;
  }

  if (!swimlane) {
    return { error: `No ${defaultRole === 'todo' ? 'To Do' : 'Done'} column found on this board` };
  }

  // Only a NAMED done column is refused. A caller that fell through to the
  // default lane never asked for Done, and `defaultRole: 'done'` is a request
  // for it by role, which is not the mistake this guards.
  if (options.refuseDone !== undefined && columnName && swimlane.role === 'done') {
    return { error: doneColumnRefusal(swimlane.name, options.refuseDone) };
  }

  return { swimlane, allSwimlanes };
}

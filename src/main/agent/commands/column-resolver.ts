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
    .filter((swimlane) => !swimlane.is_archived || (includeArchivedDone && swimlane.role === 'done'));
}

/**
 * Resolve a column name to a swimlane. If columnName is null, returns the
 * default 'todo' column. Returns an error response if the column is not found.
 * Pass options.includeArchivedDone to also match the archived Done lane by
 * name (see listResolvableSwimlanes); it stays excluded by default.
 */
export function resolveColumn(
  db: Database.Database,
  columnName: string | null,
  defaultRole: 'todo' | 'done' = 'todo',
  options: { includeArchivedDone?: boolean } = {},
): ColumnResolution | { error: string } {
  const allSwimlanes = listResolvableSwimlanes(db, options.includeArchivedDone ?? false);
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

  return { swimlane, allSwimlanes };
}

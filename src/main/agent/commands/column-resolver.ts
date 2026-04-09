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
  const swimlaneRepo = new SwimlaneRepository(db);
  return swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
}

/**
 * Resolve a column name to a swimlane. If columnName is null, returns the
 * default 'todo' column. Returns an error response if the column is not found.
 */
export function resolveColumn(
  db: Database.Database,
  columnName: string | null,
  defaultRole: 'todo' | 'done' = 'todo',
): ColumnResolution | { error: string } {
  const allSwimlanes = listActiveSwimlanes(db);
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

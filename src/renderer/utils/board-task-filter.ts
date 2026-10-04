import type { Task } from '../../shared/types';
import { parseTicketQuery, matchesTicketPrefix } from '../../shared/ticket-query';

/**
 * The board's search and filter, as one rule. The board and the Workflows
 * canvas share one query and one filter set (the toolbar row drives both), so
 * they decide a match with this one function and can never disagree about
 * which cards show.
 */
export interface BoardTaskFilter {
  priorityFilters: ReadonlySet<number>;
  labelFilters: ReadonlySet<string>;
  /** The query, trimmed and lowercased; empty matches every task. */
  normalizedSearch: string;
  /** A `#<digits>` query filters by ticket number (prefix) instead of text. See src/shared/ticket-query.ts. */
  ticketDigits: ReturnType<typeof parseTicketQuery>;
}

export function boardTaskFilter(query: string, priorityFilters: ReadonlySet<number>, labelFilters: ReadonlySet<string>): BoardTaskFilter {
  return { priorityFilters, labelFilters, normalizedSearch: query.trim().toLowerCase(), ticketDigits: parseTicketQuery(query) };
}

/** True when nothing is being searched or filtered, so every task shows. */
export function isOpenFilter(filter: BoardTaskFilter): boolean {
  return filter.priorityFilters.size === 0 && filter.labelFilters.size === 0 && filter.ticketDigits === null && filter.normalizedSearch === '';
}

export type FilterableTask = Pick<Task, 'priority' | 'labels' | 'title' | 'description'> & { display_id: number | null };

export function matchesBoardTaskFilter(task: FilterableTask, filter: BoardTaskFilter): boolean {
  if (filter.priorityFilters.size > 0 && !filter.priorityFilters.has(task.priority)) return false;
  if (filter.labelFilters.size > 0 && !(task.labels ?? []).some((label) => filter.labelFilters.has(label))) return false;
  if (filter.ticketDigits !== null) {
    // A task that has no number yet (planned in a workflow) never matches a ticket query.
    return task.display_id !== null && matchesTicketPrefix(task.display_id, filter.ticketDigits);
  }
  if (filter.normalizedSearch) {
    const title = task.title.toLowerCase();
    const description = (task.description ?? '').toLowerCase();
    if (!title.includes(filter.normalizedSearch) && !description.includes(filter.normalizedSearch)) return false;
  }
  return true;
}

import type { Swimlane, Task } from './types';

/**
 * A workflow task's route: the columns it visits, from its start column to its
 * last, minus the ones it skips.
 *
 * Pure, and shared by the engine, the move tools and the Workflows view, so a
 * task cannot be "next in Code Review" in one place and "next in Testing" in
 * another. Nothing here reads a column's NAME: boards differ (To Do, Executing,
 * Done is a valid board), so a route is ids and roles only.
 *
 * The defaults are open-ended on purpose. A null start means the first column
 * after To Do and a null last means the column before Done, so a column a team
 * adds inside the range later is on every route that did not skip it by name.
 */
export type RouteFields = Pick<Task, 'route_start_swimlane_id' | 'route_last_swimlane_id' | 'skipped_swimlane_ids'>;

export type RouteColumn = Pick<Swimlane, 'id' | 'position' | 'role' | 'is_archived' | 'is_ghost'>;

function byPosition<Column extends RouteColumn>(left: Column, right: Column): number {
  return left.position - right.position;
}

function onBoard(column: RouteColumn): boolean {
  return !column.is_archived && !column.is_ghost;
}

/** The columns any route can use: on the board, neither To Do nor Done, in board order. */
export function routeCandidates<Column extends RouteColumn>(columns: readonly Column[]): Column[] {
  return columns
    .filter((column) => onBoard(column) && column.role !== 'todo' && column.role !== 'done')
    .sort(byPosition);
}

/** The board's Done column, or null on a board without one. */
export function doneColumn<Column extends RouteColumn>(columns: readonly Column[]): Column | null {
  return columns.find((column) => column.role === 'done' && !column.is_ghost) ?? null;
}

/** The board's To Do column, or null on a board without one. */
export function todoColumn<Column extends RouteColumn>(columns: readonly Column[]): Column | null {
  return columns.find((column) => column.role === 'todo' && !column.is_ghost) ?? null;
}

/**
 * The columns a task visits, in order. A start or last that names a column no
 * longer on the board falls back to the open end, so deleting a column never
 * strands a route.
 */
export function routeColumns<Column extends RouteColumn>(columns: readonly Column[], route: RouteFields): Column[] {
  const candidates = routeCandidates(columns);
  if (candidates.length === 0) return [];
  const startIndex = route.route_start_swimlane_id
    ? candidates.findIndex((column) => column.id === route.route_start_swimlane_id)
    : 0;
  const lastIndex = route.route_last_swimlane_id
    ? candidates.findIndex((column) => column.id === route.route_last_swimlane_id)
    : candidates.length - 1;
  const from = startIndex >= 0 ? startIndex : 0;
  const to = lastIndex >= 0 ? lastIndex : candidates.length - 1;
  if (to < from) return [];
  const skipped = new Set(route.skipped_swimlane_ids);
  return candidates.slice(from, to + 1).filter((column) => !skipped.has(column.id));
}

/**
 * Where a workflow task goes from `currentColumnId`: the first route column
 * after it on the board, or Done when the route has nothing after it. Works
 * from any column, on the route or not: a task an agent moved into a skipped
 * column, or back to an earlier one, continues from where it is.
 *
 * From To Do it is the route's first column, which is where a start lands.
 * Null only on a board with no Done column and nothing left on the route.
 */
export function nextOnRoute<Column extends RouteColumn>(
  columns: readonly Column[],
  route: RouteFields,
  currentColumnId: string,
): Column | null {
  const current = columns.find((column) => column.id === currentColumnId) ?? null;
  const steps = routeColumns(columns, route);
  if (current?.role === 'todo') return steps[0] ?? doneColumn(columns);
  if (current?.role === 'done') return null;
  const after = current ? steps.find((column) => column.position > current.position) : steps[0];
  return after ?? doneColumn(columns);
}

/** The column a start moves the task into: its route's first column, or Done for an empty route. */
export function startColumn<Column extends RouteColumn>(columns: readonly Column[], route: RouteFields): Column | null {
  return routeColumns(columns, route)[0] ?? doneColumn(columns);
}

/** Is this column on the route (a step the task visits)? */
export function isOnRoute(columns: readonly RouteColumn[], route: RouteFields, columnId: string): boolean {
  return routeColumns(columns, route).some((column) => column.id === columnId);
}

/**
 * The route that visits exactly `includedColumnIds` (the Workflows view's route
 * switches). An end that is the board's own first or last route column is
 * stored open (null), so a column a team adds there later joins the route, as
 * for a task nobody customized. Null when nothing is included: a task visits at
 * least one column.
 */
export function routeFromColumns(columns: readonly RouteColumn[], includedColumnIds: readonly string[]): RouteFields | null {
  const candidates = routeCandidates(columns);
  const included = new Set(includedColumnIds);
  const firstIndex = candidates.findIndex((column) => included.has(column.id));
  if (firstIndex < 0) return null;
  let lastIndex = firstIndex;
  candidates.forEach((column, index) => {
    if (included.has(column.id)) lastIndex = index;
  });
  return {
    route_start_swimlane_id: firstIndex === 0 ? null : candidates[firstIndex].id,
    route_last_swimlane_id: lastIndex === candidates.length - 1 ? null : candidates[lastIndex].id,
    skipped_swimlane_ids: candidates.slice(firstIndex, lastIndex + 1).filter((column) => !included.has(column.id)).map((column) => column.id),
  };
}

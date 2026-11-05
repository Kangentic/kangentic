import type { Swimlane } from '../../shared/types';
import { isForwardOf, isOnRoute, nextOnRoute, type RouteFields } from '../../shared/workflow-route';

/**
 * Where a "move this task" request lands: a column named by the caller, or the
 * next column after the task's own.
 *
 * Shared by the Move to column automation and `kangentic_move_task`'s
 * `column: "next"`, so an agent and an automation asked for the same move land
 * in the same column. For a workflow task (`route` given) the next column is
 * the next one on its route, which can be Done; outside a workflow it is the
 * next column on the board, by position.
 *
 * The route also wins over a column a row names (owner's rule, 2026-10-04): a
 * forward row whose column the route does not visit lands on the route's next
 * column instead. Rows ran before the step, so a row that went by its name
 * walked a planned-and-executed task into a Code Review its route skips, where
 * an empty diff sent it back, up to four times in six minutes. A send-back keeps
 * the column it names. An agent's or a person's named move never comes through
 * here (`column-resolver.ts`, the move handlers), so it stays as it was asked.
 *
 * A column a user archived and a ghost column are never a destination: neither
 * is on the board a person sees. Done is, although it is stored archived (the
 * board draws it as its own lane), so a row can move a task there by name, and
 * "next" from the last column before it lands there, as `isBoardColumn`
 * (agent/commands/column-resolver.ts) decides for kangentic_move_task.
 */
export type MoveTargetResult = { ok: true; column: Swimlane } | { ok: false; reason: string };

function onBoard(column: Swimlane): boolean {
  return (!column.is_archived || column.role === 'done') && !column.is_ghost;
}

/**
 * How a column's name is matched: blind to case and to surrounding whitespace.
 * The column rename (`renameAutomationColumnReferences`) matches stored names
 * through it too, so a name this reads as a column is one a rename of that
 * column rewrites.
 */
export function columnNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function resolveMoveTarget(
  columns: ReadonlyArray<Swimlane>,
  fromColumnId: string,
  requested: string | null,
  route: RouteFields | null = null,
): MoveTargetResult {
  const board = columns.filter(onBoard).slice().sort((left, right) => left.position - right.position);
  const from = columns.find((column) => column.id === fromColumnId) ?? null;

  if (requested === null || columnNameKey(requested) === 'next') {
    if (!from) return { ok: false, reason: 'The task is in a column that no longer exists.' };
    if (route) {
      const onRoute = nextOnRoute(columns, route, from.id);
      if (!onRoute) return { ok: false, reason: `There is no column after ${from.name} on this task's route.` };
      return { ok: true, column: onRoute };
    }
    const next = board.find((column) => column.position > from.position);
    if (!next) return { ok: false, reason: `There is no column after ${from.name}.` };
    return { ok: true, column: next };
  }

  const wanted = columnNameKey(requested);
  const named = board.find((column) => columnNameKey(column.name) === wanted);
  if (!named) {
    const names = board.map((column) => column.name).join(', ');
    return { ok: false, reason: `No column named "${requested.trim()}" on this board. Columns: ${names}.` };
  }
  if (from && named.id === from.id) return { ok: false, reason: `The task is already in ${named.name}.` };
  if (route && from && isForwardOf(named, from) && !isOnRoute(columns, route, named.id)) {
    // Null only for a task in Done or on a board with no Done column, and then
    // the row's own column is the one left.
    return { ok: true, column: nextOnRoute(columns, route, from.id) ?? named };
  }
  return { ok: true, column: named };
}

/** The route to pass `resolveMoveTarget` for a task: its own when it is in a workflow, else none. */
export function routeOf(task: RouteFields & { workflow_id: string | null }): RouteFields | null {
  // Truthiness, not `!== null`: a Task assembled without the column carries
  // `undefined`, which is no workflow.
  return task.workflow_id ? task : null;
}

import type { Swimlane } from '../../shared/types';
import { nextOnRoute, type RouteFields } from '../../shared/workflow-route';

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
 * Archived and ghost columns are never a destination: neither is on the board
 * a person sees.
 */
export type MoveTargetResult = { ok: true; column: Swimlane } | { ok: false; reason: string };

function onBoard(column: Swimlane): boolean {
  return !column.is_archived && !column.is_ghost;
}

export function resolveMoveTarget(
  columns: ReadonlyArray<Swimlane>,
  fromColumnId: string,
  requested: string | null,
  route: RouteFields | null = null,
): MoveTargetResult {
  const board = columns.filter(onBoard).slice().sort((left, right) => left.position - right.position);
  const from = columns.find((column) => column.id === fromColumnId) ?? null;

  if (requested === null || requested.trim().toLowerCase() === 'next') {
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

  const wanted = requested.trim().toLowerCase();
  const named = board.find((column) => column.name.trim().toLowerCase() === wanted);
  if (!named) {
    const names = board.map((column) => column.name).join(', ');
    return { ok: false, reason: `No column named "${requested.trim()}" on this board. Columns: ${names}.` };
  }
  if (from && named.id === from.id) return { ok: false, reason: `The task is already in ${named.name}.` };
  return { ok: true, column: named };
}

/** The route to pass `resolveMoveTarget` for a task: its own when it is in a workflow, else none. */
export function routeOf(task: RouteFields & { workflow_id: string | null }): RouteFields | null {
  return task.workflow_id !== null ? task : null;
}

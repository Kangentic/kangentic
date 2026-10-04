import type { Swimlane } from '../../shared/types';

/**
 * Where a "move this task" request lands: a column named by the caller, or the
 * next column after the task's own.
 *
 * Shared by the Move to column automation and `kangentic_move_task`'s
 * `column: "next"`, so an agent and an automation asked for the same move land
 * in the same column. A workflow task's next column comes from its route,
 * which the workflow engine resolves before it calls this; outside a workflow
 * it is the next column on the board, by position.
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
): MoveTargetResult {
  const board = columns.filter(onBoard).slice().sort((left, right) => left.position - right.position);
  const from = columns.find((column) => column.id === fromColumnId) ?? null;

  if (requested === null || requested.trim().toLowerCase() === 'next') {
    if (!from) return { ok: false, reason: 'The task is in a column that no longer exists.' };
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

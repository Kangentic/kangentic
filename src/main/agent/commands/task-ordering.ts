/**
 * Pure ordering arithmetic behind the MCP task-placement surface
 * (`kangentic_move_task`'s `position` and `kangentic_reorder_tasks`).
 *
 * Kept apart from `task-commands.ts` because this is the part of task placement
 * that is actually easy to get wrong, and because keeping it pure lets the
 * boundary cases be named and asserted directly - a fractional slot, a negative
 * one, an empty column, a gapped column - rather than only incidentally, through
 * whatever a handler test happens to exercise. See
 * `tests/unit/task-ordering.test.ts`.
 *
 * Every function here speaks ORDINAL SLOTS: a zero-based index into a column's
 * non-archived task order. That is the same vocabulary `kangentic_create_column`
 * already uses for its own `position`, and it is deliberately NOT the raw stored
 * `tasks.position` value. See `resolveRawPosition` for why the two diverge.
 */

/**
 * Clamp a requested ordinal slot into `0..maxSlot` inclusive, tolerating a
 * non-integer or out-of-range request rather than failing the call.
 *
 * The right `maxSlot` differs by operation, and the off-by-one between them is
 * the reason this is a named helper rather than an inline `Math.min`:
 *
 * - Moving a task INTO a different column: `maxSlot` is the column's length,
 *   because the task is not there yet and appending is a legal slot.
 * - Repositioning a task INSIDE its own column: `maxSlot` is the length with
 *   that task removed, because the slot is evaluated against the other cards.
 */
export function clampSlot(requested: number, maxSlot: number): number {
  if (!Number.isFinite(requested)) return maxSlot;
  return Math.min(Math.max(Math.trunc(requested), 0), Math.max(maxSlot, 0));
}

/**
 * Apply a requested ordering to a column, with PREFIX semantics: the requested
 * ids take slots `0..n-1` in the order given, and every task not named keeps its
 * existing relative order below them.
 *
 * Passing every id in the column therefore sets the column's full order, while
 * passing three ids pins those three to the top. Being a prefix rather than a
 * strict full-list contract is what makes the tool safe to call against a live
 * board: a task created between the agent's read and its write is not named, so
 * it simply sinks below the named ones instead of failing the call.
 *
 * `requestedIds` must already be resolved to task UUIDs, de-duplicated, and
 * checked to belong to this column - `handleReorderTasks` does all three, and
 * reports a precise error for each. This function does not re-validate, so a
 * stray id would be prepended to the result; the repository's `swimlane_id`
 * guard is the second line of defence.
 */
export function computeReorderedIds(currentOrderedIds: string[], requestedIds: string[]): string[] {
  const requested = new Set(requestedIds);
  return [...requestedIds, ...currentOrderedIds.filter((id) => !requested.has(id))];
}

/**
 * Move one task to an ordinal slot within its own column, returning the
 * column's new id order.
 *
 * `slot` is interpreted against the column WITHOUT the moved task, matching how
 * `TaskRepository.move` evaluates a same-lane target (it runs the removal shift
 * before the make-room shift). It is clamped, so slot 99 on a five-card column
 * means "last" rather than an error.
 */
export function computeIdsWithTaskAtSlot(
  currentOrderedIds: string[],
  taskId: string,
  slot: number,
): string[] {
  const others = currentOrderedIds.filter((id) => id !== taskId);
  const target = clampSlot(slot, others.length);
  return [...others.slice(0, target), taskId, ...others.slice(target)];
}

/**
 * Translate an ordinal slot into the RAW `tasks.position` value to hand
 * `TaskRepository.move`.
 *
 * The two diverge as soon as a column's raw positions have a gap, and gaps are
 * normal here: `archive()` leaves `position` untouched, and `create` takes
 * `MAX(position) + 1` over archived rows too, while `list()` filters them out.
 * A column can sit at raw 0, 5, 9 indefinitely. Passing the ordinal straight
 * through would then sweep whichever task's raw position merely coincides with
 * it and land the card a slot early - the same hazard `handleCreateColumn`
 * documents for swimlanes.
 *
 * So anchor on the raw position of the task currently occupying that slot;
 * `move()`'s `position >= ?` shift makes room ahead of it. Past the last slot
 * there is no anchor, hence `appendPosition`, which the caller derives as
 * `MAX(position) + 1` over ALL rows in the column INCLUDING archived ones (the
 * convention `create` uses) so an append cannot collide with an archived row.
 *
 * @param orderedPositions the column's non-archived raw positions, in order
 * @param appendPosition   `MAX(position) + 1` over the column, archived included
 */
export function resolveRawPosition(
  orderedPositions: number[],
  ordinal: number,
  appendPosition: number,
): number {
  const slot = clampSlot(ordinal, orderedPositions.length);
  return slot < orderedPositions.length ? orderedPositions[slot] : appendPosition;
}

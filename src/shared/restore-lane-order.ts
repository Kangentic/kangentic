/**
 * Where a task restored out of Done lands in its target lane, as the lane's new
 * order. Main's TASK_UNARCHIVE writes this order back as dense positions (0..n),
 * and the renderer's optimistic restore and the UI mock place the card by the
 * same rule, so the card shows in the slot main will write.
 *
 * `laneTaskIds` is the target lane's live cards in position order. The restored
 * id is dropped from it first, so a task that is already in the lane is placed
 * once. `requestedIndex` is an index into what remains, the end slot included.
 * Anything else (omitted, fractional, negative, or past the end) puts the card
 * last. Writing the order back is what makes "last" true on a lane whose
 * positions have gaps (0, 5, 9): appending at the lane's length would sort the
 * card second there.
 */
export function restoredLaneOrder(
  laneTaskIds: readonly string[],
  restoredId: string,
  requestedIndex: number | undefined,
): string[] {
  const orderedIds = laneTaskIds.filter((taskId) => taskId !== restoredId);
  const isSlotInLane = typeof requestedIndex === 'number'
    && Number.isInteger(requestedIndex)
    && requestedIndex >= 0
    && requestedIndex <= orderedIds.length;
  orderedIds.splice(isSlotInLane ? requestedIndex : orderedIds.length, 0, restoredId);
  return orderedIds;
}

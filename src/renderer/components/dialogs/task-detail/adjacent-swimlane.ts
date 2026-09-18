import type { Swimlane } from '../../../../shared/types';

/** Which way `taskDetail.moveColumnLeft` / `.moveColumnRight` steps. */
export type ColumnStepDirection = 'left' | 'right';

/**
 * The swimlane one step left/right of `currentSwimlaneId`, or `null` at an
 * edge (no wraparound) or if the current lane cannot be found.
 *
 * Candidates use the same filter as `PromotePopover` / `RestorePopover`
 * (`role !== 'done' && !is_archived && !is_ghost`). Done is never a hotkey
 * target: a Done move archives the task and closes the window
 * (`useWindowAutoCloseOnDone`), the opposite of what this hotkey is for. The
 * Done lane is persisted `is_archived: true` by every write path today, but
 * nothing in the schema enforces that coupling, so the role is checked too.
 *
 * Walks the FULL ordered list (not a pre-filtered one) so a task sitting in a
 * ghost/archived lane can still step out to the nearest real neighbour, one
 * position at a time, rather than jumping past several skipped lanes at once.
 */
export function adjacentSwimlane(
  swimlanes: Swimlane[],
  currentSwimlaneId: string,
  direction: ColumnStepDirection,
): Swimlane | null {
  const ordered = [...swimlanes].sort((laneA, laneB) => laneA.position - laneB.position);
  const currentIndex = ordered.findIndex((lane) => lane.id === currentSwimlaneId);
  if (currentIndex === -1) return null;

  const step = direction === 'left' ? -1 : 1;
  for (let index = currentIndex + step; index >= 0 && index < ordered.length; index += step) {
    const candidate = ordered[index];
    if (candidate.role !== 'done' && !candidate.is_archived && !candidate.is_ghost) return candidate;
  }
  return null;
}

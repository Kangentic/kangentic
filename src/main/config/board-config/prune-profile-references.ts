/**
 * Main-process wrapper around the shared profile-reference pruner.
 *
 * The pure function lives in `src/shared/board-profile-references.ts` because
 * the renderer's Column Manager needs it too (it holds its own in-memory
 * `profileDrafts` snapshot). This file only adds the read-modify-write against
 * whichever profile accessors the caller has.
 */
import { pruneProfileReferencesForColumn } from '../../../shared/board-profile-references';
import type { BoardProfile } from '../../../shared/types';

/**
 * Read the board's profiles, prune a deleted column out of them, and write them
 * back only if something actually changed.
 *
 * Shared by the two main-process delete paths (the SWIMLANE_DELETE IPC handler
 * and the MCP `delete_column` handler), which reach profiles through different
 * accessors but need identical behavior.
 *
 * CALL THIS BEFORE THE kangentic.json WRITE-BACK. `buildBoardConfigFromDb`
 * carries `profiles` across from whatever is on disk, so a write-back that runs
 * first would re-serialize the stale entries this just removed.
 */
export function pruneDeletedColumnFromProfiles(
  accessors: {
    getBoardProfiles: () => BoardProfile[];
    setBoardProfiles: (profiles: BoardProfile[]) => void;
  },
  column: { columnId: string; columnName: string },
): { removedEntries: number; clearedPlanExitTargets: number } {
  const profiles = accessors.getBoardProfiles();
  if (profiles.length === 0) return { removedEntries: 0, clearedPlanExitTargets: 0 };

  const { profiles: pruned, removedEntries, clearedPlanExitTargets } =
    pruneProfileReferencesForColumn(profiles, column);
  if (removedEntries === 0 && clearedPlanExitTargets === 0) {
    return { removedEntries: 0, clearedPlanExitTargets: 0 };
  }

  accessors.setBoardProfiles(pruned);
  return { removedEntries, clearedPlanExitTargets };
}

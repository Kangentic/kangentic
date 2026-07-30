/**
 * Drop a deleted column's references out of the board's Board Profiles.
 *
 * Board Profiles live in `kangentic.json`, not the DB, so no repository or
 * foreign key reaches them: deleting a swimlane row leaves them pointing at a
 * column that no longer exists. There are TWO distinct references, keyed
 * differently, and both have to go:
 *
 *   1. `profile.columns[<swimlane uuid>]` - the per-column strategy delta. Keyed
 *      by uuid so a rename does not detach in-flight tasks (see BoardProfile).
 *   2. `entry.planExitTarget` - a column NAME, the one field in a profile entry
 *      that keeps the by-name convention it round-trips under.
 *
 * Lives in `shared/` because BOTH sides need it, for different reasons:
 *   - main prunes the on-disk profiles when a column is deleted (the IPC handler
 *     and the MCP `delete_column` handler, via `pruneDeletedColumnFromProfiles`);
 *   - the renderer's Column Manager prunes its in-memory `profileDrafts`, which
 *     it snapshots at mount and writes back WHOLE at save time. Without that,
 *     saving a staged column delete together with any profile edit would write
 *     the stale snapshot straight back over main's pruning.
 *
 * Pure: returns a new array and never mutates its input, so a caller can compare
 * against the original to decide whether a write is needed. Name matching is
 * case-insensitive and trims, matching `resolveColumn` and the Column Manager's
 * duplicate check, so a hand-written profile still gets cleaned.
 */
import type { BoardProfile } from './types';

export interface PrunedProfileReferences {
  profiles: BoardProfile[];
  /** How many `columns[uuid]` deltas were dropped, across all profiles. */
  removedEntries: number;
  /** How many `planExitTarget` values were cleared, across all profiles. */
  clearedPlanExitTargets: number;
}

export function pruneProfileReferencesForColumn(
  profiles: BoardProfile[],
  column: { columnId: string; columnName: string },
): PrunedProfileReferences {
  const targetName = column.columnName.trim().toLowerCase();
  let removedEntries = 0;
  let clearedPlanExitTargets = 0;

  const pruned = profiles.map((profile) => {
    const nextColumns: BoardProfile['columns'] = {};

    for (const [swimlaneId, entry] of Object.entries(profile.columns ?? {})) {
      if (swimlaneId === column.columnId) {
        removedEntries += 1;
        continue;
      }
      // A hand-written kangentic.json is never schema-checked here:
      // `validateBoardConfig` inspects columns and actions, never `profiles`, so
      // an entry can be null or a non-object however the type reads. Skipping it
      // matches `resolveColumnStrategy`'s `if (!entry) return base` guard. Throwing
      // would be far worse than a no-op: BOTH callers delete the swimlane row
      // BEFORE pruning, so the exception would skip the kangentic.json write-back
      // and the next project open would re-create the column from the stale file.
      if (!entry || typeof entry !== 'object') {
        nextColumns[swimlaneId] = entry;
        continue;
      }
      const pointsAtDeleted =
        typeof entry.planExitTarget === 'string'
        && entry.planExitTarget.trim().toLowerCase() === targetName;
      if (pointsAtDeleted) {
        clearedPlanExitTargets += 1;
        // Drop the key rather than writing null: absent means "inherit the
        // column's own plan-exit target", which is the right fallback. A null
        // would mean "explicitly no target", overriding the base column.
        const { planExitTarget: _cleared, ...rest } = entry;
        nextColumns[swimlaneId] = rest;
        continue;
      }
      nextColumns[swimlaneId] = entry;
    }

    return { ...profile, columns: nextColumns };
  });

  return { profiles: pruned, removedEntries, clearedPlanExitTargets };
}

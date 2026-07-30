/**
 * Board Profiles live in kangentic.json with no foreign key, so deleting a
 * column leaves them pointing at a lane that no longer exists. Two references,
 * keyed differently: `columns[<uuid>]` and the nested `planExitTarget` (a NAME).
 * Both used to survive a delete.
 */
import { describe, it, expect, vi } from 'vitest';
import { pruneProfileReferencesForColumn } from '../../src/shared/board-profile-references';
import { pruneDeletedColumnFromProfiles } from '../../src/main/config/board-config/prune-profile-references';
import type { BoardProfile } from '../../src/shared/types';

function makeProfile(overrides: Partial<BoardProfile> = {}): BoardProfile {
  return {
    id: 'profile-1',
    name: 'Heavy',
    columns: {},
    ...overrides,
  };
}

describe('pruneProfileReferencesForColumn', () => {
  it('drops the deleted column\'s delta, keyed by swimlane uuid', () => {
    const profiles = [makeProfile({
      columns: {
        'lane-doomed': { modelOverride: 'opus' },
        'lane-keep': { modelOverride: 'sonnet' },
      },
    })];

    const result = pruneProfileReferencesForColumn(profiles, {
      columnId: 'lane-doomed',
      columnName: 'Brand Review',
    });

    expect(Object.keys(result.profiles[0].columns)).toEqual(['lane-keep']);
    expect(result.removedEntries).toBe(1);
    expect(result.clearedPlanExitTargets).toBe(0);
  });

  it('clears a planExitTarget naming the deleted column, matching case-insensitively', () => {
    const profiles = [makeProfile({
      columns: {
        'lane-planning': { planExitTarget: '  brand review  ', modelOverride: 'opus' },
      },
    })];

    const result = pruneProfileReferencesForColumn(profiles, {
      columnId: 'lane-doomed',
      columnName: 'Brand Review',
    });

    // The key is DROPPED, not set to null: absent means "inherit the column's
    // own plan-exit target", while null would mean "explicitly no target" and
    // would override the base column.
    expect(result.profiles[0].columns['lane-planning']).not.toHaveProperty('planExitTarget');
    expect(result.profiles[0].columns['lane-planning'].modelOverride).toBe('opus');
    expect(result.clearedPlanExitTargets).toBe(1);
  });

  it('leaves a planExitTarget naming a different column alone', () => {
    const profiles = [makeProfile({
      columns: { 'lane-planning': { planExitTarget: 'Executing' } },
    })];

    const result = pruneProfileReferencesForColumn(profiles, {
      columnId: 'lane-doomed',
      columnName: 'Brand Review',
    });

    expect(result.profiles[0].columns['lane-planning'].planExitTarget).toBe('Executing');
    expect(result.clearedPlanExitTargets).toBe(0);
  });

  it('cleans every profile, not just the first', () => {
    const profiles = [
      makeProfile({ id: 'profile-1', name: 'Heavy', columns: { 'lane-doomed': { modelOverride: 'opus' } } }),
      makeProfile({ id: 'profile-2', name: 'Cheap', columns: { 'lane-doomed': { modelOverride: 'sonnet' } } }),
    ];

    const result = pruneProfileReferencesForColumn(profiles, {
      columnId: 'lane-doomed',
      columnName: 'Brand Review',
    });

    expect(result.removedEntries).toBe(2);
    expect(result.profiles.every((profile) => Object.keys(profile.columns).length === 0)).toBe(true);
  });

  it('never mutates the input', () => {
    const profiles = [makeProfile({ columns: { 'lane-doomed': { modelOverride: 'opus' } } })];

    pruneProfileReferencesForColumn(profiles, { columnId: 'lane-doomed', columnName: 'Brand Review' });

    expect(profiles[0].columns).toHaveProperty('lane-doomed');
  });

  // ---------------------------------------------------------------------
  // Malformed profiles - `profiles` in kangentic.json is never schema-checked
  // (validateBoardConfig inspects columns and actions, never `profiles`), so a
  // hand-edited file can carry a null column entry or a non-string
  // planExitTarget. Both callers delete the swimlane row BEFORE pruning, so a
  // throw here would skip the kangentic.json write-back entirely and the next
  // project open would re-create the deleted column from the stale file.
  // ---------------------------------------------------------------------

  it('does not throw on a null column entry, and only the deleted column\'s entry is removed', () => {
    // Revert proof: removing the `!entry || typeof entry !== 'object'` guard in
    // board-profile-references.ts makes this throw a TypeError reading
    // `entry.planExitTarget` off null, instead of a clean no-op pass-through.
    const profiles = [makeProfile({
      columns: {
        'lane-doomed': { modelOverride: 'opus' },
        'lane-malformed': null,
      } as unknown as BoardProfile['columns'],
    })];

    expect(() => pruneProfileReferencesForColumn(profiles, {
      columnId: 'lane-doomed',
      columnName: 'Brand Review',
    })).not.toThrow();

    const result = pruneProfileReferencesForColumn(profiles, {
      columnId: 'lane-doomed',
      columnName: 'Brand Review',
    });

    expect(result.profiles[0].columns).not.toHaveProperty('lane-doomed');
    // Passed through untouched: the key survives with its null value intact,
    // not dropped or coerced.
    expect(result.profiles[0].columns).toHaveProperty('lane-malformed', null);
    expect(result.removedEntries).toBe(1);
  });

  it('does not throw and does not mistake a non-string planExitTarget for a match', () => {
    // This one pins a DIFFERENT guard than the null-entry test above: the
    // pre-existing `typeof entry.planExitTarget === 'string'` narrowing.
    // Revert proof: dropping that `typeof` check (so the expression reads
    // `entry.planExitTarget.trim().toLowerCase() === targetName`) makes this
    // throw a TypeError, since `.trim()` does not exist on a number.
    const profiles = [makeProfile({
      columns: {
        'lane-planning': { planExitTarget: 42 } as unknown as BoardProfile['columns'][string],
      },
    })];

    expect(() => pruneProfileReferencesForColumn(profiles, {
      columnId: 'lane-doomed',
      columnName: 'Brand Review',
    })).not.toThrow();

    const result = pruneProfileReferencesForColumn(profiles, {
      columnId: 'lane-doomed',
      columnName: 'Brand Review',
    });

    expect(result.profiles[0].columns['lane-planning'].planExitTarget).toBe(42);
    expect(result.clearedPlanExitTargets).toBe(0);
  });
});

describe('pruneDeletedColumnFromProfiles', () => {
  it('does not write when no profile referenced the column', () => {
    const setBoardProfiles = vi.fn();
    const profiles = [makeProfile({ columns: { 'lane-keep': { modelOverride: 'opus' } } })];

    const result = pruneDeletedColumnFromProfiles(
      { getBoardProfiles: () => profiles, setBoardProfiles },
      { columnId: 'lane-doomed', columnName: 'Brand Review' },
    );

    expect(setBoardProfiles).not.toHaveBeenCalled();
    expect(result).toEqual({ removedEntries: 0, clearedPlanExitTargets: 0 });
  });

  it('does not write when the board has no profiles at all', () => {
    const setBoardProfiles = vi.fn();

    pruneDeletedColumnFromProfiles(
      { getBoardProfiles: () => [], setBoardProfiles },
      { columnId: 'lane-doomed', columnName: 'Brand Review' },
    );

    expect(setBoardProfiles).not.toHaveBeenCalled();
  });

  it('writes the pruned list back when something referenced the column', () => {
    const setBoardProfiles = vi.fn();
    const profiles = [makeProfile({ columns: { 'lane-doomed': { modelOverride: 'opus' } } })];

    const result = pruneDeletedColumnFromProfiles(
      { getBoardProfiles: () => profiles, setBoardProfiles },
      { columnId: 'lane-doomed', columnName: 'Brand Review' },
    );

    expect(setBoardProfiles).toHaveBeenCalledOnce();
    expect(Object.keys(setBoardProfiles.mock.calls[0][0][0].columns)).toEqual([]);
    expect(result.removedEntries).toBe(1);
  });
});

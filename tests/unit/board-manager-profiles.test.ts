/**
 * Column Manager profile editing: the fold/diff pair that lets every field in
 * the existing column form edit a profile without being individually rewired.
 *
 * `foldProfileOverDraft` produces what the form displays (base column + the
 * profile's delta); `diffStrategyAgainstBase` reduces an edited lane back to
 * just the differences. Storing a DIFF rather than a copy is what keeps a
 * profile tracking its column when that column later changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  foldProfileOverDraft,
  diffStrategyAgainstBase,
  carryUnmappedEntryKeys,
} from '../../src/renderer/components/dialogs/BoardManagerDialog';
import type { BoardProfile, BoardProfileEntry, Swimlane } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BOARD_MANAGER_DIALOG_PATH = path.join(
  REPO_ROOT,
  'src/renderer/components/dialogs/BoardManagerDialog.tsx',
);

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-executing',
    name: 'Executing',
    description: null,
    role: null,
    position: 2,
    color: '#3b82f6',
    icon: 'square-terminal',
    is_archived: false,
    is_ghost: false,
    permission_mode: 'auto',
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: 'claude-opus-5',
    effort_override: 'high',
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProfile(columns: BoardProfile['columns']): BoardProfile {
  return { id: 'profile-frugal', name: 'Frugal', columns };
}

describe('foldProfileOverDraft', () => {
  it('returns the base column untouched when no profile is selected', () => {
    const base = makeLane();
    expect(foldProfileOverDraft(base, null)).toBe(base);
  });

  it('returns the base column when the profile has no entry for it', () => {
    const base = makeLane();
    expect(foldProfileOverDraft(base, makeProfile({ 'other-lane': { modelOverride: 'x' } }))).toBe(base);
  });

  it('applies the profile delta over the base', () => {
    const folded = foldProfileOverDraft(
      makeLane(),
      makeProfile({ 'lane-executing': { modelOverride: 'claude-sonnet-5' } }),
    );
    expect(folded?.model_override).toBe('claude-sonnet-5');
    expect(folded?.effort_override).toBe('high'); // untouched, inherited
  });

  // The case a `??`-based fold gets wrong: the form must show "agent default"
  // for a profile that explicitly clears a base column's pin.
  it('honors an explicit null as CLEAR, not inherit', () => {
    const folded = foldProfileOverDraft(
      makeLane({ model_override: 'claude-opus-5' }),
      makeProfile({ 'lane-executing': { modelOverride: null } }),
    );
    expect(folded?.model_override).toBeNull();
  });

  it('never mutates the base column', () => {
    const base = makeLane();
    foldProfileOverDraft(base, makeProfile({ 'lane-executing': { modelOverride: 'claude-sonnet-5' } }));
    expect(base.model_override).toBe('claude-opus-5');
  });

  it('leaves column identity alone - it is shared across profiles', () => {
    const folded = foldProfileOverDraft(
      makeLane(),
      makeProfile({ 'lane-executing': { modelOverride: 'claude-sonnet-5' } }),
    );
    expect(folded?.name).toBe('Executing');
    expect(folded?.color).toBe('#3b82f6');
    expect(folded?.icon).toBe('square-terminal');
    expect(folded?.position).toBe(2);
  });
});

describe('diffStrategyAgainstBase', () => {
  it('is empty when nothing differs, so the column key gets dropped entirely', () => {
    const base = makeLane();
    expect(diffStrategyAgainstBase(makeLane(), base)).toEqual({});
  });

  it('stores only the fields that differ', () => {
    const base = makeLane();
    const edited = makeLane({ model_override: 'claude-sonnet-5' });
    expect(diffStrategyAgainstBase(edited, base)).toEqual({ modelOverride: 'claude-sonnet-5' });
  });

  // Round-trip of the clear case: picking "agent default" against a base column
  // that pins a model has to persist as an explicit null, not as an omission.
  it('stores an explicit null when the edit clears a base pin', () => {
    const base = makeLane({ model_override: 'claude-opus-5' });
    const edited = makeLane({ model_override: null });
    expect(diffStrategyAgainstBase(edited, base)).toEqual({ modelOverride: null });
  });

  it('omits a field that was cleared but was already null on the base', () => {
    const base = makeLane({ agent_override: null });
    const edited = makeLane({ agent_override: null });
    expect(diffStrategyAgainstBase(edited, base).agentOverride).toBeUndefined();
  });

  it('covers the non-string strategy fields too', () => {
    const base = makeLane({ auto_spawn: true, handoff_context: false, session_target: 'main' });
    const edited = makeLane({ auto_spawn: false, handoff_context: true, session_target: 'isolated' });
    expect(diffStrategyAgainstBase(edited, base)).toEqual({
      autoSpawn: false,
      handoffContext: true,
      sessionTarget: 'isolated',
    });
  });

  it('never records column identity, even when it differs', () => {
    const base = makeLane();
    const edited = makeLane({ name: 'Renamed', color: '#ff0000', position: 9 });
    expect(diffStrategyAgainstBase(edited, base)).toEqual({});
  });

  it('round-trips: fold(diff(edited)) reproduces the edited lane', () => {
    const base = makeLane();
    const edited = makeLane({ model_override: null, effort_override: 'xhigh', auto_spawn: false });
    const profile = makeProfile({ 'lane-executing': diffStrategyAgainstBase(edited, base) });
    const folded = foldProfileOverDraft(base, profile);
    expect(folded?.model_override).toBeNull();
    expect(folded?.effort_override).toBe('xhigh');
    expect(folded?.auto_spawn).toBe(false);
  });
});

describe('carryUnmappedEntryKeys', () => {
  it('drops the mapped key and keeps the key PROFILE_FIELD_MAP does not cover', () => {
    const existingEntry: BoardProfileEntry = { planExitTarget: 'Executing', modelOverride: 'opus' };
    expect(carryUnmappedEntryKeys(existingEntry)).toEqual({ planExitTarget: 'Executing' });
  });

  it('returns an empty entry for an undefined prior entry', () => {
    expect(carryUnmappedEntryKeys(undefined)).toEqual({});
  });
});

describe('Board Manager profile save: unmapped entry keys survive an unrelated edit (regression)', () => {
  // Bug: `updateDraft`'s profile branch rebuilt the stored entry purely from
  // `diffStrategyAgainstBase` (which only covers PROFILE_FIELD_MAP) and then
  // REPLACED the stored entry wholesale (`nextColumns[activeId] = nextEntry`).
  // `planExitTarget` cannot be a PROFILE_FIELD_MAP entry - it is a column NAME,
  // not a Swimlane uuid field - yet it is fully settable through
  // `kangentic_update_board_profile`. It was silently destroyed the moment a
  // user edited any OTHER field (e.g. modelOverride) of that column under that
  // profile.
  it('carries a prior planExitTarget forward when only modelOverride changes', () => {
    const base = makeLane({ model_override: 'claude-opus-5' });
    const existingEntry: BoardProfileEntry = { planExitTarget: 'Executing', modelOverride: 'claude-opus-5' };
    const edited = makeLane({ model_override: 'claude-sonnet-5' });

    const nextEntry = diffStrategyAgainstBase(edited, base);
    const mergedEntry = { ...carryUnmappedEntryKeys(existingEntry), ...nextEntry };

    expect(mergedEntry).toEqual({ planExitTarget: 'Executing', modelOverride: 'claude-sonnet-5' });
  });

  // The composition test above only proves the two exported helpers compose
  // correctly in isolation - it calls neither `updateDraft` nor any component
  // code, so it cannot detect a regression in the save path itself: a revert
  // to `nextColumns[activeId] = nextEntry` (dropping the carry-forward merge)
  // would leave it green. Pin the actual wiring the way
  // column-strategy-parity.test.ts pins `applyProfileToLane` call sites: a
  // direct source check for the merge expression `updateDraft` must apply.
  it('updateDraft\'s profile save path actually merges carryUnmappedEntryKeys before storing (source check)', () => {
    const source = fs.readFileSync(BOARD_MANAGER_DIALOG_PATH, 'utf-8');
    expect(
      source,
      'BoardManagerDialog.tsx no longer merges carryUnmappedEntryKeys(...) into the stored profile '
      + 'entry before saving. A wholesale `nextColumns[activeId] = nextEntry` replace silently '
      + 'destroys any entry key PROFILE_FIELD_MAP does not cover (e.g. planExitTarget) on the next '
      + 'unrelated edit to that column under that profile.',
    ).toContain('...carryUnmappedEntryKeys(profile.columns[activeId]), ...nextEntry');
  });
});

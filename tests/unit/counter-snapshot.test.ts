/**
 * Unit tests for the audit-log counter snapshot helpers. `snapshotCounters`
 * captures the five predicate-relevant fields from engine state (collapsing
 * named + anonymous bg shells into one `bgShells` total); `formatCounterDelta`
 * renders the human-readable delta the activity audit log shows next to each
 * transition. These feed diagnostics only, but they are the lens the team
 * reads engine behavior through, so every render branch is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { snapshotCounters, formatCounterDelta } from '../../src/main/activity-engine/engine/counter-snapshot';
import { createSessionEngineState } from '../../src/main/activity-engine/engine/state-factory';
import type { CountersSnapshot } from '../../src/main/activity-engine/engine/shapes';

describe('snapshotCounters', () => {
  it('captures all-zero counters from a fresh session state', () => {
    const snapshot = snapshotCounters(createSessionEngineState());
    expect(snapshot).toEqual({
      pendingToolCount: 0,
      subagentDepth: 0,
      bgShells: 0,
      turnActive: false,
      permissionPending: false,
    });
  });

  it('reflects mutated counters and flags', () => {
    const state = createSessionEngineState();
    state.pendingToolCount = 2;
    state.subagentDepth = 1;
    state.turnActive = true;
    state.permissionPending = true;
    const snapshot = snapshotCounters(state);
    expect(snapshot).toMatchObject({
      pendingToolCount: 2,
      subagentDepth: 1,
      turnActive: true,
      permissionPending: true,
    });
  });

  it('sums named (Set) and anonymous bg shells into one bgShells total', () => {
    const state = createSessionEngineState();
    state.activeBackgroundShellIds.add('bx6k8r2cr');
    state.activeBackgroundShellIds.add('beg7osflu');
    state.anonymousBackgroundShellCount = 3;
    expect(snapshotCounters(state).bgShells).toBe(5);
  });
});

describe('formatCounterDelta', () => {
  const ZERO: CountersSnapshot = {
    pendingToolCount: 0,
    subagentDepth: 0,
    bgShells: 0,
    turnActive: false,
    permissionPending: false,
  };

  function withFields(overrides: Partial<CountersSnapshot>): CountersSnapshot {
    return { ...ZERO, ...overrides };
  }

  it('returns undefined when nothing changed', () => {
    expect(formatCounterDelta(ZERO, ZERO)).toBeUndefined();
  });

  describe('numeric counters render as a signed delta', () => {
    it('tools +N for an increase', () => {
      expect(formatCounterDelta(ZERO, withFields({ pendingToolCount: 1 }))).toBe('tools +1');
    });
    it('tools -N (no plus) for a decrease', () => {
      expect(formatCounterDelta(withFields({ pendingToolCount: 2 }), ZERO)).toBe('tools -2');
    });
    it('subagent +N / -N', () => {
      expect(formatCounterDelta(ZERO, withFields({ subagentDepth: 1 }))).toBe('subagent +1');
      expect(formatCounterDelta(withFields({ subagentDepth: 1 }), ZERO)).toBe('subagent -1');
    });
    it('bg +N / -N', () => {
      expect(formatCounterDelta(ZERO, withFields({ bgShells: 3 }))).toBe('bg +3');
      expect(formatCounterDelta(withFields({ bgShells: 3 }), withFields({ bgShells: 1 }))).toBe('bg -2');
    });
  });

  describe('boolean flags render as the new value (yes/no)', () => {
    it('turn yes when turnActive goes false -> true', () => {
      expect(formatCounterDelta(ZERO, withFields({ turnActive: true }))).toBe('turn yes');
    });
    it('turn no when turnActive goes true -> false', () => {
      expect(formatCounterDelta(withFields({ turnActive: true }), ZERO)).toBe('turn no');
    });
    it('perm yes / perm no', () => {
      expect(formatCounterDelta(ZERO, withFields({ permissionPending: true }))).toBe('perm yes');
      expect(formatCounterDelta(withFields({ permissionPending: true }), ZERO)).toBe('perm no');
    });
  });

  it('joins multiple changes in field order with ", "', () => {
    const before = withFields({ pendingToolCount: 1, turnActive: true });
    const after = withFields({ pendingToolCount: 0, subagentDepth: 1, bgShells: 2, turnActive: false, permissionPending: true });
    expect(formatCounterDelta(before, after)).toBe('tools -1, subagent +1, bg +2, turn no, perm yes');
  });
});

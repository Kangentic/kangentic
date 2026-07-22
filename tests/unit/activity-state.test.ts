/**
 * Unit tests for the classification TABLE VALUES in src/shared/activity-state.ts.
 *
 * The compile-time `satisfies Record<ActivityState, ActivityDisposition>` guard
 * guarantees EXHAUSTIVENESS - a missing variant fails tsc. But it does NOT
 * guarantee CORRECTNESS: swapping idle->'active' or thinking->'idle' in the
 * table still compiles. These tests pin the actual runtime mapping so a wrong
 * disposition assignment is caught at test time, not just at compile time.
 *
 * The existing tests/unit/activity-state-classification.test.ts is a STATIC
 * SOURCE SCAN that enforces "no hand-rolled bucket comparisons in renderer
 * code". It never imports or calls the classifier functions. This file tests
 * the RUNTIME VALUES of those functions - a complementary, distinct concern.
 */
import { describe, it, expect } from 'vitest';
import type { ActivityState } from '../../src/shared/types';
import {
  requiresUserInteraction,
  isActive,
  dispositionOf,
} from '../../src/shared/activity-state';

// Every ActivityState variant. Adding a new variant here (after adding it to
// the type) is the reminder to also classify it in ACTIVITY_DISPOSITION.
const ALL_ACTIVITY_STATES: ActivityState[] = ['idle', 'permission', 'thinking'];

// ---------------------------------------------------------------------------
// requiresUserInteraction: true for 'idle' and 'permission', false otherwise.
//
// This is the "does the user need to act?" question. Both 'idle' (agent
// finished its turn) and 'permission' (agent is blocked waiting for approval)
// require user interaction. 'thinking' (agent is working) does not.
// ---------------------------------------------------------------------------

describe('requiresUserInteraction - full table', () => {
  it('returns true for idle (agent finished its turn, waiting on user)', () => {
    expect(requiresUserInteraction('idle')).toBe(true);
  });

  it('returns true for permission (agent blocked awaiting approval)', () => {
    expect(requiresUserInteraction('permission')).toBe(true);
  });

  it('returns false for thinking (agent is actively working)', () => {
    expect(requiresUserInteraction('thinking')).toBe(false);
  });

  it('returns false for undefined (engine has not reported a state yet)', () => {
    expect(requiresUserInteraction(undefined)).toBe(false);
  });

  it('every ActivityState maps to the correct requiresUserInteraction value', () => {
    // Pin the full table so a newly-added variant that swaps the bucket is
    // immediately caught without having to read the individual tests above.
    const expected: Record<ActivityState, boolean> = {
      idle: true,
      permission: true,
      thinking: false,
    };

    for (const state of ALL_ACTIVITY_STATES) {
      expect(
        requiresUserInteraction(state),
        `requiresUserInteraction('${state}') should be ${expected[state]}`,
      ).toBe(expected[state]);
    }
  });
});

// ---------------------------------------------------------------------------
// isActive: true only for 'thinking', false for everything else.
//
// This is the "is the agent doing work right now?" question. Only 'thinking'
// is the active direction. 'idle' and 'permission' both represent states where
// the agent is waiting (for the user or for approval) - they are NOT active.
// ---------------------------------------------------------------------------

describe('isActive - full table', () => {
  it('returns true for thinking (agent is actively working)', () => {
    expect(isActive('thinking')).toBe(true);
  });

  it('returns false for idle (agent finished, waiting on user)', () => {
    expect(isActive('idle')).toBe(false);
  });

  it('returns false for permission (agent waiting for approval - not active)', () => {
    expect(isActive('permission')).toBe(false);
  });

  it('returns false for undefined (engine has not reported a state yet)', () => {
    expect(isActive(undefined)).toBe(false);
  });

  it('every ActivityState maps to the correct isActive value', () => {
    const expected: Record<ActivityState, boolean> = {
      thinking: true,
      idle: false,
      permission: false,
    };

    for (const state of ALL_ACTIVITY_STATES) {
      expect(
        isActive(state),
        `isActive('${state}') should be ${expected[state]}`,
      ).toBe(expected[state]);
    }
  });
});

// ---------------------------------------------------------------------------
// dispositionOf: the disposition VALUE ('idle' | 'active'), not just a
// boolean bucket check. Consumed by session_activity_intervals' recorder so
// the persisted `disposition` column is derived from this single table
// instead of a re-derived copy.
// ---------------------------------------------------------------------------

describe('dispositionOf - full table', () => {
  it('every ActivityState maps to the correct disposition value, agreeing with requiresUserInteraction/isActive', () => {
    const expected: Record<ActivityState, 'idle' | 'active'> = {
      idle: 'idle',
      permission: 'idle',
      thinking: 'active',
    };

    for (const state of ALL_ACTIVITY_STATES) {
      expect(dispositionOf(state), `dispositionOf('${state}') should be '${expected[state]}'`).toBe(expected[state]);
      // Cross-check against the boolean helpers so the two representations
      // of the same classification table can never silently diverge.
      expect(dispositionOf(state) === 'idle').toBe(requiresUserInteraction(state));
      expect(dispositionOf(state) === 'active').toBe(isActive(state));
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-check: the two functions are complementary for the 'thinking' vs
// idle-family split, but NOT simple negations of each other (undefined maps
// to false for both). This explicitly documents the intended relationship.
// ---------------------------------------------------------------------------

describe('requiresUserInteraction and isActive are complementary, not negations', () => {
  it('undefined returns false for both (not a contradiction - just an absent state)', () => {
    expect(requiresUserInteraction(undefined)).toBe(false);
    expect(isActive(undefined)).toBe(false);
  });

  it('every defined ActivityState is classified as exactly one of requires-interaction or active, never both', () => {
    for (const state of ALL_ACTIVITY_STATES) {
      const requiresInteraction = requiresUserInteraction(state);
      const activeState = isActive(state);
      // A state cannot simultaneously require user interaction AND be active.
      expect(
        requiresInteraction && activeState,
        `'${state}' must not be both requiresUserInteraction=true and isActive=true`,
      ).toBe(false);
      // A state must be at least one of the two (idle-family or active).
      expect(
        requiresInteraction || activeState,
        `'${state}' must be either requiresUserInteraction=true or isActive=true`,
      ).toBe(true);
    }
  });
});

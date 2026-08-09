/**
 * Unit tests for the pure helper functions exported from:
 *   src/renderer/components/debug/ActivityDebugOverlay.tsx
 *   src/renderer/components/debug/ActivityTimeline.tsx
 *
 * All helpers are module-private utilities promoted to named exports so the
 * test can import them without any mocking or rendering.
 *
 * Coverage:
 *   computeGridLayout       - grid columns and panel width for every boundary count
 *   reasonsEqual            - structural equality for every ActivityReason kind
 *   snapshotsContentEqual   - structural equality for ActivityStatsSnapshot
 *   triggerExplanation      - exact lookup, every prefix pattern, and the fallback
 *   formatSignalAge         - null, ms, seconds, and minutes branches
 *   formatHHMMSS            - zero-padding, single-digit hours/minutes/seconds
 *   pickWatchdog            - every branch of the engine's watchdog selector
 *
 * No browser globals are exercised here. Functions that reference `window`
 * (computeCenteredPosition, drag event handlers) are NOT exported and are
 * intentionally out of scope for this tier.
 */
import { describe, it, expect } from 'vitest';
import {
  computeGridLayout,
  reasonsEqual,
  snapshotsContentEqual,
  triggerExplanation,
  formatSignalAge,
  formatPtyAge,
  formatHHMMSS,
} from '../../src/renderer/components/debug/ActivityDebugOverlay';
import { pickWatchdog } from '../../src/renderer/components/debug/ActivityTimeline';
import type { ActivityReason, ActivityStatsSnapshot, ActivityState } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Constants mirrored from the component file so assertions can be derived
// rather than hardcoded. When the component changes these knobs, the tests
// will keep the right shape as long as the assertions use these constants.
// ---------------------------------------------------------------------------
const COL_WIDTH_PX = 360;
const GAP_PX = 12;
const PANEL_PADDING_X_PX = 24;
const MAX_COLS = 3;

/** Single-column width (sessionCount <= 1). */
const ONE_COL_WIDTH = COL_WIDTH_PX + PANEL_PADDING_X_PX;

function nColWidth(cols: number): number {
  return COL_WIDTH_PX * cols + GAP_PX * (cols - 1) + PANEL_PADDING_X_PX;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_COMPENSATION_COUNTERS: ActivityStatsSnapshot['compensationCounters'] = {
  staleThinking: 0,
  bgShellHatch: 0,
  stuckPendingTools: 0,
  forceThinking: 0,
  forceIdle: 0,
  unmatchedBgShellEnd: 0,
  ignoredInnerSubagentStop: 0,
  stuckSubagent: 0,
};

function makeSnapshot(overrides: Partial<ActivityStatsSnapshot> = {}): ActivityStatsSnapshot {
  return {
    sessionId: 'session-1',
    activity: 'idle' as ActivityState,
    reason: { kind: 'idle', since: 1700000000000 } as ActivityReason,
    pendingToolCount: 0,
    subagentDepth: 0,
    backgroundShellIds: [],
    anonymousBackgroundShellCount: 0,
    exemptBackgroundShellIds: [],
    turnActive: false,
    permissionPending: false,
    msSinceLastSignal: null,
    lastSignalAt: null,
    lastPtyOutputAt: null,
    msSincePtyOutput: null,
    pendingIdleArmed: false,
    needsUserSince: 1700000000000,
    recentTransitions: [],
    compensationCounters: EMPTY_COMPENSATION_COUNTERS,
    recentPtyChunks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeGridLayout
// ---------------------------------------------------------------------------

describe('computeGridLayout', () => {
  describe('single-column region (sessionCount <= 1)', () => {
    it('returns 1 column for 0 sessions', () => {
      const layout = computeGridLayout(0);
      expect(layout.cols).toBe(1);
      expect(layout.widthPx).toBe(ONE_COL_WIDTH);
    });

    it('returns 1 column for exactly 1 session', () => {
      const layout = computeGridLayout(1);
      expect(layout.cols).toBe(1);
      expect(layout.widthPx).toBe(ONE_COL_WIDTH);
    });
  });

  describe('two-column region', () => {
    it('returns 2 columns for 2 sessions', () => {
      // ceil(sqrt(2)) = ceil(1.414) = 2
      const layout = computeGridLayout(2);
      expect(layout.cols).toBe(2);
      expect(layout.widthPx).toBe(nColWidth(2));
    });

    it('returns 2 columns for 3 sessions', () => {
      // ceil(sqrt(3)) = ceil(1.732) = 2
      const layout = computeGridLayout(3);
      expect(layout.cols).toBe(2);
      expect(layout.widthPx).toBe(nColWidth(2));
    });

    it('returns 2 columns for 4 sessions', () => {
      // ceil(sqrt(4)) = 2, still under MAX_COLS=3
      const layout = computeGridLayout(4);
      expect(layout.cols).toBe(2);
      expect(layout.widthPx).toBe(nColWidth(2));
    });
  });

  describe('three-column region (capped at MAX_COLS)', () => {
    it('returns 3 columns for 5 sessions', () => {
      // ceil(sqrt(5)) = ceil(2.236) = 3
      const layout = computeGridLayout(5);
      expect(layout.cols).toBe(MAX_COLS);
      expect(layout.widthPx).toBe(nColWidth(MAX_COLS));
    });

    it('returns 3 columns for 9 sessions', () => {
      // ceil(sqrt(9)) = 3, exactly MAX_COLS
      const layout = computeGridLayout(9);
      expect(layout.cols).toBe(MAX_COLS);
      expect(layout.widthPx).toBe(nColWidth(MAX_COLS));
    });

    it('caps at 3 columns for 10 sessions (scroll threshold)', () => {
      // ceil(sqrt(10)) = 4, but MAX_COLS=3 caps it
      const layout = computeGridLayout(10);
      expect(layout.cols).toBe(MAX_COLS);
      expect(layout.widthPx).toBe(nColWidth(MAX_COLS));
    });

    it('caps at 3 columns for large session counts', () => {
      const layout = computeGridLayout(100);
      expect(layout.cols).toBe(MAX_COLS);
      expect(layout.widthPx).toBe(nColWidth(MAX_COLS));
    });
  });

  it('widthPx formula is stable: COL_WIDTH * cols + GAP * (cols-1) + PADDING', () => {
    for (const sessionCount of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const { cols, widthPx } = computeGridLayout(sessionCount);
      expect(widthPx).toBe(nColWidth(cols));
    }
  });
});

// ---------------------------------------------------------------------------
// reasonsEqual
// ---------------------------------------------------------------------------

describe('reasonsEqual', () => {
  it('returns true for identical reference', () => {
    const reason: ActivityReason = { kind: 'idle', since: 1700000000000 };
    expect(reasonsEqual(reason, reason)).toBe(true);
  });

  describe('kind: idle', () => {
    it('returns true for two distinct idle reasons', () => {
      expect(reasonsEqual({ kind: 'idle', since: 1700000000000 }, { kind: 'idle', since: 1700000000000 })).toBe(true);
    });
  });

  describe('kind: permission', () => {
    it('returns true for two distinct permission reasons', () => {
      expect(reasonsEqual({ kind: 'permission', since: 1700000000000 }, { kind: 'permission', since: 1700000000000 })).toBe(true);
    });
  });

  describe('kind: turn-active', () => {
    it('returns true for two distinct turn-active reasons', () => {
      expect(reasonsEqual({ kind: 'turn-active' }, { kind: 'turn-active' })).toBe(true);
    });
  });

  describe('kind: tool', () => {
    it('returns true when pendingCount and currentTool match', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 2, currentTool: 'bash' };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 2, currentTool: 'bash' };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns true when both currentTool are null', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns false when pendingCount differs', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: 'bash' };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 2, currentTool: 'bash' };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when currentTool differs', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: 'bash' };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: 'read' };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when one currentTool is null and the other is not', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: 'bash' };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });
  });

  describe('kind: subagent', () => {
    it('returns true when depth matches', () => {
      const reasonA: ActivityReason = { kind: 'subagent', depth: 2 };
      const reasonB: ActivityReason = { kind: 'subagent', depth: 2 };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns false when depth differs', () => {
      const reasonA: ActivityReason = { kind: 'subagent', depth: 1 };
      const reasonB: ActivityReason = { kind: 'subagent', depth: 3 };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });
  });

  describe('kind: background-shell', () => {
    it('returns true when count and ids match', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns true for empty ids arrays', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 0, ids: [] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 0, ids: [] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns false when count differs', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 1, ids: [] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: [] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when ids length differs', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1'] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when ids differ in content', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's3'] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when ids order differs', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s2', 's1'] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });
  });

  describe('cross-kind', () => {
    it('returns false when kinds differ (idle vs permission)', () => {
      expect(reasonsEqual({ kind: 'idle', since: 1700000000000 }, { kind: 'permission', since: 1700000000000 })).toBe(false);
    });

    it('returns false when kinds differ (tool vs subagent)', () => {
      const toolReason: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      const subagentReason: ActivityReason = { kind: 'subagent', depth: 1 };
      expect(reasonsEqual(toolReason, subagentReason)).toBe(false);
    });

    it('returns false when kinds differ (background-shell vs turn-active)', () => {
      const bgReason: ActivityReason = { kind: 'background-shell', count: 0, ids: [] };
      expect(reasonsEqual(bgReason, { kind: 'turn-active' })).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// snapshotsContentEqual
// ---------------------------------------------------------------------------

describe('snapshotsContentEqual', () => {
  it('returns true for identical reference', () => {
    const snapshot = makeSnapshot();
    expect(snapshotsContentEqual(snapshot, snapshot)).toBe(true);
  });

  it('returns true for two value-equal snapshots with no transitions', () => {
    const snapshotA = makeSnapshot();
    const snapshotB = makeSnapshot();
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
  });

  it('returns false when sessionId differs', () => {
    const snapshotA = makeSnapshot({ sessionId: 'session-1' });
    const snapshotB = makeSnapshot({ sessionId: 'session-2' });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when activity state differs', () => {
    const snapshotA = makeSnapshot({ activity: 'idle' });
    const snapshotB = makeSnapshot({ activity: 'thinking' as ActivityState });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when pendingToolCount differs', () => {
    const snapshotA = makeSnapshot({ pendingToolCount: 0 });
    const snapshotB = makeSnapshot({ pendingToolCount: 1 });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when subagentDepth differs', () => {
    const snapshotA = makeSnapshot({ subagentDepth: 0 });
    const snapshotB = makeSnapshot({ subagentDepth: 1 });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when anonymousBackgroundShellCount differs', () => {
    const snapshotA = makeSnapshot({ anonymousBackgroundShellCount: 0 });
    const snapshotB = makeSnapshot({ anonymousBackgroundShellCount: 2 });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when turnActive differs', () => {
    const snapshotA = makeSnapshot({ turnActive: false });
    const snapshotB = makeSnapshot({ turnActive: true });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when permissionPending differs', () => {
    const snapshotA = makeSnapshot({ permissionPending: false });
    const snapshotB = makeSnapshot({ permissionPending: true });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when pendingIdleArmed differs', () => {
    const snapshotA = makeSnapshot({ pendingIdleArmed: false });
    const snapshotB = makeSnapshot({ pendingIdleArmed: true });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  describe('backgroundShellIds comparison', () => {
    it('returns true when both have the same ids in order', () => {
      const snapshotA = makeSnapshot({ backgroundShellIds: ['s1', 's2'] });
      const snapshotB = makeSnapshot({ backgroundShellIds: ['s1', 's2'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
    });

    it('returns false when backgroundShellIds length differs', () => {
      const snapshotA = makeSnapshot({ backgroundShellIds: ['s1'] });
      const snapshotB = makeSnapshot({ backgroundShellIds: ['s1', 's2'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when backgroundShellIds content differs', () => {
      const snapshotA = makeSnapshot({ backgroundShellIds: ['s1', 's2'] });
      const snapshotB = makeSnapshot({ backgroundShellIds: ['s1', 's3'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });
  });

  describe('exemptBackgroundShellIds comparison', () => {
    // Exempt shells do not move the ACTIVITY, so nothing else in the snapshot
    // changes when one starts or exits. That makes this comparison the only
    // thing that re-renders the overlay's exempt counter - without it, a
    // preview watcher could come and go with the tile frozen at its old value.
    it('returns true when both have the same ids in order', () => {
      const snapshotA = makeSnapshot({ exemptBackgroundShellIds: ['s1', 's2'] });
      const snapshotB = makeSnapshot({ exemptBackgroundShellIds: ['s1', 's2'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
    });

    it('returns false when exemptBackgroundShellIds length differs', () => {
      const snapshotA = makeSnapshot({ exemptBackgroundShellIds: [] });
      const snapshotB = makeSnapshot({ exemptBackgroundShellIds: ['s1'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when exemptBackgroundShellIds content differs', () => {
      const snapshotA = makeSnapshot({ exemptBackgroundShellIds: ['s1'] });
      const snapshotB = makeSnapshot({ exemptBackgroundShellIds: ['s2'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('does not confuse an exempt shell with a holding one', () => {
      const holding = makeSnapshot({ backgroundShellIds: ['s1'] });
      const exempt = makeSnapshot({ exemptBackgroundShellIds: ['s1'] });
      expect(snapshotsContentEqual(holding, exempt)).toBe(false);
    });
  });

  describe('reason comparison (delegates to reasonsEqual)', () => {
    it('returns false when reason kind differs', () => {
      const snapshotA = makeSnapshot({ reason: { kind: 'idle', since: 1700000000000 } });
      const snapshotB = makeSnapshot({ reason: { kind: 'permission', since: 1700000000000 } });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when tool reason pendingCount differs', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 2, currentTool: null };
      expect(snapshotsContentEqual(makeSnapshot({ reason: reasonA }), makeSnapshot({ reason: reasonB }))).toBe(false);
    });
  });

  describe('recentTransitions ring-buffer comparison', () => {
    it('returns true when both have empty transitions', () => {
      expect(snapshotsContentEqual(makeSnapshot({ recentTransitions: [] }), makeSnapshot({ recentTransitions: [] }))).toBe(true);
    });

    it('returns false when transition count differs', () => {
      const transition = { ts: 1000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const snapshotA = makeSnapshot({ recentTransitions: [] });
      const snapshotB = makeSnapshot({ recentTransitions: [transition] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when last-entry ts differs', () => {
      const transitionA = { ts: 1000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const transitionB = { ts: 2000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const snapshotA = makeSnapshot({ recentTransitions: [transitionA] });
      const snapshotB = makeSnapshot({ recentTransitions: [transitionB] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when last-entry trigger differs', () => {
      const transitionA = { ts: 1000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'idle' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const transitionB = { ts: 1000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'idle' as ActivityReason['kind'], trigger: 'force-thinking' };
      const snapshotA = makeSnapshot({ recentTransitions: [transitionA] });
      const snapshotB = makeSnapshot({ recentTransitions: [transitionB] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns true when same last-entry even with different middle entries (ring-buffer semantics)', () => {
      // The implementation only checks length + last entry, not middle entries,
      // because middle entries in a ring buffer cannot mutate in place.
      const lastEntry = { ts: 2000, from: 'thinking' as ActivityState, to: 'idle' as ActivityState, reasonKind: 'idle' as ActivityReason['kind'], trigger: 'force-idle' };
      const firstEntryA = { ts: 900, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const firstEntryB = { ts: 1100, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const snapshotA = makeSnapshot({ recentTransitions: [firstEntryA, lastEntry] });
      const snapshotB = makeSnapshot({ recentTransitions: [firstEntryB, lastEntry] });
      // Same length (2) and same last entry - function returns true
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
    });

    it('handles empty recentTransitions gracefully (no last entry)', () => {
      // Both have length 0 - lastA and lastB are both undefined.
      // (undefined?.ts ?? 0) === (undefined?.ts ?? 0) => 0 === 0 => true.
      // (undefined?.trigger ?? '') === (undefined?.trigger ?? '') => '' === '' => true.
      const snapshotA = makeSnapshot({ recentTransitions: [] });
      const snapshotB = makeSnapshot({ recentTransitions: [] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// triggerExplanation
// ---------------------------------------------------------------------------

describe('triggerExplanation', () => {
  // Exact-match triggers from TRIGGER_EXACT_EXPLANATIONS.
  describe('exact lookup table entries', () => {
    const EXACT_TRIGGERS = [
      'force-thinking',
      'force-idle',
      'interrupted',
      'timer:stability',
      'timer:stale-thinking',
      'timer:bg-shell-hatch',
      'event:bg-shells-adopted',
    ] as const;

    for (const trigger of EXACT_TRIGGERS) {
      it(`returns an exact explanation for "${trigger}"`, () => {
        const result = triggerExplanation(trigger, 'idle');
        // Must contain the reason hint suffix.
        expect(result).toContain('Reason at commit: idle');
        // Must NOT start with the generic fallback prefix.
        expect(result).not.toMatch(/^Trigger: /);
      });
    }

    it('appends the reasonKind in the exact-match path', () => {
      const result = triggerExplanation('force-thinking', 'tool');
      expect(result).toContain('Reason at commit: tool');
    });
  });

  describe('parameterized prefix: event:bg-shell-ended:', () => {
    it('matches any bg-shell-ended suffix', () => {
      const result = triggerExplanation('event:bg-shell-ended:abc-123', 'idle');
      expect(result).toContain('Background shell ended');
      expect(result).toContain('Reason at commit: idle');
    });

    it('uses the supplied reasonKind in the hint', () => {
      const result = triggerExplanation('event:bg-shell-ended:xyz', 'background-shell');
      expect(result).toContain('Reason at commit: background-shell');
    });
  });

  describe('parameterized prefix: event:idle:', () => {
    it('embeds the detail segment in the message', () => {
      const result = triggerExplanation('event:idle:pty-silence', 'idle');
      expect(result).toContain('"pty-silence"');
      expect(result).toContain('Reason at commit: idle');
    });

    it('works with any detail value', () => {
      const result = triggerExplanation('event:idle:permission-granted', 'permission');
      expect(result).toContain('"permission-granted"');
    });
  });

  describe('generic event: prefix', () => {
    it('embeds the event type for unknown event triggers', () => {
      const result = triggerExplanation('event:tool_start', 'tool');
      expect(result).toContain('"tool_start"');
      expect(result).toContain('processed');
      expect(result).toContain('Reason at commit: tool');
    });

    it('embeds the event type for multi-segment event triggers', () => {
      const result = triggerExplanation('event:some:unknown:event', 'subagent');
      // event: prefix is sliced, remainder is 'some:unknown:event'
      expect(result).toContain('"some:unknown:event"');
    });
  });

  describe('generic timer: prefix', () => {
    it('returns engine timer message for unknown timer triggers', () => {
      const result = triggerExplanation('timer:unknown-timer', 'idle');
      expect(result).toContain('Engine timer fired');
      expect(result).toContain('Reason at commit: idle');
    });
  });

  describe('generic fallback', () => {
    it('returns the trigger name in the fallback message for unknown triggers', () => {
      const result = triggerExplanation('some-unknown-trigger', 'idle');
      expect(result).toContain('some-unknown-trigger');
      expect(result).toContain('Reason at commit: idle');
    });

    it('fallback includes all reasonKind variants', () => {
      const kinds: ActivityReason['kind'][] = ['idle', 'permission', 'tool', 'subagent', 'background-shell', 'turn-active'];
      for (const kind of kinds) {
        const result = triggerExplanation('unknown', kind);
        expect(result).toContain(`Reason at commit: ${kind}`);
      }
    });
  });

  describe('prefix priority: exact match wins over generic prefix', () => {
    it('event:bg-shells-adopted uses exact lookup, not generic event: prefix', () => {
      const exactResult = triggerExplanation('event:bg-shells-adopted', 'idle');
      // The exact entry mentions "Watcher saw shell-like processes"
      expect(exactResult).toContain('Watcher');
      // The generic event: prefix path would say 'processed'
      expect(exactResult).not.toMatch(/^Hook event/);
    });

    it('timer:stability uses exact lookup, not generic timer: prefix', () => {
      const result = triggerExplanation('timer:stability', 'idle');
      expect(result).toContain('400ms');
      expect(result).not.toBe('Engine timer fired. Reason at commit: idle');
    });
  });
});

// ---------------------------------------------------------------------------
// formatSignalAge
// ---------------------------------------------------------------------------

describe('formatSignalAge', () => {
  it('returns null for null input (no signal received yet)', () => {
    expect(formatSignalAge(null)).toBeNull();
  });

  it('returns ms label for 0ms', () => {
    expect(formatSignalAge(0)).toBe('0ms since signal');
  });

  it('returns ms label for sub-1000ms values', () => {
    expect(formatSignalAge(500)).toBe('500ms since signal');
    expect(formatSignalAge(999)).toBe('999ms since signal');
  });

  it('returns seconds label at exactly 1000ms boundary', () => {
    // 1000ms = 1.0s, so the seconds branch applies (ms < 1000 is false)
    expect(formatSignalAge(1000)).toBe('1.0s since signal');
  });

  it('returns seconds label for values in the 1000-59999ms range', () => {
    expect(formatSignalAge(1400)).toBe('1.4s since signal');
    expect(formatSignalAge(30000)).toBe('30.0s since signal');
    expect(formatSignalAge(59999)).toBe('60.0s since signal');
  });

  it('returns minutes label at exactly 60000ms boundary', () => {
    // 60000ms = 60s = 1.0m
    expect(formatSignalAge(60000)).toBe('1.0m since signal');
  });

  it('returns minutes label for values >= 60000ms', () => {
    expect(formatSignalAge(90000)).toBe('1.5m since signal');
    expect(formatSignalAge(180000)).toBe('3.0m since signal');
    expect(formatSignalAge(300000)).toBe('5.0m since signal');
  });
});

// ---------------------------------------------------------------------------
// formatPtyAge
// ---------------------------------------------------------------------------

describe('formatPtyAge', () => {
  it('returns null for null input (no PTY chunk received yet)', () => {
    expect(formatPtyAge(null)).toBeNull();
  });

  it('returns ms label for 0ms', () => {
    expect(formatPtyAge(0)).toBe('0ms since pty');
  });

  it('returns ms label for sub-1000ms values', () => {
    expect(formatPtyAge(500)).toBe('500ms since pty');
    expect(formatPtyAge(999)).toBe('999ms since pty');
  });

  it('returns seconds label at exactly 1000ms boundary', () => {
    // 1000ms = 1.0s, so the seconds branch applies (ms < 1000 is false)
    expect(formatPtyAge(1000)).toBe('1.0s since pty');
  });

  it('returns seconds label for values in the 1000-59999ms range', () => {
    expect(formatPtyAge(1400)).toBe('1.4s since pty');
    expect(formatPtyAge(30000)).toBe('30.0s since pty');
    expect(formatPtyAge(59999)).toBe('60.0s since pty');
  });

  it('returns minutes label at exactly 60000ms boundary', () => {
    // 60000ms = 60s = 1.0m
    expect(formatPtyAge(60000)).toBe('1.0m since pty');
  });

  it('returns minutes label for values >= 60000ms', () => {
    expect(formatPtyAge(90000)).toBe('1.5m since pty');
    expect(formatPtyAge(180000)).toBe('3.0m since pty');
    expect(formatPtyAge(300000)).toBe('5.0m since pty');
  });
});

// ---------------------------------------------------------------------------
// formatHHMMSS
// ---------------------------------------------------------------------------

describe('formatHHMMSS', () => {
  it('zero-pads single-digit hours', () => {
    // Hour 3, minute 5, second 7 → "03:05:07"
    const date = new Date(2024, 0, 1, 3, 5, 7);
    expect(formatHHMMSS(date)).toBe('03:05:07');
  });

  it('zero-pads single-digit minutes', () => {
    const date = new Date(2024, 0, 1, 14, 9, 0);
    expect(formatHHMMSS(date)).toBe('14:09:00');
  });

  it('zero-pads single-digit seconds', () => {
    const date = new Date(2024, 0, 1, 10, 30, 4);
    expect(formatHHMMSS(date)).toBe('10:30:04');
  });

  it('formats midnight correctly', () => {
    const date = new Date(2024, 0, 1, 0, 0, 0);
    expect(formatHHMMSS(date)).toBe('00:00:00');
  });

  it('formats end-of-day values without overflow', () => {
    const date = new Date(2024, 0, 1, 23, 59, 59);
    expect(formatHHMMSS(date)).toBe('23:59:59');
  });

  it('produces the HH:MM:SS separator pattern', () => {
    const date = new Date(2024, 5, 15, 12, 34, 56);
    const result = formatHHMMSS(date);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(result).toBe('12:34:56');
  });
});

// ---------------------------------------------------------------------------
// pickWatchdog (from ActivityTimeline)
// ---------------------------------------------------------------------------

describe('pickWatchdog', () => {
  it('returns null when activity is idle', () => {
    const snapshot = makeSnapshot({ activity: 'idle' });
    expect(pickWatchdog(snapshot)).toBeNull();
  });

  it('returns null when activity is permission', () => {
    const snapshot = makeSnapshot({ activity: 'permission' as ActivityState });
    expect(pickWatchdog(snapshot)).toBeNull();
  });

  it('returns null when thinking but permissionPending is true', () => {
    const snapshot = makeSnapshot({ activity: 'thinking' as ActivityState, permissionPending: true });
    expect(pickWatchdog(snapshot)).toBeNull();
  });

  describe('bg-shell-hatch branch (named vs anonymous)', () => {
    it('returns the 5m named-shell cap when a named bg shell is the sole holder', () => {
      // A hook-declared (named) bg shell is positive evidence of real work,
      // so it is held to the long 5-min cap, not the short grace.
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: false,
        pendingToolCount: 0,
        subagentDepth: 0,
        backgroundShellIds: ['shell-1'],
        anonymousBackgroundShellCount: 0,
      });
      const result = pickWatchdog(snapshot);
      expect(result).not.toBeNull();
      expect(result?.shortLabel).toBe('bg-shell-hatch 5m');
      expect(result?.thresholdMs).toBe(5 * 60_000);
    });

    it('uses the 5m named cap when both named and anonymous shells are present', () => {
      // Any named shell upgrades the whole hold to the long cap.
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: false,
        pendingToolCount: 0,
        subagentDepth: 0,
        backgroundShellIds: ['shell-1'],
        anonymousBackgroundShellCount: 2,
      });
      const result = pickWatchdog(snapshot);
      expect(result?.shortLabel).toBe('bg-shell-hatch 5m');
      expect(result?.thresholdMs).toBe(5 * 60_000);
    });

    it('returns the 30s grace when only anonymous (heuristic) bg shells are held', () => {
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: false,
        pendingToolCount: 0,
        subagentDepth: 0,
        backgroundShellIds: [],
        anonymousBackgroundShellCount: 2,
      });
      const result = pickWatchdog(snapshot);
      expect(result?.shortLabel).toBe('bg-shell-hatch 30s');
      expect(result?.thresholdMs).toBe(30_000);
    });
  });

  describe('stuck-pending-tools branch (5 minutes)', () => {
    it('returns stuck-pending-tools when thinking, pendingTools>0, subagents=0, bgShells=0', () => {
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: true,
        pendingToolCount: 1,
        subagentDepth: 0,
        backgroundShellIds: [],
        anonymousBackgroundShellCount: 0,
      });
      const result = pickWatchdog(snapshot);
      expect(result).not.toBeNull();
      expect(result?.shortLabel).toBe('stuck-pending-tools 5m');
      expect(result?.thresholdMs).toBe(5 * 60_000);
    });
  });

  describe('stale-thinking branch (180 seconds)', () => {
    it('returns stale-thinking when thinking, turnActive=true, pendingTools=0, subagents=0, bgShells=0', () => {
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: true,
        pendingToolCount: 0,
        subagentDepth: 0,
        backgroundShellIds: [],
        anonymousBackgroundShellCount: 0,
      });
      const result = pickWatchdog(snapshot);
      expect(result).not.toBeNull();
      expect(result?.shortLabel).toBe('stale-thinking 180s');
      expect(result?.thresholdMs).toBe(180_000);
    });
  });

  describe('stuck-subagent branch (5 minutes)', () => {
    it('returns stuck-subagent when subagentDepth>0 is the sole holder (pendingTools=0, bgShells=0)', () => {
      // A subagent whose named terminal stop was dropped leaves subagentDepth
      // stuck > 0 with no other holder. Mirrors the engine's stuck-subagent
      // hold; without this branch the overlay showed no deadline line.
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: true,
        pendingToolCount: 0,
        subagentDepth: 2,
        backgroundShellIds: [],
        anonymousBackgroundShellCount: 0,
      });
      const result = pickWatchdog(snapshot);
      expect(result).not.toBeNull();
      expect(result?.shortLabel).toBe('stuck-subagent 5m');
      expect(result?.thresholdMs).toBe(5 * 60_000);
    });
  });

  describe('multi-holder thinking (no single watchdog applies)', () => {
    it('returns null when thinking with both a subagent and pending tools', () => {
      // stuck-subagent requires pendingToolCount=0; stuck-pending-tools
      // requires subagentDepth=0. With both non-zero, neither branch matches
      // and we fall through to the final null.
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: true,
        pendingToolCount: 1,
        subagentDepth: 1,
        backgroundShellIds: [],
        anonymousBackgroundShellCount: 0,
      });
      expect(pickWatchdog(snapshot)).toBeNull();
    });

    it('returns null when thinking with both bg shells and pending tools', () => {
      // bg-shell-hatch requires pendingTools=0; stuck-pending-tools requires
      // bgShells=0. With both non-zero, neither branch matches and we fall
      // through to the final null.
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: false,
        pendingToolCount: 1,
        subagentDepth: 0,
        backgroundShellIds: ['shell-1'],
        anonymousBackgroundShellCount: 0,
      });
      expect(pickWatchdog(snapshot)).toBeNull();
    });

    it('returns null when thinking with both a subagent and bg shells', () => {
      // stuck-subagent requires bgShells=0; bg-shell-hatch requires
      // subagentDepth=0. With both non-zero, neither matches and we fall
      // through to the final null.
      const snapshot = makeSnapshot({
        activity: 'thinking' as ActivityState,
        turnActive: false,
        pendingToolCount: 0,
        subagentDepth: 2,
        backgroundShellIds: [],
        anonymousBackgroundShellCount: 1,
      });
      expect(pickWatchdog(snapshot)).toBeNull();
    });
  });
});

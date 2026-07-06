/**
 * Unit tests for the latestRateLimits snapshot logic in session-store.ts.
 *
 * The snapshot is a shared account-wide value merged MONOTONICALLY per window
 * by `mergeRateLimitSnapshot` (see rate-limit-window.test.ts for the pure merge
 * cases). These tests exercise the three store writers that feed it:
 *  - updateUsage: folds a single session's rateLimits into the snapshot. A
 *    higher same-window value raises it; a lower same-window value (a sibling's
 *    stale cached report - the flip-flop bug) is rejected and the reference is
 *    preserved; a genuine rollover is taken wholesale.
 *  - batchUpdateUsage: folds every entry through the same merge, so the result
 *    is ORDER-INDEPENDENT (a stale entry iterated last cannot clobber a fresher
 *    one), and the reference is unchanged when nothing raised.
 *  - syncSessions: folds all cached entries through the merge. This seeds the
 *    snapshot on first sync and, on re-sync, only ever raises it - a stale
 *    cached entry can never regress an already-populated snapshot.
 *
 * All tests drive the Zustand store directly. window.electronAPI is stubbed
 * globally so module-level optional chaining in the store does not throw in
 * the Node test environment. Only sessions.* and config.* methods that the
 * targeted code paths touch are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { SessionUsage } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing the store.
// syncSessions() calls four IPC methods in parallel. We stub them with
// resolvable no-ops so await Promise.all([...]) succeeds in the Node env.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: vi.fn(),
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: {
      list: async () => [],
    },
    sessions: {
      list: async () => [],
      spawn: async () => ({}),
      kill: async () => {},
      reset: async () => {},
      suspend: async () => {},
      resume: async () => ({}),
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getActivityReasons: async () => ({}),
      getEventsCache: async () => ({}),
    },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useSessionStore } from '../../src/renderer/stores/session-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fixed reset epochs (seconds) so repeated makeRateLimits() calls share
// IDENTICAL reset times deterministically. The monotonic merge keys same-window
// vs rolled-over off resetsAt, so two calls must not drift by wall-clock jitter
// (which would be cross-platform-fragile). Rollover tests pass explicit
// overrides to advance a window's resetsAt.
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;
const FIVE_HOUR_RESET = 2_000_000 + 3600;
const SEVEN_DAY_RESET = 2_000_000 + 86400 * 5;

function makeRateLimits(
  fiveHourPct: number,
  sevenDayPct: number,
  resets?: { fiveHour?: number; sevenDay?: number },
): NonNullable<SessionUsage['rateLimits']> {
  return [
    {
      id: 'five-hour',
      label: '5h session',
      iconKind: 'session',
      usedPercentage: fiveHourPct,
      resetsAt: resets?.fiveHour ?? FIVE_HOUR_RESET,
      windowDurationSeconds: FIVE_HOUR_SECONDS,
    },
    {
      id: 'seven-day',
      label: '7d weekly',
      iconKind: 'period',
      usedPercentage: sevenDayPct,
      resetsAt: resets?.sevenDay ?? SEVEN_DAY_RESET,
      windowDurationSeconds: SEVEN_DAY_SECONDS,
    },
  ];
}

function makeUsage(rateLimits?: NonNullable<SessionUsage['rateLimits']>): SessionUsage {
  return {
    model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
    contextWindow: {
      usedPercentage: 10,
      usedTokens: 1000,
      cacheTokens: 0,
      totalInputTokens: 800,
      totalOutputTokens: 200,
      contextWindowSize: 200000,
    },
    cost: { totalCostUsd: 0.01, totalDurationMs: 3000 },
    ...(rateLimits ? { rateLimits } : {}),
  };
}

/** Reset only the fields touched by these tests to avoid cross-test leakage. */
function resetStore(): void {
  useSessionStore.setState({
    sessions: [],
    _sessionByTaskId: new Map(),
    activeSessionId: null,
    detailTaskId: null,
    dialogSessionIds: [],
    sessionUsage: {},
    latestRateLimits: null,
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionEvents: {},
    seenIdleSessions: {},
    pendingCommandLabel: {},
    spawnProgress: {},
    _pendingOpenTaskId: null,
    _pendingOpenCommandTerminal: false,
  });
}

// ---------------------------------------------------------------------------
// updateUsage
// ---------------------------------------------------------------------------

describe('updateUsage - latestRateLimits snapshot', () => {
  beforeEach(resetStore);

  it('populates latestRateLimits when the incoming usage carries rateLimits', () => {
    const rateLimits = makeRateLimits(50, 20);
    useSessionStore.getState().updateUsage('sess-a', makeUsage(rateLimits));

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(50);
    expect(snapshot!.rateLimits[1].usedPercentage).toBe(20);
    expect(snapshot!.sourceSessionId).toBe('sess-a');
  });

  it('records a capturedAt timestamp (epoch ms) close to Date.now()', () => {
    const before = Date.now();
    useSessionStore.getState().updateUsage('sess-b', makeUsage(makeRateLimits(30, 10)));
    const after = Date.now();

    const capturedAt = useSessionStore.getState().latestRateLimits!.capturedAt;
    expect(capturedAt).toBeGreaterThanOrEqual(before);
    expect(capturedAt).toBeLessThanOrEqual(after);
  });

  it('does NOT update latestRateLimits when the incoming usage has no rateLimits', () => {
    // Seed an existing snapshot for sess-a
    useSessionStore.getState().updateUsage('sess-a', makeUsage(makeRateLimits(40, 15)));
    const snapshotBefore = useSessionStore.getState().latestRateLimits;

    // Update sess-a with usage that lacks rateLimits
    useSessionStore.getState().updateUsage('sess-a', makeUsage());

    expect(useSessionStore.getState().latestRateLimits).toBe(snapshotBefore);
  });

  it('raises the snapshot when another session reports higher same-window usage', () => {
    useSessionStore.getState().updateUsage('sess-alpha', makeUsage(makeRateLimits(10, 5)));
    useSessionStore.getState().updateUsage('sess-beta', makeUsage(makeRateLimits(90, 70)));

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot!.sourceSessionId).toBe('sess-beta');
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(90);
  });

  it('rejects a lower same-window report from a stale sibling and keeps the reference (flip-flop regression)', () => {
    // The reported bug: session fresh writes 98/19, then a sibling whose CLI
    // still holds a cached 71/14 writes for the SAME windows. Last-writer-wins
    // made the pill alternate every ~5s; the merge must hold 98/19 and not even
    // allocate a new snapshot.
    useSessionStore.getState().updateUsage('sess-fresh', makeUsage(makeRateLimits(98, 19)));
    const snapshotBefore = useSessionStore.getState().latestRateLimits;

    useSessionStore.getState().updateUsage('sess-stale', makeUsage(makeRateLimits(71, 14)));

    const snapshotAfter = useSessionStore.getState().latestRateLimits;
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(snapshotAfter!.sourceSessionId).toBe('sess-fresh');
    expect(snapshotAfter!.rateLimits[0].usedPercentage).toBe(98);
    expect(snapshotAfter!.rateLimits[1].usedPercentage).toBe(19);
  });

  it('takes a rolled-over window wholesale even when the new usedPercentage is lower', () => {
    useSessionStore.getState().updateUsage('sess-a', makeUsage(makeRateLimits(96, 40)));
    // Five-hour window resets: resetsAt advances by a whole window length and
    // the percentage drops to a fresh 2. That is a genuine rollover, not stale.
    useSessionStore.getState().updateUsage(
      'sess-a',
      makeUsage(makeRateLimits(2, 40, { fiveHour: FIVE_HOUR_RESET + FIVE_HOUR_SECONDS })),
    );

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(2);
    expect(snapshot!.rateLimits[0].resetsAt).toBe(FIVE_HOUR_RESET + FIVE_HOUR_SECONDS);
  });

  it('also merges usage into sessionUsage regardless of rateLimits presence', () => {
    const usageWithRateLimits = makeUsage(makeRateLimits(25, 8));
    useSessionStore.getState().updateUsage('sess-c', usageWithRateLimits);

    const storedUsage = useSessionStore.getState().sessionUsage['sess-c'];
    expect(storedUsage).toBeDefined();
    expect(storedUsage.contextWindow.usedPercentage).toBe(10);
  });

  it('writes latestRateLimits with an empty rateLimits array (truthy check passes; renderer gates on length > 0)', () => {
    // RateLimitWindow[] is typed as an array, so [] is a valid value. The
    // if (data.rateLimits) guard in updateUsage treats [] as truthy, so the
    // snapshot IS written. The ContextBar component then gates on
    // latestRateLimits.rateLimits.length > 0 so the pill stays hidden.
    // This test documents the store-level contract: empty array triggers the
    // snapshot update; hiding is the renderer's responsibility.
    useSessionStore.getState().updateUsage('sess-empty', {
      ...makeUsage(),
      rateLimits: [],
    });

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.rateLimits).toEqual([]);
    expect(snapshot!.sourceSessionId).toBe('sess-empty');
  });

  it('does not clobber an existing snapshot when a later report carries a truthy but empty rateLimits array', () => {
    // `data.rateLimits` of `[]` is still truthy (arrays are always truthy in
    // JS regardless of length), so `if (data.rateLimits)` in updateUsage runs
    // the merge path even when the report is effectively empty. This differs
    // from the "no rateLimits when the snapshot is null" case above: here a
    // snapshot ALREADY EXISTS, so the store's own `merged !== s.latestRateLimits`
    // guard must hold end to end - mergeRateLimitSnapshot(current, { rateLimits:
    // [], ... }) has no window to compare against and returns `current`
    // unchanged, so the empty report must not reset the two populated windows
    // to an empty array or allocate a new snapshot object.
    useSessionStore.getState().updateUsage('sess-seed', makeUsage(makeRateLimits(60, 25)));
    const snapshotBefore = useSessionStore.getState().latestRateLimits;
    expect(snapshotBefore).not.toBeNull();

    useSessionStore.getState().updateUsage('sess-seed', { ...makeUsage(), rateLimits: [] });

    const snapshotAfter = useSessionStore.getState().latestRateLimits;
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(snapshotAfter!.rateLimits).toHaveLength(2);
    expect(snapshotAfter!.rateLimits[0].usedPercentage).toBe(60);
    expect(snapshotAfter!.rateLimits[1].usedPercentage).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// batchUpdateUsage - partial-fill path
// ---------------------------------------------------------------------------

describe('batchUpdateUsage - partial-fill path', () => {
  beforeEach(resetStore);

  it('folds every entry through the merge, ending at the per-window maximum', () => {
    const entries = new Map<string, SessionUsage>([
      ['sess-no-limits', makeUsage()],
      ['sess-first-limits', makeUsage(makeRateLimits(20, 5))],
      ['sess-last-limits', makeUsage(makeRateLimits(75, 60))],
    ]);

    useSessionStore.getState().batchUpdateUsage(entries);

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sourceSessionId).toBe('sess-last-limits');
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(75);
    expect(snapshot!.rateLimits[1].usedPercentage).toBe(60);
  });

  it('is order-independent: a stale entry iterated last cannot clobber a fresher earlier one', () => {
    // Fresh 75/60 is inserted FIRST, stale 20/5 LAST. Under last-writer-wins the
    // snapshot would have ended at the stale 20/5; the merge keeps 75/60.
    const entries = new Map<string, SessionUsage>([
      ['sess-fresh', makeUsage(makeRateLimits(75, 60))],
      ['sess-stale', makeUsage(makeRateLimits(20, 5))],
    ]);

    useSessionStore.getState().batchUpdateUsage(entries);

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot!.sourceSessionId).toBe('sess-fresh');
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(75);
    expect(snapshot!.rateLimits[1].usedPercentage).toBe(60);
  });

  it('preserves the reference when every entry carries only lower same-window values', () => {
    useSessionStore.getState().updateUsage('sess-seed', makeUsage(makeRateLimits(55, 30)));
    const snapshotBefore = useSessionStore.getState().latestRateLimits;

    const entries = new Map<string, SessionUsage>([
      ['sess-a', makeUsage(makeRateLimits(10, 5))],
      ['sess-b', makeUsage(makeRateLimits(20, 8))],
    ]);

    useSessionStore.getState().batchUpdateUsage(entries);

    expect(useSessionStore.getState().latestRateLimits).toBe(snapshotBefore);
  });

  it('merges all entries into sessionUsage, including those without rateLimits', () => {
    const entries = new Map<string, SessionUsage>([
      ['sess-no-limits', makeUsage()],
      ['sess-with-limits', makeUsage(makeRateLimits(30, 12))],
    ]);

    useSessionStore.getState().batchUpdateUsage(entries);

    const usageState = useSessionStore.getState().sessionUsage;
    expect(usageState['sess-no-limits']).toBeDefined();
    expect(usageState['sess-with-limits']).toBeDefined();
  });

  it('still updates latestRateLimits even when the final entry has no rateLimits but an earlier one does', () => {
    // Map iteration order: entry1 (with limits) then entry2 (without limits).
    // The last entry that had rateLimits is entry1, so snapshot stays as entry1.
    const entries = new Map<string, SessionUsage>([
      ['sess-with-limits', makeUsage(makeRateLimits(40, 15))],
      ['sess-no-limits', makeUsage()],
    ]);

    useSessionStore.getState().batchUpdateUsage(entries);

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot!.sourceSessionId).toBe('sess-with-limits');
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// batchUpdateUsage - no-op path (reference identity)
// ---------------------------------------------------------------------------

describe('batchUpdateUsage - no-op path', () => {
  beforeEach(resetStore);

  it('preserves the existing latestRateLimits reference when no entry carries rateLimits', () => {
    // Seed an initial snapshot
    useSessionStore.getState().updateUsage('sess-seed', makeUsage(makeRateLimits(55, 30)));
    const snapshotBefore = useSessionStore.getState().latestRateLimits;
    expect(snapshotBefore).not.toBeNull();

    // Batch with zero rateLimits entries
    const entries = new Map<string, SessionUsage>([
      ['sess-a', makeUsage()],
      ['sess-b', makeUsage()],
    ]);

    useSessionStore.getState().batchUpdateUsage(entries);

    // Reference identity: must be the EXACT same object, not a copy
    expect(useSessionStore.getState().latestRateLimits).toBe(snapshotBefore);
  });

  it('leaves latestRateLimits as null when starting from null and no entry carries rateLimits', () => {
    // latestRateLimits starts as null (resetStore above)
    const entries = new Map<string, SessionUsage>([
      ['sess-a', makeUsage()],
    ]);

    useSessionStore.getState().batchUpdateUsage(entries);

    expect(useSessionStore.getState().latestRateLimits).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncSessions - seed + monotonic fold path
// ---------------------------------------------------------------------------

describe('syncSessions - seed + monotonic fold path', () => {
  beforeEach(resetStore);

  it('preserves a pre-existing latestRateLimits snapshot on re-sync (rejects a stale cached entry)', async () => {
    // Pre-seed a snapshot via updateUsage (simulates IPC-delivered update
    // that arrived before the sync call).
    useSessionStore.getState().updateUsage('sess-live', makeUsage(makeRateLimits(80, 55)));
    const snapshotBefore = useSessionStore.getState().latestRateLimits;
    expect(snapshotBefore).not.toBeNull();

    // Override getUsage to return a lower same-window snapshot for sess-stale.
    // The merge rejects it (lower than the live 80/55), so the fold leaves the
    // pre-existing snapshot's exact reference in place.
    const staleRateLimits = makeRateLimits(15, 3);
    const originalGetUsage = (window as Record<string, unknown> & {
      electronAPI: { sessions: { getUsage: () => unknown } }
    }).electronAPI.sessions.getUsage;
    (window as Record<string, unknown> & {
      electronAPI: { sessions: { getUsage: (projectId?: string) => Promise<Record<string, SessionUsage>> } }
    }).electronAPI.sessions.getUsage = async () => ({
      'sess-stale': makeUsage(staleRateLimits),
    });

    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      // Restore original stub
      (window as Record<string, unknown> & {
        electronAPI: { sessions: { getUsage: () => unknown } }
      }).electronAPI.sessions.getUsage = originalGetUsage;
    }

    // The pre-existing snapshot from sess-live must be unchanged, down to the
    // exact object reference (a rejected merge returns `current`).
    const snapshotAfter = useSessionStore.getState().latestRateLimits;
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(snapshotAfter!.sourceSessionId).toBe('sess-live');
    expect(snapshotAfter!.rateLimits[0].usedPercentage).toBe(80);
    expect(snapshotAfter!.rateLimits[1].usedPercentage).toBe(55);
  });

  it('raises a pre-existing snapshot when a cached entry reports higher same-window usage on re-sync', async () => {
    // "Preserved" means "never regressed", not "frozen": a cached entry that is
    // genuinely fresher (higher same-window usage) legitimately raises it.
    useSessionStore.getState().updateUsage('sess-old', makeUsage(makeRateLimits(50, 10)));

    (window as Record<string, unknown> & {
      electronAPI: { sessions: { getUsage: (projectId?: string) => Promise<Record<string, SessionUsage>> } }
    }).electronAPI.sessions.getUsage = async () => ({
      'sess-new': makeUsage(makeRateLimits(80, 55)),
    });

    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      (window as Record<string, unknown> & {
        electronAPI: { sessions: { getUsage: () => unknown } }
      }).electronAPI.sessions.getUsage = async () => ({});
    }

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot!.sourceSessionId).toBe('sess-new');
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(80);
    expect(snapshot!.rateLimits[1].usedPercentage).toBe(55);
  });

  it('seeds order-independently: a stale cached entry iterated last does not win', async () => {
    // Object.entries preserves insertion order, so the fold sees fresh 73/41
    // FIRST and stale 18/4 LAST. The old null-guard seed took the last entry
    // (stale); the fold keeps the per-window maximum (fresh).
    (window as Record<string, unknown> & {
      electronAPI: { sessions: { getUsage: (projectId?: string) => Promise<Record<string, SessionUsage>> } }
    }).electronAPI.sessions.getUsage = async () => ({
      'sess-fresh': makeUsage(makeRateLimits(73, 41)),
      'sess-stale': makeUsage(makeRateLimits(18, 4)),
    });

    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      (window as Record<string, unknown> & {
        electronAPI: { sessions: { getUsage: () => unknown } }
      }).electronAPI.sessions.getUsage = async () => ({});
    }

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot!.sourceSessionId).toBe('sess-fresh');
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(73);
    expect(snapshot!.rateLimits[1].usedPercentage).toBe(41);
  });

  it('seeds latestRateLimits from cachedUsage when the snapshot is null (first sync)', async () => {
    // latestRateLimits starts as null
    const cachedRateLimits = makeRateLimits(22, 7);

    (window as Record<string, unknown> & {
      electronAPI: { sessions: { getUsage: (projectId?: string) => Promise<Record<string, SessionUsage>> } }
    }).electronAPI.sessions.getUsage = async () => ({
      'sess-cached': makeUsage(cachedRateLimits),
    });

    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      (window as Record<string, unknown> & {
        electronAPI: { sessions: { getUsage: () => unknown } }
      }).electronAPI.sessions.getUsage = async () => ({});
    }

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sourceSessionId).toBe('sess-cached');
    expect(snapshot!.rateLimits[0].usedPercentage).toBe(22);
  });
});

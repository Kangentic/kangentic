/**
 * Unit tests for the latestRateLimits snapshot logic in session-store.ts.
 *
 * Covered paths:
 *  - updateUsage: populates latestRateLimits whenever data.rateLimits is present
 *  - batchUpdateUsage (partial-fill): last entry with rateLimits wins; entries
 *    without rateLimits still merge into sessionUsage
 *  - batchUpdateUsage (no-op): when no entry carries rateLimits, the reference
 *    is unchanged (the `if (latestRateLimits !== s.latestRateLimits)` guard)
 *  - syncSessions (non-seeding): a pre-existing latestRateLimits snapshot is
 *    preserved when syncSessions() runs again (the `if (!nextLatestRateLimits)`
 *    guard prevents the seed loop from overwriting an already-populated value)
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
      getEventsCache: async () => ({}),
    },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useSessionStore } from '../../src/renderer/stores/session-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRateLimits(fiveHourPct: number, sevenDayPct: number): NonNullable<SessionUsage['rateLimits']> {
  return {
    fiveHour: { usedPercentage: fiveHourPct, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    sevenDay: { usedPercentage: sevenDayPct, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 5 },
  };
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
    dialogSessionId: null,
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
    expect(snapshot!.rateLimits.fiveHour.usedPercentage).toBe(50);
    expect(snapshot!.rateLimits.sevenDay.usedPercentage).toBe(20);
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

  it('overwrites a previous snapshot from another session', () => {
    useSessionStore.getState().updateUsage('sess-alpha', makeUsage(makeRateLimits(10, 5)));
    useSessionStore.getState().updateUsage('sess-beta', makeUsage(makeRateLimits(90, 70)));

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot!.sourceSessionId).toBe('sess-beta');
    expect(snapshot!.rateLimits.fiveHour.usedPercentage).toBe(90);
  });

  it('also merges usage into sessionUsage regardless of rateLimits presence', () => {
    const usageWithRateLimits = makeUsage(makeRateLimits(25, 8));
    useSessionStore.getState().updateUsage('sess-c', usageWithRateLimits);

    const storedUsage = useSessionStore.getState().sessionUsage['sess-c'];
    expect(storedUsage).toBeDefined();
    expect(storedUsage.contextWindow.usedPercentage).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// batchUpdateUsage - partial-fill path
// ---------------------------------------------------------------------------

describe('batchUpdateUsage - partial-fill path', () => {
  beforeEach(resetStore);

  it('advances latestRateLimits to the last entry in iteration order that has rateLimits', () => {
    const entries = new Map<string, SessionUsage>([
      ['sess-no-limits', makeUsage()],
      ['sess-first-limits', makeUsage(makeRateLimits(20, 5))],
      ['sess-last-limits', makeUsage(makeRateLimits(75, 60))],
    ]);

    useSessionStore.getState().batchUpdateUsage(entries);

    const snapshot = useSessionStore.getState().latestRateLimits;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sourceSessionId).toBe('sess-last-limits');
    expect(snapshot!.rateLimits.fiveHour.usedPercentage).toBe(75);
    expect(snapshot!.rateLimits.sevenDay.usedPercentage).toBe(60);
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
    expect(snapshot!.rateLimits.fiveHour.usedPercentage).toBe(40);
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
// syncSessions - non-seeding path
// ---------------------------------------------------------------------------

describe('syncSessions - non-seeding path', () => {
  beforeEach(resetStore);

  it('preserves a pre-existing latestRateLimits snapshot on re-sync (does not overwrite it)', async () => {
    // Pre-seed a snapshot via updateUsage (simulates IPC-delivered update
    // that arrived before the sync call).
    useSessionStore.getState().updateUsage('sess-live', makeUsage(makeRateLimits(80, 55)));
    const snapshotBefore = useSessionStore.getState().latestRateLimits;
    expect(snapshotBefore).not.toBeNull();

    // Override getUsage to return a different snapshot for sess-stale.
    // If the seed guard fires (bug), it would overwrite with 15/3.
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

    // The pre-existing snapshot from sess-live must be unchanged.
    const snapshotAfter = useSessionStore.getState().latestRateLimits;
    expect(snapshotAfter!.sourceSessionId).toBe('sess-live');
    expect(snapshotAfter!.rateLimits.fiveHour.usedPercentage).toBe(80);
    expect(snapshotAfter!.rateLimits.sevenDay.usedPercentage).toBe(55);
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
    expect(snapshot!.rateLimits.fiveHour.usedPercentage).toBe(22);
  });
});

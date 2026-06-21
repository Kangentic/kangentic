/**
 * Unit tests for the cache reconciliation in session-store.syncSessions().
 *
 * The contract being locked in:
 *
 *  - Eviction: when an id appears in the renderer store but is absent
 *    from the main-process cache, the renderer entry is dropped. The
 *    main engine has stopped tracking the session (suspend, respawn,
 *    full removal); the cache, not the store, is the authoritative
 *    key set.
 *
 *  - IPC-during-async-gap preservation: when an id appears in BOTH
 *    the cache and the store, the store value wins. An onActivity /
 *    onUsage / onEvent push may have delivered a fresher value
 *    between fetching the cache and applying it; syncSessions must
 *    not clobber that.
 *
 * The test pre-existed bug regression (`{ ...cached, ...current }`)
 * was that store-on-top preserved entries the cache had dropped,
 * leading to stale `sessionActivity[id] = 'thinking'` icons that
 * survived suspend/respawn and accumulated across HMR cycles.
 *
 * All tests drive the Zustand store directly. window.electronAPI is
 * stubbed globally so module-level optional chaining in the store
 * does not throw in the Node test environment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { ActivityReason, ActivityState, Session, SessionEvent, SessionUsage } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing the store.
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
      reconcile: async () => null,
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getActivityReasons: async () => ({}),
      getEventsCache: async () => ({}),
      getFirstOutput: async () => ({}),
    },
    tasks: {
      getSpawnProgress: async () => ({}),
    },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useSessionStore } from '../../src/renderer/stores/session-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(usedPercentage: number): SessionUsage {
  return {
    model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
    contextWindow: {
      usedPercentage,
      usedTokens: usedPercentage * 100,
      cacheTokens: 0,
      totalInputTokens: usedPercentage * 80,
      totalOutputTokens: usedPercentage * 20,
      contextWindowSize: 200000,
    },
    cost: { totalCostUsd: 0.01, totalDurationMs: 3000 },
  };
}

function makeEvent(detail: string): SessionEvent {
  return { ts: Date.now(), type: 'idle', detail };
}

type MockableMethod = 'getActivity' | 'getActivityReasons' | 'getUsage' | 'getEventsCache' | 'getFirstOutput' | 'list';

interface MockResults {
  getActivity?: Record<string, ActivityState>;
  getActivityReasons?: Record<string, ActivityReason>;
  getUsage?: Record<string, SessionUsage>;
  getEventsCache?: Record<string, SessionEvent[]>;
  getFirstOutput?: Record<string, boolean>;
  /** Override the (default empty) live session list returned by sessions.list(). */
  list?: Session[];
  /** Override the queryable spawn-progress map (tasks.getSpawnProgress). */
  getSpawnProgress?: Record<string, string>;
}

/**
 * Override the stubbed IPC fetch methods used by syncSessions for one
 * call, then restore the originals. Keeps cross-test state clean.
 */
async function syncWithMocks(results: MockResults): Promise<void> {
  const electronAPI = (window as Record<string, unknown> & {
    electronAPI: {
      sessions: Record<MockableMethod, () => unknown>;
      tasks: Record<'getSpawnProgress', () => unknown>;
    };
  }).electronAPI;
  const sessions = electronAPI.sessions;
  const tasks = electronAPI.tasks;
  const originals: Partial<Record<MockableMethod, unknown>> = {
    getActivity: sessions.getActivity,
    getActivityReasons: sessions.getActivityReasons,
    getUsage: sessions.getUsage,
    getEventsCache: sessions.getEventsCache,
    getFirstOutput: sessions.getFirstOutput,
    list: sessions.list,
  };
  const originalGetSpawnProgress = tasks.getSpawnProgress;
  if (results.getActivity !== undefined) {
    sessions.getActivity = (async () => results.getActivity) as () => unknown;
  }
  if (results.getActivityReasons !== undefined) {
    sessions.getActivityReasons = (async () => results.getActivityReasons) as () => unknown;
  }
  if (results.getUsage !== undefined) {
    sessions.getUsage = (async () => results.getUsage) as () => unknown;
  }
  if (results.getEventsCache !== undefined) {
    sessions.getEventsCache = (async () => results.getEventsCache) as () => unknown;
  }
  if (results.getFirstOutput !== undefined) {
    sessions.getFirstOutput = (async () => results.getFirstOutput) as () => unknown;
  }
  if (results.list !== undefined) {
    sessions.list = (async () => results.list) as () => unknown;
  }
  if (results.getSpawnProgress !== undefined) {
    tasks.getSpawnProgress = (async () => results.getSpawnProgress) as () => unknown;
  }
  try {
    await useSessionStore.getState().syncSessions();
  } finally {
    tasks.getSpawnProgress = originalGetSpawnProgress as () => unknown;
    if (originals.getActivity !== undefined) {
      sessions.getActivity = originals.getActivity as () => unknown;
    }
    if (originals.getActivityReasons !== undefined) {
      sessions.getActivityReasons = originals.getActivityReasons as () => unknown;
    }
    if (originals.getUsage !== undefined) {
      sessions.getUsage = originals.getUsage as () => unknown;
    }
    if (originals.getFirstOutput !== undefined) {
      sessions.getFirstOutput = originals.getFirstOutput as () => unknown;
    }
    if (originals.list !== undefined) {
      sessions.list = originals.list as () => unknown;
    }
    if (originals.getEventsCache !== undefined) {
      sessions.getEventsCache = originals.getEventsCache as () => unknown;
    }
  }
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
    sessionActivityReason: {},
    sessionEvents: {},
    seenIdleSessions: {},
    pendingCommandLabel: {},
    spawnProgress: {},
    _pendingOpenTaskId: null,
    _pendingOpenCommandTerminal: false,
  });
}

// ---------------------------------------------------------------------------
// Eviction: store entries absent from the cache are dropped.
// ---------------------------------------------------------------------------

describe('syncSessions - cache reconciliation evicts stale entries', () => {
  beforeEach(resetStore);

  it('drops a sessionActivity entry that no longer exists in the cache', async () => {
    // Seed two thinking sessions in the store. Then pretend the engine
    // has dropped 'sess-b' (suspend, respawn, etc.) so the cache only
    // contains 'sess-a'. The reconcile must keep 'sess-a' and evict 'sess-b'.
    useSessionStore.setState({
      sessionActivity: { 'sess-a': 'thinking', 'sess-b': 'thinking' },
    });

    await syncWithMocks({
      getActivity: { 'sess-a': 'thinking' },
    });

    const activity = useSessionStore.getState().sessionActivity;
    expect(activity).toEqual({ 'sess-a': 'thinking' });
    expect(activity['sess-b']).toBeUndefined();
  });

  it('drops a sessionUsage entry that no longer exists in the cache', async () => {
    useSessionStore.setState({
      sessionUsage: { 'sess-a': makeUsage(20), 'sess-stale': makeUsage(80) },
    });

    await syncWithMocks({
      getUsage: { 'sess-a': makeUsage(25) },
    });

    const usage = useSessionStore.getState().sessionUsage;
    expect(Object.keys(usage)).toEqual(['sess-a']);
    expect(usage['sess-stale']).toBeUndefined();
  });

  it('drops a sessionActivityReason entry that no longer exists in the cache', async () => {
    // Regression: pre-fix, sessionActivityReason was never reconciled by
    // syncSessions, so HMR / full reload left stale idle reasons in the
    // map indefinitely. The reconcile must use the same eviction
    // semantics as sessionActivity.
    const staleReason: ActivityReason = { kind: 'idle' };
    const liveReason: ActivityReason = { kind: 'turn-active' };
    useSessionStore.setState({
      sessionActivityReason: { 'sess-a': liveReason, 'sess-stale': staleReason },
    });

    await syncWithMocks({
      getActivityReasons: { 'sess-a': liveReason },
    });

    const reasons = useSessionStore.getState().sessionActivityReason;
    expect(Object.keys(reasons)).toEqual(['sess-a']);
    expect(reasons['sess-stale']).toBeUndefined();
  });

  it('drops a sessionEvents entry that no longer exists in the cache', async () => {
    useSessionStore.setState({
      sessionEvents: {
        'sess-a': [makeEvent('keep')],
        'sess-stale': [makeEvent('drop')],
      },
    });

    await syncWithMocks({
      getEventsCache: { 'sess-a': [makeEvent('keep')] },
    });

    const events = useSessionStore.getState().sessionEvents;
    expect(Object.keys(events)).toEqual(['sess-a']);
    expect(events['sess-stale']).toBeUndefined();
  });

  it('produces an empty record when the cache is empty, regardless of what the store held', async () => {
    useSessionStore.setState({
      sessionActivity: { 'sess-a': 'thinking', 'sess-b': 'idle' },
      sessionUsage: { 'sess-a': makeUsage(50) },
      sessionEvents: { 'sess-a': [makeEvent('any')] },
    });

    await syncWithMocks({
      getActivity: {},
      getUsage: {},
      getEventsCache: {},
    });

    const state = useSessionStore.getState();
    expect(state.sessionActivity).toEqual({});
    expect(state.sessionUsage).toEqual({});
    expect(state.sessionEvents).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Preservation: store entries for ids in the cache win over cache values.
// ---------------------------------------------------------------------------

describe('syncSessions - cache reconciliation preserves IPC-during-async-gap updates', () => {
  beforeEach(resetStore);

  it('keeps the store value for sessionActivity when the id is in both maps', async () => {
    // Simulates: cache snapshot says 'idle' (taken at start of sync),
    // but an onActivity push during the async gap moved it to 'thinking'
    // in the store. The reconcile must keep the store value.
    useSessionStore.setState({
      sessionActivity: { 'sess-a': 'thinking' },
    });

    await syncWithMocks({
      getActivity: { 'sess-a': 'idle' },
    });

    expect(useSessionStore.getState().sessionActivity['sess-a']).toBe('thinking');
  });

  it('keeps the store value for sessionUsage when the id is in both maps', async () => {
    const liveUsage = makeUsage(75);
    useSessionStore.setState({
      sessionUsage: { 'sess-a': liveUsage },
    });

    await syncWithMocks({
      getUsage: { 'sess-a': makeUsage(10) },
    });

    expect(useSessionStore.getState().sessionUsage['sess-a']).toBe(liveUsage);
  });

  it('keeps the store value for sessionActivityReason when the id is in both maps', async () => {
    // onActivity push during the async gap may have delivered a fresher
    // reason than the cache snapshot; reconcile must keep the store value.
    const liveReason: ActivityReason = { kind: 'turn-active' };
    const cacheReason: ActivityReason = { kind: 'idle' };
    useSessionStore.setState({
      sessionActivityReason: { 'sess-a': liveReason },
    });

    await syncWithMocks({
      getActivityReasons: { 'sess-a': cacheReason },
    });

    expect(useSessionStore.getState().sessionActivityReason['sess-a']).toBe(liveReason);
  });

  it('keeps the store value for sessionEvents when the id is in both maps', async () => {
    const liveEvents = [makeEvent('store-side-1'), makeEvent('store-side-2')];
    useSessionStore.setState({
      sessionEvents: { 'sess-a': liveEvents },
    });

    await syncWithMocks({
      getEventsCache: { 'sess-a': [makeEvent('cache-side-only')] },
    });

    expect(useSessionStore.getState().sessionEvents['sess-a']).toBe(liveEvents);
  });

  it('adds a brand-new id from the cache when the store has nothing for it', async () => {
    // 'sess-new' is absent from the store but present in cache; reconcile
    // must surface it. This is the "first sync sees a new session" path.
    useSessionStore.setState({
      sessionActivity: { 'sess-existing': 'idle' },
    });

    await syncWithMocks({
      getActivity: { 'sess-existing': 'idle', 'sess-new': 'thinking' },
    });

    const activity = useSessionStore.getState().sessionActivity;
    expect(activity['sess-existing']).toBe('idle');
    expect(activity['sess-new']).toBe('thinking');
  });
});

// ---------------------------------------------------------------------------
// HMR-resilience: missing preload method, throwing IPC, list() failure.
//
// When the renderer HMRs to code that calls a freshly-added preload IPC
// method, the running preload may not yet have it (preload changes
// require a full app restart). syncSessions must NOT throw out of
// Promise.all and leave the store at its post-HMR initial empty state -
// that breaks every xterm's session binding.
// ---------------------------------------------------------------------------

describe('syncSessions - HMR resilience: tolerates missing or failing preload methods', () => {
  beforeEach(resetStore);

  it('preserves existing sessionActivityReason when getActivityReasons is missing from the preload', async () => {
    // Simulates HMR skew: renderer code calls getActivityReasons(),
    // but the running preload bundle is older and does not have it.
    // safeFetch + the optional-call should yield undefined; the
    // reconcile branch must keep the existing store map intact.
    const liveReason: ActivityReason = { kind: 'turn-active' };
    useSessionStore.setState({
      sessionActivityReason: { 'sess-a': liveReason },
    });

    const sessions = (window as Record<string, unknown> & {
      electronAPI: { sessions: { getActivityReasons?: unknown } };
    }).electronAPI.sessions;
    const original = sessions.getActivityReasons;
    sessions.getActivityReasons = undefined;
    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      sessions.getActivityReasons = original;
    }

    // Existing reason map preserved exactly. NOT cleared/evicted.
    expect(useSessionStore.getState().sessionActivityReason['sess-a']).toBe(liveReason);
  });

  it('preserves existing sessionActivityReason when getActivityReasons rejects', async () => {
    const liveReason: ActivityReason = { kind: 'tool', tool: 'Read' };
    useSessionStore.setState({
      sessionActivityReason: { 'sess-a': liveReason },
    });

    const sessions = (window as Record<string, unknown> & {
      electronAPI: { sessions: Record<string, () => unknown> };
    }).electronAPI.sessions;
    const original = sessions.getActivityReasons;
    sessions.getActivityReasons = (async () => {
      throw new Error('IPC: handler not registered');
    }) as () => unknown;
    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      sessions.getActivityReasons = original;
    }

    expect(useSessionStore.getState().sessionActivityReason['sess-a']).toBe(liveReason);
  });

  it('bails without mutating store state when sessions.list() fails', async () => {
    // The session list is foundational. If it fails, blanking out the
    // store would unmount every xterm. Better to keep stale data until
    // the next sync succeeds.
    const liveSession: Session = makeSession({
      id: 'sess-a', taskId: 'task-a', projectId: 'proj-a',
    });
    const liveActivity: ActivityState = 'thinking';
    useSessionStore.setState({
      sessions: [liveSession],
      sessionActivity: { 'sess-a': liveActivity },
    });

    const sessions = (window as Record<string, unknown> & {
      electronAPI: { sessions: Record<string, () => unknown> };
    }).electronAPI.sessions;
    const original = sessions.list;
    sessions.list = (async () => {
      throw new Error('IPC: handler not registered');
    }) as () => unknown;
    try {
      const result = await useSessionStore.getState().syncSessions();
      expect(result).toBe(false);
    } finally {
      sessions.list = original;
    }

    // Both the sessions array and the activity cache survive untouched.
    expect(useSessionStore.getState().sessions).toEqual([liveSession]);
    expect(useSessionStore.getState().sessionActivity['sess-a']).toBe(liveActivity);
  });

  it('reconciles successful fetches even when one sibling fetch is missing', async () => {
    // Mixed scenario: the renderer HMRs to a state where one of several
    // preload methods is missing. The OTHER fetches must still reconcile
    // (so HMR isn't fully blocked - users keep getting fresh data for
    // the methods that DO exist).
    useSessionStore.setState({
      sessionActivity: { 'sess-stale': 'thinking' },
      sessionActivityReason: { 'sess-stale': { kind: 'idle' } },
    });

    const sessions = (window as Record<string, unknown> & {
      electronAPI: { sessions: { getActivityReasons?: unknown; getActivity?: () => unknown } };
    }).electronAPI.sessions;
    const originalReasons = sessions.getActivityReasons;
    const originalActivity = sessions.getActivity;
    sessions.getActivityReasons = undefined;
    sessions.getActivity = (async () => ({ 'sess-fresh': 'idle' })) as () => unknown;
    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      sessions.getActivityReasons = originalReasons;
      sessions.getActivity = originalActivity;
    }

    // sessionActivity reconciled (evicted sess-stale, added sess-fresh).
    const activity = useSessionStore.getState().sessionActivity;
    expect(activity['sess-stale']).toBeUndefined();
    expect(activity['sess-fresh']).toBe('idle');

    // sessionActivityReason preserved unchanged because the fetch was
    // unavailable (NOT evicted).
    const reasons = useSessionStore.getState().sessionActivityReason;
    expect(reasons['sess-stale']).toEqual({ kind: 'idle' });
  });
});

// ---------------------------------------------------------------------------
// reconcileSession action
//
// Contract:
//  - null no-op: when the IPC returns null, the sessions array is unchanged,
//    spawnProgress is unchanged, and the action returns null.
//  - by-id replace: when the live session shares the id of an existing row,
//    replace it in-place and clear spawnProgress[taskId].
//  - taskId-evict + add: when the live session has a NEW id but an old row
//    with the same taskId exists, evict the old row, add the new one, and
//    clear spawnProgress[taskId].
//  - spawnProgress eviction: any 'Initializing...' label for the task is
//    cleared whenever a live session arrives (both replace and evict paths).
// ---------------------------------------------------------------------------

/** Build a minimal Session object for test seeding. */
function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'taskId'>): Session {
  return {
    projectId: 'proj-test',
    pid: null,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    ...overrides,
  };
}

/**
 * Temporarily replace sessions.reconcile for one call, then restore.
 * Mirrors the syncWithMocks pattern used by the cache-reconciliation tests above.
 */
async function reconcileWith(
  returnValue: Session | null,
): Promise<Session | null> {
  const sessionsApi = (window as Record<string, unknown> & {
    electronAPI: { sessions: { reconcile: (taskId: string) => Promise<Session | null> } };
  }).electronAPI.sessions;
  const original = sessionsApi.reconcile;
  sessionsApi.reconcile = async () => returnValue;
  try {
    return await useSessionStore.getState().reconcileSession('task-a');
  } finally {
    sessionsApi.reconcile = original;
  }
}

describe('reconcileSession - null no-op', () => {
  beforeEach(resetStore);

  it('leaves sessions array unchanged when reconcile() returns null', async () => {
    const existing = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({ sessions: [existing], _sessionByTaskId: new Map([['task-a', existing]]) });

    const result = await reconcileWith(null);

    expect(result).toBeNull();
    const { sessions } = useSessionStore.getState();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toBe(existing);
  });

  it('leaves spawnProgress unchanged when reconcile() returns null', async () => {
    useSessionStore.setState({ spawnProgress: { 'task-a': 'Initializing...' } });

    await reconcileWith(null);

    expect(useSessionStore.getState().spawnProgress['task-a']).toBe('Initializing...');
  });
});

describe('reconcileSession - by-id in-place replace', () => {
  beforeEach(resetStore);

  it('replaces the existing row in-place when the live session shares the same id', async () => {
    // Seed a suspended row for the same session id. The live session
    // returns with status='running' - simulates the renderer-drifted-from-main bug.
    const staleSuspended = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [staleSuspended],
      _sessionByTaskId: new Map([['task-a', staleSuspended]]),
    });

    const liveSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'running', pid: 99 });
    const result = await reconcileWith(liveSession);

    expect(result).toBe(liveSession);
    const { sessions, _sessionByTaskId } = useSessionStore.getState();
    // Exactly one row still in the array.
    expect(sessions).toHaveLength(1);
    // The row is the live session object (replaced in-place).
    expect(sessions[0]).toBe(liveSession);
    // Index reflects the replacement.
    expect(_sessionByTaskId.get('task-a')).toBe(liveSession);
  });

  it('clears spawnProgress[taskId] on by-id replace', async () => {
    const staleSuspended = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [staleSuspended],
      _sessionByTaskId: new Map([['task-a', staleSuspended]]),
      spawnProgress: { 'task-a': 'Initializing...' },
    });

    const liveSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    expect(useSessionStore.getState().spawnProgress['task-a']).toBeUndefined();
  });

  it('does not disturb sibling sessions for other tasks on by-id replace', async () => {
    const sibling = makeSession({ id: 'sess-sibling', taskId: 'task-b', status: 'running' });
    const stale = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [stale, sibling],
      _sessionByTaskId: new Map([['task-a', stale], ['task-b', sibling]]),
    });

    const liveSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    const { sessions } = useSessionStore.getState();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === 'sess-sibling')).toBe(sibling);
  });
});

describe('reconcileSession - taskId-evict + add (respawn path)', () => {
  beforeEach(resetStore);

  it('evicts the old row and inserts the new session when the id differs', async () => {
    // Seed an old suspended session (old id). Main has respawned the task
    // under a new session id. The store should drop the old row and add the new one.
    const oldSession = makeSession({ id: 'sess-old', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [oldSession],
      _sessionByTaskId: new Map([['task-a', oldSession]]),
    });

    const liveSession = makeSession({ id: 'sess-new', taskId: 'task-a', status: 'running', pid: 42 });
    const result = await reconcileWith(liveSession);

    expect(result).toBe(liveSession);
    const { sessions, _sessionByTaskId } = useSessionStore.getState();
    // Old row is gone; new row is present.
    expect(sessions.find((s) => s.id === 'sess-old')).toBeUndefined();
    expect(sessions.find((s) => s.id === 'sess-new')).toBe(liveSession);
    expect(sessions).toHaveLength(1);
    // Index reflects new row.
    expect(_sessionByTaskId.get('task-a')).toBe(liveSession);
  });

  it('clears spawnProgress[taskId] on taskId-evict + add', async () => {
    const oldSession = makeSession({ id: 'sess-old', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [oldSession],
      _sessionByTaskId: new Map([['task-a', oldSession]]),
      spawnProgress: { 'task-a': 'Initializing...' },
    });

    const liveSession = makeSession({ id: 'sess-new', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    expect(useSessionStore.getState().spawnProgress['task-a']).toBeUndefined();
  });

  it('does not disturb sibling sessions for other tasks on evict + add', async () => {
    const sibling = makeSession({ id: 'sess-sibling', taskId: 'task-b', status: 'running' });
    const oldSession = makeSession({ id: 'sess-old', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [oldSession, sibling],
      _sessionByTaskId: new Map([['task-a', oldSession], ['task-b', sibling]]),
    });

    const liveSession = makeSession({ id: 'sess-new', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    const { sessions } = useSessionStore.getState();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === 'sess-sibling')).toBe(sibling);
  });
});

describe('reconcileSession - spawnProgress eviction on heal', () => {
  beforeEach(resetStore);

  it('clears the spawnProgress label when a live session arrives, leaving other tasks untouched', async () => {
    // Two tasks both have in-flight spawn labels. Only task-a is being reconciled.
    const staleSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [staleSession],
      _sessionByTaskId: new Map([['task-a', staleSession]]),
      spawnProgress: {
        'task-a': 'Initializing...',
        'task-b': 'Starting agent...',
      },
    });

    const liveSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    const { spawnProgress } = useSessionStore.getState();
    // task-a's label is gone (healed).
    expect(spawnProgress['task-a']).toBeUndefined();
    // task-b's label is untouched (different task, not reconciled).
    expect(spawnProgress['task-b']).toBe('Starting agent...');
  });
});

// ---------------------------------------------------------------------------
// Edge case 2: project-switch usage flash.
//
// The live session list - NOT the project-scoped usage/events snapshot - is
// the keyset authority. A running session whose usage was scoped out by the
// project filter (cross-project, or a mid-spawn undefined projectId) must keep
// its last-known usage so the card never flashes to the 0% baseline. A session
// the engine no longer tracks (absent from list, or present but exited) is
// still evicted, preserving the anti-'thinking'-leak contract.
// ---------------------------------------------------------------------------

describe('syncSessions - live session keyset authority (no project-switch usage flash)', () => {
  beforeEach(resetStore);

  it('preserves a live running session\'s usage even when the project-scoped snapshot omits it', async () => {
    const liveUsage = makeUsage(50);
    useSessionStore.setState({
      sessionUsage: { 'sess-live': liveUsage, 'sess-dead': makeUsage(80) },
    });

    await syncWithMocks({
      // Live session present in the unscoped list...
      list: [makeSession({ id: 'sess-live', taskId: 't1', status: 'running' })],
      // ...but the project-scoped usage snapshot returned nothing for it.
      getUsage: {},
    });

    const usage = useSessionStore.getState().sessionUsage;
    // Live session keeps its last-known usage (no flash).
    expect(usage['sess-live']).toBe(liveUsage);
    // Session the engine no longer tracks at all is still evicted.
    expect(usage['sess-dead']).toBeUndefined();
  });

  it('preserves a live running session\'s events the same way', async () => {
    const liveEvents = [makeEvent('keep-me')];
    useSessionStore.setState({
      sessionEvents: { 'sess-live': liveEvents, 'sess-dead': [makeEvent('drop-me')] },
    });

    await syncWithMocks({
      list: [makeSession({ id: 'sess-live', taskId: 't1', status: 'running' })],
      getEventsCache: {},
    });

    const events = useSessionStore.getState().sessionEvents;
    expect(events['sess-live']).toBe(liveEvents);
    expect(events['sess-dead']).toBeUndefined();
  });

  it('still evicts usage for a session present in the list but no longer live (exited)', async () => {
    useSessionStore.setState({
      sessionUsage: { 'sess-exited': makeUsage(40) },
    });

    await syncWithMocks({
      // The session lingers in the registry list but has exited - not live,
      // so live-keep must NOT retain its usage.
      list: [makeSession({ id: 'sess-exited', taskId: 't1', status: 'exited' })],
      getUsage: {},
    });

    expect(useSessionStore.getState().sessionUsage['sess-exited']).toBeUndefined();
  });

  it('keeps usage for a queued session (counts as live)', async () => {
    const queuedUsage = makeUsage(0);
    useSessionStore.setState({
      sessionUsage: { 'sess-queued': queuedUsage },
    });

    await syncWithMocks({
      list: [makeSession({ id: 'sess-queued', taskId: 't1', status: 'queued' })],
      getUsage: {},
    });

    expect(useSessionStore.getState().sessionUsage['sess-queued']).toBe(queuedUsage);
  });
});

// ---------------------------------------------------------------------------
// Edge case 1: HMR strand on "Starting agent...".
//
// syncSessions reconciles spawnProgress against the queryable main-process
// snapshot (tasks.getSpawnProgress) plus the live session list, so a clearing
// push lost in an HMR listener gap can no longer strand a card.
// ---------------------------------------------------------------------------

describe('syncSessions - spawnProgress reconciliation', () => {
  beforeEach(resetStore);

  it('preserves an in-flight label that the main map still reports (no live session yet)', async () => {
    useSessionStore.setState({
      spawnProgress: { 't-inflight': 'Starting agent...' },
    });

    await syncWithMocks({
      getSpawnProgress: { 't-inflight': 'Starting agent...' },
      list: [], // session not in the registry yet (pre-spawn window)
    });

    expect(useSessionStore.getState().spawnProgress['t-inflight']).toBe('Starting agent...');
  });

  it('prunes a stranded label once the task has a live session, even if the main map still holds it', async () => {
    useSessionStore.setState({
      spawnProgress: { 't-done': 'Starting agent...' },
    });

    await syncWithMocks({
      // Main map may still carry it (clear push raced), but a live session
      // exists -> the spawn is over, drop the label.
      getSpawnProgress: { 't-done': 'Starting agent...' },
      list: [makeSession({ id: 's-done', taskId: 't-done', status: 'running' })],
    });

    expect(useSessionStore.getState().spawnProgress['t-done']).toBeUndefined();
  });

  it('clears a stranded label that the main map no longer reports (spawn finished)', async () => {
    useSessionStore.setState({
      spawnProgress: { 't-strand': 'Starting agent...' },
    });

    await syncWithMocks({
      getSpawnProgress: {}, // main already cleared it; the renderer push was lost
      list: [], // no live session either
    });

    expect(useSessionStore.getState().spawnProgress['t-strand']).toBeUndefined();
  });

  it('keeps the store value for a task the main map still reports (async-gap fresher phase)', async () => {
    // A later phase label arrived in the store during the async gap; the main
    // map reports an earlier one. Since the id IS in the main map, the store
    // value wins (mirrors reconcileCache's async-gap preservation).
    useSessionStore.setState({
      spawnProgress: { 't-phase': 'Creating worktree...' },
    });

    await syncWithMocks({
      getSpawnProgress: { 't-phase': 'Fetching latest...' },
      list: [],
    });

    expect(useSessionStore.getState().spawnProgress['t-phase']).toBe('Creating worktree...');
  });

  it('on HMR/preload skew (getSpawnProgress unavailable) preserves current minus live-session tasks', async () => {
    useSessionStore.setState({
      spawnProgress: { 't-strand': 'Starting agent...', 't-done': 'Starting agent...' },
    });

    const tasks = (window as Record<string, unknown> & {
      electronAPI: { tasks: { getSpawnProgress?: unknown } };
    }).electronAPI.tasks;
    const original = tasks.getSpawnProgress;
    tasks.getSpawnProgress = undefined; // simulate older preload
    try {
      // t-done now has a live session; t-strand does not.
      const sessions = (window as Record<string, unknown> & {
        electronAPI: { sessions: Record<string, () => unknown> };
      }).electronAPI.sessions;
      const originalList = sessions.list;
      sessions.list = (async () => [makeSession({ id: 's-done', taskId: 't-done', status: 'running' })]) as () => unknown;
      try {
        await useSessionStore.getState().syncSessions();
      } finally {
        sessions.list = originalList;
      }
    } finally {
      tasks.getSpawnProgress = original;
    }

    const { spawnProgress } = useSessionStore.getState();
    expect(spawnProgress['t-strand']).toBe('Starting agent...'); // preserved
    expect(spawnProgress['t-done']).toBeUndefined(); // pruned (live session)
  });
});

// ---------------------------------------------------------------------------
// Siblings: sessionFirstOutput rebuild + pendingCommandLabel orphan prune.
// ---------------------------------------------------------------------------

describe('syncSessions - sessionFirstOutput rebuild from the main tracker', () => {
  beforeEach(resetStore);

  it('reconciles sessionFirstOutput against the tracker snapshot (evicts gone, keeps live)', async () => {
    useSessionStore.setState({
      sessionFirstOutput: { 'sess-a': true, 'sess-gone': true },
    });

    await syncWithMocks({
      getFirstOutput: { 'sess-a': true },
    });

    const firstOutput = useSessionStore.getState().sessionFirstOutput;
    expect(firstOutput['sess-a']).toBe(true);
    expect(firstOutput['sess-gone']).toBeUndefined();
  });

  it('preserves sessionFirstOutput when getFirstOutput is unavailable (HMR/preload skew)', async () => {
    useSessionStore.setState({
      sessionFirstOutput: { 'sess-a': true },
    });

    const sessions = (window as Record<string, unknown> & {
      electronAPI: { sessions: { getFirstOutput?: unknown } };
    }).electronAPI.sessions;
    const original = sessions.getFirstOutput;
    sessions.getFirstOutput = undefined;
    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      sessions.getFirstOutput = original;
    }

    expect(useSessionStore.getState().sessionFirstOutput['sess-a']).toBe(true);
  });
});

describe('syncSessions - live session keyset authority: events for a queued session', () => {
  beforeEach(resetStore);

  // sessionUsage+queued is already covered; this mirrors that test for sessionEvents.
  it('keeps events for a queued session (counts as live)', async () => {
    const queuedEvents = [makeEvent('queued-event')];
    useSessionStore.setState({
      sessionEvents: { 'sess-queued-ev': queuedEvents },
    });

    await syncWithMocks({
      list: [makeSession({ id: 'sess-queued-ev', taskId: 't-ev', status: 'queued' })],
      getEventsCache: {},
    });

    expect(useSessionStore.getState().sessionEvents['sess-queued-ev']).toBe(queuedEvents);
  });
});

describe('syncSessions - spawnProgress reconciliation: getSpawnProgress throws', () => {
  beforeEach(resetStore);

  // Mirrors the existing getActivityReasons-throws resilience test:
  // when the IPC call rejects, the store must not evict the existing
  // spawnProgress entries (same contract as the missing-method path).
  it('preserves existing spawnProgress when getSpawnProgress rejects', async () => {
    useSessionStore.setState({
      spawnProgress: { 't-strand': 'Starting agent...' },
    });

    const tasks = (window as Record<string, unknown> & {
      electronAPI: { tasks: Record<string, () => unknown> };
    }).electronAPI.tasks;
    const original = tasks.getSpawnProgress;
    tasks.getSpawnProgress = (async () => {
      throw new Error('IPC: handler not registered');
    }) as () => unknown;
    try {
      await useSessionStore.getState().syncSessions();
    } finally {
      tasks.getSpawnProgress = original;
    }

    // Entry survives - not evicted by a failed IPC call.
    expect(useSessionStore.getState().spawnProgress['t-strand']).toBe('Starting agent...');
  });
});

describe('syncSessions - pendingCommandLabel orphan prune', () => {
  beforeEach(resetStore);

  it('drops labels for tasks with neither a live session nor an in-flight spawn', async () => {
    useSessionStore.setState({
      pendingCommandLabel: {
        't-orphan': 'orphaned command',
        't-live': 'live command',
        't-spawning': 'spawning command',
      },
    });

    await syncWithMocks({
      list: [makeSession({ id: 's-live', taskId: 't-live', status: 'running' })],
      getSpawnProgress: { 't-spawning': 'Starting agent...' },
    });

    const labels = useSessionStore.getState().pendingCommandLabel;
    expect(labels['t-live']).toBe('live command'); // live session -> keep
    expect(labels['t-spawning']).toBe('spawning command'); // in-flight spawn -> keep
    expect(labels['t-orphan']).toBeUndefined(); // orphaned by HMR -> drop
  });
});

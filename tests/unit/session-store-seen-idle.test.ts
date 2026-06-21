/**
 * Unit tests for `markIdleSessionsSeen` in session-store.ts.
 *
 * The action marks running sessions that `requiresUserInteraction(state)` returns
 * true for (i.e. 'idle' AND 'permission') as seen in `seenIdleSessions`. This is
 * used for notification dedup: once the user has "seen" a session needing attention,
 * no further notification is sent until the session goes active again.
 *
 * The refactor under test changed the predicate from `=== 'idle'` to
 * `requiresUserInteraction(sessionActivity[s.id])`. A 'permission'-state session
 * must now appear in seenIdleSessions after the call, not just 'idle'-state ones.
 * A 'thinking'-state session must NEVER be included.
 *
 * All tests drive the Zustand store directly via setState. window.electronAPI is
 * stubbed globally so module-level optional chaining in the store does not throw
 * in the Node test environment. Pattern mirrors session-store-cache-reconcile.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Session } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing the store.
// markIdleSessionsSeen is synchronous and doesn't call any IPC, but the store
// module reads window.electronAPI at module load time.
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

/** Build a minimal Session for test seeding. */
function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'taskId' | 'projectId'>): Session {
  return {
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
// markIdleSessionsSeen - core contract
// ---------------------------------------------------------------------------

describe('markIdleSessionsSeen - includes both idle and permission sessions', () => {
  beforeEach(resetStore);

  it('marks an idle-state running session as seen', () => {
    const session = makeSession({ id: 'sess-idle', taskId: 'task-1', projectId: 'proj-a' });
    useSessionStore.setState({
      sessions: [session],
      sessionActivity: { 'sess-idle': 'idle' },
    });

    useSessionStore.getState().markIdleSessionsSeen('proj-a');

    expect(useSessionStore.getState().seenIdleSessions['sess-idle']).toBe(true);
  });

  it('marks a permission-state running session as seen (the critical refactor case)', () => {
    // Before the refactor, the predicate was `=== 'idle'`, so 'permission'
    // sessions were silently excluded from the seen-mark and would fire repeat
    // notifications every time the project came into focus.
    const session = makeSession({ id: 'sess-perm', taskId: 'task-2', projectId: 'proj-a' });
    useSessionStore.setState({
      sessions: [session],
      sessionActivity: { 'sess-perm': 'permission' },
    });

    useSessionStore.getState().markIdleSessionsSeen('proj-a');

    expect(useSessionStore.getState().seenIdleSessions['sess-perm']).toBe(true);
  });

  it('does NOT mark a thinking-state running session as seen', () => {
    // A 'thinking' session is actively working - it does not require user
    // interaction and must not be deduped as a notification.
    const session = makeSession({ id: 'sess-think', taskId: 'task-3', projectId: 'proj-a' });
    useSessionStore.setState({
      sessions: [session],
      sessionActivity: { 'sess-think': 'thinking' },
    });

    useSessionStore.getState().markIdleSessionsSeen('proj-a');

    expect(useSessionStore.getState().seenIdleSessions['sess-think']).toBeUndefined();
  });

  it('marks both idle and permission sessions when all three kinds coexist in the same project', () => {
    // This is the core regression test: idle is marked, permission is marked,
    // thinking is NOT marked - all in a single markIdleSessionsSeen call.
    const idleSession = makeSession({ id: 'sess-idle', taskId: 'task-1', projectId: 'proj-a' });
    const permSession = makeSession({ id: 'sess-perm', taskId: 'task-2', projectId: 'proj-a' });
    const thinkSession = makeSession({ id: 'sess-think', taskId: 'task-3', projectId: 'proj-a' });
    useSessionStore.setState({
      sessions: [idleSession, permSession, thinkSession],
      sessionActivity: {
        'sess-idle': 'idle',
        'sess-perm': 'permission',
        'sess-think': 'thinking',
      },
    });

    useSessionStore.getState().markIdleSessionsSeen('proj-a');

    const seen = useSessionStore.getState().seenIdleSessions;
    expect(seen['sess-idle']).toBe(true);
    expect(seen['sess-perm']).toBe(true);
    expect(seen['sess-think']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// markIdleSessionsSeen - project scoping
// ---------------------------------------------------------------------------

describe('markIdleSessionsSeen - project scoping', () => {
  beforeEach(resetStore);

  it('does not mark idle sessions from a different project', () => {
    const sessionA = makeSession({ id: 'sess-a', taskId: 'task-1', projectId: 'proj-a' });
    const sessionB = makeSession({ id: 'sess-b', taskId: 'task-2', projectId: 'proj-b' });
    useSessionStore.setState({
      sessions: [sessionA, sessionB],
      sessionActivity: {
        'sess-a': 'idle',
        'sess-b': 'idle',
      },
    });

    // Only mark sessions in proj-a
    useSessionStore.getState().markIdleSessionsSeen('proj-a');

    const seen = useSessionStore.getState().seenIdleSessions;
    expect(seen['sess-a']).toBe(true);
    expect(seen['sess-b']).toBeUndefined();
  });

  it('does not mark sessions with status other than running (e.g. suspended, exited)', () => {
    const suspendedSession = makeSession({
      id: 'sess-suspended',
      taskId: 'task-1',
      projectId: 'proj-a',
      status: 'suspended',
    });
    const exitedSession = makeSession({
      id: 'sess-exited',
      taskId: 'task-2',
      projectId: 'proj-a',
      status: 'exited',
    });
    useSessionStore.setState({
      sessions: [suspendedSession, exitedSession],
      sessionActivity: {
        'sess-suspended': 'idle',
        'sess-exited': 'idle',
      },
    });

    useSessionStore.getState().markIdleSessionsSeen('proj-a');

    const seen = useSessionStore.getState().seenIdleSessions;
    expect(seen['sess-suspended']).toBeUndefined();
    expect(seen['sess-exited']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// markIdleSessionsSeen - no-op when nothing qualifies
// ---------------------------------------------------------------------------

describe('markIdleSessionsSeen - no-op when nothing qualifies', () => {
  beforeEach(resetStore);

  it('does not update seenIdleSessions when there are no idle or permission sessions', () => {
    const thinkingSession = makeSession({ id: 'sess-think', taskId: 'task-1', projectId: 'proj-a' });
    useSessionStore.setState({
      sessions: [thinkingSession],
      sessionActivity: { 'sess-think': 'thinking' },
      seenIdleSessions: { 'sess-other': true },
    });

    const seenBefore = useSessionStore.getState().seenIdleSessions;
    useSessionStore.getState().markIdleSessionsSeen('proj-a');
    const seenAfter = useSessionStore.getState().seenIdleSessions;

    // No update happened - the reference is identical (no setState call)
    expect(seenAfter).toBe(seenBefore);
  });

  it('does not update seenIdleSessions when the session list is empty', () => {
    useSessionStore.setState({
      sessions: [],
      seenIdleSessions: { 'sess-pre-existing': true },
    });

    const seenBefore = useSessionStore.getState().seenIdleSessions;
    useSessionStore.getState().markIdleSessionsSeen('proj-a');
    const seenAfter = useSessionStore.getState().seenIdleSessions;

    expect(seenAfter).toBe(seenBefore);
  });
});

// ---------------------------------------------------------------------------
// markIdleSessionsSeen - preserves existing seen entries
// ---------------------------------------------------------------------------

describe('markIdleSessionsSeen - preserves pre-existing seen entries', () => {
  beforeEach(resetStore);

  it('merges new seen entries with pre-existing ones', () => {
    const newIdleSession = makeSession({ id: 'sess-new', taskId: 'task-2', projectId: 'proj-a' });
    useSessionStore.setState({
      sessions: [newIdleSession],
      sessionActivity: { 'sess-new': 'idle' },
      // Pre-existing seen entry from an earlier notification
      seenIdleSessions: { 'sess-old': true },
    });

    useSessionStore.getState().markIdleSessionsSeen('proj-a');

    const seen = useSessionStore.getState().seenIdleSessions;
    expect(seen['sess-old']).toBe(true);
    expect(seen['sess-new']).toBe(true);
  });
});

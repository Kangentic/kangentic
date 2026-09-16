/**
 * The session store's `removeSession` action (the `sessions.onRemoved` push
 * path) and the `syncSessions` guard against a stale list resurrecting a row
 * removed during its async gap.
 *
 * The measured sequence from kangentic.com #76 (#661), IPC log
 * ipc-2026-09-16.jsonl:
 *
 *   task:move        - moveTask evicts the task's rows optimistically
 *                      (withoutSessionsForTasks in task-slice.ts), rows ONLY:
 *                      sessionUsage and the other per-session maps survive
 *   session:exit     - the natural PTY exit, dropped for an intentional kill
 *   session:status   - main's remove() announcing the removal as a forced
 *                      'exited' status, 159ms AFTER the eviction
 *
 * The status handler is an upsert, so the last push re-seeded the row the
 * eviction had dropped, and the surviving usage entry filled a context bar
 * under a black terminal. The removal now arrives on its own push and this
 * action is its handler: evict, then feed the teardown's push for the same
 * id, and the row stays gone along with every keyed entry. That ordering is
 * the exact one a future refactor would silently reintroduce, which is why
 * it is pinned here rather than only in the UI tier.
 *
 * Drives the real Zustand store with `window.electronAPI` stubbed, the way
 * session-store-task-row-dedup.test.ts does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Session, SessionUsage } from '../../src/shared/types';

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
      getMessageTrails: async () => ({}),
    },
    tasks: {
      getSpawnProgress: async () => ({}),
    },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useSessionStore } from '../../src/renderer/stores/session-store';
import {
  buildSessionByTaskId,
  withoutSessionsForTasks,
} from '../../src/renderer/stores/session-store/session-index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-remove';
const TASK_ID = 'task-reset-to-todo';
const OTHER_TASK_ID = 'task-elsewhere';
const SESSION_ID = 'sess-torn-down';
const OTHER_SESSION_ID = 'sess-elsewhere';

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'taskId'>): Session {
  return {
    projectId: PROJECT_ID,
    pid: 4242,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-09-16T15:20:00.000Z',
    exitCode: null,
    resuming: false,
    agentSessionId: null,
    ...overrides,
  };
}

function makeUsage(usedPercentage: number): SessionUsage {
  return {
    model: { id: 'claude-opus-5', displayName: 'Opus 5' },
    contextWindow: {
      usedPercentage,
      usedTokens: usedPercentage * 1000,
      cacheTokens: 0,
      totalInputTokens: usedPercentage * 800,
      totalOutputTokens: usedPercentage * 200,
      contextWindowSize: 1000000,
    },
    cost: { totalCostUsd: 0.5, totalDurationMs: 18000 },
  };
}

const tornDown = makeSession({ id: SESSION_ID, taskId: TASK_ID });
const elsewhere = makeSession({ id: OTHER_SESSION_ID, taskId: OTHER_TASK_ID });

/** The store as it stood the instant before the move: a live agent with every
 *  per-session map populated for it, and an unrelated live session beside it. */
function seedLiveAgent(): void {
  const sessions = [tornDown, elsewhere];
  useSessionStore.setState({
    sessions,
    _sessionByTaskId: buildSessionByTaskId(sessions),
    activeSessionId: SESSION_ID,
    sessionUsage: { [SESSION_ID]: makeUsage(11), [OTHER_SESSION_ID]: makeUsage(3) },
    sessionFirstOutput: { [SESSION_ID]: true, [OTHER_SESSION_ID]: true },
    sessionActivity: { [SESSION_ID]: 'thinking', [OTHER_SESSION_ID]: 'idle' },
    sessionActivityReason: { [SESSION_ID]: { kind: 'turn-active' }, [OTHER_SESSION_ID]: { kind: 'idle', since: 1 } },
    sessionEvents: { [SESSION_ID]: [{ ts: 1, type: 'idle', detail: 'x' }], [OTHER_SESSION_ID]: [] },
    seenIdleSessions: { [SESSION_ID]: true },
    sessionMessageTrails: { [SESSION_ID]: [{ uuid: 'u1', ts: 1, text: 'last words' }] },
    spawnProgress: {},
    pendingCommandLabel: {},
  });
}

/** Exactly what `moveTask` does for a todo-role target (task-slice.ts). */
function evictLikeMoveTask(taskId: string): void {
  useSessionStore.setState((state) => ({
    ...withoutSessionsForTasks(state.sessions, taskId),
  }));
}

function keyedEntriesFor(sessionId: string): Record<string, boolean> {
  const state = useSessionStore.getState();
  return {
    usage: sessionId in state.sessionUsage,
    firstOutput: sessionId in state.sessionFirstOutput,
    activity: sessionId in state.sessionActivity,
    activityReason: sessionId in state.sessionActivityReason,
    events: sessionId in state.sessionEvents,
    seenIdle: sessionId in state.seenIdleSessions,
    messageTrail: sessionId in state.sessionMessageTrails,
  };
}

const NONE_HELD = {
  usage: false, firstOutput: false, activity: false, activityReason: false,
  events: false, seenIdle: false, messageTrail: false,
};

describe('removeSession after the todo-move eviction (the measured #661 ordering)', () => {
  beforeEach(seedLiveAgent);

  it('leaves no row, no index entry, and no per-session map entry for the removed id', () => {
    evictLikeMoveTask(TASK_ID);
    // The eviction is rows-only, which is the half the earlier fix relied on
    // and the half that left the context bar populated.
    expect(useSessionStore.getState().sessions.some((session) => session.taskId === TASK_ID)).toBe(false);
    expect(keyedEntriesFor(SESSION_ID).usage).toBe(true);

    // The teardown's push, for the same id, after the eviction.
    useSessionStore.getState().removeSession(SESSION_ID);

    const state = useSessionStore.getState();
    expect(state.sessions.map((session) => session.id)).toEqual([OTHER_SESSION_ID]);
    expect(state._sessionByTaskId.has(TASK_ID)).toBe(false);
    expect(state._sessionByTaskId.get(OTHER_TASK_ID)?.id).toBe(OTHER_SESSION_ID);
    expect(keyedEntriesFor(SESSION_ID)).toEqual(NONE_HELD);
    expect(state.activeSessionId).toBeNull();
  });

  it('touches nothing that belongs to another session', () => {
    const before = useSessionStore.getState();
    evictLikeMoveTask(TASK_ID);
    useSessionStore.getState().removeSession(SESSION_ID);

    const after = useSessionStore.getState();
    expect(after.sessionUsage[OTHER_SESSION_ID]).toBe(before.sessionUsage[OTHER_SESSION_ID]);
    expect(after.sessionActivity[OTHER_SESSION_ID]).toBe('idle');
    expect(after.sessionFirstOutput[OTHER_SESSION_ID]).toBe(true);
    expect(after.sessionEvents[OTHER_SESSION_ID]).toBe(before.sessionEvents[OTHER_SESSION_ID]);
  });

  it('leaves the task-keyed maps alone: a reset removes then respawns under the same task', () => {
    useSessionStore.setState({
      spawnProgress: { [TASK_ID]: 'Creating worktree...' },
      pendingCommandLabel: { [TASK_ID]: '/code-review' },
    });

    useSessionStore.getState().removeSession(SESSION_ID);

    const state = useSessionStore.getState();
    expect(state.spawnProgress[TASK_ID]).toBe('Creating worktree...');
    expect(state.pendingCommandLabel[TASK_ID]).toBe('/code-review');
  });
});

describe('removeSession after a status push re-seeded the row (robustness)', () => {
  // Not the measured path (the natural exit emits no status push), but the
  // shape a later remove() takes after a status push that legitimately
  // flipped the row first: the agent-absence sweep's retirement, or a
  // suspended placeholder, followed by a delete.
  beforeEach(seedLiveAgent);

  it('ends clean whether the row was evicted, re-upserted as exited, or both', () => {
    evictLikeMoveTask(TASK_ID);
    useSessionStore.getState().upsertSession({ ...tornDown, status: 'exited', exitCode: 1, pid: null });
    // The upsert did what an upsert does: the phantom is back.
    expect(useSessionStore.getState().sessions.some((session) => session.id === SESSION_ID)).toBe(true);

    useSessionStore.getState().removeSession(SESSION_ID);

    const state = useSessionStore.getState();
    expect(state.sessions.some((session) => session.id === SESSION_ID)).toBe(false);
    expect(state._sessionByTaskId.has(TASK_ID)).toBe(false);
    expect(keyedEntriesFor(SESSION_ID)).toEqual(NONE_HELD);
  });
});

describe('removeSession for an id this renderer never held', () => {
  beforeEach(seedLiveAgent);

  it('returns the same state reference, so nothing re-renders', () => {
    const before = useSessionStore.getState();

    useSessionStore.getState().removeSession('sess-from-another-window');

    const after = useSessionStore.getState();
    expect(after).toBe(before);
    expect(after.sessions).toBe(before.sessions);
    expect(after.sessionUsage).toBe(before.sessionUsage);
  });

  it('still scrubs a map entry whose row is already gone', () => {
    // A late usage push can land after the eviction; the removal must sweep
    // it even with no row to anchor it.
    evictLikeMoveTask(TASK_ID);
    expect(keyedEntriesFor(SESSION_ID).usage).toBe(true);

    useSessionStore.getState().removeSession(SESSION_ID);

    expect(keyedEntriesFor(SESSION_ID)).toEqual(NONE_HELD);
  });
});

describe('syncSessions does not resurrect a row removed during its async gap', () => {
  beforeEach(seedLiveAgent);

  it('drops a stale list entry for an id that was held at sync start and removed before it resolved', async () => {
    const sessionsApi = (window as Record<string, unknown> & {
      electronAPI: { sessions: { list: () => Promise<Session[]> } };
    }).electronAPI.sessions;
    const originalList = sessionsApi.list;
    let resolveList: (sessions: Session[]) => void = () => {};
    // A list issued BEFORE the removal, held open past it: main's registry
    // still had the row when it answered.
    sessionsApi.list = () => new Promise<Session[]>((resolve) => { resolveList = resolve; });

    try {
      const syncing = useSessionStore.getState().syncSessions();
      // Let syncSessions issue its fetches, then remove mid-gap.
      await Promise.resolve();
      useSessionStore.getState().removeSession(SESSION_ID);
      expect(useSessionStore.getState().sessions.some((session) => session.id === SESSION_ID)).toBe(false);

      resolveList([tornDown, elsewhere]);
      await syncing;
    } finally {
      sessionsApi.list = originalList;
    }

    const state = useSessionStore.getState();
    expect(state.sessions.map((session) => session.id)).toEqual([OTHER_SESSION_ID]);
    expect(state._sessionByTaskId.has(TASK_ID)).toBe(false);
  });

  it('keeps a row that arrived mid-gap and is absent from the stale list (the mirror case)', async () => {
    // A spawn whose status push landed after main answered the list. Dropping
    // it left a live agent invisible until the next sync, because a running
    // session gets no further status push while it stays running.
    const sessionsApi = (window as Record<string, unknown> & {
      electronAPI: { sessions: { list: () => Promise<Session[]> } };
    }).electronAPI.sessions;
    const originalList = sessionsApi.list;
    const arrived = makeSession({ id: 'sess-arrived-mid-gap', taskId: 'task-arrived-mid-gap' });
    let resolveList: (sessions: Session[]) => void = () => {};
    sessionsApi.list = () => new Promise<Session[]>((resolve) => { resolveList = resolve; });

    try {
      const syncing = useSessionStore.getState().syncSessions();
      await Promise.resolve();
      useSessionStore.getState().upsertSession(arrived);
      // The stale list predates the spawn.
      resolveList([tornDown, elsewhere]);
      await syncing;
    } finally {
      sessionsApi.list = originalList;
    }

    const state = useSessionStore.getState();
    expect(state.sessions.map((session) => session.id).sort())
      .toEqual([OTHER_SESSION_ID, 'sess-arrived-mid-gap', SESSION_ID].sort());
    expect(state._sessionByTaskId.get('task-arrived-mid-gap')?.id).toBe('sess-arrived-mid-gap');
  });

  it('does not import a stale cache entry for an id removed mid-gap, and keeps a pushed value for an id that arrived mid-gap', async () => {
    // The cache fetches are answered alongside the list, at the START of the
    // sync, so they are exactly as stale as the list. Found by the
    // replica-convergence property test: the row-level guards held while the
    // dead session's usage and activity came back through the cache merge.
    const sessionsApi = (window as Record<string, unknown> & {
      electronAPI: {
        sessions: {
          list: () => Promise<Session[]>;
          getUsage: () => Promise<Record<string, SessionUsage>>;
          getActivity: () => Promise<Record<string, string>>;
        };
      };
    }).electronAPI.sessions;
    const originals = { list: sessionsApi.list, getUsage: sessionsApi.getUsage, getActivity: sessionsApi.getActivity };
    const arrived = makeSession({ id: 'sess-arrived-with-activity', taskId: 'task-arrived-with-activity' });
    let resolveList: (sessions: Session[]) => void = () => {};
    sessionsApi.list = () => new Promise<Session[]>((resolve) => { resolveList = resolve; });
    // Main's caches as they stood when the list was issued: the torn-down
    // session still present, the newcomer not yet spawned.
    sessionsApi.getUsage = async () => ({ [SESSION_ID]: makeUsage(11), [OTHER_SESSION_ID]: makeUsage(3) });
    sessionsApi.getActivity = async () => ({ [SESSION_ID]: 'thinking', [OTHER_SESSION_ID]: 'idle' });

    try {
      const syncing = useSessionStore.getState().syncSessions();
      await Promise.resolve();
      useSessionStore.getState().removeSession(SESSION_ID);
      useSessionStore.getState().upsertSession(arrived);
      useSessionStore.getState().updateActivity('sess-arrived-with-activity', 'thinking', { kind: 'turn-active' });
      resolveList([tornDown, elsewhere]);
      await syncing;
    } finally {
      sessionsApi.list = originals.list;
      sessionsApi.getUsage = originals.getUsage;
      sessionsApi.getActivity = originals.getActivity;
    }

    const state = useSessionStore.getState();
    expect(SESSION_ID in state.sessionUsage).toBe(false);
    expect(SESSION_ID in state.sessionActivity).toBe(false);
    expect(state.sessionUsage[OTHER_SESSION_ID]).toBeDefined();
    expect(state.sessionActivity['sess-arrived-with-activity']).toBe('thinking');
  });

  it('still imports a row it did not hold at sync start (a spawn that landed mid-gap)', async () => {
    const sessionsApi = (window as Record<string, unknown> & {
      electronAPI: { sessions: { list: () => Promise<Session[]> } };
    }).electronAPI.sessions;
    const originalList = sessionsApi.list;
    const newcomer = makeSession({ id: 'sess-newcomer', taskId: 'task-newcomer' });
    let resolveList: (sessions: Session[]) => void = () => {};
    sessionsApi.list = () => new Promise<Session[]>((resolve) => { resolveList = resolve; });

    try {
      const syncing = useSessionStore.getState().syncSessions();
      await Promise.resolve();
      // The guard keys on "held before, gone now"; a row absent on both sides
      // of the gap is simply new and must import.
      resolveList([tornDown, elsewhere, newcomer]);
      await syncing;
    } finally {
      sessionsApi.list = originalList;
    }

    expect(useSessionStore.getState().sessions.map((session) => session.id).sort())
      .toEqual([OTHER_SESSION_ID, 'sess-newcomer', SESSION_ID].sort());
  });
});

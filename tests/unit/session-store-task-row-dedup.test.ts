/**
 * The session store's one-row-per-task contract for its two IN-PLACE writers,
 * `upsertSession` (the `sessions.onStatus` push path) and `reconcileSession`
 * (the task-detail self-heal probe).
 *
 * Both used to branch on "is the incoming id already in the array": if so,
 * replace that row in place and leave every sibling alone. That is the branch
 * taken when main's list has already been imported verbatim by `syncSessions`
 * with a stale suspended row listed AHEAD of the task's running PTY: the
 * running row's id is present, so every status push and every probe result
 * replaced it in place and the stale sibling survived. `reconcileSession`'s own
 * comment promised "never two rows for the same task"; only its other branch
 * delivered. Both branches now drop the task's other rows, keeping the replaced
 * row's array position so the bottom panel's tab order does not shift.
 *
 * Drives the real Zustand store with `window.electronAPI` stubbed, the way
 * session-store-cache-reconcile.test.ts does. `upsertSession` had no direct
 * test before this; the only existing one hand-copied the reducer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Session } from '../../src/shared/types';

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
import { buildSessionByTaskId } from '../../src/renderer/stores/session-store/session-index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'taskId'>): Session {
  return {
    projectId: 'proj-test',
    pid: null,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-09-04T14:25:33.601Z',
    exitCode: null,
    resuming: false,
    agentSessionId: null,
    ...overrides,
  };
}

function seedSessions(sessions: Session[]): void {
  useSessionStore.setState({
    sessions,
    _sessionByTaskId: buildSessionByTaskId(sessions),
    activeSessionId: null,
    spawnProgress: {},
  });
}

/** Temporarily replace sessions.reconcile for one call, then restore. */
async function reconcileWith(taskId: string, returnValue: Session | null): Promise<Session | null> {
  const sessionsApi = (window as Record<string, unknown> & {
    electronAPI: { sessions: { reconcile: (taskId: string) => Promise<Session | null> } };
  }).electronAPI.sessions;
  const original = sessionsApi.reconcile;
  sessionsApi.reconcile = async () => returnValue;
  try {
    return await useSessionStore.getState().reconcileSession(taskId);
  } finally {
    sessionsApi.reconcile = original;
  }
}

// The observed shape: a stale suspended row main listed first, the task's
// running PTY second, and an unrelated task's row between them so position
// preservation is observable.
const stale = makeSession({ id: 'sess-stale', taskId: 'task-a', status: 'suspended', startedAt: '2026-09-04T14:25:26.340Z' });
const other = makeSession({ id: 'sess-other', taskId: 'task-other' });
const live = makeSession({ id: 'sess-live', taskId: 'task-a', status: 'running', pid: 60208 });

describe('upsertSession - one row per task', () => {
  beforeEach(() => seedSessions([stale, other, live]));

  it('an in-place push for the live row evicts the stale sibling and keeps the row where it was', () => {
    const pushed = { ...live, agentSessionId: 'agent-session-1' };

    useSessionStore.getState().upsertSession(pushed);

    const { sessions, _sessionByTaskId } = useSessionStore.getState();
    expect(sessions.map((session) => session.id)).toEqual(['sess-other', 'sess-live']);
    expect(sessions[1]).toBe(pushed);
    expect(_sessionByTaskId.get('task-a')).toBe(pushed);
    expect(_sessionByTaskId.get('task-other')).toBe(other);
    // The index describes exactly the array.
    expect(_sessionByTaskId.size).toBe(sessions.length);
  });

  it('an in-place push for the STALE row evicts the live sibling too: the writer trusts the push, not the status', () => {
    // Main pushes what it holds. If it pushed the stale row, the renderer
    // mirrors that; the one-row contract is about siblings, not preference.
    const pushed = { ...stale };

    useSessionStore.getState().upsertSession(pushed);

    const { sessions } = useSessionStore.getState();
    expect(sessions.map((session) => session.id)).toEqual(['sess-stale', 'sess-other']);
  });

  it('a push under a new id still replaces the task\'s rows (respawn)', () => {
    const respawned = makeSession({ id: 'sess-respawned', taskId: 'task-a', status: 'running' });

    useSessionStore.getState().upsertSession(respawned);

    const { sessions, _sessionByTaskId } = useSessionStore.getState();
    expect(sessions.map((session) => session.id)).toEqual(['sess-other', 'sess-respawned']);
    expect(_sessionByTaskId.get('task-a')).toBe(respawned);
  });
});

describe('reconcileSession - one row per task', () => {
  beforeEach(() => seedSessions([stale, other, live]));

  it('an in-place heal of the live row evicts the stale sibling that masked it', async () => {
    // Main's SESSION_RECONCILE returns the running row. Its id is already in
    // the array, so the heal takes the in-place branch; before the fix that
    // branch left `sess-stale` in front, the hook still resolved it, and the
    // probe (keyed on that id) never fired again.
    const healed = { ...live };

    const result = await reconcileWith('task-a', healed);

    expect(result).toBe(healed);
    const { sessions, _sessionByTaskId } = useSessionStore.getState();
    expect(sessions.map((session) => session.id)).toEqual(['sess-other', 'sess-live']);
    expect(sessions[1]).toBe(healed);
    expect(_sessionByTaskId.get('task-a')).toBe(healed);
    expect(_sessionByTaskId.size).toBe(sessions.length);
  });

  it('a null probe result leaves both rows alone (the probe is a positive-heal tool only)', async () => {
    const result = await reconcileWith('task-a', null);

    expect(result).toBeNull();
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['sess-stale', 'sess-other', 'sess-live']);
  });
});

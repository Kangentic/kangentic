/**
 * `upsertSession`'s spawnProgress carve-out for a `suspended` row, added for
 * the agent-handoff flash fix (Kangentic-mobile #74).
 *
 * `upsertSession` used to clear `spawnProgress[taskId]` unconditionally on any
 * arriving session row, on the theory that a real session having arrived means
 * spawn progress is done. That is wrong for a `suspended` row specifically:
 * main suspends a session as the FIRST step of a same-column respawn (model
 * change, cross-agent handoff, effort-only respawn, session-track switch) and
 * keeps a spawn-progress label in flight for the whole unlocked Phase 2 gap
 * that follows (see `suspendLiveSessionForRespawn` in
 * src/main/ipc/handlers/task-move.ts). `SessionManager.suspend()` pushes a
 * `suspended` session row to the renderer almost immediately (before its own
 * up-to-3s graceful PTY shutdown), and the old unconditional clear deleted the
 * label within milliseconds of it being set - reproducing the exact "Resume
 * session" / "Paused" flash the label exists to prevent. `clearSpawnProgress`
 * (called explicitly by every genuine park: Done, auto_spawn=false) is still
 * the sole authority for retiring a label; this carve-out only stops the
 * SUSPENDED-row push from doing it as a side effect.
 *
 * Harness copied from session-store-task-row-dedup.test.ts (the existing
 * direct `upsertSession` test), extended to seed and assert on `spawnProgress`.
 */
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Session } from '../../src/shared/types';

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

import { useSessionStore } from '../../src/renderer/stores/session-store';
import { buildSessionByTaskId } from '../../src/renderer/stores/session-store/session-index';

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'taskId' | 'status'>): Session {
  return {
    projectId: 'proj-test',
    pid: null,
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-09-04T14:25:33.601Z',
    exitCode: null,
    resuming: false,
    agentSessionId: null,
    ...overrides,
  };
}

function seedSessions(sessions: Session[], spawnProgress: Record<string, string> = {}): void {
  useSessionStore.setState({
    sessions,
    _sessionByTaskId: buildSessionByTaskId(sessions),
    activeSessionId: null,
    spawnProgress,
  });
}

describe('upsertSession preserves spawnProgress across a suspended-row push (respawn), clears it on any other status', () => {
  it('a suspended row for the task keeps its in-flight spawn-progress label', () => {
    seedSessions(
      [makeSession({ id: 'sess-a', taskId: 'task-a', status: 'running' })],
      { 'task-a': 'Switching model...' },
    );

    const suspended = makeSession({ id: 'sess-a', taskId: 'task-a', status: 'suspended' });
    useSessionStore.getState().upsertSession(suspended);

    expect(useSessionStore.getState().spawnProgress).toEqual({ 'task-a': 'Switching model...' });
    // The row itself still upserts normally - only the label survives.
    expect(useSessionStore.getState().sessions).toEqual([suspended]);
    // withSessionUpserted returns BOTH `sessions` and `_sessionByTaskId`; a
    // future edit on this branch that returns only `{ sessions }` would leave
    // the task-id index pointing at the pre-suspend (running) row instead of
    // silently dropping the key (a Zustand `set` shallow-merges, so the OLD
    // index would simply survive unreplaced).
    expect(useSessionStore.getState()._sessionByTaskId).toEqual(buildSessionByTaskId([suspended]));
  });

  it('leaves an UNRELATED task\'s label alone when a different task suspends', () => {
    seedSessions(
      [
        makeSession({ id: 'sess-a', taskId: 'task-a', status: 'running' }),
        makeSession({ id: 'sess-b', taskId: 'task-b', status: 'running' }),
      ],
      { 'task-a': 'Switching model...', 'task-b': 'Fetching latest...' },
    );

    useSessionStore.getState().upsertSession(makeSession({ id: 'sess-a', taskId: 'task-a', status: 'suspended' }));

    expect(useSessionStore.getState().spawnProgress).toEqual({
      'task-a': 'Switching model...',
      'task-b': 'Fetching latest...',
    });
  });

  it('a running row for the task still clears its spawn-progress label (progress is genuinely done)', () => {
    seedSessions(
      [makeSession({ id: 'sess-a', taskId: 'task-a', status: 'suspended' })],
      { 'task-a': 'Starting agent...' },
    );

    useSessionStore.getState().upsertSession(makeSession({ id: 'sess-a', taskId: 'task-a', status: 'running' }));

    expect(useSessionStore.getState().spawnProgress).toEqual({});
  });

  it('a queued row for the task still clears its spawn-progress label', () => {
    seedSessions(
      [],
      { 'task-a': 'Waiting...' },
    );

    useSessionStore.getState().upsertSession(makeSession({ id: 'sess-a', taskId: 'task-a', status: 'queued' }));

    expect(useSessionStore.getState().spawnProgress).toEqual({});
  });

  it('an exited row for the task still clears its spawn-progress label', () => {
    seedSessions(
      [makeSession({ id: 'sess-a', taskId: 'task-a', status: 'running' })],
      { 'task-a': 'Starting agent...' },
    );

    useSessionStore.getState().upsertSession(makeSession({ id: 'sess-a', taskId: 'task-a', status: 'exited', exitCode: 0 }));

    expect(useSessionStore.getState().spawnProgress).toEqual({});
  });
});

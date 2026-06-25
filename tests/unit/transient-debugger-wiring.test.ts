/**
 * Unit tests for the Activity Engine Debugger wiring of transient sessions.
 *
 * The debugger overlay (src/renderer/components/debug/ActivityDebugOverlay.tsx)
 * filters `state.sessions` for `projectId === currentProjectId && status === 'running'`.
 * For a Command Terminal session to appear in the overlay, the spawn flow must
 * place the Session row into `state.sessions` synchronously - waiting on the
 * push-based `session-changed` event from main introduces a race where the
 * user can open Ctrl+Shift+D before the row arrives and see an empty overlay.
 *
 * These tests lock in the contract that `spawnTransientSession` upserts the
 * session into `state.sessions` before resolving.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../src/shared/types';

const FAKE_PROJECT_ID = 'proj-debugger-test';
const FAKE_SESSION_ID = 'sess-debugger-test';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      currentProject: { id: FAKE_PROJECT_ID, name: 'Test', path: '/tmp/test' },
    })),
  },
}));

const spawnTransientMock = vi.fn();
const killTransientMock = vi.fn();
// Stub the window.electronAPI surface the slice calls into.
(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    sessions: {
      spawnTransient: spawnTransientMock,
      killTransient: killTransientMock,
    },
  },
};

import { createTransientSessionSlice, transientKey } from '../../src/renderer/stores/session-store/transient-session-slice';
import type { SessionStore } from '../../src/renderer/stores/session-store/types';
import { buildSessionByTaskId } from '../../src/renderer/stores/session-store/session-index';

/**
 * Minimal store harness that exercises the transient slice plus a real-ish
 * `upsertSession` (copied from session-store.ts:426-442). The real Zustand
 * store can't run here because session-store.ts itself imports renderer-only
 * modules.
 */
function makeSliceStore(
  initialSessions: Session[] = [],
  initialTransientSessions: Record<string, import('../../src/renderer/stores/session-store/transient-session-slice').TransientSessionEntry> = {},
) {
  let state: Partial<SessionStore> & Record<string, unknown> = {
    sessions: initialSessions,
    _sessionByTaskId: buildSessionByTaskId(initialSessions),
    sessionUsage: {},
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionActivityReason: {},
    sessionEvents: {},
    seenIdleSessions: {},
    spawnProgress: {},
    commandBarVisible: false,
    transientSessions: initialTransientSessions,
  };

  const upsertSession = (session: Session) => {
    const sessions = state.sessions as Session[];
    const existingIndex = sessions.findIndex((s) => s.id === session.id);
    let nextSessions: Session[];
    if (existingIndex >= 0) {
      nextSessions = [...sessions];
      nextSessions[existingIndex] = session;
    } else {
      nextSessions = [...sessions.filter((s) => s.taskId !== session.taskId), session];
    }
    state = {
      ...state,
      sessions: nextSessions,
      _sessionByTaskId: buildSessionByTaskId(nextSessions),
    };
  };

  state = { ...state, upsertSession };

  const get = () => state as unknown as SessionStore;
  const set = (updater: Partial<SessionStore> | ((prev: SessionStore) => Partial<SessionStore>)) => {
    if (typeof updater === 'function') {
      const partial = updater(state as unknown as SessionStore);
      if (partial !== (state as unknown)) {
        state = { ...state, ...partial };
      }
    } else {
      state = { ...state, ...updater };
    }
  };

  const sliceCreator = createTransientSessionSlice(undefined);
  const slice = sliceCreator(
    set as unknown as Parameters<typeof sliceCreator>[0],
    get,
    {} as unknown as Parameters<typeof sliceCreator>[2],
  );

  return {
    slice,
    getState: () => state as unknown as SessionStore,
  };
}

function buildFakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: FAKE_SESSION_ID,
    taskId: 'task-transient-uuid',
    projectId: FAKE_PROJECT_ID,
    pid: 1234,
    status: 'running',
    shell: 'bash',
    cwd: '/tmp/test',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: true,
    ...overrides,
  };
}

describe('spawnTransientSession — debugger overlay wiring', () => {
  beforeEach(() => {
    spawnTransientMock.mockReset();
    killTransientMock.mockReset();
  });

  it('inserts the new session into state.sessions synchronously so the debugger filter sees it', async () => {
    const session = buildFakeSession();
    spawnTransientMock.mockResolvedValueOnce({ session, branch: 'main' });

    const { slice, getState } = makeSliceStore([]);

    expect(getState().sessions).toEqual([]);

    await slice.spawnTransientSession('slot-1');

    const sessions = getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(session);
    // Debugger filter: projectId === currentProjectId && status === 'running'
    expect(sessions[0].projectId).toBe(FAKE_PROJECT_ID);
    expect(sessions[0].status).toBe('running');
    expect(sessions[0].transient).toBe(true);
  });

  it('records the transient session in the map keyed by (project, slot)', async () => {
    const session = buildFakeSession();
    spawnTransientMock.mockResolvedValueOnce({ session, branch: 'main' });

    const { slice, getState } = makeSliceStore([]);

    await slice.spawnTransientSession('slot-1');

    const post = getState();
    expect(post.transientSessions[transientKey(FAKE_PROJECT_ID, 'slot-1')]).toEqual({
      projectId: FAKE_PROJECT_ID,
      slot: 'slot-1',
      sessionId: session.id,
      branch: 'main',
    });
  });

  it('clearTransientSessionById removes the session row and its map entry', async () => {
    const session = buildFakeSession();
    spawnTransientMock.mockResolvedValueOnce({ session, branch: 'main' });

    const { slice, getState } = makeSliceStore([]);
    await slice.spawnTransientSession('slot-1');
    expect(getState().sessions).toHaveLength(1);

    slice.clearTransientSessionById(session.id);

    expect(getState().sessions).toHaveLength(0);
    expect(getState().transientSessions[transientKey(FAKE_PROJECT_ID, 'slot-1')]).toBeUndefined();
  });

  it('tracks multiple slots independently for the same project', async () => {
    const sessionOne = buildFakeSession({ id: 'sess-slot-1', taskId: 'task-1' });
    const sessionTwo = buildFakeSession({ id: 'sess-slot-2', taskId: 'task-2' });
    spawnTransientMock
      .mockResolvedValueOnce({ session: sessionOne, branch: 'main' })
      .mockResolvedValueOnce({ session: sessionTwo, branch: 'feature' });

    const { slice, getState } = makeSliceStore([]);
    await slice.spawnTransientSession('slot-1');
    await slice.spawnTransientSession('slot-2');

    const post = getState();
    expect(post.sessions).toHaveLength(2);
    expect(post.transientSessions[transientKey(FAKE_PROJECT_ID, 'slot-1')]?.sessionId).toBe('sess-slot-1');
    expect(post.transientSessions[transientKey(FAKE_PROJECT_ID, 'slot-2')]?.sessionId).toBe('sess-slot-2');

    // Stopping one slot leaves the other intact.
    slice.clearTransientSessionById('sess-slot-1');
    const afterStop = getState();
    expect(afterStop.transientSessions[transientKey(FAKE_PROJECT_ID, 'slot-1')]).toBeUndefined();
    expect(afterStop.transientSessions[transientKey(FAKE_PROJECT_ID, 'slot-2')]?.sessionId).toBe('sess-slot-2');
    expect(afterStop.sessions).toHaveLength(1);
  });

  it('clearTransientSessionById removes the matching entry across MULTIPLE projects and leaves the other project intact', () => {
    // Seed two projects with distinct sessions. proj-A owns slot-1 and proj-B owns slot-1 (same
    // slot name, different project - the composite key distinguishes them).
    const projectASessionId = 'sess-proj-a-slot-1';
    const projectBSessionId = 'sess-proj-b-slot-1';

    const projectASession = buildFakeSession({
      id: projectASessionId,
      taskId: 'task-proj-a',
      projectId: 'proj-A',
    });
    const projectBSession = buildFakeSession({
      id: projectBSessionId,
      taskId: 'task-proj-b',
      projectId: 'proj-B',
    });

    const { slice, getState } = makeSliceStore(
      [projectASession, projectBSession],
      {
        [transientKey('proj-A', 'slot-1')]: {
          projectId: 'proj-A',
          slot: 'slot-1',
          sessionId: projectASessionId,
          branch: 'main',
        },
        [transientKey('proj-B', 'slot-1')]: {
          projectId: 'proj-B',
          slot: 'slot-1',
          sessionId: projectBSessionId,
          branch: 'feature',
        },
      },
    );

    // Precondition: both entries and both session rows are present.
    expect(getState().sessions).toHaveLength(2);
    expect(getState().transientSessions[transientKey('proj-A', 'slot-1')]?.sessionId).toBe(projectASessionId);
    expect(getState().transientSessions[transientKey('proj-B', 'slot-1')]?.sessionId).toBe(projectBSessionId);

    // Remove ONLY proj-B's session.
    slice.clearTransientSessionById(projectBSessionId);

    const afterClear = getState();

    // proj-B's map entry and session row must be gone.
    expect(afterClear.transientSessions[transientKey('proj-B', 'slot-1')]).toBeUndefined();
    expect(afterClear.sessions.find((session) => session.id === projectBSessionId)).toBeUndefined();

    // proj-A's map entry and session row must be completely untouched.
    expect(afterClear.transientSessions[transientKey('proj-A', 'slot-1')]?.sessionId).toBe(projectASessionId);
    expect(afterClear.sessions.find((session) => session.id === projectASessionId)).toEqual(projectASession);
    expect(afterClear.sessions).toHaveLength(1);
  });

  it('killTransientSessionForProject kills ALL slots for the project and leaves other projects intact', async () => {
    // proj-A has two concurrent command terminals (slot-1 and slot-2).
    // proj-B has one. killTransientSessionForProject('proj-A') must IPC-kill
    // both of proj-A's sessions and scrub their state, while leaving proj-B alone.
    const projectASlot1SessionId = 'sess-proj-a-slot-1';
    const projectASlot2SessionId = 'sess-proj-a-slot-2';
    const projectBSessionId = 'sess-proj-b-slot-1';

    const projectASlot1Session = buildFakeSession({
      id: projectASlot1SessionId,
      taskId: 'task-proj-a-1',
      projectId: 'proj-A',
    });
    const projectASlot2Session = buildFakeSession({
      id: projectASlot2SessionId,
      taskId: 'task-proj-a-2',
      projectId: 'proj-A',
    });
    const projectBSession = buildFakeSession({
      id: projectBSessionId,
      taskId: 'task-proj-b',
      projectId: 'proj-B',
    });

    killTransientMock.mockResolvedValue(undefined);

    const { slice, getState } = makeSliceStore(
      [projectASlot1Session, projectASlot2Session, projectBSession],
      {
        [transientKey('proj-A', 'slot-1')]: {
          projectId: 'proj-A',
          slot: 'slot-1',
          sessionId: projectASlot1SessionId,
          branch: 'main',
        },
        [transientKey('proj-A', 'slot-2')]: {
          projectId: 'proj-A',
          slot: 'slot-2',
          sessionId: projectASlot2SessionId,
          branch: 'feature',
        },
        [transientKey('proj-B', 'slot-1')]: {
          projectId: 'proj-B',
          slot: 'slot-1',
          sessionId: projectBSessionId,
          branch: 'main',
        },
      },
    );

    // Precondition: all three entries and session rows present.
    expect(getState().sessions).toHaveLength(3);
    expect(getState().transientSessions[transientKey('proj-A', 'slot-1')]?.sessionId).toBe(projectASlot1SessionId);
    expect(getState().transientSessions[transientKey('proj-A', 'slot-2')]?.sessionId).toBe(projectASlot2SessionId);
    expect(getState().transientSessions[transientKey('proj-B', 'slot-1')]?.sessionId).toBe(projectBSessionId);

    await slice.killTransientSessionForProject('proj-A');

    // IPC must have been called for BOTH of proj-A's session ids (order may vary).
    expect(killTransientMock).toHaveBeenCalledTimes(2);
    const killedIds = killTransientMock.mock.calls.map((callArgs) => callArgs[0] as string);
    expect(killedIds).toContain(projectASlot1SessionId);
    expect(killedIds).toContain(projectASlot2SessionId);

    const afterKill = getState();

    // Both proj-A map entries and session rows must be gone.
    expect(afterKill.transientSessions[transientKey('proj-A', 'slot-1')]).toBeUndefined();
    expect(afterKill.transientSessions[transientKey('proj-A', 'slot-2')]).toBeUndefined();
    expect(afterKill.sessions.find((session) => session.id === projectASlot1SessionId)).toBeUndefined();
    expect(afterKill.sessions.find((session) => session.id === projectASlot2SessionId)).toBeUndefined();

    // proj-B's map entry and session row must be completely untouched.
    expect(afterKill.transientSessions[transientKey('proj-B', 'slot-1')]?.sessionId).toBe(projectBSessionId);
    expect(afterKill.sessions.find((session) => session.id === projectBSessionId)).toEqual(projectBSession);
    expect(afterKill.sessions).toHaveLength(1);
  });

  it('a duplicate upsertSession (from the later session-changed push) is idempotent', async () => {
    const session = buildFakeSession();
    spawnTransientMock.mockResolvedValueOnce({ session, branch: 'main' });

    const { slice, getState } = makeSliceStore([]);
    await slice.spawnTransientSession('slot-1');
    expect(getState().sessions).toHaveLength(1);

    // Simulate the push event that arrives shortly after spawn resolves.
    getState().upsertSession(session);

    expect(getState().sessions).toHaveLength(1);
    expect(getState().sessions[0]).toEqual(session);
  });
});

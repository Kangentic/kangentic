/**
 * Unit tests for `buildTransientSessionEntry` and `adoptTransientSession` on
 * TransientSessionSlice.
 *
 * `buildTransientSessionEntry` is the single builder shared by `adoptTransientSession`
 * (here) and `planTransientRecovery`'s pairing pass (tests/unit/transient-recovery.test.ts).
 * Before the extraction, `adoptTransientSession` built its pairing entry by hand and
 * omitted `label`, so a terminal recovered through the adopt path lost its derived
 * name. These tests pin that both fields - `branch` and `label` - survive the trip
 * from a live `Session` row into the pairing entry, at both the pure-builder level
 * and through the slice's observable store behavior.
 *
 * We instantiate the slice directly via `createTransientSessionSlice`, following the
 * same set/get harness as tests/unit/transient-session-label.test.ts, so no Zustand
 * store instance or `useProjectStore` import is needed.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the project-store so importing the slice doesn't pull in
// useProjectStore's browser/IPC dependencies.
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject: null })),
  },
}));

import {
  buildTransientSessionEntry,
  createTransientSessionSlice,
  transientKey,
  type TransientSessionEntry,
} from '../../src/renderer/stores/session-store/transient-session-slice';
import type { SessionStore } from '../../src/renderer/stores/session-store/types';
import type { Session } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helper: build a minimal in-memory store that runs the slice
// ---------------------------------------------------------------------------

/**
 * Create a minimal Zustand-style set/get pair for the transient slice.
 * We only need the transientSessions map from the wider SessionStore shape;
 * the other fields are never touched by adoptTransientSession.
 */
function makeSliceStore(initial?: {
  transientSessions?: Record<string, TransientSessionEntry>;
}) {
  let state: Pick<SessionStore, 'transientSessions'> & Record<string, unknown> = {
    transientSessions: initial?.transientSessions ?? {},
    sessions: [],
    _sessionByTaskId: new Map(),
    sessionUsage: {},
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionEvents: {},
    seenIdleSessions: {},
    commandBarVisible: false,
  };

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
  const slice = sliceCreator(set as unknown as Parameters<typeof sliceCreator>[0], get, {} as unknown as Parameters<typeof sliceCreator>[2]);

  return {
    slice,
    getState: () => state,
  };
}

/** A live Command Terminal PTY row as `sessions.list()` delivers it. */
function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    taskId: overrides.id,
    projectId: 'proj-abc',
    pid: 1000,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-09-08T12:00:00.000Z',
    exitCode: null,
    resuming: false,
    transient: true,
    commandTerminalSlot: null,
    commandTerminalBranch: null,
    commandTerminalLabel: null,
    isolatedSwimlaneId: null,
    agentSessionId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildTransientSessionEntry - the shared pure builder
// ---------------------------------------------------------------------------

describe('buildTransientSessionEntry', () => {
  it('carries both branch and label from the session row', () => {
    const entry = buildTransientSessionEntry(
      'proj-abc',
      'slot-1',
      makeSession({ id: 'sess-1', commandTerminalBranch: 'feature/x', commandTerminalLabel: 'Fix the parser' }),
    );

    expect(entry).toEqual({
      projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1', branch: 'feature/x', label: 'Fix the parser',
    });
  });

  it('defaults branch to null and omits label when the session carries neither', () => {
    const entry = buildTransientSessionEntry('proj-abc', 'slot-1', makeSession({ id: 'sess-1' }));

    expect(entry.branch).toBeNull();
    expect(entry).not.toHaveProperty('label');
  });
});

// ---------------------------------------------------------------------------
// adoptTransientSession - the observable store behavior
// ---------------------------------------------------------------------------

describe('adoptTransientSession', () => {
  it('writes a pairing entry carrying both branch and label from the survivor session', () => {
    const { slice, getState } = makeSliceStore();

    slice.adoptTransientSession(
      'proj-abc',
      'slot-1',
      makeSession({ id: 'sess-1', commandTerminalBranch: 'feature/x', commandTerminalLabel: 'Fix the parser' }),
    );

    expect(getState().transientSessions[transientKey('proj-abc', 'slot-1')]).toEqual({
      projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1', branch: 'feature/x', label: 'Fix the parser',
    });
  });

  it('defaults branch to null and leaves label absent for an unnamed survivor', () => {
    const { slice, getState } = makeSliceStore();

    slice.adoptTransientSession('proj-abc', 'slot-1', makeSession({ id: 'sess-1' }));

    const entry = getState().transientSessions[transientKey('proj-abc', 'slot-1')];
    expect(entry?.branch).toBeNull();
    expect(entry).not.toHaveProperty('label');
  });

  it('overwrites any existing entry at the same slot with the adopted session', () => {
    const { slice, getState } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: {
          projectId: 'proj-abc', slot: 'slot-1', sessionId: 'stale-session', branch: 'main', label: 'Stale',
        },
      },
    });

    slice.adoptTransientSession(
      'proj-abc',
      'slot-1',
      makeSession({ id: 'sess-1', commandTerminalBranch: 'feature/y', commandTerminalLabel: 'New Name' }),
    );

    expect(getState().transientSessions[transientKey('proj-abc', 'slot-1')]).toEqual({
      projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1', branch: 'feature/y', label: 'New Name',
    });
  });
});

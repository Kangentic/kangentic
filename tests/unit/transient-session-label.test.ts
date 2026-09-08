/**
 * Unit tests for `setTransientSessionLabel` on TransientSessionSlice.
 *
 * We instantiate the slice directly via `createTransientSessionSlice` and wire
 * a minimal set/get pair so no Zustand store instance is needed. This avoids
 * importing `useProjectStore` (which requires a browser environment) while
 * fully exercising the label-setting logic.
 *
 * Covers (#11):
 *   - first-prompt-wins: second call does not overwrite an existing label
 *   - empty and whitespace-only strings are no-ops
 *   - unknown sessionId leaves state unchanged
 *   - the map is keyed by (project, slot), so the label targets the matched
 *     session regardless of which slot owns it
 *
 * Also covers the `applied`-gated mirror to main (`window.electronAPI.sessions
 * .setTransientLabel`): exactly one IPC call when the label genuinely applies,
 * zero calls on any no-op path, and a rejected mirror call swallowed rather than
 * thrown or left as an unhandled rejection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the project-store so importing the slice doesn't pull in
// useProjectStore's browser/IPC dependencies.
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject: null })),
  },
}));

import {
  createTransientSessionSlice,
  transientKey,
  type TransientSessionEntry,
} from '../../src/renderer/stores/session-store/transient-session-slice';
import type { SessionStore } from '../../src/renderer/stores/session-store/types';

// ---------------------------------------------------------------------------
// Helper: build a minimal in-memory store that runs the slice
// ---------------------------------------------------------------------------

/**
 * Create a minimal Zustand-style set/get pair for the transient slice.
 * We only need the transientSessions map from the wider SessionStore shape;
 * the other fields are never touched by setTransientSessionLabel.
 */
function makeSliceStore(initial?: {
  transientSessions?: Record<string, TransientSessionEntry>;
}) {
  let state: Pick<SessionStore, 'transientSessions'> & Record<string, unknown> = {
    transientSessions: initial?.transientSessions ?? {},
    // Provide empty stubs for the other fields the slice constructor requires
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
      // The production code returns the EXISTING state object when nothing changed;
      // we only merge when the updater returns a new/different object.
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

function entry(overrides: Partial<TransientSessionEntry> & Pick<TransientSessionEntry, 'projectId' | 'slot' | 'sessionId'>): TransientSessionEntry {
  return { branch: null, ...overrides };
}

/**
 * Stub `window.electronAPI.sessions.setTransientLabel`. In the node test env
 * vitest provides no `window`, so we attach to globalThis (the same object the
 * production code's `window` resolves to under jsdom); see the identical
 * pattern in `tests/unit/auto-name-scheduler.test.ts`.
 */
function setupSetTransientLabelApi(
  impl: (sessionId: string, label: string) => Promise<void>,
): ReturnType<typeof vi.fn> {
  const setTransientLabel = vi.fn((sessionId: string, label: string) => impl(sessionId, label));
  (globalThis as unknown as { window: Record<string, unknown> }).window =
    (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
  (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = {
    sessions: { setTransientLabel },
  };
  return setTransientLabel;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Default resolving stub so every test below can call setTransientSessionLabel
  // without crashing on a real apply; tests that care about the mirror call
  // shape install their own via setupSetTransientLabelApi.
  setupSetTransientLabelApi(async () => {});
});

describe('setTransientSessionLabel', () => {
  it('sets the label on the matching transient session entry', () => {
    const { slice, getState } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1' }),
      },
    });

    slice.setTransientSessionLabel('sess-1', 'Fix Login Flow');

    expect(getState().transientSessions[transientKey('proj-abc', 'slot-1')]?.label).toBe('Fix Login Flow');
  });

  it('first-prompt-wins: a second call does not overwrite an existing label', () => {
    const { slice, getState } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1', label: 'First Label' }),
      },
    });

    slice.setTransientSessionLabel('sess-1', 'Second Label Should Be Ignored');

    expect(getState().transientSessions[transientKey('proj-abc', 'slot-1')]?.label).toBe('First Label');
  });

  it('is a no-op for an empty string', () => {
    const { slice, getState } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1' }),
      },
    });

    slice.setTransientSessionLabel('sess-1', '');

    expect(getState().transientSessions[transientKey('proj-abc', 'slot-1')]?.label).toBeUndefined();
  });

  it('is a no-op for a whitespace-only string', () => {
    const { slice, getState } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1' }),
      },
    });

    slice.setTransientSessionLabel('sess-1', '   \t  ');

    expect(getState().transientSessions[transientKey('proj-abc', 'slot-1')]?.label).toBeUndefined();
  });

  it('is a no-op for an unknown sessionId (leaves transientSessions unchanged)', () => {
    const initialMap = {
      [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1', label: 'Existing' }),
    };
    const { slice, getState } = makeSliceStore({ transientSessions: initialMap });

    slice.setTransientSessionLabel('sess-nonexistent', 'Should Not Appear');

    expect(getState().transientSessions).toStrictEqual(initialMap);
  });

  it('trims surrounding whitespace from the label before storing', () => {
    const { slice, getState } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1' }),
      },
    });

    slice.setTransientSessionLabel('sess-1', '  Refactor Auth Service  ');

    expect(getState().transientSessions[transientKey('proj-abc', 'slot-1')]?.label).toBe('Refactor Auth Service');
  });

  it('labels only the matched session across multiple slots and projects', () => {
    const { slice, getState } = makeSliceStore({
      transientSessions: {
        // Two slots in the same project, plus a slot in another project.
        [transientKey('proj-1', 'slot-1')]: entry({ projectId: 'proj-1', slot: 'slot-1', sessionId: 'sess-a' }),
        [transientKey('proj-1', 'slot-2')]: entry({ projectId: 'proj-1', slot: 'slot-2', sessionId: 'sess-b' }),
        [transientKey('proj-2', 'slot-1')]: entry({ projectId: 'proj-2', slot: 'slot-1', sessionId: 'sess-c' }),
      },
    });

    slice.setTransientSessionLabel('sess-b', 'Second Slot Label');

    expect(getState().transientSessions[transientKey('proj-1', 'slot-1')]?.label).toBeUndefined();
    expect(getState().transientSessions[transientKey('proj-1', 'slot-2')]?.label).toBe('Second Slot Label');
    expect(getState().transientSessions[transientKey('proj-2', 'slot-1')]?.label).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setTransientSessionLabel - mirror to main, gated on `applied`
// ---------------------------------------------------------------------------

describe('setTransientSessionLabel - IPC mirror to main', () => {
  it('mirrors to main exactly once, with the trimmed label, when the label newly applies', () => {
    const setTransientLabel = setupSetTransientLabelApi(async () => {});
    const { slice } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1' }),
      },
    });

    slice.setTransientSessionLabel('sess-1', '  Fix Login Flow  ');

    expect(setTransientLabel).toHaveBeenCalledTimes(1);
    expect(setTransientLabel).toHaveBeenCalledWith('sess-1', 'Fix Login Flow');
  });

  it('issues no IPC call when the entry already has a label (no-op apply)', () => {
    const setTransientLabel = setupSetTransientLabelApi(async () => {});
    const { slice } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({
          projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1', label: 'Existing',
        }),
      },
    });

    slice.setTransientSessionLabel('sess-1', 'Second Label Should Be Ignored');

    expect(setTransientLabel).not.toHaveBeenCalled();
  });

  it('issues no IPC call for an unknown sessionId (no owning entry)', () => {
    const setTransientLabel = setupSetTransientLabelApi(async () => {});
    const { slice } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1' }),
      },
    });

    slice.setTransientSessionLabel('sess-nonexistent', 'Should Not Mirror');

    expect(setTransientLabel).not.toHaveBeenCalled();
  });

  it('issues no IPC call for an empty or whitespace-only label (trimmed no-op)', () => {
    const setTransientLabel = setupSetTransientLabelApi(async () => {});
    const { slice } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1' }),
      },
    });

    slice.setTransientSessionLabel('sess-1', '   ');

    expect(setTransientLabel).not.toHaveBeenCalled();
  });

  it('swallows a rejected mirror call without throwing or producing an unhandled rejection', async () => {
    // Listen for Node's own unhandledRejection event directly rather than
    // relying on the test runner to surface one: it is the only reliable way
    // to prove the production `.catch` is doing its job, since a missing catch
    // otherwise fails nothing observable inside this test body.
    //
    // Deliberately NOT a vi.fn() here (unlike every other test in this file):
    // vi.fn's own call-tracking attaches a settle handler to the promise it
    // returns, which itself counts as "handling" the rejection from Node's
    // point of view - a repro confirmed a vi.fn-wrapped rejecting mock never
    // reaches this listener even with the production `.catch` removed. A raw
    // function is the only way this assertion can actually go red.
    const capturedRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      capturedRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    const calls: Array<[string, string]> = [];
    (globalThis as unknown as { window: Record<string, unknown> }).window =
      (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = {
      sessions: {
        setTransientLabel: (sessionId: string, label: string) => {
          calls.push([sessionId, label]);
          return Promise.reject(new Error('network down'));
        },
      },
    };

    try {
      const { slice } = makeSliceStore({
        transientSessions: {
          [transientKey('proj-abc', 'slot-1')]: entry({ projectId: 'proj-abc', slot: 'slot-1', sessionId: 'sess-1' }),
        },
      });

      expect(() => slice.setTransientSessionLabel('sess-1', 'Fix Login Flow')).not.toThrow();
      // Flush enough event-loop turns for Node to report the rejection as
      // unhandled if nothing caught it.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(calls).toEqual([['sess-1', 'Fix Login Flow']]);
      expect(capturedRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

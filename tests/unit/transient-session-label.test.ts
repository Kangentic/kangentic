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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

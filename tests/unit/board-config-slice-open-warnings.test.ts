/**
 * receiveOpenConfigWarnings in board-config-slice: the project-open reconcile's
 * warnings go to the board's warning banner and nowhere else.
 *
 * Main pushes them on EVERY open, including a healthy one, and the banner is
 * what stays until the file is fixed. A toast on each open would repeat the
 * same message every time the user switches to the project.
 *
 * Harness copies board-config-slice.test.ts: the project and toast stores are
 * mocked and the slice is built by calling its StateCreator directly.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

let activeProjectId: string | null = null;

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      openProject: vi.fn(),
      get currentProject() {
        return activeProjectId ? { id: activeProjectId } : null;
      },
    }),
  },
}));

const addToastSpy = vi.fn();
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: addToastSpy }) },
}));

(globalThis as Record<string, unknown>).window = {
  electronAPI: { boardConfig: { apply: vi.fn() } },
};

import { createBoardConfigSlice } from '../../src/renderer/stores/board-store/board-config-slice';
import type { BoardConfigSlice } from '../../src/renderer/stores/board-store/board-config-slice';

interface StubState extends BoardConfigSlice {
  loadBoard: () => Promise<void>;
}

function buildSlice() {
  let state: StubState = { loadBoard: vi.fn(async () => {}) } as StubState;

  const set = (updater: Partial<StubState> | ((previous: StubState) => Partial<StubState>)) => {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...patch };
  };
  const get = () => state;

  const slice = createBoardConfigSlice(
    set as Parameters<typeof createBoardConfigSlice>[0],
    get as never,
    {} as never,
  );
  state = { ...state, ...slice };

  return { getState: () => state };
}

beforeEach(() => {
  addToastSpy.mockReset();
  activeProjectId = 'project-a';
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('receiveOpenConfigWarnings: banner only, no toast', () => {
  it('sets the warnings for the current project and adds no toast', () => {
    const { getState } = buildSlice();
    const warnings = ['kangentic.json could not be read', 'kangentic.local.json could not be read'];

    getState().receiveOpenConfigWarnings('project-a', warnings);

    expect(getState().configWarnings).toEqual(warnings);
    expect(addToastSpy).not.toHaveBeenCalled();
  });

  it('adds no toast when the push is empty, and still clears the banner', () => {
    const { getState } = buildSlice();
    getState().setConfigWarnings(['stale warning from the last project']);

    getState().receiveOpenConfigWarnings('project-a', []);

    expect(getState().configWarnings).toEqual([]);
    expect(addToastSpy).not.toHaveBeenCalled();
  });

  it('adds no toast for a project the user has already left, and leaves the banner alone', () => {
    const { getState } = buildSlice();
    getState().setConfigWarnings(['current project warning']);

    getState().receiveOpenConfigWarnings('project-b', ['kangentic.json could not be read']);

    expect(getState().configWarnings).toEqual(['current project warning']);
    expect(addToastSpy).not.toHaveBeenCalled();
  });
});

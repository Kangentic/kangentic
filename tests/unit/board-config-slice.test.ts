/**
 * Unit tests for board-config-slice's `applyConfigChange` guard against a
 * mid-switch project open that did not land.
 *
 * `applyConfigChange` switches to the pending project (when it is not already
 * active) via `useProjectStore.getState().openProject(projectId)` before
 * applying the board config profile via
 * `window.electronAPI.boardConfig.apply(projectId)`. `openProject` never
 * throws - every failure is reported through the project store itself (a
 * toast, or the missing-path dialog) and reflected back as an
 * `OpenProjectOutcome` (see project-open-outcomes.test.ts for that contract).
 * Without checking the outcome here, a switch that did not land would still
 * fall through to `boardConfig.apply`, applying the config against whatever
 * project is actually still current.
 *
 * Harness follows project-open-outcomes.test.ts's approach: stub
 * `window.electronAPI` directly and mock the store dependencies rather than
 * exercising the real project-store IPC path, since this slice only cares
 * about the outcome value `openProject` resolves to.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const openProjectMock = vi.fn();
let activeProjectId: string | null = null;

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      openProject: openProjectMock,
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

const applyMock = vi.fn();
const getLastWarningsMock = vi.fn();
(globalThis as Record<string, unknown>).window = {
  electronAPI: { boardConfig: { apply: applyMock, getLastWarnings: getLastWarningsMock } },
};

import { createBoardConfigSlice } from '../../src/renderer/stores/board-store/board-config-slice';
import type { BoardConfigSlice } from '../../src/renderer/stores/board-store/board-config-slice';

interface StubState extends BoardConfigSlice {
  loadBoard: () => Promise<void>;
}

/**
 * Build a standalone slice instance by calling the StateCreator directly,
 * mirroring the pattern in board-manager-slice.test.ts. `loadBoard` is stubbed
 * in directly since it belongs to a sibling slice this file does not need.
 */
function buildSlice(loadBoard: () => Promise<void> = vi.fn(async () => {})) {
  let state: StubState = { loadBoard } as StubState;

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

const PROJECT_ID = 'project-b';

beforeEach(() => {
  openProjectMock.mockReset();
  applyMock.mockReset();
  applyMock.mockResolvedValue([]);
  getLastWarningsMock.mockReset();
  addToastSpy.mockReset();
  activeProjectId = 'project-a';
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('applyConfigChange: mid-switch openProject outcome', () => {
  it('does NOT call boardConfig.apply when the mid-switch openProject resolves a non-"opened" outcome', async () => {
    openProjectMock.mockResolvedValue('failed');
    const loadBoard = vi.fn(async () => {});
    const { getState } = buildSlice(loadBoard);
    getState().setPendingConfigChange(PROJECT_ID);

    await getState().applyConfigChange();

    expect(openProjectMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(applyMock).not.toHaveBeenCalled();
    expect(loadBoard).not.toHaveBeenCalled();
  });

  it('calls boardConfig.apply when the mid-switch openProject resolves "opened"', async () => {
    openProjectMock.mockResolvedValue('opened');
    const loadBoard = vi.fn(async () => {});
    const { getState } = buildSlice(loadBoard);
    getState().setPendingConfigChange(PROJECT_ID);

    await getState().applyConfigChange();

    expect(openProjectMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(applyMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(loadBoard).toHaveBeenCalledTimes(1);
  });
});

describe('receiveOpenConfigWarnings', () => {
  // Main pushes the project-open reconcile's warnings after the board is up.
  // They used to reach only the log, so a teammate's broken kangentic.json
  // left the board on stale data with nothing on screen saying why.
  it('shows the warnings of the project on screen', () => {
    const { getState } = buildSlice();

    getState().receiveOpenConfigWarnings('project-a', ['kangentic.json could not be read']);

    expect(getState().configWarnings).toEqual(['kangentic.json could not be read']);
  });

  it('ignores the warnings of a project the user has already left', () => {
    const { getState } = buildSlice();

    getState().receiveOpenConfigWarnings('project-b', ['kangentic.json could not be read']);

    expect(getState().configWarnings).toEqual([]);
  });

  it('clears a previous project banner when the opened project has none', () => {
    const { getState } = buildSlice();
    getState().setConfigWarnings(['stale warning from the last project']);

    getState().receiveOpenConfigWarnings('project-a', []);

    expect(getState().configWarnings).toEqual([]);
  });
});

describe('fetchOpenConfigWarnings', () => {
  // The fetch a project switch makes, for the open-time push the renderer
  // dropped because the project was not current yet.
  it('shows the fetched warnings of the project on screen', async () => {
    getLastWarningsMock.mockResolvedValue(['kangentic.json could not be read']);
    const { getState } = buildSlice();

    await getState().fetchOpenConfigWarnings('project-a');

    expect(getLastWarningsMock).toHaveBeenCalledWith('project-a');
    expect(getState().configWarnings).toEqual(['kangentic.json could not be read']);
    expect(addToastSpy).not.toHaveBeenCalled();
  });

  it('ignores a fetch that resolves after the user has switched away', async () => {
    getLastWarningsMock.mockResolvedValue(['kangentic.json could not be read']);
    const { getState } = buildSlice();

    await getState().fetchOpenConfigWarnings('project-b');

    expect(getState().configWarnings).toEqual([]);
  });

  it('leaves the banner alone when the fetch fails', async () => {
    getLastWarningsMock.mockRejectedValue(new Error('no handler'));
    const { getState } = buildSlice();
    getState().setConfigWarnings(['from the push']);

    await expect(getState().fetchOpenConfigWarnings('project-a')).resolves.toBeUndefined();

    expect(getState().configWarnings).toEqual(['from the push']);
  });
});

describe('applyConfigChange: a failed apply', () => {
  // Sentry DESKTOP-1H reached the user as nothing at all: both callers fire
  // applyConfigChange without awaiting it, so a throw in main became an
  // unhandled rejection.
  it('toasts the error instead of rejecting, and does not reload the board', async () => {
    activeProjectId = PROJECT_ID;
    applyMock.mockRejectedValue(
      new Error("Error invoking remote method 'boardConfig:apply': TypeError: (s ?? []) is not iterable"),
    );
    const loadBoard = vi.fn(async () => {});
    const { getState } = buildSlice(loadBoard);
    getState().setPendingConfigChange(PROJECT_ID);

    await expect(getState().applyConfigChange()).resolves.toBeUndefined();

    expect(addToastSpy).toHaveBeenCalledTimes(1);
    const toast = addToastSpy.mock.calls[0][0] as { message: string; variant: string };
    expect(toast.variant).toBe('error');
    expect(toast.message).not.toContain('Error invoking remote method');
    expect(toast.message).toContain('is not iterable');
    expect(loadBoard).not.toHaveBeenCalled();
  });
});

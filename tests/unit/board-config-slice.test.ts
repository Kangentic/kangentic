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
(globalThis as Record<string, unknown>).window = {
  electronAPI: { boardConfig: { apply: applyMock } },
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

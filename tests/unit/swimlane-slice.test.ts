/**
 * Unit tests for the swimlane-slice Zustand slice
 * (`src/renderer/stores/board-store/swimlane-slice.ts`).
 *
 * Focus: `deleteSwimlane`'s board-profile re-read, added by the column-
 * deletion work. The main-process delete IPC prunes the deleted column out of
 * the on-disk Board Profiles as a side effect, so the renderer's cached
 * `boardProfiles` (read by `ProfilePicker` and `AdvancedOverridesSection`) is
 * stale the instant the IPC resolves. `deleteSwimlane` re-reads it via
 * `loadBoardProfiles()` so those consumers see the pruned list without a
 * manual reload.
 *
 * The slice is a Zustand `StateCreator` - a plain function of (set, get,
 * api). Driven directly via a minimal in-memory harness (the same pattern
 * used by `archived-tasks-slice.test.ts` and `board-manager-slice.test.ts`),
 * so no real board store, Electron, or DOM is required. `window.electronAPI`
 * is stubbed directly on `globalThis` (vitest's default node environment has
 * no `window`), mirroring `archived-tasks-slice.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BoardProfile, Swimlane } from '../../src/shared/types';

// window.electronAPI stub. vitest's default (node) environment has no
// `window`, so we attach it to globalThis before importing the slice.
const swimlanesApi = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  reorder: vi.fn(),
};
const boardConfigApi = {
  getBoardProfiles: vi.fn(),
  setBoardProfiles: vi.fn(),
};

(globalThis as Record<string, unknown>).window = {
  electronAPI: { swimlanes: swimlanesApi, boardConfig: boardConfigApi },
};

// Imported after the window stub so the slice module resolves it at call time.
import { createSwimlaneSlice } from '../../src/renderer/stores/board-store/swimlane-slice';
import type { SwimlaneSlice } from '../../src/renderer/stores/board-store/swimlane-slice';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeSwimlane(overrides: Partial<Swimlane> & Pick<Swimlane, 'id' | 'name'>): Swimlane {
  return {
    description: null,
    role: null,
    position: 0,
    color: '#3b82f6',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Slice harness
// ---------------------------------------------------------------------------

function buildHarness(initial: Partial<SwimlaneSlice> = {}): { getState: () => SwimlaneSlice } {
  let state: SwimlaneSlice;

  const set = (
    updater: Partial<SwimlaneSlice> | ((previousState: SwimlaneSlice) => Partial<SwimlaneSlice>),
  ) => {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...patch };
  };

  const get = () => state;

  // StateCreator signature: (set, get, api). Only set/get are exercised by
  // deleteSwimlane, so the api position is stubbed.
  const slice = createSwimlaneSlice(set as never, get as never, {} as never);

  state = { ...slice, ...initial };

  return { getState: get };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('deleteSwimlane', () => {
  it('removes the deleted lane from swimlanes', async () => {
    swimlanesApi.delete.mockResolvedValueOnce(undefined);
    boardConfigApi.getBoardProfiles.mockResolvedValueOnce([]);
    const doomed = makeSwimlane({ id: 'lane-doomed', name: 'Doomed' });
    const survivor = makeSwimlane({ id: 'lane-survivor', name: 'Survivor' });
    const { getState } = buildHarness({ swimlanes: [doomed, survivor], boardProfiles: [] });

    await getState().deleteSwimlane('lane-doomed');

    expect(swimlanesApi.delete).toHaveBeenCalledWith('lane-doomed');
    expect(getState().swimlanes).toEqual([survivor]);
  });

  it('re-reads boardProfiles from the IPC so a stale cached entry does not survive the delete', async () => {
    // The discriminating setup: the SEEDED store value and the freshly
    // returned IPC value must DIFFER. If both were `[]` (or identical), the
    // assertion would pass whether or not the re-read actually ran.
    //
    // Red trigger: delete the `await get().loadBoardProfiles();` line from
    // swimlane-slice.ts's deleteSwimlane - the store then keeps the stale
    // profile (with the dangling column-id entry) forever, since nothing else
    // in this direct-delete path refreshes it.
    swimlanesApi.delete.mockResolvedValueOnce(undefined);
    const doomed = makeSwimlane({ id: 'lane-doomed', name: 'Doomed' });
    const staleProfile: BoardProfile = {
      id: 'profile-1',
      name: 'Heavy',
      columns: { 'lane-doomed': { modelOverride: 'opus' } },
    };
    const prunedProfile: BoardProfile = {
      id: 'profile-1',
      name: 'Heavy',
      columns: {},
    };
    // Main process prunes the on-disk copy as part of the delete; a fresh
    // getBoardProfiles() call after the delete returns the pruned version.
    boardConfigApi.getBoardProfiles.mockResolvedValueOnce([prunedProfile]);

    const { getState } = buildHarness({ swimlanes: [doomed], boardProfiles: [staleProfile] });

    await getState().deleteSwimlane('lane-doomed');

    expect(boardConfigApi.getBoardProfiles).toHaveBeenCalledOnce();
    expect(getState().boardProfiles).toEqual([prunedProfile]);
    expect(getState().boardProfiles).not.toEqual([staleProfile]);
  });

  it('re-reads boardProfiles AFTER the delete IPC resolves, not before', async () => {
    const callOrder: string[] = [];
    swimlanesApi.delete.mockImplementationOnce(async () => {
      callOrder.push('delete');
    });
    boardConfigApi.getBoardProfiles.mockImplementationOnce(async () => {
      callOrder.push('getBoardProfiles');
      return [];
    });
    const doomed = makeSwimlane({ id: 'lane-doomed', name: 'Doomed' });
    const { getState } = buildHarness({ swimlanes: [doomed], boardProfiles: [] });

    await getState().deleteSwimlane('lane-doomed');

    expect(callOrder).toEqual(['delete', 'getBoardProfiles']);
  });
});

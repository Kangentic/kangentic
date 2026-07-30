import { type StateCreator } from 'zustand';
import type { BoardProfile, Swimlane, SwimlaneCreateInput, SwimlaneUpdateInput } from '../../../shared/types';
import { useToastStore } from '../toast-store';
import type { BoardStore } from './types';

export interface SwimlaneSlice {
  swimlanes: Swimlane[];
  /**
   * The board's named Board Profiles (see `BoardProfile`). Empty is the normal
   * state and means every task runs the columns' own settings - the synthetic
   * "Default" profile, which is deliberately not stored.
   */
  boardProfiles: BoardProfile[];
  createSwimlane: (input: SwimlaneCreateInput) => Promise<Swimlane>;
  updateSwimlane: (input: SwimlaneUpdateInput) => Promise<Swimlane>;
  deleteSwimlane: (id: string) => Promise<void>;
  reorderSwimlanes: (ids: string[]) => Promise<void>;
  loadBoardProfiles: () => Promise<void>;
  saveBoardProfiles: (profiles: BoardProfile[]) => Promise<void>;
}

export const createSwimlaneSlice: StateCreator<BoardStore, [], [], SwimlaneSlice> = (set, get) => ({
  swimlanes: [],
  boardProfiles: [],

  loadBoardProfiles: async () => {
    try {
      set({ boardProfiles: await window.electronAPI.boardConfig.getBoardProfiles() });
    } catch (error) {
      // A project with no kangentic.json resolves to an empty list on the main
      // side rather than throwing, so reaching here means a genuine IPC failure.
      // Keep the last known list instead of clearing it: `loadBoard()` fires
      // this fire-and-forget as well, so a transient failure racing that call
      // would otherwise blank the ContextBar's profile pill (ProfilePicker
      // hides itself on an empty list) until the slower call resolved.
      console.warn('[boardProfiles] load failed; keeping the last known list', error);
    }
  },

  saveBoardProfiles: async (profiles) => {
    // Optimistic: the picker and Column Manager both read from the store, and a
    // failed write surfaces as a toast rather than a silently reverted edit.
    set({ boardProfiles: profiles });
    try {
      await window.electronAPI.boardConfig.setBoardProfiles(profiles);
    } catch (error) {
      await get().loadBoardProfiles();
      useToastStore.getState().addToast({
        message: `Failed to save profiles: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  },

  createSwimlane: async (input) => {
    const swimlane = await window.electronAPI.swimlanes.create(input);
    set((s) => ({ swimlanes: [...s.swimlanes, swimlane] }));
    return swimlane;
  },

  updateSwimlane: async (input) => {
    const swimlane = await window.electronAPI.swimlanes.update(input);
    set((s) => ({ swimlanes: s.swimlanes.map((l) => (l.id === swimlane.id ? swimlane : l)) }));
    return swimlane;
  },

  deleteSwimlane: async (id) => {
    await window.electronAPI.swimlanes.delete(id);
    set((s) => ({ swimlanes: s.swimlanes.filter((l) => l.id !== id) }));
    // The main-process delete also PRUNES this column out of the on-disk Board
    // Profiles, so our cached copy is stale the moment the IPC resolves. Re-read
    // it: the Column Manager snapshots `boardProfiles` at mount and writes the
    // whole array back on save, so a stale snapshot would restore the dangling
    // entry the delete just removed. The agent-driven path self-heals via
    // loadBoard(); this direct path had nothing refreshing it.
    await get().loadBoardProfiles();
  },

  reorderSwimlanes: async (ids) => {
    // Optimistic update: reorder in store immediately so dnd-kit's
    // transform release sees the correct DOM order (no snap-back).
    set((s) => ({
      swimlanes: ids.map((id, index) => {
        const lane = s.swimlanes.find((l) => l.id === id)!;
        return { ...lane, position: index };
      }),
    }));
    try {
      await window.electronAPI.swimlanes.reorder(ids);
    } catch (err) {
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to reorder columns: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  },
});

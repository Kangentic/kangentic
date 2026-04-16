import { type StateCreator } from 'zustand';
import type { Swimlane, SwimlaneCreateInput, SwimlaneUpdateInput } from '../../../shared/types';
import { useToastStore } from '../toast-store';
import type { BoardStore } from './types';

export interface SwimlaneSlice {
  swimlanes: Swimlane[];
  createSwimlane: (input: SwimlaneCreateInput) => Promise<Swimlane>;
  updateSwimlane: (input: SwimlaneUpdateInput) => Promise<Swimlane>;
  deleteSwimlane: (id: string) => Promise<void>;
  reorderSwimlanes: (ids: string[]) => Promise<void>;
}

export const createSwimlaneSlice: StateCreator<BoardStore, [], [], SwimlaneSlice> = (set, get) => ({
  swimlanes: [],

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

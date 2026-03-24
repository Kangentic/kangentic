import { create } from 'zustand';
import type {
  BacklogItem,
  BacklogItemCreateInput,
  BacklogItemUpdateInput,
  BacklogDemoteInput,
  Task,
} from '../../shared/types';
import { useBoardStore } from './board-store';

interface BacklogState {
  items: BacklogItem[];
  loading: boolean;
  selectedIds: Set<string>;

  // Data actions
  loadBacklog: () => Promise<void>;
  createItem: (input: BacklogItemCreateInput) => Promise<BacklogItem>;
  updateItem: (input: BacklogItemUpdateInput) => Promise<BacklogItem>;
  deleteItem: (id: string) => Promise<void>;
  reorderItems: (ids: string[]) => Promise<void>;
  bulkDelete: (ids: string[]) => Promise<void>;
  promoteItems: (ids: string[], targetSwimlaneId: string) => Promise<Task[]>;
  demoteTask: (input: BacklogDemoteInput) => Promise<BacklogItem>;
  renameLabel: (oldName: string, newName: string) => Promise<void>;
  deleteLabel: (name: string) => Promise<void>;

  // Selection
  toggleSelected: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;
}

export const useBacklogStore = create<BacklogState>((set, get) => ({
  items: [],
  loading: false,
  selectedIds: new Set(),

  loadBacklog: async () => {
    set({ loading: true });
    try {
      const items = await window.electronAPI.backlog.list();
      set({ items, loading: false });
    } catch (error) {
      console.error('[backlog-store] Failed to load backlog:', error);
      set({ loading: false });
    }
  },

  createItem: async (input) => {
    const item = await window.electronAPI.backlog.create(input);
    set((state) => ({ items: [...state.items, item] }));
    return item;
  },

  updateItem: async (input) => {
    const item = await window.electronAPI.backlog.update(input);
    set((state) => ({
      items: state.items.map((existing) => (existing.id === item.id ? item : existing)),
    }));
    return item;
  },

  deleteItem: async (id) => {
    await window.electronAPI.backlog.delete(id);
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
      selectedIds: (() => {
        const next = new Set(state.selectedIds);
        next.delete(id);
        return next;
      })(),
    }));
  },

  reorderItems: async (ids) => {
    // Optimistic: reorder locally first
    const { items } = get();
    const itemMap = new Map(items.map((item) => [item.id, item]));
    const reordered = ids.map((id, index) => {
      const item = itemMap.get(id);
      return item ? { ...item, position: index } : null;
    }).filter(Boolean) as BacklogItem[];
    set({ items: reordered });

    try {
      await window.electronAPI.backlog.reorder(ids);
    } catch (error) {
      console.error('[backlog-store] Reorder failed, reloading:', error);
      get().loadBacklog();
    }
  },

  bulkDelete: async (ids) => {
    await window.electronAPI.backlog.bulkDelete(ids);
    set((state) => ({
      items: state.items.filter((item) => !ids.includes(item.id)),
      selectedIds: new Set(),
    }));
  },

  promoteItems: async (ids, targetSwimlaneId) => {
    const createdTasks = await window.electronAPI.backlog.promote({
      backlogItemIds: ids,
      targetSwimlaneId,
    });

    // Remove promoted items from local state
    set((state) => ({
      items: state.items.filter((item) => !ids.includes(item.id)),
      selectedIds: new Set(),
    }));

    // Reload the board to pick up the new tasks
    useBoardStore.getState().loadBoard();

    return createdTasks;
  },

  demoteTask: async (input) => {
    const backlogItem = await window.electronAPI.backlog.demote(input);

    // Add to local backlog items
    set((state) => ({ items: [...state.items, backlogItem] }));

    // Reload the board to reflect the removed task
    useBoardStore.getState().loadBoard();

    return backlogItem;
  },

  renameLabel: async (oldName, newName) => {
    await window.electronAPI.backlog.renameLabel(oldName, newName);
    get().loadBacklog();
  },

  deleteLabel: async (name) => {
    await window.electronAPI.backlog.deleteLabel(name);
    get().loadBacklog();
  },

  toggleSelected: (id) => {
    set((state) => {
      const next = new Set(state.selectedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { selectedIds: next };
    });
  },

  selectAll: (ids) => {
    set((state) => {
      const allSelected = ids.every((id) => state.selectedIds.has(id));
      return { selectedIds: allSelected ? new Set() : new Set(ids) };
    });
  },

  clearSelection: () => set({ selectedIds: new Set() }),
}));

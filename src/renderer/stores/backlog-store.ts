import { create, type StateCreator } from 'zustand';
import type {
  BacklogTask,
  BacklogTaskCreateInput,
  BacklogTaskUpdateInput,
  BacklogDemoteInput,
  ImportSource,
  Task,
} from '../../shared/types';
import { useBoardStore } from './board-store';
import { useToastStore } from './toast-store';

interface BacklogState {
  items: BacklogTask[];
  loading: boolean;
  hydrated: boolean;
  selectedIds: Set<string>;

  // Dialog state lifted out of BacklogView so dialog open/close transitions
  // don't re-render the list, and items churn doesn't re-render closed dialog
  // subtrees. Mirrors the BoardDialogs pattern in board-store.
  showNewDialog: boolean;
  editingItem: BacklogTask | null;
  pendingDeleteId: string | null;
  pendingBulkDelete: boolean;
  importSource: ImportSource | null;

  // Search + filter state. Lifted out of BacklogView so the controls (rendered
  // in the shared ViewToggle toolbar) and the list (which filters on them) read
  // one instance. Mirrors the board's board-filter-slice. Local UI truth, so it
  // has no load*/sync* method and is absent from the App.tsx HMR re-sync block.
  backlogSearchQuery: string;
  backlogPriorityFilters: Set<number>;
  backlogLabelFilters: Set<string>;
  setBacklogSearchQuery: (query: string) => void;
  toggleBacklogPriorityFilter: (value: number) => void;
  toggleBacklogLabelFilter: (label: string) => void;
  clearBacklogFilters: () => void;

  // Data actions
  loadBacklog: () => Promise<void>;
  createItem: (input: BacklogTaskCreateInput) => Promise<BacklogTask>;
  updateItem: (input: BacklogTaskUpdateInput) => Promise<BacklogTask>;
  deleteItem: (id: string) => Promise<void>;
  reorderItems: (ids: string[]) => Promise<void>;
  bulkDelete: (ids: string[]) => Promise<void>;
  promoteItems: (ids: string[], targetSwimlaneId: string) => Promise<Task[]>;
  demoteTask: (input: BacklogDemoteInput) => Promise<BacklogTask>;
  renameLabel: (oldName: string, newName: string) => Promise<void>;
  deleteLabel: (name: string) => Promise<void>;

  // Selection
  toggleSelected: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;

  // Dialog setters
  openNewDialog: () => void;
  closeNewDialog: () => void;
  setEditingItem: (task: BacklogTask | null) => void;
  setPendingDeleteId: (id: string | null) => void;
  setPendingBulkDelete: (pending: boolean) => void;
  setImportSource: (source: ImportSource | null) => void;

  /** When set, BacklogView clears any active filter, scrolls to the row with this id,
   *  and pulses it briefly. Cleared once the scroll lands. Set by the global search
   *  palette when a backlog hit is selected. */
  scrollToBacklogId: string | null;
  setScrollToBacklogId: (id: string | null) => void;
}

const backlogStoreInitializer: StateCreator<BacklogState> = (set, get) => ({
  items: [],
  loading: false,
  hydrated: false,
  selectedIds: new Set(),
  showNewDialog: false,
  editingItem: null,
  pendingDeleteId: null,
  pendingBulkDelete: false,
  importSource: null,
  scrollToBacklogId: null,

  backlogSearchQuery: '',
  backlogPriorityFilters: new Set<number>(),
  backlogLabelFilters: new Set<string>(),

  setBacklogSearchQuery: (query) => set({ backlogSearchQuery: query }),

  toggleBacklogPriorityFilter: (value) => set((state) => {
    const next = new Set(state.backlogPriorityFilters);
    if (next.has(value)) { next.delete(value); } else { next.add(value); }
    return { backlogPriorityFilters: next };
  }),

  toggleBacklogLabelFilter: (label) => set((state) => {
    const next = new Set(state.backlogLabelFilters);
    if (next.has(label)) { next.delete(label); } else { next.add(label); }
    return { backlogLabelFilters: next };
  }),

  // Clears the priority/label sets only; the search box has its own clear.
  clearBacklogFilters: () => set({ backlogPriorityFilters: new Set<number>(), backlogLabelFilters: new Set<string>() }),

  loadBacklog: async () => {
    set({ loading: true });
    try {
      const items = await window.electronAPI.backlog.list();
      set({ items, loading: false, hydrated: true });
    } catch (error) {
      console.error('[backlog-store] Failed to load backlog:', error);
      set({ loading: false, hydrated: true });
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
    }).filter(Boolean) as BacklogTask[];
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
    // Save removed items for rollback on failure
    const removedItems = get().items.filter((item) => ids.includes(item.id));

    // Optimistically remove from backlog UI immediately
    set((state) => ({
      items: state.items.filter((item) => !ids.includes(item.id)),
      selectedIds: new Set(),
    }));

    try {
      // Fire IPC (returns after DB work, before agent spawn)
      const createdTasks = await window.electronAPI.backlog.promote({
        backlogTaskIds: ids,
        targetSwimlaneId,
      });

      // Reload the board to pick up the new tasks
      useBoardStore.getState().loadBoard();

      return createdTasks;
    } catch (error) {
      // Rollback: restore removed items
      set((state) => ({ items: [...state.items, ...removedItems] }));
      useToastStore.getState().addToast({
        message: `Failed to promote tasks: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'error',
      });
      throw error;
    }
  },

  demoteTask: async (input) => {
    const backlogTask = await window.electronAPI.backlog.demote(input);

    // Add to local backlog tasks
    set((state) => ({ items: [...state.items, backlogTask] }));

    // Reload the board to reflect the removed task
    useBoardStore.getState().loadBoard();

    return backlogTask;
  },

  renameLabel: async (oldName, newName) => {
    await window.electronAPI.backlog.renameLabel(oldName, newName);
    get().loadBacklog();
    useBoardStore.getState().loadBoard();
  },

  deleteLabel: async (name) => {
    await window.electronAPI.backlog.deleteLabel(name);
    get().loadBacklog();
    useBoardStore.getState().loadBoard();
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

  openNewDialog: () => set({ showNewDialog: true }),
  closeNewDialog: () => set({ showNewDialog: false }),
  setEditingItem: (task) => set({ editingItem: task }),
  setPendingDeleteId: (id) => set({ pendingDeleteId: id }),
  setPendingBulkDelete: (pending) => set({ pendingBulkDelete: pending }),
  setImportSource: (source) => set({ importSource: source }),
  setScrollToBacklogId: (id) => set({ scrollToBacklogId: id }),
});

const createBacklogStore = () => create<BacklogState>(backlogStoreInitializer);

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime export is the non-component `useBacklogStore`, so it is
// not a React Fast Refresh boundary. Pin the instance in `import.meta.hot.data`
// so a Fast Refresh that re-evaluates this module cannot strand a second store
// instance while the mounted backlog view stays subscribed to the first.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedBacklogStore: ReturnType<typeof createBacklogStore> | undefined = import.meta.hot?.data?.backlogStore;

export const useBacklogStore = preservedBacklogStore ?? createBacklogStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.backlogStore = useBacklogStore;
  // Editing this module's OWN code would leave the pinned instance running stale
  // closures; force a clean full reload instead (rare; prod drops this block).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}

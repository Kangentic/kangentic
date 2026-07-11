import { create } from 'zustand';
import { popOutInstanceKey } from '../../shared/pop-out';
import type { PopOutKind, PopOutParams } from '../../shared/pop-out';

/**
 * Mirrors which pop-out windows are currently open, keyed by popOutInstanceKey. Main
 * is the source of truth (its own window registry); this store hydrates once via
 * loadOpen() and stays live via the popOut:changed push (App.tsx wires onChanged).
 *
 * Only meaningful in the MAIN window: this is what lets the title bar / in-app
 * surfaces know a surface is detached and flip their trigger to "focus" instead of
 * "open", and suppress the in-app overlay/dialog/pane render (strict mutual
 * exclusivity). A pop-out window itself never reads this store.
 *
 * HMR: instance-pinned (Pattern E) + re-synced via loadOpen() in App.tsx's
 * vite:afterUpdate (Pattern B). tests/unit/hmr-resync.test.ts enforces both.
 */
export interface PopOutStore {
  openInstanceKeys: Record<string, true>;
  setOpen: (keys: string[]) => void;
  loadOpen: () => Promise<void>;
  isOpen: (kind: PopOutKind, params: PopOutParams) => boolean;
}

function createPopOutStore() {
  return create<PopOutStore>()((set, get) => ({
    openInstanceKeys: {},

    setOpen: (keys) => set({ openInstanceKeys: Object.fromEntries(keys.map((key) => [key, true as const])) }),

    loadOpen: async () => {
      const keys = await window.electronAPI.popOut.listOpen();
      get().setOpen(keys);
    },

    isOpen: (kind, params) => Boolean(get().openInstanceKeys[popOutInstanceKey(kind, params)]),
  }));
}

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this module's
// only runtime export is the non-component hook, so it is not a Fast Refresh boundary;
// without pinning, a re-eval could hand a second store to part of the tree.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedPopOutStore: ReturnType<typeof createPopOutStore> | undefined = import.meta.hot?.data?.popOutStore;

export const usePopOutStore = preservedPopOutStore ?? createPopOutStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.popOutStore = usePopOutStore;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}

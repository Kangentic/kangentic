import { type StateCreator } from 'zustand';
import type { ShortcutConfig } from '../../../shared/types';
import type { BoardStore } from './types';
import { applyStructuralSharing, applySwimlaneStructuralSharing, keepIfSameJson, keepIfUnchanged } from './structural-sharing';
import { applyTaskListPayload } from './lane-pins';
import { ARCHIVED_PREVIEW_LIMIT } from './archived-tasks-slice';
import { ensureIcons } from '../../utils/icon-registry';
import { useProjectStore } from '../project-store';

/** The open project's id, read when a load starts and again before it publishes. */
function currentProjectId(): string | null {
  return useProjectStore.getState().currentProject?.id ?? null;
}

export interface BoardHydrationSlice {
  loading: boolean;
  hydrated: boolean;
  shortcuts: (ShortcutConfig & { source: 'team' | 'local' })[];
  /**
   * HMR invariant: this method is called from App.tsx `vite:afterUpdate`
   * to re-sync the store after a hot reload replaces the module. Any
   * rename of `loadBoard` must be mirrored in the HMR handler - a unit
   * test (hmr-resync.test.ts) enforces the pairing.
   */
  loadBoard: () => Promise<void>;
  /** Same HMR invariant as loadBoard. */
  loadShortcuts: () => Promise<void>;
}

export const createBoardHydrationSlice: StateCreator<BoardStore, [], [], BoardHydrationSlice> = (set, get) => ({
  loading: false,
  hydrated: false,
  shortcuts: [],

  loadBoard: async () => {
    const projectId = currentProjectId();
    set({ loading: true });
    try {
      // Hydrate from the cheap archived PREVIEW (newest N + total count) instead
      // of the full archive, which can be many MB once hundreds of tasks pile up
      // and was cloned on every agent-driven reload. The full list loads lazily
      // only while an archive viewer is mounted (Completed dialog / deep-anchor
      // detail window), tracked by archiveViewers.
      const [nextTasks, nextSwimlanes, archivedPreview] = await Promise.all([
        window.electronAPI.tasks.list(),
        window.electronAPI.swimlanes.list(),
        window.electronAPI.tasks.listArchivedPreview(ARCHIVED_PREVIEW_LIMIT),
      ]);
      // A column icon outside the core set needs lucide's full map, and it must be in hand
      // before the columns land, so a project switch paints every icon on its first frame
      // (utils/icon-registry.ts). Null on a board of shipped icons, which adds no await.
      const iconLoad = ensureIcons(nextSwimlanes.map((swimlane) => swimlane.icon));
      if (iconLoad) await iconLoad;
      // A switch away while this load was in flight owns the board now: a warm switch back paints
      // from its snapshot and never calls loadBoard, so publishing here would put this project's
      // columns under the other one. The icon wait above is what widens that window.
      if (currentProjectId() !== projectId) return;
      // Board Profiles ride the board load so a project switch re-reads them
      // from the new project's kangentic.json. Fire-and-forget: profiles are
      // optional and a slow/missing config file must not delay the board paint.
      void get().loadBoardProfiles();
      // Automations ride it for the same reason and with the same urgency: the
      // column header glyph is derived from them, so a project switch must
      // re-read them, but a slow read must not hold the board's first paint.
      void get().loadAutomations();
      // Reuse object references for unchanged tasks/swimlanes so React.memo can
      // short-circuit. Every IPC roundtrip returns fresh JSON objects - if we
      // set them directly, every card and column re-renders on every agent event
      // even when only one row actually changed.
      const keepFull = get().archiveViewers > 0 && get().archivedFullyLoaded;
      set((state) => ({
        // Through applyTaskListPayload, not applyStructuralSharing directly:
        // loadBoard has no staleness guard, so an in-flight move's optimistic
        // lane would otherwise be clobbered by a payload issued before its
        // write. Reconciling pins in the same set() keeps the two consistent.
        ...applyTaskListPayload(state, nextTasks),
        swimlanes: applySwimlaneStructuralSharing(state.swimlanes, nextSwimlanes),
        // While a viewer holds the full archive, keep it (reconciled out-of-band
        // below); otherwise downgrade to the preview.
        // The same array when the preview did not change, so the Done column does
        // not re-render on every reload an agent's task update causes.
        archivedTasks: keepFull
          ? state.archivedTasks
          : keepIfUnchanged(state.archivedTasks, applyStructuralSharing(state.archivedTasks, archivedPreview.tasks)),
        archivedFullyLoaded: keepFull,
        archivedTotalCount: archivedPreview.totalCount,
        loading: false,
        hydrated: true,
      }));
      // A mounted viewer still needs an authoritative full refresh (an agent may
      // have archived a task); do it off the hydration critical path.
      if (keepFull) void get().loadArchivedTasks().catch(() => {});
    } catch (error) {
      console.error('[board-store] Failed to load board:', error);
      set({ loading: false, hydrated: true });
    }

    // Load shortcuts separately (non-blocking)
    get().loadShortcuts();
  },

  loadShortcuts: async () => {
    const projectId = currentProjectId();
    try {
      const shortcuts = await window.electronAPI.boardConfig.getShortcuts();
      // As in loadBoard: a pill's icon is in hand before the pill paints, and a load that a
      // project switch overtook does not publish.
      const iconLoad = ensureIcons(shortcuts.map((shortcut) => shortcut.icon));
      if (iconLoad) await iconLoad;
      if (currentProjectId() !== projectId) return;
      // Reloaded with every board load: an unchanged list keeps its identity, or
      // every open task window (whose detail host carries it) re-renders each time.
      set((state) => ({ shortcuts: keepIfSameJson(state.shortcuts, shortcuts) }));
    } catch {
      // Non-fatal: shortcuts are optional
    }
  },
});

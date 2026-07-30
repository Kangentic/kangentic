/**
 * Agent Monitor store: the cross-project aggregate view's open/closed state, its
 * rows, and the user's persisted view preference.
 *
 * Two data paths, deliberately:
 *   - `loadSnapshot()` pulls the full cross-project snapshot from main. Cheap, but
 *     it is a round trip, so it is debounced and only fires when the DB-resident
 *     half of a row can have changed.
 *   - `applyActivity()` patches a single row in place from the SESSION_ACTIVITY
 *     push, which already flows unbuffered and cross-project. This is the common
 *     case (an agent starting to wait on you) and it costs no round trip at all.
 */
import { create } from 'zustand';
import type {
  MonitorSessionRow,
  MonitorSnapshot,
  MonitorView,
  ActivityState,
  ActivityReason,
} from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/types';

/** Coalescing window for view-preference writes, so dragging a filter is one save. */
const VIEW_PERSIST_DEBOUNCE_MS = 400;


interface MonitorState {
  monitorOpen: boolean;
  rows: MonitorSessionRow[];
  /** True until the first snapshot lands, so the body can show a cold-load skeleton. */
  loading: boolean;
  loaded: boolean;
  view: MonitorView;

  open: () => void;
  close: () => void;
  toggle: () => void;
  loadSnapshot: () => Promise<void>;
  applySnapshot: (snapshot: MonitorSnapshot) => void;
  applyActivity: (sessionId: string, activity: ActivityState, reason: ActivityReason | null) => void;
  setView: (patch: Partial<MonitorView>) => void;
  hydrateView: (view: Partial<MonitorView> | undefined) => void;
}

function createMonitorStore() {
  // Module-scope mutable state, preserved across HMR (Pattern A). Without this a
  // Fast Refresh mid-flight would drop the in-flight guard and the pending save.
  // @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
  let inFlight: Promise<void> | null = import.meta.hot?.data?.monitorInFlight ?? null;
  // @ts-expect-error -- Vite handles import.meta.hot
  let persistTimer: ReturnType<typeof setTimeout> | null = import.meta.hot?.data?.monitorPersistTimer ?? null;

  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot?.dispose((data: Record<string, unknown>) => {
    data.monitorInFlight = inFlight;
    data.monitorPersistTimer = persistTimer;
  });

  const store = create<MonitorState>((set, get) => ({
    monitorOpen: false,
    rows: [],
    loading: false,
    loaded: false,
    view: DEFAULT_CONFIG.monitor,

    open: () => {
      set({ monitorOpen: true });
      void get().loadSnapshot();
    },
    close: () => set({ monitorOpen: false }),
    toggle: () => (get().monitorOpen ? get().close() : get().open()),

    loadSnapshot: async () => {
      // Dedupe concurrent callers (open + a push arriving together) onto one round trip.
      if (inFlight) return inFlight;
      const monitorApi = window.electronAPI?.monitor;
      if (!monitorApi) return;

      if (!get().loaded) set({ loading: true });
      const request = (async () => {
        try {
          const snapshot = await monitorApi.getSnapshot();
          get().applySnapshot(snapshot);
        } catch (error) {
          console.error('[monitor] Failed to load snapshot:', error);
        } finally {
          set({ loading: false });
          inFlight = null;
        }
      })();
      inFlight = request;
      return request;
    },

    applySnapshot: (snapshot) => set({ rows: snapshot.rows, loaded: true }),

    /**
     * Patch one row's live state without a refetch. The snapshot is the authority
     * on WHICH sessions exist; an activity push for a session we have not seen yet
     * is dropped rather than synthesizing a half-populated row (the next snapshot
     * will carry it complete).
     */
    applyActivity: (sessionId, activity, reason) => set((state) => {
      const index = state.rows.findIndex((row) => row.sessionId === sessionId);
      if (index === -1) return state;
      const next = [...state.rows];
      next[index] = { ...next[index], activity, activityReason: reason };
      return { rows: next };
    }),

    /**
     * The single write path for the view preference, so persistence can never be
     * forgotten per-control. Writes are debounced and go through the GLOBAL config
     * merge, which is also what makes the preference survive a quit or crash
     * rather than only an orderly close.
     */
    setView: (patch) => {
      const view = { ...get().view, ...patch };
      set({ view });

      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void window.electronAPI?.config?.set({ monitor: view }).catch((error) => {
          console.error('[monitor] Failed to persist view:', error);
        });
      }, VIEW_PERSIST_DEBOUNCE_MS);
    },

    /**
     * Seed from persisted config on boot, filling any key the stored blob lacks
     * and discarding values that are no longer valid.
     *
     * The sanitize pass matters because the option sets can shrink between
     * versions (sorting BY project was removed once it proved to duplicate
     * grouping by project). A stale value merged in blindly leaves the control
     * with nothing selected and the list ordered by the fallback - looking broken
     * rather than migrated.
     *
     * The two list filters get the harshest treatment: they are CLEARED, not
     * sanitized. No control writes them any more (the project scope picker was
     * removed - a view whose whole job is every agent everywhere does not need a
     * one-project scope), so a value an older build persisted would hide rows with
     * nothing in the UI able to bring them back. An unreachable filter is worse
     * than a stale enum, which at least falls back to a working default.
     */
    hydrateView: (view) => {
      // Legacy shapes, migrated rather than discarded: silently resetting a
      // remembered preference on upgrade is worse than a few lines of mapping.
      //   layout 'compact' -> 'list'      (renamed to name a form, not a density)
      //   hideIdle         -> liveOnly    (same boolean, honest name)
      //   groupBy 'flat'   -> default      (no longer selectable)
      //   sort 'attention' -> default      (now structural, via Status grouping)
      // `legacy` is the RAW persisted blob, deliberately read before the defaults
      // are merged in. `merged.liveOnly` is never undefined (the default supplies
      // `false`), so a `merged.liveOnly ?? legacy.hideIdle` chain would short-
      // circuit on the default and the migration below would never run.
      const legacy = (view ?? {}) as Partial<MonitorView> & { hideIdle?: boolean };
      const merged = { ...DEFAULT_CONFIG.monitor, ...(view ?? {}) };
      const valid = <T extends string>(value: T, allowed: readonly T[], fallback: T): T =>
        (allowed.includes(value) ? value : fallback);

      set({
        view: {
          ...merged,
          layout: valid(
            (merged.layout as string) === 'compact' ? 'list' : merged.layout,
            ['cards', 'table', 'list'],
            'cards',
          ),
          groupBy: valid(merged.groupBy, ['state', 'project'], DEFAULT_CONFIG.monitor.groupBy),
          sort: valid(merged.sort, ['longest-running', 'recently-started'], 'longest-running'),
          liveOnly: legacy.liveOnly ?? legacy.hideIdle ?? DEFAULT_CONFIG.monitor.liveOnly,
          projectFilter: [],
          stateFilter: [],
        },
      });
    },
  }));

  return store;
}

// HMR instance pinning (Pattern E): this module's only runtime export is the
// non-component hook, so it is not a Fast Refresh boundary; without pinning a
// re-eval could hand a second store to part of the tree.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedMonitorStore: ReturnType<typeof createMonitorStore> | undefined = import.meta.hot?.data?.monitorStore;

export const useMonitorStore = preservedMonitorStore ?? createMonitorStore();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.monitorStore = useMonitorStore;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}

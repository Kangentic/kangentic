/**
 * Agent Monitor store: the cross-project aggregate view's open/closed state, its
 * rows, and the user's persisted view preference.
 *
 * Three data paths, deliberately:
 *   - `attach()` / `detach()` bracket an open monitor. Attach registers this
 *     renderer with main - which builds and pushes MONITOR_CHANGED only while at
 *     least one renderer is subscribed - and seeds the rows from the snapshot
 *     the handshake returns, so opening is one round trip.
 *   - `loadSnapshot()` pulls the full cross-project snapshot from main without
 *     touching the subscription (the board-driven refetch and the HMR resync).
 *   - `applyActivity()` patches a single row in place from the SESSION_ACTIVITY
 *     push, which already flows unbuffered and cross-project. This is the common
 *     case (an agent starting to wait on you) and it costs no round trip at all.
 *   - `applyPeeks()` does the same for live terminal output (MONITOR_PEEK). Unlike
 *     the other two this stream is subscribe-gated, because it is the only one
 *     with a standing cost in main; see useMonitorPeekSubscription.
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
import { reconcileMonitorRows } from './monitor-rows';

/** Coalescing window for view-preference writes, so dragging a filter is one save. */
const VIEW_PERSIST_DEBOUNCE_MS = 400;

/** Value equality for a peek. At most a handful of short strings. */
function peekTextEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}


interface MonitorState {
  monitorOpen: boolean;
  rows: MonitorSessionRow[];
  /** Bumped only when a SNAPSHOT actually changed the rows (never by an
   *  `applyActivity` patch). Consumers that must refetch when the DB-resident
   *  half of a row may have changed (MonitorTaskDetailHost's bundle) key on
   *  this instead of the `rows` identity, which every cross-project activity
   *  tick replaces. */
  snapshotGeneration: number;
  /** True until the first snapshot lands, so the body can show a cold-load skeleton. */
  loading: boolean;
  loaded: boolean;
  view: MonitorView;

  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Register this renderer as a live monitor consumer with main and seed the
   *  rows from the snapshot the subscription handshake returns. Main only
   *  builds/pushes MONITOR_CHANGED while a subscriber exists, so this is what
   *  turns the push pipeline on. */
  attach: () => Promise<void>;
  /** Counterpart of attach; turns main's push pipeline back off for this
   *  renderer. Window close and hard reload are handled by main itself. */
  detach: () => void;
  loadSnapshot: () => Promise<void>;
  applySnapshot: (snapshot: MonitorSnapshot) => void;
  applyActivity: (sessionId: string, activity: ActivityState, reason: ActivityReason | null) => void;
  /** Batch of changed output peeks from MONITOR_PEEK, keyed by session id. */
  applyPeeks: (peeks: Record<string, string[]>) => void;
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
  /** Orders the two fetch-and-apply paths (attach's subscribe, loadSnapshot's
   *  getSnapshot), which are NOT deduped against each other - attach must always
   *  reach main to register the subscription. A reply applies only while it is
   *  still the newest fetch, so an older reply cannot overwrite a newer snapshot
   *  or double-bump `snapshotGeneration`. Pushes bypass this deliberately: they
   *  carry the newest build, and the next push heals any transient skew. */
  // @ts-expect-error -- Vite handles import.meta.hot
  let fetchOrdinal: number = import.meta.hot?.data?.monitorFetchOrdinal ?? 0;

  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot?.dispose((data: Record<string, unknown>) => {
    data.monitorInFlight = inFlight;
    data.monitorPersistTimer = persistTimer;
    data.monitorFetchOrdinal = fetchOrdinal;
  });

  const store = create<MonitorState>((set, get) => ({
    monitorOpen: false,
    rows: [],
    snapshotGeneration: 0,
    loading: false,
    loaded: false,
    view: DEFAULT_CONFIG.monitor,

    open: () => {
      set({ monitorOpen: true });
      void get().attach();
    },
    close: () => {
      set({ monitorOpen: false });
      get().detach();
    },
    toggle: () => (get().monitorOpen ? get().close() : get().open()),

    attach: async () => {
      const monitorApi = window.electronAPI?.monitor;
      if (!monitorApi?.subscribe) return;
      const ordinal = ++fetchOrdinal;
      if (!get().loaded) set({ loading: true });
      try {
        const snapshot = await monitorApi.subscribe();
        if (ordinal === fetchOrdinal) get().applySnapshot(snapshot);
      } catch (error) {
        // Sticky by design: pushes are gated on the subscription, so no
        // MONITOR_CHANGED arrives to self-heal a failed handshake - closing and
        // reopening the monitor re-runs it. Not worth a retry loop for a local
        // ipcRenderer.invoke that only fails once the app is tearing down.
        console.error('[monitor] Failed to subscribe:', error);
      } finally {
        set({ loading: false });
      }
    },

    detach: () => {
      void window.electronAPI?.monitor?.unsubscribe?.().catch((error) => {
        console.error('[monitor] Failed to unsubscribe:', error);
      });
    },

    loadSnapshot: async () => {
      // Dedupe concurrent loadSnapshot callers (a board-change refetch and an
      // HMR resync arriving together) onto one round trip. attach() deliberately
      // does NOT route through this gate - it must always reach main to register
      // the subscription - so `fetchOrdinal` orders the two paths instead.
      if (inFlight) return inFlight;
      const monitorApi = window.electronAPI?.monitor;
      if (!monitorApi) return;

      const ordinal = ++fetchOrdinal;
      if (!get().loaded) set({ loading: true });
      const request = (async () => {
        try {
          const snapshot = await monitorApi.getSnapshot();
          if (ordinal === fetchOrdinal) get().applySnapshot(snapshot);
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

    /**
     * Merge rather than assign. Every row arrives as a fresh object (structured
     * clone across IPC) even when nothing changed, and the push is unconditional,
     * so assigning would re-render every card on a 250ms cadence for as long as
     * session events flow. `reconcileMonitorRows` hands back the previous array
     * when the snapshot is equivalent; returning `state` untouched then makes this
     * a genuine no-op, since zustand skips the notify when the updater returns the
     * same state object.
     */
    applySnapshot: (snapshot) => set((state) => {
      const rows = reconcileMonitorRows(state.rows, snapshot.rows);
      if (rows === state.rows && state.loaded) return state;
      return { rows, loaded: true, snapshotGeneration: state.snapshotGeneration + 1 };
    }),

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
     * Patch live output peeks onto their rows, same contract as `applyActivity`:
     * the snapshot decides WHICH sessions exist, so a peek for an unknown session
     * is dropped rather than synthesizing a row.
     *
     * Arrives as a batch because main coalesces a sampling tick into one push.
     * Returning `state` untouched when nothing matched keeps a push for
     * sessions this renderer does not show (main broadcasts to every subscribed
     * monitor) from re-rendering the list.
     */
    applyPeeks: (peeks) => set((state) => {
      let next: MonitorSessionRow[] | null = null;
      for (const [sessionId, lines] of Object.entries(peeks)) {
        const index = state.rows.findIndex((row) => row.sessionId === sessionId);
        if (index === -1) continue;
        const current = next ? next[index] : state.rows[index];
        // Skip a push that says nothing new. Main change-gates per TRACKER, not
        // per renderer, so a second monitor window receives the other's
        // subscribe-time seed as a full re-send of text it already has. Without
        // this every one of those rows gets a new object identity, which defeats
        // `React.memo` on the cards and re-runs the filter/sort/group memo for a
        // frame that renders identically.
        if (peekTextEqual(current.outputPeek, lines)) continue;
        if (!next) next = [...state.rows];
        next[index] = { ...next[index], outputPeek: lines };
      }
      return next ? { rows: next } : state;
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

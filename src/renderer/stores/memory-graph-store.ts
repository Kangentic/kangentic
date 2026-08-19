/**
 * Renderer state for the Memory Graph surface.
 *
 * Deliberately a copy of the monitor/stats store shape rather than an
 * abstraction over them. Three instances is normally where an extraction earns
 * its keep, but the three differ where it matters: stats carries a
 * stale-while-revalidate payload cache, monitor carries a subscription
 * handshake and an ownership reporter, and this one carries a
 * build-in-the-background lifecycle neither of the others has. A shared base
 * forced now would fit none of them.
 *
 * The load pattern is push-first: `open()` reads the cached projection (always
 * cheap - main never runs the pass in a handler) and then asks for a refresh,
 * with the finished pass arriving on `memory:graphChanged`. There is no poller,
 * which is the point: `MemoryTab` already polls memory status every 1500ms, and
 * a second poller for the same subsystem is exactly what this avoids.
 */

import { create } from 'zustand';
import type { MemoryGraphQueryResult, MemoryGraphSnapshot } from '../../shared/types';

interface MemoryGraphState {
  graphOpen: boolean;
  snapshot: MemoryGraphSnapshot | null;
  /** The project the current snapshot describes. Re-pointing swaps it. */
  projectId: string | null;
  /**
   * True when the surface was opened without naming a project, meaning "show
   * whatever project is current" and letting main resolve it.
   *
   * This is what makes the DETACHED window work. A pop-out is a separate
   * renderer whose `usePopOutBootstrap` loads config and nothing else, so its
   * `project-store` is never populated and it cannot observe a project switch
   * in the main window. Following main instead of pinning an id means a
   * completion push for a DIFFERENT project is still a reason to re-read, and
   * the detached map re-points correctly.
   */
  followsCurrentProject: boolean;
  loading: boolean;
  loaded: boolean;

  open: (projectId: string | null) => void;
  close: () => void;
  toggle: (projectId: string | null) => void;

  /** Subscribe to completion pushes. Safe to call repeatedly. */
  attach: () => void;
  detach: () => void;

  /** The last retrieval result, or null when the box is empty. */
  query: MemoryGraphQueryResult | null;
  querying: boolean;
  runQuery: (query: string) => Promise<void>;
  clearQuery: () => void;

  loadSnapshot: (projectId?: string | null) => Promise<void>;
  /** Point the surface at a different project without a rebuild: the cached
   *  projection for that project is served immediately if it exists. */
  pointAt: (projectId: string | null) => Promise<void>;
}

// Pattern A: module-scope state preserved across HMR. These must round-trip as
// a unit - an unsubscribe handle without its in-flight guard would leave a
// duplicate listener that no longer matches the fetch it was paired with.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let inFlight: Promise<void> | null = import.meta.hot?.data?.memoryGraphInFlight ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
let unsubscribeChanged: (() => void) | null = import.meta.hot?.data?.memoryGraphUnsubscribe ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
let fetchOrdinal: number = import.meta.hot?.data?.memoryGraphFetchOrdinal ?? 0;
// @ts-expect-error -- Vite handles import.meta.hot
let queryOrdinal: number = import.meta.hot?.data?.memoryGraphQueryOrdinal ?? 0;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.memoryGraphInFlight = inFlight;
    data.memoryGraphUnsubscribe = unsubscribeChanged;
    data.memoryGraphFetchOrdinal = fetchOrdinal;
    data.memoryGraphQueryOrdinal = queryOrdinal;
  });
}

function createMemoryGraphStore() {
  return create<MemoryGraphState>((set, get) => ({
    graphOpen: false,
    snapshot: null,
    projectId: null,
    followsCurrentProject: true,
    loading: false,
    loaded: false,
    query: null,
    querying: false,

    runQuery: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        get().clearQuery();
        return;
      }
      queryOrdinal += 1;
      const ordinal = queryOrdinal;
      set({ querying: true });
      try {
        const result = await window.electronAPI.memory.queryGraph(trimmed, get().projectId);
        // Drop a slow reply that a newer keystroke already superseded.
        if (ordinal !== queryOrdinal) return;
        set({ query: result, querying: false });
      } catch {
        if (ordinal === queryOrdinal) set({ querying: false });
      }
    },

    clearQuery: () => {
      queryOrdinal += 1;
      set({ query: null, querying: false });
    },

    open: (projectId) => {
      if (get().graphOpen) return;
      // Flip first so the shell paints before any IPC resolves.
      set({ graphOpen: true, followsCurrentProject: projectId === null });
      get().attach();
      void get().loadSnapshot(projectId);
    },

    close: () => {
      set({ graphOpen: false });
      get().detach();
    },

    toggle: (projectId) => (get().graphOpen ? get().close() : get().open(projectId)),

    attach: () => {
      if (unsubscribeChanged) return;
      unsubscribeChanged = window.electronAPI.memory.onGraphChanged((changedProjectId) => {
        const { projectId, followsCurrentProject } = get();
        if (followsCurrentProject) {
          // Following main: re-read with null so main re-resolves. A push for
          // another project is exactly how a detached window learns the main
          // window switched, since it has no project store of its own.
          void get().loadSnapshot(null);
          return;
        }
        // Pinned: ignore a pass finishing for a project we are not showing, or
        // a re-point gets clobbered by the previous project's late result.
        if (changedProjectId !== projectId) return;
        void get().loadSnapshot(changedProjectId);
      });
    },

    detach: () => {
      unsubscribeChanged?.();
      unsubscribeChanged = null;
    },

    loadSnapshot: async (projectId) => {
      const targetProjectId = projectId ?? get().projectId;
      if (inFlight) return inFlight;

      fetchOrdinal += 1;
      const ordinal = fetchOrdinal;
      set({ loading: true });

      const request = (async () => {
        try {
          const snapshot = await window.electronAPI.memory.graphSnapshot(targetProjectId);
          // A newer fetch already landed: dropping this one keeps a slow reply
          // from overwriting fresher state.
          if (ordinal !== fetchOrdinal) return;
          // Trust the id main RESOLVED, not the one requested. Callers routinely
          // pass null to mean "whatever project is current", and main resolves
          // it; keeping the null would leave `projectId` null forever, so the
          // completion-push filter below would discard every push and a finished
          // build would never appear.
          set({
            snapshot,
            projectId: snapshot?.projectId ?? targetProjectId,
            loading: false,
            loaded: true,
          });

          // Ask for a rebuild only when the cache is actually stale. The
          // request is cheap and idempotent, but firing it unconditionally on
          // every open would re-enter the paced pass for no reason.
          if (snapshot && (snapshot.stale || snapshot.projection === null) && !snapshot.building) {
            void window.electronAPI.memory.refreshGraph(targetProjectId);
          }
        } catch {
          if (ordinal === fetchOrdinal) set({ loading: false, loaded: true });
        } finally {
          inFlight = null;
        }
      })();

      inFlight = request;
      return request;
    },

    pointAt: async (projectId) => {
      if (projectId === get().projectId) return;
      // Clear the old projection so the canvas never renders one project's map
      // labelled as another's while the new snapshot is in flight.
      set({ snapshot: null, projectId, loaded: false, followsCurrentProject: projectId === null });
      await get().loadSnapshot(projectId);
    },
  }));
}

// Pattern E: pin the store instance across HMR so components that already hold
// a reference keep talking to the same store.
// @ts-expect-error -- Vite handles import.meta.hot
const preservedMemoryGraphStore: ReturnType<typeof createMemoryGraphStore> | undefined = import.meta.hot?.data?.memoryGraphStore;

export const useMemoryGraphStore = preservedMemoryGraphStore ?? createMemoryGraphStore();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.memoryGraphStore = useMemoryGraphStore;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}

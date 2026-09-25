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
import type {
  MemoryGraphAnswerResult,
  MemoryGraphSnapshot,
} from '../../shared/types';

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

  /**
   * The agent's answer to the current question, or why there is none.
   *
   * There used to be a `query` beside this - the local search's own result,
   * re-run on every keystroke - and two systems answering the same box was the
   * whole confusion. One field now, because there is one act.
   */
  answer: MemoryGraphAnswerResult | null;
  answering: boolean;
  /**
   * The question the current answer belongs to.
   *
   * Kept so a NEW search can drop it. An answer is about a question, and one
   * left standing over a different search claims to be about that one instead -
   * which is exactly what it looked like: an answer about the most expensive
   * task sitting on top of a search for "terminal".
   */
  answeredQuestion: string | null;
  /**
   * The answer as it is being written, before the whole thing has arrived.
   *
   * Rendered live so the reader sees content at first-token time (measured
   * 1.1 to 1.8s) rather than a spinner until completion (measured ~6s). Only
   * prose is shown from this: refs, view, grounds and task rows are parsed off
   * the COMPLETE answer, which still replaces this when it lands.
   */
  streamingAnswer: string;
  /**
   * What the agent is doing between text, when it is not writing.
   *
   * A transcript question is several turns - search, read, answer - and
   * without this the extra turns read as a longer spinner. Null while text is
   * flowing or nothing is in flight.
   */
  streamingStatus: string | null;
  /** Asks the CURRENT query text. `granularity` is the detail level the user is
   *  looking at, so a region the answer names is one they can see. */
  askQuestion: (question: string, granularity?: string) => Promise<void>;
  clearAnswer: () => void;

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
let unsubscribeConfig: (() => void) | null = import.meta.hot?.data?.memoryGraphUnsubscribeConfig ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
let fetchOrdinal: number = import.meta.hot?.data?.memoryGraphFetchOrdinal ?? 0;
// @ts-expect-error -- Vite handles import.meta.hot
let unsubscribeStream: (() => void) | null = import.meta.hot?.data?.memoryGraphUnsubscribeStream ?? null;
// The question whose deltas are wanted. A delta carrying any other id is from a
// question the user has already moved past and is dropped, never appended.
// @ts-expect-error -- Vite handles import.meta.hot
let activeRequestId: string | null = import.meta.hot?.data?.memoryGraphActiveRequestId ?? null;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.memoryGraphInFlight = inFlight;
    data.memoryGraphUnsubscribe = unsubscribeChanged;
    data.memoryGraphUnsubscribeConfig = unsubscribeConfig;
    data.memoryGraphFetchOrdinal = fetchOrdinal;
    data.memoryGraphUnsubscribeStream = unsubscribeStream;
    data.memoryGraphActiveRequestId = activeRequestId;
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

    answer: null,
    answering: false,
    answeredQuestion: null,
    streamingAnswer: '',
    streamingStatus: null,

    askQuestion: async (question, granularity) => {
      const trimmed = question.trim();
      if (!trimmed || get().answering) return;
      // A fresh id per question. Every delta the main process pushes carries
      // it, and the subscription drops any delta whose id is not this one -
      // which is what stops a slow answer to the LAST question from writing
      // into the box for this one.
      const requestId = crypto.randomUUID();
      activeRequestId = requestId;
      // Cleared first, so a previous answer cannot sit under a spinner looking
      // like the answer to the question now being asked.
      set({
        answering: true,
        answer: null,
        answeredQuestion: null,
        streamingAnswer: '',
        streamingStatus: null,
      });
      try {
        const result = await window.electronAPI.memory.answerFromGraph(
          trimmed,
          get().projectId,
          granularity,
          requestId,
        );
        // The whole answer REPLACES the stream. Refs, view, grounds and rows
        // are all parsed off this complete text; the stream only ever carried
        // prose to look at while waiting.
        if (activeRequestId === requestId) {
          set({ answer: result, answering: false, answeredQuestion: trimmed, streamingAnswer: '', streamingStatus: null });
        }
      } catch (error) {
        if (activeRequestId === requestId) {
          set({
            answer: { ok: false, reason: error instanceof Error ? error.message : String(error) },
            answering: false,
            answeredQuestion: trimmed,
            streamingAnswer: '',
            streamingStatus: null,
          });
        }
      }
    },

    clearAnswer: () => {
      activeRequestId = null;
      set({ answer: null, answering: false, answeredQuestion: null, streamingAnswer: '', streamingStatus: null });
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
      /**
       * A CONFIG change is the other thing this surface renders, and it used to
       * be invisible here.
       *
       * The snapshot carries `semanticAvailable` and the coverage counts
       * alongside the projection, but only a projection PASS pushed an update.
       * Turning semantic search on changes the first two immediately and starts
       * no pass, so the surface kept showing "Semantic search is off" over an
       * index that was working - a stale frame the user could only clear by
       * closing and reopening.
       *
       * `config.onChanged` is a bare signal fanned to every window (the main one
       * and any pop-out), so re-reading the snapshot on it keeps a detached
       * graph honest too. It is cheap by contract: `getSnapshot` reads the cache
       * and never runs the pass.
       */
      if (!unsubscribeConfig) {
        unsubscribeConfig = window.electronAPI.config.onChanged(() => {
          if (!get().graphOpen) return;
          void get().loadSnapshot(get().followsCurrentProject ? null : get().projectId);
        });
      }
      // Progress on an answer in flight. Gated on the request id minted in
      // `askQuestion`, so a delta from a question the user has already moved
      // past is dropped rather than appended to the one on screen.
      if (!unsubscribeStream) {
        unsubscribeStream = window.electronAPI.memory.onAnswerStream((event) => {
          if (activeRequestId === null || event.requestId !== activeRequestId) return;
          if (event.kind === 'text') {
            set((state) => ({ streamingAnswer: state.streamingAnswer + event.text, streamingStatus: null }));
          } else if (event.kind === 'tool') {
            // Named for the reader, not the tool: the one tool the agent
            // holds is the conversation search, and "searching" is what
            // they should see it doing.
            set({ streamingStatus: 'Searching your conversations' });
          } else {
            // `done` clears the status line only. The text stays until the
            // whole answer arrives and replaces it, so nothing flashes empty.
            set({ streamingStatus: null });
          }
        });
      }
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
      unsubscribeConfig?.();
      unsubscribeConfig = null;
      unsubscribeStream?.();
      unsubscribeStream = null;
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

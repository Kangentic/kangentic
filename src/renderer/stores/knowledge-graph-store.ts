/**
 * Renderer state for the Knowledge Graph surface: the map, and the chat asked of it.
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
 * with the finished pass arriving on `knowledgeGraph:graphChanged`. There is no poller,
 * which is the point: `KnowledgeGraphTab` already polls memory status every 1500ms, and
 * a second poller for the same subsystem is exactly what this avoids.
 *
 * THE CHAT is a thread of turns. The first question moves from the box on the
 * map into the right panel, follow-ups go in the panel's composer, and the
 * panel's X ends the chat and brings the box back. The thread is not persisted:
 * it clears on X and on a project switch.
 */

import { create } from 'zustand';
import type {
  KnowledgeGraphAnswerHistoryTurn,
  KnowledgeGraphProjectSummary,
  KnowledgeGraphSnapshot,
  KnowledgeGraphRelatedTask,
} from '../../shared/types';

/** What a turn is doing. */
export type KnowledgeGraphChatTurnStatus = 'finding' | 'answering' | 'done' | 'failed';

/** One question and its answer. */
export interface KnowledgeGraphChatTurn {
  /** Also the request id every stream event for it carries. */
  id: string;
  question: string;
  status: KnowledgeGraphChatTurnStatus;
  /** The related work, once the local search returns. Null before that. */
  related: KnowledgeGraphRelatedTask[] | null;
  /** How many related tasks the agent was handed ("Reading 14 related tasks"). */
  handedCount: number;
  /** Each search the agent made on its own: the query, and what it found. */
  searches: Array<{ query: string; docKeys: string[] }>;
  /** The answer: streamed as it is written, then replaced by the settled prose. */
  text: string;
  /** The tasks the answer is about, in the order to show them. */
  rows: KnowledgeGraphRelatedTask[];
  /** Why it failed, verbatim. */
  reason: string | null;
}

/** What a question is asked with, besides its text. */
export interface AskOptions {
  granularity?: string;
  /** The conversations inside the map's filters, or null when unfiltered. */
  scopeDocKeys?: string[] | null;
}

interface KnowledgeGraphState {
  graphOpen: boolean;
  snapshot: KnowledgeGraphSnapshot | null;
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

  /** The chat, oldest turn first. Empty means the box is on the map. */
  thread: KnowledgeGraphChatTurn[];
  /** Which turn's tasks the map shows. Null means the latest. */
  focusedTurnId: string | null;
  /**
   * What is typed in the box and not yet asked.
   *
   * In the store rather than the component because a question can outlive the
   * box's own render: pressing Enter before an answering agent is chosen sends
   * the user to Settings > Knowledge Graph, and the question they typed has to be there,
   * unchanged, when they come back and press Enter again.
   */
  draftQuestion: string;
  setDraftQuestion: (text: string) => void;
  /**
   * A question handed in from outside the graph (Quick Find's Ask row), waiting
   * for the graph body to ask it. The body asks it through its own path, so
   * the setup check (no answering agent chosen yet) and the map's current
   * scope apply exactly as they do to a question typed into the box.
   */
  queuedQuestion: string | null;
  /** Open the graph and ask `question` there. */
  askInGraph: (question: string, projectId: string | null) => void;
  /** Take the queued question, clearing it, so it is asked once. */
  takeQueuedQuestion: () => string | null;
  /** Ask a question: the first opens the chat, later ones follow up. */
  askQuestion: (question: string, options?: AskOptions) => Promise<void>;
  /** Ask a failed turn's question again, in its place. */
  retryTurn: (turnId: string, options?: AskOptions) => Promise<void>;
  /** Show an earlier turn's tasks on the map. */
  focusTurn: (turnId: string | null) => void;
  /** End the chat: clear the thread and bring the box back. */
  endChat: () => void;

  loadSnapshot: (projectId?: string | null, options?: SnapshotReadOptions) => Promise<void>;
  /** Point the surface at a different project without a rebuild: the cached
   *  projection for that project is served immediately if it exists. */
  pointAt: (projectId: string | null) => Promise<void>;

  /** Every project the Projects picker can offer. Loaded when the graph opens. */
  projects: KnowledgeGraphProjectSummary[];
  loadProjects: () => Promise<void>;
  /**
   * Which projects the map shows and a question is asked across, or null to
   * follow the open project, which is the default and the single-project path.
   *
   * Changing it keeps the chat: the scope behaves like a filter, so a follow-up
   * is asked across the new scope. It resets when the graph closes.
   */
  scopeProjectIds: string[] | null;
  setScope: (projectIds: string[] | null) => void;
  /**
   * The scoped projects' snapshots, by project id, when the scope is set. Kept
   * apart from `snapshot` on purpose: that one is the open project's, served by
   * the single-project loader, whose in-flight guard and project-switch handling
   * would collapse several parallel loads into one.
   */
  scopeSnapshots: Record<string, KnowledgeGraphSnapshot | null>;
  loadScopeSnapshot: (projectId: string, options?: SnapshotReadOptions) => Promise<void>;
}

/** How a snapshot read came about. */
interface SnapshotReadOptions {
  /** Main pushed `knowledgeGraph:graphChanged`, rather than the reader acting. Such a
   *  read never starts a rebuild of its own (see `rebuildsAsked`). */
  fromPush?: boolean;
}

// Pattern A: module-scope state preserved across HMR. These must round-trip as
// a unit - an unsubscribe handle without its in-flight guard would leave a
// duplicate listener that no longer matches the fetch it was paired with.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let inFlight: Promise<void> | null = import.meta.hot?.data?.knowledgeGraphInFlight ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
let unsubscribeChanged: (() => void) | null = import.meta.hot?.data?.knowledgeGraphUnsubscribe ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
let unsubscribeConfig: (() => void) | null = import.meta.hot?.data?.knowledgeGraphUnsubscribeConfig ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
let fetchOrdinal: number = import.meta.hot?.data?.knowledgeGraphFetchOrdinal ?? 0;
// @ts-expect-error -- Vite handles import.meta.hot
let unsubscribeStream: (() => void) | null = import.meta.hot?.data?.knowledgeGraphUnsubscribeStream ?? null;
// The turn whose stream events are wanted. An event carrying any other id is
// from a turn the user has already moved past (or ended) and is dropped.
// @ts-expect-error -- Vite handles import.meta.hot
let activeRequestId: string | null = import.meta.hot?.data?.knowledgeGraphActiveRequestId ?? null;
// The chat's id, which keys the agent's MCP URL so its searches reach this chat.
// @ts-expect-error -- Vite handles import.meta.hot
let chatId: string | null = import.meta.hot?.data?.knowledgeGraphChatId ?? null;
// Scoped projects with a snapshot read in flight, and those asked for again
// while it was: one more read runs when the first lands, so a completion push
// that arrives mid-read is never lost.
// hmr-safe: a read in flight across a Fast Refresh finishes into the pinned store, and at worst one completion push re-reads once more
const scopeReadsInFlight = new Set<string>();
// hmr-safe: pairs with scopeReadsInFlight above
const scopeReadsPending = new Set<string>();
/**
 * Projects whose map this surface asked main to rebuild, until a read finds it
 * fresh. A push re-reads the snapshot, and only a project in here chains
 * another pass. Record sweeps and finished embedding drains push too, and any
 * turn an agent takes makes the map stale, so when every push could rebuild, an
 * open graph that was fresh when opened started a pass on each turn (a full
 * rescan once a live session's document grew) and moved its nodes under the
 * reader.
 */
// hmr-safe: losing it across a Fast Refresh ends one chain of rebuilds at most, and the next open asks again
const rebuildsAsked = new Set<string>();

/** Ask main to rebuild a stale map: always on a read the reader caused, and on
 *  a push only to carry on a rebuild this surface asked for. */
function rebuildIfStale(projectId: string, snapshot: KnowledgeGraphSnapshot | null, fromPush: boolean): void {
  if (!snapshot || snapshot.building) return;
  if (!snapshot.stale && snapshot.projection !== null) {
    rebuildsAsked.delete(projectId);
    return;
  }
  if (fromPush && !rebuildsAsked.has(projectId)) return;
  rebuildsAsked.add(projectId);
  void window.electronAPI.knowledgeGraph.refreshGraph(projectId);
}

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.knowledgeGraphInFlight = inFlight;
    data.knowledgeGraphUnsubscribe = unsubscribeChanged;
    data.knowledgeGraphUnsubscribeConfig = unsubscribeConfig;
    data.knowledgeGraphFetchOrdinal = fetchOrdinal;
    data.knowledgeGraphUnsubscribeStream = unsubscribeStream;
    data.knowledgeGraphActiveRequestId = activeRequestId;
    data.knowledgeGraphChatId = chatId;
  });
}

/** A turn's settled answer, as a follow-up carries it. */
function historyOf(thread: ReadonlyArray<KnowledgeGraphChatTurn>): KnowledgeGraphAnswerHistoryTurn[] {
  return thread
    .filter((turn) => turn.status === 'done')
    .map((turn) => ({ question: turn.question, answer: turn.text, taskKeys: turn.rows.map((row) => row.key) }));
}

function createKnowledgeGraphStore() {
  return create<KnowledgeGraphState>((set, get) => {
    /**
     * Re-read every scoped project but the open one, whose island comes from
     * the graph's own snapshot read (`loadSnapshot`). Reading it twice cost a
     * second coverage pass on main for every refresh.
     */
    const refreshScopedProjects = (): void => {
      for (const id of get().scopeProjectIds ?? []) {
        if (id !== get().projectId) void get().loadScopeSnapshot(id);
      }
    };

    /** Patch one turn in place, by id. */
    const updateTurn = (turnId: string, patch: (turn: KnowledgeGraphChatTurn) => Partial<KnowledgeGraphChatTurn>): void => {
      set((state) => ({
        thread: state.thread.map((turn) => (turn.id === turnId ? { ...turn, ...patch(turn) } : turn)),
      }));
    };

    /** Run one turn to its end. The turn is already in the thread. */
    const runTurn = async (turn: KnowledgeGraphChatTurn, history: KnowledgeGraphAnswerHistoryTurn[], options: AskOptions): Promise<void> => {
      activeRequestId = turn.id;
      // Minted by `open` normally, so the prewarmed session and the first
      // question share it; here for a caller that asks without opening.
      if (!chatId) chatId = crypto.randomUUID();
      try {
        const result = await window.electronAPI.knowledgeGraph.answerFromGraph(
          turn.question,
          get().projectId,
          options.granularity,
          turn.id,
          { chatId, history, scopeDocKeys: options.scopeDocKeys ?? null, projectIds: get().scopeProjectIds ?? undefined },
        );
        if (!get().thread.some((entry) => entry.id === turn.id)) return;
        if (result.ok) {
          updateTurn(turn.id, () => ({
            status: 'done',
            text: result.answer,
            rows: result.rows,
            related: result.related,
            handedCount: result.handedCount,
          }));
        } else {
          updateTurn(turn.id, () => ({ status: 'failed', reason: result.reason }));
        }
      } catch (error) {
        if (!get().thread.some((entry) => entry.id === turn.id)) return;
        updateTurn(turn.id, () => ({
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        if (activeRequestId === turn.id) activeRequestId = null;
      }
    };

    const newTurn = (question: string): KnowledgeGraphChatTurn => ({
      id: crypto.randomUUID(),
      question,
      status: 'finding',
      related: null,
      handedCount: 0,
      searches: [],
      text: '',
      rows: [],
      reason: null,
    });

    const inFlightTurn = (): boolean => get().thread.some(
      (turn) => turn.status === 'finding' || turn.status === 'answering',
    );

    return {
      graphOpen: false,
      snapshot: null,
      projectId: null,
      projects: [],
      scopeProjectIds: null,
      scopeSnapshots: {},
      followsCurrentProject: true,
      loading: false,
      loaded: false,

      thread: [],
      focusedTurnId: null,
      draftQuestion: '',

      setDraftQuestion: (text) => set({ draftQuestion: text }),

      queuedQuestion: null,

      askInGraph: (question, projectId) => {
        const trimmed = question.trim();
        if (!trimmed) return;
        // The draft too, so a question that goes to Settings first (no agent
        // chosen yet) is still typed when the user comes back.
        set({ queuedQuestion: trimmed, draftQuestion: trimmed });
        get().open(projectId);
      },

      takeQueuedQuestion: () => {
        const question = get().queuedQuestion;
        if (question !== null) set({ queuedQuestion: null });
        return question;
      },

      askQuestion: async (question, options = {}) => {
        const trimmed = question.trim();
        if (!trimmed || inFlightTurn()) return;
        const history = historyOf(get().thread);
        const turn = newTurn(trimmed);
        // The new turn is what the map shows, so focus follows the latest.
        set((state) => ({ thread: [...state.thread, turn], focusedTurnId: null, draftQuestion: '' }));
        await runTurn(turn, history, options);
      },

      retryTurn: async (turnId, options = {}) => {
        if (inFlightTurn()) return;
        const index = get().thread.findIndex((turn) => turn.id === turnId);
        if (index < 0) return;
        const failed = get().thread[index];
        const history = historyOf(get().thread.slice(0, index));
        const turn = newTurn(failed.question);
        set((state) => ({
          thread: [...state.thread.slice(0, index), turn, ...state.thread.slice(index + 1)],
          focusedTurnId: null,
        }));
        await runTurn(turn, history, options);
      },

      focusTurn: (turnId) => set({ focusedTurnId: turnId }),

      endChat: () => {
        activeRequestId = null;
        // The ended chat's warm session goes, and the next chat's starts, so
        // the question that follows X is as warm as the first one was.
        if (chatId) window.electronAPI.knowledgeGraph.endChat(chatId);
        chatId = crypto.randomUUID();
        set({ thread: [], focusedTurnId: null });
        if (get().graphOpen) window.electronAPI.knowledgeGraph.prewarm({ chatId, projectId: get().projectId });
      },

      open: (projectId) => {
        if (get().graphOpen) return;
        // Flip first so the shell paints before any IPC resolves.
        set({ graphOpen: true, followsCurrentProject: projectId === null });
        get().attach();
        void get().loadSnapshot(projectId);
        void get().loadProjects();
        // Start the embedding worker now, so the first question does not pay
        // its cold start before the related work can light the map, and the
        // answering agent's session for this chat, so it skips the CLI's
        // start-up. Neither embeds nor calls a model until asked.
        if (!chatId) chatId = crypto.randomUUID();
        window.electronAPI.knowledgeGraph.prewarm({ chatId, projectId: projectId ?? get().projectId });
      },

      close: () => {
        // The scope is a view choice for this visit; the next open starts on the
        // open project again. The chat is kept, its warm session is not: a
        // process idling behind a closed graph serves nobody, and the next open
        // warms one again.
        set({ graphOpen: false, scopeProjectIds: null, scopeSnapshots: {} });
        // The next open reads afresh and asks for its own rebuilds.
        rebuildsAsked.clear();
        get().detach();
        if (chatId) window.electronAPI.knowledgeGraph.endChat(chatId);
      },

      loadProjects: async () => {
        try {
          const projects = await window.electronAPI.knowledgeGraph.graphProjects();
          set({ projects });
        } catch {
          // The picker stays hidden, and the map shows the open project.
        }
      },

      setScope: (projectIds) => {
        const openProjectId = get().projectId;
        const unique = projectIds ? [...new Set(projectIds)] : null;
        // Just the open project is the default path, not a scope.
        const scope = unique && !(unique.length === 1 && unique[0] === openProjectId) ? unique : null;
        if (!scope) {
          set({ scopeProjectIds: null });
          return;
        }
        // The open project's map is already here, so it is seeded rather than
        // read again. Waiting on a read left the view with nothing to draw for
        // a moment, which blanked the map and unmounted the picker mid-choice.
        const own = get().snapshot;
        const cached = get().scopeSnapshots;
        const seeded = openProjectId && own && scope.includes(openProjectId) && !(openProjectId in cached)
          ? { ...cached, [openProjectId]: own }
          : cached;
        set({ scopeProjectIds: scope, scopeSnapshots: seeded });
        for (const id of scope) {
          if (!(id in seeded)) void get().loadScopeSnapshot(id);
        }
      },

      loadScopeSnapshot: async (projectId, options) => {
        if (scopeReadsInFlight.has(projectId)) {
          scopeReadsPending.add(projectId);
          return;
        }
        scopeReadsInFlight.add(projectId);
        try {
          const snapshot = await window.electronAPI.knowledgeGraph.graphSnapshot(projectId);
          // Dropped once the project has left the scope, or the graph closed.
          if (!get().scopeProjectIds?.includes(projectId)) return;
          set((state) => ({ scopeSnapshots: { ...state.scopeSnapshots, [projectId]: snapshot } }));
          // Only a SELECTED project is ever asked to build, never one merely
          // listed in the picker.
          rebuildIfStale(projectId, snapshot, options?.fromPush === true);
        } catch {
          if (get().scopeProjectIds?.includes(projectId)) {
            set((state) => ({ scopeSnapshots: { ...state.scopeSnapshots, [projectId]: null } }));
          }
        } finally {
          scopeReadsInFlight.delete(projectId);
          // The read asked for meanwhile was a push's: a reader's own read of a
          // scoped project happens once, when it is picked.
          if (scopeReadsPending.delete(projectId)) void get().loadScopeSnapshot(projectId, { fromPush: true });
        }
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
            refreshScopedProjects();
          });
        }
        // Progress on the turn in flight. Gated on the request id, so an event
        // from a turn the user has moved past is dropped, never applied.
        if (!unsubscribeStream) {
          unsubscribeStream = window.electronAPI.knowledgeGraph.onAnswerStream((event) => {
            if (activeRequestId === null || event.requestId !== activeRequestId) return;
            const turnId = event.requestId;
            if (event.kind === 'set') {
              updateTurn(turnId, () => ({ status: 'answering', related: event.related, handedCount: event.handedCount }));
            } else if (event.kind === 'search') {
              updateTurn(turnId, (turn) => ({ searches: [...turn.searches, { query: event.query, docKeys: event.docKeys }] }));
            } else if (event.kind === 'text') {
              updateTurn(turnId, (turn) => ({ status: 'answering', text: turn.text + event.text }));
            }
            // `tool` is covered by `search`, which the server reports for every
            // agent with the capability, query and all; `done` changes nothing
            // until the settled answer lands.
          });
        }
        if (unsubscribeChanged) return;
        unsubscribeChanged = window.electronAPI.knowledgeGraph.onGraphChanged((changedProjectId) => {
          // A scoped project's map finished: re-read just that one. The open
          // project's own read below refreshes its island too.
          if (get().scopeProjectIds?.includes(changedProjectId) && changedProjectId !== get().projectId) {
            void get().loadScopeSnapshot(changedProjectId, { fromPush: true });
          }
          const { projectId, followsCurrentProject } = get();
          if (followsCurrentProject) {
            // Following main: re-read with null so main re-resolves. A push for
            // another project is exactly how a detached window learns the main
            // window switched, since it has no project store of its own.
            void get().loadSnapshot(null, { fromPush: true });
            return;
          }
          // Pinned: ignore a pass finishing for a project we are not showing, or
          // a re-point gets clobbered by the previous project's late result.
          if (changedProjectId !== projectId) return;
          void get().loadSnapshot(changedProjectId, { fromPush: true });
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

      loadSnapshot: async (projectId, options) => {
        const targetProjectId = projectId ?? get().projectId;
        if (inFlight) return inFlight;

        fetchOrdinal += 1;
        const ordinal = fetchOrdinal;
        set({ loading: true });

        const request = (async () => {
          try {
            const snapshot = await window.electronAPI.knowledgeGraph.graphSnapshot(targetProjectId);
            // A newer fetch already landed: dropping this one keeps a slow reply
            // from overwriting fresher state.
            if (ordinal !== fetchOrdinal) return;
            // A different project means a different chat: the tasks a thread
            // names belong to the project it was asked in.
            const nextProjectId = snapshot?.projectId ?? targetProjectId;
            const switched = nextProjectId !== get().projectId;
            const projectChanged = switched && get().thread.length > 0;
            // Trust the id main RESOLVED, not the one requested. Callers routinely
            // pass null to mean "whatever project is current", and main resolves
            // it; keeping the null would leave `projectId` null forever, so the
            // completion-push filter below would discard every push and a finished
            // build would never appear.
            // The open project's island is this same snapshot, so a scope that
            // holds it takes it from here rather than reading it a second time.
            const scoped = snapshot !== null && nextProjectId !== null
              && (get().scopeProjectIds?.includes(nextProjectId) ?? false);
            set((state) => ({
              snapshot,
              projectId: nextProjectId,
              loading: false,
              loaded: true,
              ...(scoped && nextProjectId ? { scopeSnapshots: { ...state.scopeSnapshots, [nextProjectId]: snapshot } } : {}),
            }));
            // After the switch, so the next chat's session warms for the new project.
            if (projectChanged) get().endChat();

            // Ask for a rebuild only when the cache is actually stale. The
            // request is cheap and idempotent, but firing it unconditionally on
            // every open would re-enter the paced pass for no reason. A push
            // that moved a following window to another project is the main
            // window's switch, the reader's act, so it may start one.
            if (nextProjectId) rebuildIfStale(nextProjectId, snapshot, options?.fromPush === true && !switched);
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
        // labelled as another's while the new snapshot is in flight, and end
        // the chat, whose tasks belong to the old project.
        set({ snapshot: null, projectId, loaded: false, followsCurrentProject: projectId === null });
        // After the switch, so the next chat's session warms for the new project.
        get().endChat();
        await get().loadSnapshot(projectId);
      },
    };
  });
}

// Pattern E: pin the store instance across HMR so components that already hold
// a reference keep talking to the same store.
// @ts-expect-error -- Vite handles import.meta.hot
const preservedKnowledgeGraphStore: ReturnType<typeof createKnowledgeGraphStore> | undefined = import.meta.hot?.data?.knowledgeGraphStore;

export const useKnowledgeGraphStore = preservedKnowledgeGraphStore ?? createKnowledgeGraphStore();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.knowledgeGraphStore = useKnowledgeGraphStore;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}

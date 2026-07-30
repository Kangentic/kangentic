import { create } from 'zustand';
import { ACTIVITY_TAB, type Session, type SessionUsage, type SessionEvent } from '../../shared/types';
import { requiresUserInteraction, isActive } from '../../shared/activity-state';
import { useProjectStore } from './project-store';
import { useConfigStore } from './config-store';
import type { SessionStore, PendingTuiAnchor } from './session-store/types';
import { buildSessionByTaskId } from './session-store/session-index';
import { createTaskChangesPanelSlice } from './session-store/task-changes-panel-slice';
import { createTransientSessionSlice, transientKey, type TransientSessionEntry } from './session-store/transient-session-slice';
import { mergeRateLimitSnapshot } from '../utils/rate-limit-window';

const MAX_EVENTS_PER_SESSION = 500;

/**
 * Reconcile a per-session cache map fetched from main against the
 * renderer store's snapshot of the same map.
 *
 * The cache (`cached`) is the authoritative key set: it contains
 * exactly the sessions that the main-process activity engine still
 * tracks. Any id present in `current` but absent from `cached` is
 * intentionally dropped - the main process has removed that session
 * (suspend, respawn, full removal) and the renderer entry is stale.
 *
 * For ids present in both maps, the store entry wins. An IPC push
 * (`onActivity`, `onUsage`, `onEvent`) may have delivered a fresher
 * value during the async gap between fetching the cache and applying
 * it; we don't want syncSessions to clobber that.
 *
 * Why not the simpler `{ ...cached, ...current }`: that variant
 * preserves entries that no longer exist in `cached`, leading to
 * indefinite leaks of `sessionActivity[id] = 'thinking'` (and
 * matching usage/events) for sessions the engine has already
 * dropped. HMR re-runs syncSessions on every renderer reload, so
 * the leak compounds across cycles.
 */
function reconcileCache<T>(
  cached: Record<string, T>,
  current: Record<string, T>,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [sessionId, cachedValue] of Object.entries(cached)) {
    result[sessionId] = sessionId in current ? current[sessionId] : cachedValue;
  }
  return result;
}

/**
 * Like reconcileCache, but the LIVE SESSION LIST - not the fetched snapshot -
 * is the keyset authority for what counts as "still tracked".
 *
 * The plain reconcileCache evicts any store entry absent from `cached`. That
 * is correct for an UNSCOPED cache (it contains every live session), but wrong
 * for the PROJECT-SCOPED usage/events fetches: a live session in another
 * project (or one the project filter dropped because its projectId was
 * undefined mid-spawn) is absent from `cached` yet very much alive, and
 * dropping its last-known value flashes the card to the 0% baseline until the
 * next (buffered, throttled) push lands.
 *
 * So we additionally preserve any `current[id]` whose id is still in
 * `liveSessionIds`. Genuinely-gone sessions (absent from cached AND not live)
 * are still evicted, preserving the anti-'thinking'-leak contract that the
 * plain reconcileCache was built for.
 */
function reconcileLiveCache<T>(
  cached: Record<string, T>,
  current: Record<string, T>,
  liveSessionIds: Set<string>,
): Record<string, T> {
  const result = reconcileCache(cached, current);
  for (const [sessionId, currentValue] of Object.entries(current)) {
    if (!(sessionId in result) && liveSessionIds.has(sessionId)) {
      result[sessionId] = currentValue;
    }
  }
  return result;
}

/**
 * Reconcile the spawn-progress map against the queryable main-process snapshot.
 *
 * The main map (`cached`) is the strict keyset authority - if main reports no
 * in-flight spawn for a task, the renderer must not show a "Starting agent..."
 * label for it. This is what clears the HMR-strand bug: a label whose clearing
 * push was lost in the listener gap (spawn finished, or spawn failed in the
 * catch path) is dropped on the next sync because main no longer reports it.
 *
 * Note the asymmetry vs reconcileLiveCache: a live session is a KEEP signal for
 * usage (the agent is alive, keep its numbers) but a DELETE signal for spawn
 * progress (the session exists, so the spawn is over - drop the label).
 *
 * We do NOT re-add a store-only label that main does not report, even with no
 * live session: that case is indistinguishable from a strand, and an actively
 * spawning task re-establishes its label via its next progress push within
 * milliseconds. For ids main DOES report, the store value wins (async-gap
 * preservation: a fresher phase label may have arrived during the fetch).
 */
function reconcileSpawnProgress(
  cached: Record<string, string>,
  current: Record<string, string>,
  liveTaskIds: Set<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [taskId, cachedLabel] of Object.entries(cached)) {
    if (liveTaskIds.has(taskId)) continue; // session arrived -> spawn done
    result[taskId] = taskId in current ? current[taskId] : cachedLabel;
  }
  return result;
}

/**
 * HMR-resilient IPC fetch.
 *
 * Returns the resolved value on success, or `undefined` when:
 *   - The preload method does not exist (older preload bundle while the
 *     renderer has HMR'd to newer code that calls a freshly-added IPC).
 *   - The IPC call itself rejected.
 *
 * Callers handle `undefined` by preserving the existing store value
 * instead of treating a missing fetch as "the engine has nothing to
 * report" (which would evict every entry and blank out the session
 * list / terminal bindings).
 *
 * Triggered by the failure mode where adding a new preload method
 * (e.g. `getActivityReasons`) and HMR-reloading the renderer leaves the
 * renderer expecting a method the running preload doesn't have. Without
 * this wrapper, `Promise.all` rejects, `syncSessions` throws, and the
 * Zustand store stays at its post-HMR initial empty state - terminals
 * lose their session binding.
 */
async function safeFetch<T>(
  label: string,
  fn: () => Promise<T> | undefined,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[syncSessions] ${label} failed (likely HMR / preload skew):`, error);
    return undefined;
  }
}

/** Aborts in-flight syncSessions() calls when the project switches.
 *  Persisted across HMR via import.meta.hot.data so cancelSync() can
 *  still abort an in-flight sync after a module replacement. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let syncController: AbortController | null = import.meta.hot?.data?.syncController ?? null;

/** Transient session state preserved across HMR. Without this, the
 *  transientSessions map resets to {} on module re-evaluation, orphaning
 *  live PTY processes in the main process and causing duplicate spawns. */
// @ts-expect-error -- Vite handles import.meta.hot
const hmrTransientData: Record<string, unknown> | undefined = import.meta.hot?.data?.transientState;
const preservedTransientState = hmrTransientData as {
  transientSessions: Record<string, TransientSessionEntry>;
} | undefined;

/** Spawn progress labels preserved across HMR. Without this, a main-process
 *  emitSpawnProgress push that arrives pre-reload is dropped when the store
 *  re-initializes to defaults - leaving a stale "Initializing..." state on
 *  the task card that the user can't clear without a full app restart. */
// @ts-expect-error -- Vite handles import.meta.hot
const preservedSpawnProgress: Record<string, string> = import.meta.hot?.data?.spawnProgress ?? {};
// @ts-expect-error -- Vite handles import.meta.hot
const preservedPendingCommandLabel: Record<string, string> = import.meta.hot?.data?.pendingCommandLabel ?? {};

/** Conversation-viewer nav signals preserved across HMR. Without this, an HMR
 *  that re-evaluates this module resets conversationSessionId to null;
 *  useConversationWindowBridge keys on that field and treats null as "the user
 *  closed it," silently closing an open Conversation window mid-edit. */
// @ts-expect-error -- Vite handles import.meta.hot
const preservedConversationSessionId: string | null = import.meta.hot?.data?.conversationSessionId ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
const preservedScrollToTurnUuid: string | null = import.meta.hot?.data?.scrollToTurnUuid ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
const preservedPendingTuiAnchor: PendingTuiAnchor | null = import.meta.hot?.data?.pendingTuiAnchor ?? null;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.syncController = syncController;
    const state = useSessionStore.getState();
    data.transientState = {
      transientSessions: state.transientSessions,
    };
    data.spawnProgress = state.spawnProgress;
    data.pendingCommandLabel = state.pendingCommandLabel;
    data.conversationSessionId = state.conversationSessionId;
    data.scrollToTurnUuid = state.scrollToTurnUuid;
    data.pendingTuiAnchor = state.pendingTuiAnchor;
  });
}

/** Cancel any in-flight syncSessions() call. Called on project switch. */
export function cancelSync(): void {
  syncController?.abort();
  syncController = null;
}

/**
 * Session store composition. Three self-contained concerns are
 * extracted to slices under ./session-store/ (task-changes-panel,
 * usage-period, transient-session). The rest (session CRUD, sync, usage/events/activity,
 * UI hints, derived helpers) stays inline here because it's tightly
 * coupled and hard to split cleanly.
 *
 * HMR preservation: syncController (AbortController), the three
 * transient-session pointers, spawnProgress, pendingCommandLabel, and the
 * conversation-viewer nav signals (conversationSessionId, scrollToTurnUuid)
 * survive module replacement via `import.meta.hot.dispose`. Without
 * this, hot reload orphans live PTY processes, breaks in-flight
 * project switches, strands "Initializing..." indicators on
 * task cards whose in-flight spawn-progress pushes arrived pre-reload, and
 * silently closes an open Conversation window mid-edit.
 *
 * HMR re-sync: the `vite:afterUpdate` handler in App.tsx calls
 * `syncSessions()` after hot reload. Renaming syncSessions would
 * require updating that handler + the hmr-resync.test.ts unit test.
 */
export const useSessionStore = create<SessionStore>((set, get, api) => ({
  sessions: [],
  _sessionByTaskId: new Map(),
  activeSessionId: null,
  detailTaskId: null,
  detailTaskInitialEdit: false,
  dialogSessionIds: [],
  remoteDetailTaskIds: [],
  pendingDetailWindowsProjectId: null,
  scrollToEventKey: null,
  conversationSessionId: preservedConversationSessionId,
  scrollToTurnUuid: preservedScrollToTurnUuid,
  // hmr-safe: one-shot cross-project handoff, alive only during an async project
  // switch; dropping it on a coincident HMR only skips an auto-open, no visible close.
  _pendingOpenConversation: null,
  _pendingScrollToTurnUuid: null,
  pendingTuiAnchor: preservedPendingTuiAnchor,
  sessionUsage: {},
  latestRateLimits: null,
  sessionFirstOutput: {},
  sessionActivity: {},
  sessionActivityReason: {},
  sessionEvents: {},
  seenIdleSessions: {},
  pendingCommandLabel: preservedPendingCommandLabel,
  spawnProgress: preservedSpawnProgress,
  _pendingOpenTaskId: null,
  // hmr-safe: one-shot handoff, armed only across an async project switch; dropping
  // it on a coincident HMR just skips an auto-open (re-click the indicator), no
  // visible corruption. Same call as `_pendingOpenConversation` above.
  _pendingOpenCommandTerminal: false,
  setPendingOpenCommandTerminal: (value) => set({ _pendingOpenCommandTerminal: value }),

  setPendingOpenTaskId: (id) => set({ _pendingOpenTaskId: id }),

  syncSessions: async () => {
    // Abort any prior in-flight sync (e.g. user switched projects quickly)
    syncController?.abort();
    const controller = new AbortController();
    syncController = controller;
    const { signal } = controller;

    const currentProjectId = useProjectStore.getState().currentProject?.id;

    // Snapshot session references before async gap -- used to detect
    // IPC-delivered updates that arrive during the gap.
    const preAsyncSessions = new Map(get().sessions.map((s) => [s.id, s]));

    // Sessions list is always unscoped -- sidebar needs cross-project data.
    // Usage/events are scoped to current project; activity, first-output and
    // spawn-progress are unscoped (small maps; keyset reconciled against the
    // live session list below). Parallelize all IPC calls; they're independent.
    //
    // Each call is wrapped in safeFetch so a missing preload method (HMR
    // skew: renderer ahead of preload) or a transient IPC failure does
    // NOT throw out of Promise.all and leave the store at its post-HMR
    // initial empty state. Successful calls reconcile normally; missing
    // ones preserve the existing store snapshot. The optional-call
    // operator on the newer methods handles a running preload that predates
    // them.
    const sessionsApi = window.electronAPI.sessions;
    const tasksApi = window.electronAPI.tasks;
    const [
      freshSessions,
      cachedUsage,
      cachedActivity,
      cachedReasons,
      cachedEvents,
      cachedFirstOutput,
      cachedSpawnProgress,
    ] = await Promise.all([
      safeFetch('list', () => sessionsApi.list()),
      safeFetch('getUsage', () => sessionsApi.getUsage(currentProjectId)),
      safeFetch('getActivity', () => sessionsApi.getActivity()),
      safeFetch('getActivityReasons', () => sessionsApi.getActivityReasons?.()),
      safeFetch('getEventsCache', () => sessionsApi.getEventsCache(currentProjectId)),
      safeFetch('getFirstOutput', () => sessionsApi.getFirstOutput?.()),
      safeFetch('getSpawnProgress', () => tasksApi.getSpawnProgress?.()),
    ]);
    if (signal.aborted) return false;

    // Sessions list is foundational - if it failed, bail without
    // mutating store state. Better to keep stale data than to wipe the
    // session list and unmount every xterm.
    if (!freshSessions) {
      console.warn('[syncSessions] sessions.list() failed; preserving existing state');
      return false;
    }

    const currentState = get();
    const postAsyncSessions = new Map(currentState.sessions.map((s) => [s.id, s]));

    // Merge: use server data as base, but preserve IPC-delivered updates
    // that arrived during the async gap (detected by reference change).
    const mergedSessions = freshSessions.map((freshSession) => {
      const preAsync = preAsyncSessions.get(freshSession.id);
      const postAsync = postAsyncSessions.get(freshSession.id);
      // If the store's reference changed during the async gap,
      // an IPC listener updated this session -- keep the fresher version.
      if (postAsync && preAsync && postAsync !== preAsync) {
        return postAsync;
      }
      return freshSession;
    });

    const stillExists = currentState.activeSessionId
      && mergedSessions.some((s) => s.id === currentState.activeSessionId);

    // Live sets: a session the engine still actively tracks. Using the
    // established running||queued predicate (cf. task-move.ts) so exited /
    // suspended rows in the list stay evictable. These - not the
    // project-scoped fetch - are the keyset authority for the per-session
    // maps, so a live session never loses its last-known derived state just
    // because the project filter scoped its usage out.
    const isLive = (s: Session) => s.status === 'running' || s.status === 'queued';
    const liveSessionIds = new Set(mergedSessions.filter(isLive).map((s) => s.id));
    const liveTaskIds = new Set(mergedSessions.filter(isLive).map((s) => s.taskId));

    // spawnProgress: reconcile against the queryable main map. Cleared for any
    // task that now has a live session (spawn done) and for any label the main
    // map no longer holds (the clearing push may have been lost in an HMR
    // listener gap). HMR/preload skew (undefined fetch) -> preserve current
    // minus tasks that already have a live session.
    const nextSpawnProgress = cachedSpawnProgress
      ? reconcileSpawnProgress(cachedSpawnProgress, currentState.spawnProgress, liveTaskIds)
      : Object.fromEntries(
          Object.entries(currentState.spawnProgress).filter(([taskId]) => !liveTaskIds.has(taskId)),
        );

    // pendingCommandLabel (terminal overlay hint, no main-side source): prune
    // entries orphaned by HMR - a task with neither a live session nor an
    // in-flight spawn can never show its boot overlay again. Conservative: any
    // still-booting/live label is kept and cleared on the normal push path.
    const nextPendingCommandLabel = Object.fromEntries(
      Object.entries(currentState.pendingCommandLabel).filter(
        ([taskId]) => liveTaskIds.has(taskId) || taskId in nextSpawnProgress,
      ),
    );

    // For usage/events: reconcile via reconcileLiveCache - the live session
    // list is the keyset authority, so a running session keeps its last-known
    // value even when the project-scoped fetch omits it (cross-project, or a
    // mid-spawn undefined projectId). Genuinely-gone sessions are still
    // evicted, preserving the anti-'thinking'-leak contract.
    //
    // For activity/activityReason: keep plain reconcileCache. Those fetches
    // are UNSCOPED, so the cache already covers every live session; live-keep
    // would be a no-op and could mask a legitimate activity clear.
    //
    // For firstOutput: reconcile against the main tracker (authoritative,
    // unscoped) so a running session that already produced output is not
    // flashed back to its boot state after an HMR reset of this map.
    //
    // When a fetch returned undefined (HMR skew or transient failure),
    // we preserve the existing store map instead of treating it as an
    // empty cache. An empty cache would evict every entry, which is the
    // exact failure mode we're guarding against.
    //
    // latestRateLimits: fold every cached entry with rateLimits through the
    // monotonic per-window merge (order-independent for realistic inputs, where
    // a genuine rollover advances resetsAt by a whole window, far past the merge
    // epsilon; the epsilon relation is not strictly transitive at the boundary).
    // This both seeds the snapshot on first sync and, on a re-sync, only ever
    // raises it: an IPC-delivered update that arrived during the async gap has
    // already populated the store, and the merge rejects any same-window cached
    // value that is not fresher, so a stale entry can never regress it. Without
    // this
    // fold the global snapshot would stay null until the next status update,
    // leaving a noticeable gap on app start. Reference identity is preserved
    // when nothing changed, so a no-op re-sync does not re-render ContextBars.
    let nextLatestRateLimits = currentState.latestRateLimits;
    if (cachedUsage) {
      for (const [sessionId, usage] of Object.entries(cachedUsage)) {
        if (usage.rateLimits) {
          nextLatestRateLimits = mergeRateLimitSnapshot(nextLatestRateLimits, {
            rateLimits: usage.rateLimits,
            capturedAt: Date.now(),
            sourceSessionId: sessionId,
          });
        }
      }
    }
    set({
      sessions: mergedSessions,
      _sessionByTaskId: buildSessionByTaskId(mergedSessions),
      activeSessionId: stillExists ? currentState.activeSessionId : null,
      sessionUsage: cachedUsage
        ? reconcileLiveCache(cachedUsage, currentState.sessionUsage, liveSessionIds)
        : currentState.sessionUsage,
      latestRateLimits: nextLatestRateLimits,
      sessionActivity: cachedActivity
        ? reconcileCache(cachedActivity, currentState.sessionActivity)
        : currentState.sessionActivity,
      sessionActivityReason: cachedReasons
        ? reconcileCache(cachedReasons, currentState.sessionActivityReason)
        : currentState.sessionActivityReason,
      sessionEvents: cachedEvents
        ? reconcileLiveCache(cachedEvents, currentState.sessionEvents, liveSessionIds)
        : currentState.sessionEvents,
      sessionFirstOutput: cachedFirstOutput
        ? reconcileCache(cachedFirstOutput, currentState.sessionFirstOutput)
        : currentState.sessionFirstOutput,
      spawnProgress: nextSpawnProgress,
      pendingCommandLabel: nextPendingCommandLabel,
    });

    // Recover transient session entries after a full page reload. The main
    // process keeps transient PTYs alive, but the renderer's in-memory map is
    // lost on a hard reload (HMR preserves it via import.meta.hot.data, so this
    // only fires on a true reload, not Fast Refresh). Rebuild best-effort: pair
    // the project's surviving transient PTYs to slot ids in a stable order. The
    // command windows reattach by (project, slot) on next open. Skip if the
    // project already has tracked entries (the HMR-preserved path).
    if (currentProjectId) {
      const alreadyTracked = Object.values(get().transientSessions).some(
        (entry) => entry.projectId === currentProjectId,
      );
      if (!alreadyTracked) {
        const survivors = mergedSessions
          .filter((session) => session.transient && session.projectId === currentProjectId && session.status === 'running')
          .sort((sessionA, sessionB) => sessionA.id.localeCompare(sessionB.id));
        if (survivors.length > 0) {
          set((state) => {
            const transientSessions: Record<string, TransientSessionEntry> = { ...state.transientSessions };
            survivors.forEach((session, index) => {
              const slot = `slot-${index + 1}`;
              transientSessions[transientKey(currentProjectId, slot)] = {
                projectId: currentProjectId,
                slot,
                sessionId: session.id,
                branch: null,
              };
            });
            return { transientSessions };
          });
        }
      }
    }

    return true;
  },

  spawnSession: async (input) => {
    const session = await window.electronAPI.sessions.spawn(input, useProjectStore.getState().currentProject?.id ?? null);
    set((s) => {
      const sessions = [...s.sessions.filter((sess) => sess.id !== session.id && sess.taskId !== session.taskId), session];
      return {
        sessions,
        _sessionByTaskId: buildSessionByTaskId(sessions),
        activeSessionId: session.id,
      };
    });
    return session;
  },

  killSession: async (id) => {
    await window.electronAPI.sessions.kill(id);
    set((s) => {
      const sessions = s.sessions.map((sess) =>
        sess.id === id ? { ...sess, status: 'exited' as const, exitCode: -1 } : sess
      );
      return { sessions, _sessionByTaskId: buildSessionByTaskId(sessions) };
    });
  },

  resetSession: async (taskId) => {
    await window.electronAPI.sessions.reset(taskId, useProjectStore.getState().currentProject?.id ?? null);
    set((s) => {
      const sessions = s.sessions.filter((session) => session.taskId !== taskId);
      return { sessions, _sessionByTaskId: buildSessionByTaskId(sessions) };
    });
  },

  suspendSession: async (taskId) => {
    // Optimistically mark session as suspended
    set((s) => {
      const sessions = s.sessions.map((sess) =>
        sess.taskId === taskId ? { ...sess, status: 'suspended' as const } : sess
      );
      return { sessions, _sessionByTaskId: buildSessionByTaskId(sessions) };
    });
    await window.electronAPI.sessions.suspend(taskId, useProjectStore.getState().currentProject?.id ?? null);
  },

  resumeSession: async (taskId, resumePrompt?) => {
    const newSession = await window.electronAPI.sessions.resume(taskId, resumePrompt, useProjectStore.getState().currentProject?.id ?? null);
    set((s) => {
      const sessions = [
        ...s.sessions.filter((sess) => sess.taskId !== taskId),
        newSession,
      ];
      return {
        sessions,
        _sessionByTaskId: buildSessionByTaskId(sessions),
        activeSessionId: newSession.id,
      };
    });
    return newSession;
  },

  reconcileSession: async (taskId) => {
    const liveSession = await window.electronAPI.sessions.reconcile(taskId, useProjectStore.getState().currentProject?.id ?? null);
    if (!liveSession) {
      // Main has no LIVE session for this task. That includes the legitimate
      // "session is suspended" case (reconcileTaskSessionRef only returns
      // running/queued sessions), so we deliberately leave the renderer
      // cache alone here. Evicting would erase the Resume button for every
      // genuinely-suspended dialog open. The probe is a positive-heal tool
      // only; cleanup of stale suspended rows is the job of syncSessions or
      // explicit Reset.
      return null;
    }
    set((state) => {
      // Live session exists on main: replace any stale row for this task.
      // Keyed by id first (covers in-place status fix on the same id);
      // falls back to taskId eviction (covers respawn where the session
      // id changed) so we never end up with two rows for the same task.
      const existingIndex = state.sessions.findIndex((sess) => sess.id === liveSession.id);
      let sessions: Session[];
      if (existingIndex >= 0) {
        sessions = [...state.sessions];
        sessions[existingIndex] = liveSession;
      } else {
        sessions = [...state.sessions.filter((sess) => sess.taskId !== taskId), liveSession];
      }
      // Clear any in-flight spawn progress label for this task: a real
      // session has arrived, so the "Initializing..." indicator is done.
      // Mirrors upsertSession's behavior so a healed session doesn't leave
      // a stale spawnProgress entry stranded on the task card.
      const { [liveSession.taskId]: _removed, ...remainingProgress } = state.spawnProgress;
      return {
        sessions,
        _sessionByTaskId: buildSessionByTaskId(sessions),
        spawnProgress: remainingProgress,
      };
    });
    return liveSession;
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  selectActiveSession: (id) => {
    set({ activeSessionId: id });
    // Persist the user's tab choice to AppConfig so it survives project switch
    // and app restart. Skip non-persistable selections: null, the activity tab
    // sentinel, sessions outside the current project, or transient sessions.
    if (id === null || id === ACTIVITY_TAB) return;
    const session = get().sessions.find((s) => s.id === id);
    if (!session || session.transient) return;
    const currentProjectId = useProjectStore.getState().currentProject?.id;
    if (!currentProjectId || session.projectId !== currentProjectId) return;
    const existing = useConfigStore.getState().config.lastActiveTaskByProject ?? {};
    if (existing[currentProjectId] === session.taskId) return;
    const updated = { ...existing, [currentProjectId]: session.taskId };
    // Optimistically update the local config store so back-to-back calls
    // (e.g. rapid project-switch + tab-click) read the latest value rather
    // than a pre-IPC stale snapshot.
    useConfigStore.setState((state) => ({
      config: { ...state.config, lastActiveTaskByProject: updated },
      globalConfig: { ...state.globalConfig, lastActiveTaskByProject: updated },
    }));
    window.electronAPI.config.set({ lastActiveTaskByProject: updated });
  },

  setDetailTaskId: (id, options) =>
    set({ detailTaskId: id, detailTaskInitialEdit: id ? !!options?.initialEdit : false }),
  claimDialogSession: (sessionId) =>
    set((state) =>
      state.dialogSessionIds.includes(sessionId)
        ? state
        : { dialogSessionIds: [...state.dialogSessionIds, sessionId] },
    ),
  releaseDialogSession: (sessionId) =>
    set((state) => ({ dialogSessionIds: state.dialogSessionIds.filter((id) => id !== sessionId) })),
  setPendingDetailWindowsProjectId: (projectId) => set({ pendingDetailWindowsProjectId: projectId }),
  setScrollToEventKey: (key) => set({ scrollToEventKey: key }),
  setConversationSessionId: (id) => set({ conversationSessionId: id }),
  setScrollToTurnUuid: (uuid) => set({ scrollToTurnUuid: uuid }),
  setPendingOpenConversation: (id) => set({ _pendingOpenConversation: id }),
  setPendingScrollToTurnUuid: (uuid) => set({ _pendingScrollToTurnUuid: uuid }),
  setPendingTuiAnchor: (anchor) => set({ pendingTuiAnchor: anchor }),

  upsertSession: (session) => {
    set((state) => {
      const existingIndex = state.sessions.findIndex((s) => s.id === session.id);
      let sessions: Session[];
      if (existingIndex >= 0) {
        sessions = [...state.sessions];
        sessions[existingIndex] = session;
      } else {
        // New session - also remove any stale session for the same task
        // (handles respawns where the session ID changes but taskId stays)
        sessions = [...state.sessions.filter((s) => s.taskId !== session.taskId), session];
      }
      // Clear spawn progress when a real session arrives (progress is done)
      const { [session.taskId]: _removed, ...remainingProgress } = state.spawnProgress;
      return { sessions, _sessionByTaskId: buildSessionByTaskId(sessions), spawnProgress: remainingProgress };
    });
  },

  updateSessionStatus: (id, updates) => {
    set((s) => {
      const sessions = s.sessions.map((sess) =>
        sess.id === id ? { ...sess, ...updates } : sess
      );
      return { sessions, _sessionByTaskId: buildSessionByTaskId(sessions) };
    });
  },

  updateUsage: (sessionId, data) => {
    set((s) => {
      const next: Partial<SessionStore> = {
        sessionUsage: { ...s.sessionUsage, [sessionId]: data },
      };
      if (data.rateLimits) {
        // Merge monotonically per window rather than overwriting: a sibling
        // session carrying a stale cached report must not clobber a fresher
        // one, which is what made the pill flip-flop every ~5s.
        const merged = mergeRateLimitSnapshot(s.latestRateLimits, {
          rateLimits: data.rateLimits,
          capturedAt: Date.now(),
          sourceSessionId: sessionId,
        });
        if (merged !== s.latestRateLimits) {
          next.latestRateLimits = merged;
        }
      }
      return next;
    });
  },

  markFirstOutput: (sessionId) => {
    set((s) => ({
      sessionFirstOutput: { ...s.sessionFirstOutput, [sessionId]: true },
    }));
  },

  updateActivity: (sessionId, state, reason) => {
    set((s) => {
      const updates: Partial<SessionStore> = {
        sessionActivity: { ...s.sessionActivity, [sessionId]: state },
      };
      if (reason !== undefined) {
        updates.sessionActivityReason = { ...s.sessionActivityReason, [sessionId]: reason };
      }
      // When the session resumes active work, remove from seen so the next
      // idle/permission pause notifies fresh.
      if (isActive(state)) {
        const { [sessionId]: _removed, ...rest } = s.seenIdleSessions;
        updates.seenIdleSessions = rest;
      }
      return updates;
    });
  },

  addEvent: (sessionId, event) => {
    set((s) => {
      const existing = s.sessionEvents[sessionId] || [];
      const updated = [...existing, event];
      // Cap at MAX_EVENTS_PER_SESSION to keep DOM bounded
      const capped = updated.length > MAX_EVENTS_PER_SESSION
        ? updated.slice(-MAX_EVENTS_PER_SESSION)
        : updated;
      return { sessionEvents: { ...s.sessionEvents, [sessionId]: capped } };
    });
  },

  batchUpdateUsage: (entries: Map<string, SessionUsage>) => {
    set((s) => {
      const merged = { ...s.sessionUsage };
      let latestRateLimits = s.latestRateLimits;
      for (const [sessionId, data] of entries) {
        merged[sessionId] = data;
        if (data.rateLimits) {
          // Fold each entry through the monotonic per-window merge, so the
          // result is order-independent for realistic inputs (a genuine rollover
          // advances resetsAt by a whole window, far past the merge epsilon): a
          // stale entry iterated last cannot clobber a fresher one from earlier
          // in the batch.
          latestRateLimits = mergeRateLimitSnapshot(latestRateLimits, {
            rateLimits: data.rateLimits,
            capturedAt: Date.now(),
            sourceSessionId: sessionId,
          });
        }
      }
      const next: Partial<SessionStore> = { sessionUsage: merged };
      if (latestRateLimits !== s.latestRateLimits) {
        next.latestRateLimits = latestRateLimits;
      }
      return next;
    });
  },

  batchAddEvents: (entries: Array<{ sessionId: string; event: SessionEvent }>) => {
    set((s) => {
      const merged = { ...s.sessionEvents };
      for (const { sessionId, event } of entries) {
        const existing = merged[sessionId] || [];
        const updated = [...existing, event];
        merged[sessionId] = updated.length > MAX_EVENTS_PER_SESSION
          ? updated.slice(-MAX_EVENTS_PER_SESSION)
          : updated;
      }
      return { sessionEvents: merged };
    });
  },

  clearEvents: (sessionId) => {
    set((s) => {
      const { [sessionId]: _removed, ...rest } = s.sessionEvents;
      return { sessionEvents: rest };
    });
  },

  setPendingCommandLabel: (taskId, label) => {
    set((s) => ({ pendingCommandLabel: { ...s.pendingCommandLabel, [taskId]: label } }));
  },
  clearPendingCommandLabel: (taskId) => {
    set((s) => {
      const { [taskId]: _removed, ...rest } = s.pendingCommandLabel;
      return { pendingCommandLabel: rest };
    });
  },

  setSpawnProgress: (taskId, label) => {
    if (label === null) {
      set((s) => {
        const { [taskId]: _removed, ...rest } = s.spawnProgress;
        return { spawnProgress: rest };
      });
    } else {
      set((s) => ({ spawnProgress: { ...s.spawnProgress, [taskId]: label } }));
    }
  },

  markIdleSessionsSeen: (projectId) => {
    const { sessions, sessionActivity, seenIdleSessions } = get();
    const idleSessionIds = sessions
      .filter((s) => s.projectId === projectId && s.status === 'running' && requiresUserInteraction(sessionActivity[s.id]))
      .map((s) => s.id);
    if (idleSessionIds.length === 0) return;
    const updated = { ...seenIdleSessions };
    for (const id of idleSessionIds) {
      updated[id] = true;
    }
    set({ seenIdleSessions: updated });
  },

  markSingleIdleSessionSeen: (sessionId) => {
    const { sessionActivity, seenIdleSessions } = get();
    if (requiresUserInteraction(sessionActivity[sessionId]) && !seenIdleSessions[sessionId]) {
      set({ seenIdleSessions: { ...seenIdleSessions, [sessionId]: true } });
    }
  },

  getRunningCount: () => get().sessions.filter((s) => s.status === 'running').length,
  getQueuedCount: () => get().sessions.filter((s) => s.status === 'queued').length,
  getQueuePosition: (sessionId) => {
    const queued = get().sessions
      .filter((s) => s.status === 'queued')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const idx = queued.findIndex((s) => s.id === sessionId);
    if (idx === -1) return null;
    return { position: idx + 1, total: queued.length };
  },

  ...createTaskChangesPanelSlice(set, get, api),
  ...createTransientSessionSlice(preservedTransientState)(set, get, api),
}));

import { create } from 'zustand';
import type { Session, SessionUsage, ActivityState, SessionEvent } from '../../shared/types';
import { useProjectStore } from './project-store';
import type { SessionStore } from './session-store/types';
import { buildSessionByTaskId } from './session-store/session-index';
import { createTaskChangesPanelSlice } from './session-store/task-changes-panel-slice';
import { createUsagePeriodSlice } from './session-store/usage-period-slice';
import { createTransientSessionSlice } from './session-store/transient-session-slice';

const MAX_EVENTS_PER_SESSION = 500;

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
  transientSessions: Record<string, { sessionId: string; branch: string | null }>;
  transientSessionId: string | null;
  transientBranch: string | null;
} | undefined;

/** Spawn progress labels preserved across HMR. Without this, a main-process
 *  emitSpawnProgress push that arrives pre-reload is dropped when the store
 *  re-initializes to defaults - leaving a stale "Initializing..." state on
 *  the task card that the user can't clear without a full app restart. */
// @ts-expect-error -- Vite handles import.meta.hot
const preservedSpawnProgress: Record<string, string> = import.meta.hot?.data?.spawnProgress ?? {};
// @ts-expect-error -- Vite handles import.meta.hot
const preservedPendingCommandLabel: Record<string, string> = import.meta.hot?.data?.pendingCommandLabel ?? {};

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.syncController = syncController;
    const state = useSessionStore.getState();
    data.transientState = {
      transientSessions: state.transientSessions,
      transientSessionId: state.transientSessionId,
      transientBranch: state.transientBranch,
    };
    data.spawnProgress = state.spawnProgress;
    data.pendingCommandLabel = state.pendingCommandLabel;
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
 * transient-session pointers, spawnProgress, and pendingCommandLabel
 * survive module replacement via `import.meta.hot.dispose`. Without
 * this, hot reload orphans live PTY processes, breaks in-flight
 * project switches, and strands "Initializing..." indicators on
 * task cards whose in-flight spawn-progress pushes arrived pre-reload.
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
  dialogSessionId: null,
  sessionUsage: {},
  sessionFirstOutput: {},
  sessionActivity: {},
  sessionEvents: {},
  seenIdleSessions: {},
  pendingCommandLabel: preservedPendingCommandLabel,
  spawnProgress: preservedSpawnProgress,
  _pendingOpenTaskId: null,
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
    // Usage/events are scoped to current project; activity is unscoped
    // because sidebar badges need cross-project activity data.
    // Parallelize all four IPC calls -- they're independent.
    const [freshSessions, cachedUsage, cachedActivity, cachedEvents] = await Promise.all([
      window.electronAPI.sessions.list(),
      window.electronAPI.sessions.getUsage(currentProjectId),
      window.electronAPI.sessions.getActivity(),
      window.electronAPI.sessions.getEventsCache(currentProjectId),
    ]);
    if (signal.aborted) return false;

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

    // For usage/activity/events: keep store on top -- IPC-delivered updates
    // are strictly more recent than the cache snapshot.
    set({
      sessions: mergedSessions,
      _sessionByTaskId: buildSessionByTaskId(mergedSessions),
      activeSessionId: stillExists ? currentState.activeSessionId : null,
      sessionUsage: { ...cachedUsage, ...currentState.sessionUsage },
      sessionActivity: { ...cachedActivity, ...currentState.sessionActivity },
      sessionEvents: { ...cachedEvents, ...currentState.sessionEvents },
    });

    // Recover transient session pointers after a full page reload.
    // The main process keeps transient PTYs alive, but the renderer's
    // in-memory pointers (transientSessionId, transientSessions map)
    // are lost on full reload. Rebuild them from the session list.
    if (currentProjectId && !get().transientSessionId) {
      const transientSession = mergedSessions.find(
        (s) => s.transient && s.projectId === currentProjectId && s.status === 'running',
      );
      if (transientSession) {
        set((state) => ({
          transientSessions: {
            ...state.transientSessions,
            [currentProjectId]: { sessionId: transientSession.id, branch: null },
          },
          transientSessionId: transientSession.id,
          transientBranch: null,
        }));
      }
    }

    return true;
  },

  spawnSession: async (input) => {
    const session = await window.electronAPI.sessions.spawn(input);
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
    await window.electronAPI.sessions.reset(taskId);
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
    await window.electronAPI.sessions.suspend(taskId);
  },

  resumeSession: async (taskId, resumePrompt?) => {
    const newSession = await window.electronAPI.sessions.resume(taskId, resumePrompt);
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

  setActiveSession: (id) => set({ activeSessionId: id }),
  setDetailTaskId: (id) => set({ detailTaskId: id }),
  setDialogSessionId: (id) => set({ dialogSessionId: id }),

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
    set((s) => ({
      sessionUsage: { ...s.sessionUsage, [sessionId]: data },
    }));
  },

  markFirstOutput: (sessionId) => {
    set((s) => ({
      sessionFirstOutput: { ...s.sessionFirstOutput, [sessionId]: true },
    }));
  },

  updateActivity: (sessionId, state) => {
    set((s) => {
      const updates: Partial<SessionStore> = {
        sessionActivity: { ...s.sessionActivity, [sessionId]: state },
      };
      // When session resumes thinking, remove from seen so next idle is fresh
      if (state === 'thinking') {
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
      for (const [sessionId, data] of entries) {
        merged[sessionId] = data;
      }
      return { sessionUsage: merged };
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
      .filter((s) => s.projectId === projectId && s.status === 'running' && sessionActivity[s.id] === 'idle')
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
    if (sessionActivity[sessionId] === 'idle' && !seenIdleSessions[sessionId]) {
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
  ...createUsagePeriodSlice(set, get, api),
  ...createTransientSessionSlice(preservedTransientState)(set, get, api),
}));

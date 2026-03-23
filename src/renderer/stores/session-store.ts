import { create } from 'zustand';
import type { Session, SessionUsage, ActivityState, SessionEvent, SpawnSessionInput } from '../../shared/types';
import { useProjectStore } from './project-store';

const MAX_EVENTS_PER_SESSION = 500;

/** Build a taskId→Session lookup Map from the sessions array. */
function buildSessionByTaskId(sessions: Session[]): Map<string, Session> {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    map.set(session.taskId, session);
  }
  return map;
}

interface SessionStore {
  sessions: Session[];
  /** Derived O(1) lookup: taskId → Session. Rebuilt whenever `sessions` changes. */
  _sessionByTaskId: Map<string, Session>;
  // ACTIVITY_TAB = activity log tab; session UUID = individual tab; null = none
  activeSessionId: string | null;
  detailTaskId: string | null;
  dialogSessionId: string | null;
  sessionUsage: Record<string, SessionUsage>;
  /** Tracks sessions whose PTY has activated the alternate screen buffer (TUI ready). */
  sessionFirstOutput: Record<string, boolean>;
  sessionActivity: Record<string, ActivityState>;
  sessionEvents: Record<string, SessionEvent[]>;
  seenIdleSessions: Record<string, boolean>;
  /** Command label to show in the terminal overlay (e.g. "/code-review") keyed by task ID */
  pendingCommandLabel: Record<string, string>;
  _pendingOpenTaskId: string | null;
  _syncGeneration: number;

  syncSessions: () => Promise<void>;
  _bumpSyncGeneration: () => number;
  setPendingOpenTaskId: (id: string | null) => void;
  setDetailTaskId: (id: string | null) => void;
  spawnSession: (input: SpawnSessionInput) => Promise<Session>;
  killSession: (id: string) => Promise<void>;
  suspendSession: (taskId: string) => Promise<void>;
  resumeSession: (taskId: string, resumePrompt?: string) => Promise<Session>;
  setActiveSession: (id: string | null) => void;
  setDialogSessionId: (id: string | null) => void;
  upsertSession: (session: Session) => void;
  updateSessionStatus: (id: string, updates: Partial<Session>) => void;
  updateUsage: (sessionId: string, data: SessionUsage) => void;
  markFirstOutput: (sessionId: string) => void;
  updateActivity: (sessionId: string, state: ActivityState) => void;
  addEvent: (sessionId: string, event: SessionEvent) => void;
  clearEvents: (sessionId: string) => void;
  setPendingCommandLabel: (taskId: string, label: string) => void;
  clearPendingCommandLabel: (taskId: string) => void;
  markIdleSessionsSeen: (projectId: string) => void;

  // Transient session (command bar)
  transientSessionId: string | null;
  spawnTransientSession: (branch?: string) => Promise<{ session: Session; branch: string; checkoutError?: string }>;
  killTransientSession: () => Promise<void>;

  getRunningCount: () => number;
  getQueuedCount: () => number;
  getQueuePosition: (sessionId: string) => { position: number; total: number } | null;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
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
  pendingCommandLabel: {},
  _pendingOpenTaskId: null,
  _syncGeneration: 0,
  transientSessionId: null,

  setPendingOpenTaskId: (id) => set({ _pendingOpenTaskId: id }),

  _bumpSyncGeneration: () => {
    const next = get()._syncGeneration + 1;
    set({ _syncGeneration: next });
    return next;
  },

  syncSessions: async () => {
    const generation = get()._syncGeneration;
    const currentProjectId = useProjectStore.getState().currentProject?.id;

    // Snapshot session references before async gap -- used to detect
    // IPC-delivered updates that arrive during the gap.
    const preAsyncSessions = new Map(get().sessions.map((s) => [s.id, s]));

    // Sessions list is always unscoped -- sidebar needs cross-project data
    const freshSessions = await window.electronAPI.sessions.list();

    // Usage/events are scoped to current project; activity is unscoped
    // because sidebar badges need cross-project activity data.
    const cachedUsage = await window.electronAPI.sessions.getUsage(currentProjectId);
    const cachedActivity = await window.electronAPI.sessions.getActivity();
    const cachedEvents = await window.electronAPI.sessions.getEventsCache(currentProjectId);

    // Stale guard: discard if a project switch bumped the generation
    if (get()._syncGeneration !== generation) return;

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
      return { sessions, _sessionByTaskId: buildSessionByTaskId(sessions) };
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
        const { [sessionId]: _, ...rest } = s.seenIdleSessions;
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

  clearEvents: (sessionId) => {
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessionEvents;
      return { sessionEvents: rest };
    });
  },

  setPendingCommandLabel: (taskId, label) => {
    set((s) => ({ pendingCommandLabel: { ...s.pendingCommandLabel, [taskId]: label } }));
  },
  clearPendingCommandLabel: (taskId) => {
    set((s) => {
      const { [taskId]: _, ...rest } = s.pendingCommandLabel;
      return { pendingCommandLabel: rest };
    });
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

  spawnTransientSession: async (branch?) => {
    const currentProject = useProjectStore.getState().currentProject;
    if (!currentProject) throw new Error('No project is currently open');
    const result = await window.electronAPI.sessions.spawnTransient({
      projectId: currentProject.id,
      branch,
    });
    set({ transientSessionId: result.session.id });
    return result;
  },

  killTransientSession: async () => {
    const transientSessionId = get().transientSessionId;
    if (transientSessionId) {
      await window.electronAPI.sessions.killTransient(transientSessionId);
      set({ transientSessionId: null });
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
}));

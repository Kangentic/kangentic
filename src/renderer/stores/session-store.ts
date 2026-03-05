import { create } from 'zustand';
import type { Session, SessionUsage, ActivityState, SessionEvent, SpawnSessionInput } from '../../shared/types';

const MAX_EVENTS_PER_SESSION = 500;

interface SessionStore {
  sessions: Session[];
  // ACTIVITY_TAB = activity log tab; session UUID = individual tab; null = none
  activeSessionId: string | null;
  openTaskId: string | null;
  dialogSessionId: string | null;
  sessionUsage: Record<string, SessionUsage>;
  sessionActivity: Record<string, ActivityState>;
  sessionEvents: Record<string, SessionEvent[]>;
  seenIdleSessions: Record<string, boolean>;

  syncSessions: () => Promise<void>;
  spawnSession: (input: SpawnSessionInput) => Promise<Session>;
  killSession: (id: string) => Promise<void>;
  suspendSession: (taskId: string) => Promise<void>;
  resumeSession: (taskId: string) => Promise<Session>;
  setActiveSession: (id: string | null) => void;
  setOpenTaskId: (id: string | null) => void;
  setDialogSessionId: (id: string | null) => void;
  updateSessionStatus: (id: string, updates: Partial<Session>) => void;
  updateUsage: (sessionId: string, data: SessionUsage) => void;
  updateActivity: (sessionId: string, state: ActivityState) => void;
  addEvent: (sessionId: string, event: SessionEvent) => void;
  clearEvents: (sessionId: string) => void;
  markIdleSessionsSeen: (projectId: string) => void;

  getRunningCount: () => number;
  getQueuedCount: () => number;
  getQueuePosition: (sessionId: string) => { position: number; total: number } | null;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  openTaskId: null,
  dialogSessionId: null,
  sessionUsage: {},
  sessionActivity: {},
  sessionEvents: {},
  seenIdleSessions: {},

  syncSessions: async () => {
    const freshSessions = await window.electronAPI.sessions.list();
    const cachedUsage = await window.electronAPI.sessions.getUsage();
    const cachedActivity = await window.electronAPI.sessions.getActivity();
    const cachedEvents = await window.electronAPI.sessions.getEventsCache();

    // Single snapshot of current store state — prevents interleaved reads
    // if a synchronous store update lands between multiple get() calls.
    const currentState = get();

    const stillExists = currentState.activeSessionId
      && freshSessions.some((s) => s.id === currentState.activeSessionId);

    // Merge sessions: prefer store's copy (preserves IPC-delivered status
    // updates that arrived during the async calls above). Sessions only in
    // the fresh list are newly discovered and get added as-is.
    const currentSessionMap = new Map(currentState.sessions.map((session) => [session.id, session]));
    const mergedSessions = freshSessions.map((freshSession) => {
      const currentSession = currentSessionMap.get(freshSession.id);
      if (currentSession) {
        return currentSession;
      }
      return freshSession;
    });

    // Spread cached data first, then store data on top — IPC-delivered
    // updates already in the store take precedence over the snapshot.
    set({
      sessions: mergedSessions,
      activeSessionId: stillExists ? currentState.activeSessionId : null,
      sessionUsage: { ...cachedUsage, ...currentState.sessionUsage },
      sessionActivity: { ...cachedActivity, ...currentState.sessionActivity },
      sessionEvents: { ...cachedEvents, ...currentState.sessionEvents },
    });
  },

  spawnSession: async (input) => {
    const session = await window.electronAPI.sessions.spawn(input);
    set((s) => ({
      sessions: [...s.sessions.filter((sess) => sess.id !== session.id), session],
      activeSessionId: session.id,
    }));
    return session;
  },

  killSession: async (id) => {
    await window.electronAPI.sessions.kill(id);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, status: 'exited' as const, exitCode: -1 } : sess
      ),
    }));
  },

  suspendSession: async (taskId) => {
    // Optimistically mark session as suspended
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.taskId === taskId ? { ...sess, status: 'suspended' as const } : sess
      ),
    }));
    await window.electronAPI.sessions.suspend(taskId);
  },

  resumeSession: async (taskId) => {
    const newSession = await window.electronAPI.sessions.resume(taskId);
    set((s) => ({
      sessions: [
        ...s.sessions.filter((sess) => sess.taskId !== taskId),
        newSession,
      ],
      activeSessionId: newSession.id,
    }));
    return newSession;
  },

  setActiveSession: (id) => set({ activeSessionId: id }),
  setOpenTaskId: (id) => set({ openTaskId: id }),
  setDialogSessionId: (id) => set({ dialogSessionId: id }),

  updateSessionStatus: (id, updates) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, ...updates } : sess
      ),
    }));
  },

  updateUsage: (sessionId, data) => {
    set((s) => ({
      sessionUsage: { ...s.sessionUsage, [sessionId]: data },
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

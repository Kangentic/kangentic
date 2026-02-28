import { create } from 'zustand';
import type { Session, SessionUsage, ActivityState, SessionEvent, SpawnSessionInput } from '../../shared/types';

const MAX_EVENTS_PER_SESSION = 500;

interface SessionStore {
  sessions: Session[];
  // '__all__' = activity log tab; session UUID = individual tab; null = none
  activeSessionId: string | null;
  openTaskId: string | null;
  dialogSessionId: string | null;
  sessionUsage: Record<string, SessionUsage>;
  sessionActivity: Record<string, ActivityState>;
  sessionEvents: Record<string, SessionEvent[]>;

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

  syncSessions: async () => {
    const sessions = await window.electronAPI.sessions.list();
    const currentActive = get().activeSessionId;
    const stillExists = currentActive && sessions.some((s) => s.id === currentActive);

    // Restore cached data from main process (survives renderer reloads)
    const cachedUsage = await window.electronAPI.sessions.getUsage();
    const cachedActivity = await window.electronAPI.sessions.getActivity();
    const cachedEvents = await window.electronAPI.sessions.getEventsCache();

    set({
      sessions,
      activeSessionId: stillExists ? currentActive : null,
      sessionUsage: { ...get().sessionUsage, ...cachedUsage },
      sessionActivity: { ...get().sessionActivity, ...cachedActivity },
      sessionEvents: { ...get().sessionEvents, ...cachedEvents },
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
    set((s) => ({
      sessionActivity: { ...s.sessionActivity, [sessionId]: state },
    }));
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

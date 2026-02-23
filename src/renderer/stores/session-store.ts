import { create } from 'zustand';
import type { Session, SpawnSessionInput } from '../../shared/types';

interface SessionStore {
  sessions: Session[];
  activeSessionId: string | null;
  openTaskId: string | null;
  dialogSessionId: string | null;

  loadSessions: () => Promise<void>;
  spawnSession: (input: SpawnSessionInput) => Promise<Session>;
  killSession: (id: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  setOpenTaskId: (id: string | null) => void;
  setDialogSessionId: (id: string | null) => void;
  updateSessionStatus: (id: string, updates: Partial<Session>) => void;

  getRunningCount: () => number;
  getQueuedCount: () => number;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  openTaskId: null,
  dialogSessionId: null,

  loadSessions: async () => {
    const sessions = await window.electronAPI.sessions.list();
    const currentActive = get().activeSessionId;
    const stillExists = currentActive && sessions.some((s) => s.id === currentActive);
    set({
      sessions,
      // Reset activeSessionId when it no longer matches a loaded session.
      // The TerminalPanel auto-selects the first session on next render.
      activeSessionId: stillExists ? currentActive : null,
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

  getRunningCount: () => get().sessions.filter((s) => s.status === 'running').length,
  getQueuedCount: () => get().sessions.filter((s) => s.status === 'queued').length,
}));

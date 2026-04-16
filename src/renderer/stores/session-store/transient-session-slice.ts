import { type StateCreator } from 'zustand';
import type { Session } from '../../../shared/types';
import { useProjectStore } from '../project-store';
import type { SessionStore } from './types';
import { buildSessionByTaskId } from './session-index';

export interface TransientSessionSlice {
  /** Whether the command bar overlay is currently visible (drives focused-session priority). */
  commandBarVisible: boolean;
  setCommandBarVisible: (visible: boolean) => void;

  /** Per-project transient session tracking: projectId -> { sessionId, branch }. */
  transientSessions: Record<string, { sessionId: string; branch: string | null }>;
  /** Current project's transient session ID (convenience pointer into transientSessions). */
  transientSessionId: string | null;
  /** Current project's transient branch (convenience pointer into transientSessions). */
  transientBranch: string | null;

  spawnTransientSession: (branch?: string) => Promise<{ session: Session; branch: string; checkoutError?: string }>;
  killTransientSession: () => Promise<void>;
  /** Clear transient session ID without IPC call (session already exited naturally). */
  clearTransientSession: () => void;
  /** Stash current project's transient session pointers (keep PTY alive for later restore). */
  stashTransientSession: () => void;
  /** Restore a project's transient session from the map (if still alive). */
  restoreTransientSession: (projectId: string) => void;
  /** Kill a specific project's transient session and clean up all data. */
  killTransientSessionForProject: (projectId: string) => Promise<void>;
}

/**
 * Ephemeral "command terminal" sessions spawned from the command bar
 * overlay. Unlike task-bound sessions, these have no DB row and their
 * identity is tracked entirely in renderer memory (persisted across
 * HMR via import.meta.hot.data; see session-store/hmr-persistence.ts).
 *
 * Each project has at most one transient session at a time. Switching
 * projects stashes the current pointers so the PTY survives and can be
 * restored when the user returns. Closing the command bar overlay
 * keeps the PTY alive in the background.
 *
 * killTransient* methods also scrub the session's entries from all the
 * derived per-session dictionaries (usage, activity, events, etc.)
 * that live on the core slice, because the session is gone and those
 * entries would leak.
 */
export function createTransientSessionSlice(preserved: {
  transientSessions: Record<string, { sessionId: string; branch: string | null }>;
  transientSessionId: string | null;
  transientBranch: string | null;
} | undefined): StateCreator<SessionStore, [], [], TransientSessionSlice> {
  return (set, get) => ({
    commandBarVisible: false,
    setCommandBarVisible: (visible) => set({ commandBarVisible: visible }),

    transientSessions: preserved?.transientSessions ?? {},
    transientSessionId: preserved?.transientSessionId ?? null,
    transientBranch: preserved?.transientBranch ?? null,

    spawnTransientSession: async (branch?) => {
      const currentProject = useProjectStore.getState().currentProject;
      if (!currentProject) throw new Error('No project is currently open');
      const result = await window.electronAPI.sessions.spawnTransient({
        projectId: currentProject.id,
        branch,
      });
      set((state) => ({
        transientSessions: {
          ...state.transientSessions,
          [currentProject.id]: { sessionId: result.session.id, branch: result.branch },
        },
        transientSessionId: result.session.id,
        transientBranch: result.branch,
      }));
      return result;
    },

    killTransientSession: async () => {
      const transientSessionId = get().transientSessionId;
      if (transientSessionId) {
        await window.electronAPI.sessions.killTransient(transientSessionId);
        get().clearTransientSession();
      }
    },

    clearTransientSession: () => {
      const transientSessionId = get().transientSessionId;
      if (transientSessionId) {
        set((state) => {
          const { [transientSessionId]: _usage, ...restUsage } = state.sessionUsage;
          const { [transientSessionId]: _firstOutput, ...restFirstOutput } = state.sessionFirstOutput;
          const { [transientSessionId]: _activity, ...restActivity } = state.sessionActivity;
          const { [transientSessionId]: _events, ...restEvents } = state.sessionEvents;
          const { [transientSessionId]: _seen, ...restSeen } = state.seenIdleSessions;
          const sessions = state.sessions.filter((s) => s.id !== transientSessionId);

          // Remove owning project's entry from the per-project map
          const updatedTransientSessions = { ...state.transientSessions };
          for (const [projectId, entry] of Object.entries(updatedTransientSessions)) {
            if (entry.sessionId === transientSessionId) {
              delete updatedTransientSessions[projectId];
              break;
            }
          }

          return {
            sessions,
            _sessionByTaskId: buildSessionByTaskId(sessions),
            sessionUsage: restUsage,
            sessionFirstOutput: restFirstOutput,
            sessionActivity: restActivity,
            sessionEvents: restEvents,
            seenIdleSessions: restSeen,
            transientSessions: updatedTransientSessions,
            transientSessionId: null,
            transientBranch: null,
          };
        });
      } else {
        set({ transientSessionId: null, transientBranch: null });
      }
    },

    stashTransientSession: () => {
      // Null the convenience pointers only. The map entry and all session data
      // (usage, activity, events, firstOutput) stay in the store keyed by sessionId.
      set({ transientSessionId: null, transientBranch: null });
    },

    restoreTransientSession: (projectId) => {
      const entry = get().transientSessions[projectId];
      if (entry) {
        // Verify the session is still alive
        const session = get().sessions.find((s) => s.id === entry.sessionId && s.status === 'running');
        if (session) {
          set({ transientSessionId: entry.sessionId, transientBranch: entry.branch });
        } else {
          // Session died while stashed - clean up the map entry
          set((state) => {
            const { [projectId]: _removed, ...rest } = state.transientSessions;
            return { transientSessions: rest, transientSessionId: null, transientBranch: null };
          });
        }
      } else {
        set({ transientSessionId: null, transientBranch: null });
      }
    },

    killTransientSessionForProject: async (projectId) => {
      const entry = get().transientSessions[projectId];
      if (!entry) return;
      try {
        await window.electronAPI.sessions.killTransient(entry.sessionId);
      } catch {
        // Best-effort
      }
      set((state) => {
        const { [projectId]: _removed, ...restTransient } = state.transientSessions;
        const { [entry.sessionId]: _usage, ...restUsage } = state.sessionUsage;
        const { [entry.sessionId]: _firstOutput, ...restFirst } = state.sessionFirstOutput;
        const { [entry.sessionId]: _activity, ...restActivity } = state.sessionActivity;
        const { [entry.sessionId]: _events, ...restEvents } = state.sessionEvents;
        const { [entry.sessionId]: _seen, ...restSeen } = state.seenIdleSessions;
        const sessions = state.sessions.filter((s) => s.id !== entry.sessionId);
        const isCurrentTransient = state.transientSessionId === entry.sessionId;
        return {
          transientSessions: restTransient,
          transientSessionId: isCurrentTransient ? null : state.transientSessionId,
          transientBranch: isCurrentTransient ? null : state.transientBranch,
          sessions,
          _sessionByTaskId: buildSessionByTaskId(sessions),
          sessionUsage: restUsage,
          sessionFirstOutput: restFirst,
          sessionActivity: restActivity,
          sessionEvents: restEvents,
          seenIdleSessions: restSeen,
        };
      });
    },
  });
}

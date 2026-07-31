import { type StateCreator } from 'zustand';
import type { ActivityState, Session, SessionInjectSettingsInput } from '../../../shared/types';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { useProjectStore } from '../project-store';
import { useToastStore } from '../toast-store';
import type { SessionStore } from './types';
import { buildSessionByTaskId } from './session-index';

/**
 * One transient (Command Terminal) session, owned by a single command-terminal
 * window. `projectId` + `slot` are embedded in the value (not just the composite
 * key) so value-iterating consumers (the focused set, the exit handler, the
 * auto-name scheduler) can filter by project without parsing the key.
 *
 * `label` is the auto-derived display name (from the first prompt event); when
 * absent the command bar falls back to "Command Terminal".
 */
export interface TransientSessionEntry {
  projectId: string;
  /** Durable window slot id (`slot-1`, `slot-2`, ...). The window persists across
   *  the ephemeral PTY; the slot is the stable identity that pairs them. */
  slot: string;
  sessionId: string;
  branch: string | null;
  label?: string;
}

/** Composite map key. One Command Terminal window owns one (project, slot) PTY. */
export function transientKey(projectId: string, slot: string): string {
  return `${projectId}::${slot}`;
}

/** Every transient session id for a project, in map order. Drives the focused-set
 *  push (each visible terminal must be focused). Activity aggregates do NOT use
 *  this: they go through `selectCommandTerminalSummary` below, which reads the
 *  sessions list so it stays correct for background projects after a reload. */
export function selectCurrentProjectTransientSessionIds(
  transientSessions: Record<string, TransientSessionEntry>,
  projectId: string | null,
): string[] {
  if (!projectId) return [];
  return Object.values(transientSessions)
    .filter((entry) => entry.projectId === projectId)
    .map((entry) => entry.sessionId);
}

/**
 * Presentational tone for a project's Command Terminal aggregate. Derived, not an
 * `ActivityState`: the idle-vs-active bucketing already happened via the shared
 * classifiers when this was computed, so consumers may branch on it directly.
 */
export type CommandTerminalTone = 'rest' | 'thinking' | 'idle';

export interface CommandTerminalSummary {
  /** Live (running) Command Terminal PTYs the project owns right now. */
  count: number;
  tone: CommandTerminalTone;
}

const EMPTY_COMMAND_TERMINAL_SUMMARY: CommandTerminalSummary = { count: 0, tone: 'rest' };

/**
 * How many Command Terminals a project has running, and their aggregate activity
 * tone. Drives the title-bar glyph and the per-project sidebar indicator.
 *
 * Reads the SESSIONS list rather than the `transientSessions` map on purpose. That
 * map is renderer-owned window pairing, and its hard-reload recovery only re-pairs
 * the CURRENT project's survivors (see `syncSessions`), so a map-based count would
 * read zero for every background project after a reload. `session:list` is unscoped
 * and every row carries `projectId` + `transient` stamped by main, so this stays
 * correct cross-project and across reloads.
 *
 * WORKING wins: any active terminal makes the whole project read active, else
 * attention if any needs you, else rest. Bucketed only through the shared
 * classifiers (activity-state rule).
 */
export function selectCommandTerminalSummary(
  sessions: readonly Session[],
  sessionActivity: Record<string, ActivityState>,
  projectId: string | null,
): CommandTerminalSummary {
  if (!projectId) return EMPTY_COMMAND_TERMINAL_SUMMARY;
  let count = 0;
  let anyActive = false;
  let anyNeedsUser = false;
  for (const session of sessions) {
    if (!session.transient) continue;
    if (session.status !== 'running') continue;
    if (session.projectId !== projectId) continue;
    count += 1;
    const activity = sessionActivity[session.id];
    if (isActive(activity)) anyActive = true;
    else if (requiresUserInteraction(activity)) anyNeedsUser = true;
  }
  if (count === 0) return EMPTY_COMMAND_TERMINAL_SUMMARY;
  return { count, tone: anyActive ? 'thinking' : anyNeedsUser ? 'idle' : 'rest' };
}

/** Shallow copy of `record` minus any key in `ids`. */
function omitKeys<T>(record: Record<string, T>, ids: Set<string>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!ids.has(key)) result[key] = value;
  }
  return result;
}

/**
 * Strip every per-session dictionary entry + the sessions-list rows for a set of
 * dead transient sessions, in one pass. Shared by the by-id, by-slot, and
 * by-project removers: the session is gone, so leaving these entries would leak
 * (a `sessionActivity[id] = 'thinking'` that never clears, stale usage/events).
 */
function scrubSessionDicts(state: SessionStore, sessionIds: string[]): Partial<SessionStore> {
  const ids = new Set(sessionIds);
  const sessions = state.sessions.filter((session) => !ids.has(session.id));
  return {
    sessions,
    _sessionByTaskId: buildSessionByTaskId(sessions),
    sessionUsage: omitKeys(state.sessionUsage, ids),
    sessionFirstOutput: omitKeys(state.sessionFirstOutput, ids),
    sessionActivity: omitKeys(state.sessionActivity, ids),
    sessionActivityReason: omitKeys(state.sessionActivityReason, ids),
    sessionEvents: omitKeys(state.sessionEvents, ids),
    seenIdleSessions: omitKeys(state.seenIdleSessions, ids),
  };
}

export interface TransientSessionSlice {
  /** Whether the command bar overlay is currently visible (drives focused-session priority). */
  commandBarVisible: boolean;
  setCommandBarVisible: (visible: boolean) => void;

  /** Bumped to ask the mounted command bar to hide itself. The open/closed state
   *  is React state inside `useCommandBar`, so a non-React caller (the Agent
   *  Monitor's deep-link) has no handle on it; a nonce is how this codebase asks
   *  a mounted surface to do something from the outside (`requestBoardSearchFocus`).
   *  Hiding keeps every Command Terminal PTY alive, exactly like the toggle. */
  commandBarHideNonce: number;
  requestHideCommandBar: () => void;

  /** Per-(project, slot) transient session tracking, keyed by `transientKey()`.
   *  Each Command Terminal window owns one entry. */
  transientSessions: Record<string, TransientSessionEntry>;

  /** Spawn a transient session for `slot` in the current project (optionally on a
   *  branch). Records it in the map under `transientKey(projectId, slot)`. `grid`
   *  seeds the new PTY's dimensions (e.g. a branch respawn reusing the still-mounted
   *  xterm's current size); omit to spawn at the defaults. */
  spawnTransientSession: (
    slot: string,
    branch?: string,
    grid?: { cols: number; rows: number },
  ) => Promise<{ session: Session; branch: string; checkoutError?: string }>;
  /** Kill one slot's transient PTY (IPC) and scrub its renderer state. */
  killTransientSessionBySlot: (projectId: string, slot: string) => Promise<void>;
  /** Remove a transient session's renderer state by session id, no IPC (the PTY
   *  already exited naturally). Drops its (project, slot) map entry too. */
  clearTransientSessionById: (sessionId: string) => void;
  /** Kill ALL of a project's transient sessions and clean up (project delete / relocate). */
  killTransientSessionForProject: (projectId: string) => Promise<void>;
  /** Set the derived label on a transient session entry (first prompt wins). */
  setTransientSessionLabel: (sessionId: string, label: string) => void;
  /** Inject a live model/effort change into a transient session's PTY (no DB persistence).
   *  Surfaces a toast on failure; the live pill updates when the CLI echoes the new value. */
  injectTransientSettings: (input: SessionInjectSettingsInput) => Promise<void>;
}

/**
 * Ephemeral "command terminal" sessions spawned from the command bar overlay.
 * Unlike task-bound sessions, these have no DB row and their identity is tracked
 * entirely in renderer memory (persisted across HMR via import.meta.hot.data;
 * see session-store.ts).
 *
 * Phase 2: each project can have MULTIPLE transient sessions at once, one per
 * Command Terminal window. They are keyed by `(projectId, slot)`, where `slot`
 * is the owning window's durable anchor. Switching projects keeps every PTY
 * alive in the map; the command bar closes and its windows rebind to the new
 * project's slots on reopen. Closing the overlay keeps every PTY alive.
 *
 * The remove paths also scrub the session's entries from all the derived
 * per-session dictionaries (usage, activity, events, etc.) that live on the
 * core slice, because the session is gone and those entries would leak.
 */
export function createTransientSessionSlice(preserved: {
  transientSessions: Record<string, TransientSessionEntry>;
} | undefined): StateCreator<SessionStore, [], [], TransientSessionSlice> {
  return (set, get) => ({
    commandBarVisible: false,
    setCommandBarVisible: (visible) => set({ commandBarVisible: visible }),

    commandBarHideNonce: 0,
    requestHideCommandBar: () => set((state) => ({ commandBarHideNonce: state.commandBarHideNonce + 1 })),

    transientSessions: preserved?.transientSessions ?? {},

    spawnTransientSession: async (slot, branch?, grid?) => {
      const currentProject = useProjectStore.getState().currentProject;
      if (!currentProject) throw new Error('No project is currently open');
      const result = await window.electronAPI.sessions.spawnTransient({
        projectId: currentProject.id,
        // Slots are allocated here, so main cannot derive one. It is forwarded
        // purely so the Agent Monitor names this terminal the same way its own
        // window title bar does.
        slot,
        branch,
        cols: grid?.cols,
        rows: grid?.rows,
      });
      // Insert the session synchronously so anything that filters
      // state.sessions for `projectId === current && status === 'running'`
      // (Activity Engine Debugger overlay, syncSessions recovery's liveness
      // check) sees the row immediately. The push-based session-changed event
      // from the main process arrives a moment later and calls upsertSession
      // again; that call is idempotent.
      get().upsertSession(result.session);
      set((state) => ({
        transientSessions: {
          ...state.transientSessions,
          [transientKey(currentProject.id, slot)]: {
            projectId: currentProject.id,
            slot,
            sessionId: result.session.id,
            branch: result.branch,
          },
        },
      }));
      return result;
    },

    killTransientSessionBySlot: async (projectId, slot) => {
      const entry = get().transientSessions[transientKey(projectId, slot)];
      if (!entry) return;
      try {
        await window.electronAPI.sessions.killTransient(entry.sessionId);
      } catch {
        // Best-effort cleanup.
      }
      get().clearTransientSessionById(entry.sessionId);
    },

    clearTransientSessionById: (sessionId) => {
      set((state) => {
        // Drop the owning (project, slot) entry.
        const transientSessions = { ...state.transientSessions };
        for (const [key, entry] of Object.entries(transientSessions)) {
          if (entry.sessionId === sessionId) {
            delete transientSessions[key];
            break;
          }
        }
        return {
          ...scrubSessionDicts(state, [sessionId]),
          transientSessions,
        };
      });
    },

    killTransientSessionForProject: async (projectId) => {
      const entries = Object.values(get().transientSessions).filter(
        (entry) => entry.projectId === projectId,
      );
      if (entries.length === 0) return;
      for (const entry of entries) {
        try {
          await window.electronAPI.sessions.killTransient(entry.sessionId);
        } catch {
          // Best-effort
        }
      }
      set((state) => {
        const transientSessions: Record<string, TransientSessionEntry> = {};
        for (const [key, entry] of Object.entries(state.transientSessions)) {
          if (entry.projectId !== projectId) transientSessions[key] = entry;
        }
        return {
          ...scrubSessionDicts(state, entries.map((entry) => entry.sessionId)),
          transientSessions,
        };
      });
    },

    setTransientSessionLabel: (sessionId, label) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      set((state) => {
        const next = { ...state.transientSessions };
        for (const [key, entry] of Object.entries(next)) {
          if (entry.sessionId === sessionId) {
            // Only set the label once (first prompt wins). Don't overwrite a
            // user-set or earlier-derived label on subsequent prompts.
            if (entry.label) return state;
            next[key] = { ...entry, label: trimmed };
            return { transientSessions: next };
          }
        }
        return state;
      });
    },

    injectTransientSettings: async (input) => {
      // Best-effort live inject. There is no override row to roll back and no
      // optimistic UI to revert; the model/effort pill reflects the live CLI
      // value, which updates when the agent echoes the change via the usage
      // pipeline. We only surface a toast if the inject could not be applied.
      try {
        const result = await window.electronAPI.sessions.injectSettings(input);
        if (!result.ok) {
          useToastStore.getState().addToast({
            message: `Could not apply model/effort: ${result.reason}`,
            variant: 'error',
          });
        }
      } catch (error) {
        useToastStore.getState().addToast({
          message: `Could not apply model/effort: ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'error',
        });
      }
    },
  });
}

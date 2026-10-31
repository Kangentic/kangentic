import { type StateCreator } from 'zustand';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { ActivityState, Session, SessionInjectSettingsInput } from '../../../shared/types';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import { useProjectStore } from '../project-store';
import { useToastStore } from '../toast-store';
import { describeIpcError, asSentence } from '../../lib/ipc-error';
import type { SessionStore } from './types';
import { withoutSessionsIndexed } from './session-index';

/**
 * One transient (Command Terminal) session, owned by a single command-terminal
 * window. `projectId` + `slot` are embedded in the value (not just the composite
 * key) so value-iterating consumers (the focused set, the removal subscriber)
 * can filter by project without parsing the key.
 *
 * The terminal's NAME is not here: main derives it and stamps it on the session
 * row (`Session.commandTerminalLabel`), which the window title reads from the
 * replica.
 */
export interface TransientSessionEntry {
  projectId: string;
  /** Durable window slot id (`slot-1`, `slot-2`, ...). The window persists across
   *  the ephemeral PTY; the slot is the stable identity that pairs them. */
  slot: string;
  sessionId: string;
  branch: string | null;
}

/**
 * What a kill request actually did.
 *
 * `'no-session'` means the slot held no map entry, so no IPC was issued at all. It is
 * NOT a quiet success: the PTY, if one exists, is still running and now unreachable
 * from this slot. The way that actually happens is a Stop landing before the initial
 * spawn resolves, since `spawnTransientSession` inserts the entry only after its await;
 * the spawn then completes unattended and the next layer-open reconciles a window back
 * for it. `handleTerminate` still closes the window on this outcome and stays silent
 * about it - see the reasoning there before making it louder.
 */
export type TransientKillOutcome = 'killed' | 'no-session' | 'failed';

/** What a rail row's menu can ask a terminal's window to open once it is expanded. */
export type CommandTerminalWindowAction = 'commands' | 'switch-branch' | 'toggle-changes' | 'rename';

/** Composite map key. One Command Terminal window owns one (project, slot) PTY. */
export function transientKey(projectId: string, slot: string): string {
  return `${projectId}::${slot}`;
}

/**
 * Build the pairing entry for a SURVIVING PTY that main says owns `(projectId,
 * slot)`.
 *
 * Shared by the only two paths that re-pair a survivor - `adoptTransientSession`
 * below and `planTransientRecovery`'s pairing pass - because they have to agree on
 * which fields an entry carries. They once did not (the adopt path dropped the
 * terminal's name), and one builder is what stops that drifting again.
 *
 * `spawnTransientSession` deliberately does NOT use this: a fresh spawn takes its
 * branch from the spawn RESULT rather than the session row.
 */
export function buildTransientSessionEntry(
  projectId: string,
  slot: string,
  session: Session,
): TransientSessionEntry {
  return {
    projectId,
    slot,
    sessionId: session.id,
    branch: session.commandTerminalBranch ?? null,
  };
}

/**
 * The live Command Terminal slots a project holds, from the unscoped session
 * replica. A phone can start a terminal with the desktop layer closed, and main
 * gives it a slot, so the layer's "next free slot" must skip those as well as
 * its own windows' slots, or it would ask main for a slot main already gave out.
 * Every row but an exited one holds its slot, a queued one included: the same
 * set main's `reserveCommandTerminalSlot` counts.
 */
export function selectLiveCommandTerminalSlots(sessions: readonly Session[], projectId: string | null): Set<string> {
  const slots = new Set<string>();
  if (!projectId) return slots;
  for (const session of sessions) {
    if (!isCommandTerminalSession(session) || session.projectId !== projectId || session.status === 'exited') continue;
    if (session.commandTerminalSlot) slots.add(session.commandTerminalSlot);
  }
  return slots;
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
 * map is renderer-owned window pairing, reconstructed after a reload by
 * `planTransientRecovery`; reading main's own rows keeps this count independent of
 * whether that reconstruction has run yet. `session:list` is unscoped and every row
 * carries `projectId` + `transient` stamped by main, so it is correct cross-project
 * and across reloads by construction.
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
    if (!isCommandTerminalSession(session)) continue;
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
    resumeAgentSessionId?: string,
  ) => Promise<{ session: Session; branch: string; checkoutError?: string }>;
  /**
   * Earlier conversations a slot is to resume, keyed by `transientKey()`, each
   * with a nonce so asking twice for the same one still reaches the window. Set
   * by the panel's Earlier list (`requestCommandTerminalResume`) and taken by the
   * slot's window: a window still mounting spawns into it, and a live but unused
   * one ends its fresh terminal and respawns into it in place.
   */
  pendingCommandTerminalResumes: Record<string, { agentSessionId: string; nonce: number }>;
  requestCommandTerminalResume: (projectId: string, slot: string, agentSessionId: string) => void;
  /** Take (and clear) the slot's pending resume, or null when there is none. */
  takeCommandTerminalResume: (projectId: string, slot: string) => string | null;
  /** Drop the project's pending resumes for slots with no window, so a request
   *  a closed window never took cannot resume in the next terminal there. */
  dropCommandTerminalResumesExcept: (projectId: string, windowSlots: ReadonlySet<string>) => void;
  /**
   * Something the rail asked a terminal's window to open, keyed by
   * `transientKey()`, with a nonce so asking twice still reaches it. A Running
   * row's (or a strip chip's) menu expands the terminal and leaves the request;
   * the slot's window takes it and opens its Commands palette, its branch
   * picker, its Changes, or its name field, where the user can see them.
   */
  pendingCommandTerminalWindowActions: Record<string, { action: CommandTerminalWindowAction; nonce: number }>;
  requestCommandTerminalWindowAction: (projectId: string, slot: string, action: CommandTerminalWindowAction) => void;
  /** Take (and clear) the slot's pending window action, or null when there is none. */
  takeCommandTerminalWindowAction: (projectId: string, slot: string) => CommandTerminalWindowAction | null;
  /** Pair an ALREADY-RUNNING transient PTY to `(projectId, slot)` without spawning.
   *
   *  The window mount effect's last resort before it spawns: main's session row
   *  says this PTY belongs to this slot, but nothing in the map points at it. That
   *  is the reload-orphan shape, and spawning instead would manufacture a duplicate
   *  and strand the survivor. Recovery normally re-pairs first, so this only fires
   *  when a window mounts ahead of it. */
  adoptTransientSession: (projectId: string, slot: string, session: Session) => void;
  /** Kill one slot's transient PTY (IPC) and scrub its renderer state.
   *
   *  Reports which of the three things actually happened, because they are not
   *  interchangeable and used to be indistinguishable: a missing map entry issued no
   *  IPC at all and a rejected kill was swallowed, so both resolved exactly like a
   *  successful kill. A caller that surfaces "stopped" on every path tells the user a
   *  PTY died when it may still be running. The renderer state is scrubbed either way. */
  killTransientSessionBySlot: (projectId: string, slot: string) => Promise<TransientKillOutcome>;
  /** Remove a transient session's renderer state by session id, no IPC (the PTY
   *  already exited naturally). Drops its (project, slot) map entry too. */
  clearTransientSessionById: (sessionId: string) => void;
  /** Kill ALL of a project's transient sessions and clean up (project delete / relocate). */
  killTransientSessionForProject: (projectId: string) => Promise<void>;
  /** Re-derive every one of a project's Command Terminal branches from the
   *  checkout's live HEAD, and mirror each change to main.
   *
   *  The branch is a PER-PROJECT fact: every Command Terminal of a project runs
   *  in the same project root, so they all share one HEAD, and that HEAD is also
   *  moved by the user's own git usage, non-worktree task spawns, and the agents
   *  inside the terminals. The spawn-time stamp therefore goes stale, and this is
   *  what makes the pill honest again: the layer calls it on mount (a reattach)
   *  and on every diff-watcher fire. One git read per project per fire, however
   *  many terminals are open. An unknown HEAD (git error) leaves the entries as
   *  they are; a detached HEAD reads as the short sha. */
  refreshTransientBranchesFromHead: (projectId: string, projectPath: string) => Promise<void>;
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
  // In-flight HEAD refreshes by project id; the value records whether a fire
  // arrived mid-read, so the read repeats once more instead of running twice
  // at once. Function-scoped, not module-scoped: it belongs to this store
  // instance, which is pinned across HMR with the rest of the session store.
  const headRefreshRerun = new Map<string, boolean>();

  return (set, get) => ({
    commandBarVisible: false,
    setCommandBarVisible: (visible) => set({ commandBarVisible: visible }),

    commandBarHideNonce: 0,
    requestHideCommandBar: () => set((state) => ({ commandBarHideNonce: state.commandBarHideNonce + 1 })),

    transientSessions: preserved?.transientSessions ?? {},

    spawnTransientSession: async (slot, branch?, grid?, resumeAgentSessionId?) => {
      const currentProject = useProjectStore.getState().currentProject;
      // Translated: the window's catch toasts this message, and a project that
      // closes during a branch switch's stop (an await before this read) reaches it.
      if (!currentProject) throw new Error(i18n._(msg`No project is currently open`));
      const result = await window.electronAPI.sessions.spawnTransient({
        projectId: currentProject.id,
        // The window is anchored to this slot before it spawns, so it asks main
        // for it. Main owns the allocation (a phone may hold slots too) and
        // refuses a slot that is taken; the caller's catch toasts that.
        slot,
        branch,
        cols: grid?.cols,
        rows: grid?.rows,
        ...(resumeAgentSessionId ? { resumeAgentSessionId } : {}),
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

    // Not carried through the HMR stash, unlike `transientSessions`: a request
    // lives for the few frames until its window takes it, and the pinned store
    // keeps it through every update after the first.
    pendingCommandTerminalResumes: {},

    requestCommandTerminalResume: (projectId, slot, agentSessionId) => {
      set((state) => ({
        pendingCommandTerminalResumes: {
          ...state.pendingCommandTerminalResumes,
          [transientKey(projectId, slot)]: {
            agentSessionId,
            nonce: (state.pendingCommandTerminalResumes[transientKey(projectId, slot)]?.nonce ?? 0) + 1,
          },
        },
      }));
    },

    takeCommandTerminalResume: (projectId, slot) => {
      const key = transientKey(projectId, slot);
      const pending = get().pendingCommandTerminalResumes[key];
      if (!pending) return null;
      set((state) => {
        const pendingCommandTerminalResumes = { ...state.pendingCommandTerminalResumes };
        delete pendingCommandTerminalResumes[key];
        return { pendingCommandTerminalResumes };
      });
      return pending.agentSessionId;
    },

    dropCommandTerminalResumesExcept: (projectId, windowSlots) => {
      const pending = get().pendingCommandTerminalResumes;
      const projectPrefix = transientKey(projectId, '');
      const orphanedKeys = Object.keys(pending).filter((key) =>
        key.startsWith(projectPrefix) && !windowSlots.has(key.slice(projectPrefix.length)));
      if (orphanedKeys.length === 0) return;
      set((state) => {
        const pendingCommandTerminalResumes = { ...state.pendingCommandTerminalResumes };
        for (const key of orphanedKeys) delete pendingCommandTerminalResumes[key];
        return { pendingCommandTerminalResumes };
      });
    },

    // Not carried through the HMR stash, for the same reason as the resumes.
    pendingCommandTerminalWindowActions: {},

    requestCommandTerminalWindowAction: (projectId, slot, action) => {
      set((state) => ({
        pendingCommandTerminalWindowActions: {
          ...state.pendingCommandTerminalWindowActions,
          [transientKey(projectId, slot)]: {
            action,
            nonce: (state.pendingCommandTerminalWindowActions[transientKey(projectId, slot)]?.nonce ?? 0) + 1,
          },
        },
      }));
    },

    takeCommandTerminalWindowAction: (projectId, slot) => {
      const key = transientKey(projectId, slot);
      const pending = get().pendingCommandTerminalWindowActions[key];
      if (!pending) return null;
      set((state) => {
        const pendingCommandTerminalWindowActions = { ...state.pendingCommandTerminalWindowActions };
        delete pendingCommandTerminalWindowActions[key];
        return { pendingCommandTerminalWindowActions };
      });
      return pending.action;
    },

    adoptTransientSession: (projectId, slot, session) => {
      set((state) => ({
        transientSessions: {
          ...state.transientSessions,
          [transientKey(projectId, slot)]: buildTransientSessionEntry(projectId, slot, session),
        },
      }));
    },

    killTransientSessionBySlot: async (projectId, slot) => {
      const entry = get().transientSessions[transientKey(projectId, slot)];
      // No entry means no PTY to address. Nothing was killed, and saying so is the
      // point: this path issues no IPC and the caller cannot otherwise tell.
      if (!entry) return 'no-session';
      // Scrubbed BEFORE the kill, not after. Main announces the removal while the
      // kill is still in flight, and the removal subscriber
      // (useCloseCommandWindowOnRemoval) closes the window of any terminal whose
      // entry still points at the removed session. That close is for an end main
      // started (a phone's Stop, the agent exiting). This end is the window's
      // own: Stop closes the window itself, and a branch switch respawns into it.
      get().clearTransientSessionById(entry.sessionId);
      try {
        await window.electronAPI.sessions.killTransient(entry.sessionId);
      } catch {
        // The renderer already let go of a PTY it can no longer address; report
        // the failure rather than passing as a kill.
        return 'failed';
      }
      return 'killed';
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
        // The by-id scrub every dead session gets (rows, index, per-session
        // maps): shared with `removeSession`, see session-index.ts.
        return {
          ...withoutSessionsIndexed(state, [sessionId]),
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
          ...withoutSessionsIndexed(state, entries.map((entry) => entry.sessionId)),
          transientSessions,
        };
      });
    },

    refreshTransientBranchesFromHead: async (projectId, projectPath) => {
      // Nothing to correct without an entry: skip the git read outright (the
      // layer's mount fire lands before a cold spawn has written its entry).
      const hasEntry = Object.values(get().transientSessions).some((entry) => entry.projectId === projectId);
      if (!hasEntry) return;
      // Guarded, not assumed: a renderer hot-swapped ahead of its preload would
      // otherwise throw here and take the layer down with it.
      const readHead = window.electronAPI.git.worktreeHead;
      const mirrorBranch = window.electronAPI.sessions.setTransientBranch;
      if (typeof readHead !== 'function') return;

      if (headRefreshRerun.has(projectId)) {
        headRefreshRerun.set(projectId, true);
        return;
      }
      try {
        do {
          headRefreshRerun.set(projectId, false);
          let head: { branch: string | null; sha: string | null };
          try {
            head = await readHead({ path: projectPath });
          } catch {
            // Best-effort: an unreachable main leaves the entries as they are.
            return;
          }
          // A detached HEAD shows as its short sha rather than as the default
          // branch name the picker would otherwise fall back to, which is the
          // one thing the pill must never claim.
          const value = head.branch ?? (head.sha ? head.sha.slice(0, 7) : null);
          if (!value) continue;

          const changedSessionIds: string[] = [];
          set((state) => {
            let next: Record<string, TransientSessionEntry> | null = null;
            for (const [key, entry] of Object.entries(state.transientSessions)) {
              if (entry.projectId !== projectId || entry.branch === value) continue;
              if (!next) next = { ...state.transientSessions };
              next[key] = { ...entry, branch: value };
              changedSessionIds.push(entry.sessionId);
            }
            return next ? { transientSessions: next } : state;
          });
          // Mirror to main only on a real change, so a steady HEAD issues no
          // IPC per fire. Main holds it passively for the Monitor row and a
          // post-reload adopt; nothing here waits on it.
          if (typeof mirrorBranch !== 'function') continue;
          for (const sessionId of changedSessionIds) {
            void mirrorBranch(sessionId, value).catch(() => {
              // Best-effort - the branch is already applied locally.
            });
          }
        } while (headRefreshRerun.get(projectId) === true);
      } finally {
        headRefreshRerun.delete(projectId);
      }
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
            title: i18n._(msg`Couldn't apply model or effort`),
            message: asSentence(result.reason),
            variant: 'error',
          });
        }
      } catch (error) {
        useToastStore.getState().addToast({
          title: i18n._(msg`Couldn't apply model or effort`),
          message: asSentence(describeIpcError(error, '')),
          variant: 'error',
        });
      }
    },
  });
}

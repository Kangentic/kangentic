import type {
  Session,
  SessionUsage,
  ActivityState,
  ActivityReason,
  SessionEvent,
  SpawnSessionInput,
} from '../../../shared/types';
import type { TaskChangesPanelSlice } from './task-changes-panel-slice';
import type { UsagePeriodSlice } from './usage-period-slice';
import type { TransientSessionSlice } from './transient-session-slice';

/**
 * The "core" session store state: every key that lives on the main
 * session-store.ts file (sessions, usage/activity/events, CRUD
 * methods, sync, UI hints, derived getters).
 *
 * The three extracted slices (transient-session, task-changes-panel,
 * usage-period) are composed on top via intersection in SessionStore
 * below. This split is imperfect: transient-session-slice reaches
 * into core's per-session dictionaries to scrub them on session kill.
 * The core shape must stay in sync with what transient-session-slice
 * references.
 */
export interface CoreSessionSlice {
  sessions: Session[];
  /** Derived O(1) lookup: taskId -> Session. Rebuilt whenever `sessions` changes. */
  _sessionByTaskId: Map<string, Session>;
  activeSessionId: string | null;
  detailTaskId: string | null;
  /** Whether the next task-detail window opened from `detailTaskId` should start
   *  in edit mode. Set alongside `detailTaskId` by `setDetailTaskId`; read once
   *  by the window-manager bridge when it opens the window. */
  detailTaskInitialEdit: boolean;
  /** Sessions currently owned by an open task-detail window. Each window claims
   *  its own session; the bottom panel renders no terminal while this is
   *  non-empty (the panel and the windows are mutually exclusive terminal
   *  owners). Was a single scalar (`dialogSessionId`) when only one modal could
   *  be open; an array now that windows are modeless and stack. */
  dialogSessionIds: string[];
  /** Destination project id captured at the FIRST frame of a project switch when that
   *  project has persisted detail windows (read synchronously from
   *  `config.workspaceByProject` before the deferred cold-path workspace restore runs). The
   *  bottom terminal panel ORs this into its `forceCollapsed` so it renders collapsed from
   *  frame one instead of flashing expanded-then-collapsed while the destination's detail
   *  windows are still mid-restore. Cleared once that restore completes. Project-scoped so a
   *  stale arm for a project we have already left is ignored, and a missed clear self-heals on
   *  the next switch. See `src/renderer/utils/terminal-force-collapse.ts`. */
  pendingDetailWindowsProjectId: string | null;
  /** When set, the Activity Log scrolls to the event with this `${sessionId}-${ts}` key
   *  on next mount/render, then the field is cleared. Set by the global session
   *  search palette when a hit is selected. */
  scrollToEventKey: string | null;
  sessionUsage: Record<string, SessionUsage>;
  /**
   * Most recent rate-limit snapshot observed across any session. Rate
   * limits are an account-wide value, but each session only sees its
   * own status.json updates, so per-session entries drift apart. The
   * renderer keeps one shared snapshot so every ContextBar agrees.
   * Null until the first usage payload with `rateLimits` arrives.
   */
  latestRateLimits: {
    rateLimits: NonNullable<SessionUsage['rateLimits']>;
    capturedAt: number;
    sourceSessionId: string;
  } | null;
  /** Tracks sessions whose PTY has activated the alternate screen buffer (TUI ready). */
  sessionFirstOutput: Record<string, boolean>;
  sessionActivity: Record<string, ActivityState>;
  /**
   * Latest `ActivityReason` per session - kind + counts + currentTool.
   * Updated alongside `sessionActivity` from the `onActivity` push event.
   * Consumed by the TaskCard hover tooltip and the debug overlay.
   */
  sessionActivityReason: Record<string, ActivityReason>;
  sessionEvents: Record<string, SessionEvent[]>;
  seenIdleSessions: Record<string, boolean>;
  /** Command label to show in the terminal overlay (e.g. "/code-review") keyed by task ID. */
  pendingCommandLabel: Record<string, string>;
  /** Spawn progress label from main process (e.g. "Fetching latest...") keyed by task ID. */
  spawnProgress: Record<string, string>;
  _pendingOpenTaskId: string | null;
  /** One-shot flag set by notification click for transient (Command Terminal) sessions. */
  _pendingOpenCommandTerminal: boolean;
  setPendingOpenCommandTerminal: (value: boolean) => void;

  syncSessions: () => Promise<boolean>;
  setPendingOpenTaskId: (id: string | null) => void;
  setDetailTaskId: (id: string | null, options?: { initialEdit?: boolean }) => void;
  spawnSession: (input: SpawnSessionInput) => Promise<Session>;
  killSession: (id: string) => Promise<void>;
  resetSession: (taskId: string) => Promise<void>;
  suspendSession: (taskId: string) => Promise<void>;
  resumeSession: (taskId: string, resumePrompt?: string) => Promise<Session>;
  /**
   * Probe main's registry for the live session of `taskId` and reconcile
   * the renderer cache. If main returns a live Session (running/queued),
   * replace any stale row for the task with it. If main returns null
   * this is a no-op: legitimately suspended sessions also return null
   * because `reconcileTaskSessionRef` only counts running/queued as
   * live, and evicting on null would erase the Resume button for every
   * genuinely-paused dialog open. Returns the live session (or null).
   * Used by the task detail dialog on mount to self-heal a stale
   * 'suspended' view.
   */
  reconcileSession: (taskId: string) => Promise<Session | null>;
  setActiveSession: (id: string | null) => void;
  /** User-gesture variant of setActiveSession. Updates state AND persists the
   *  selection to AppConfig.lastActiveTaskByProject so it survives app restart
   *  and project switch. Used by tab-click handlers; the auto-select fallback
   *  in TerminalPanel uses setActiveSession directly so default picks don't
   *  overwrite the remembered value. */
  selectActiveSession: (id: string | null) => void;
  /** A task-detail window claims its session (one xterm per PTY: the panel drops
   *  it while a window owns it). Idempotent. */
  claimDialogSession: (sessionId: string) => void;
  /** A task-detail window releases its session on close/unmount. */
  releaseDialogSession: (sessionId: string) => void;
  /** Arm/disarm the "destination has detail windows pending restore" signal at a project
   *  switch. Pass the destination project id when it has persisted detail windows, or null to
   *  disarm. See `pendingDetailWindowsProjectId`. */
  setPendingDetailWindowsProjectId: (projectId: string | null) => void;
  setScrollToEventKey: (key: string | null) => void;
  upsertSession: (session: Session) => void;
  updateSessionStatus: (id: string, updates: Partial<Session>) => void;
  updateUsage: (sessionId: string, data: SessionUsage) => void;
  markFirstOutput: (sessionId: string) => void;
  updateActivity: (sessionId: string, state: ActivityState, reason?: ActivityReason) => void;
  addEvent: (sessionId: string, event: SessionEvent) => void;
  batchUpdateUsage: (entries: Map<string, SessionUsage>) => void;
  batchAddEvents: (entries: Array<{ sessionId: string; event: SessionEvent }>) => void;
  clearEvents: (sessionId: string) => void;
  setPendingCommandLabel: (taskId: string, label: string) => void;
  clearPendingCommandLabel: (taskId: string) => void;
  setSpawnProgress: (taskId: string, label: string | null) => void;
  markIdleSessionsSeen: (projectId: string) => void;
  markSingleIdleSessionSeen: (sessionId: string) => void;

  getRunningCount: () => number;
  getQueuedCount: () => number;
  getQueuePosition: (sessionId: string) => { position: number; total: number } | null;
}

export type SessionStore = CoreSessionSlice & TaskChangesPanelSlice & UsagePeriodSlice & TransientSessionSlice;

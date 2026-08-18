import type {
  Session,
  SessionUsage,
  ActivityState,
  ActivityReason,
  SessionEvent,
  SpawnSessionInput,
} from '../../../shared/types';
import type { TaskChangesPanelSlice } from './task-changes-panel-slice';
import type { TransientSessionSlice } from './transient-session-slice';
import type { RateLimitSnapshot } from '../../utils/rate-limit-window';

/** A one-shot capture of a task's terminal scrollback viewport at the moment
 *  its conversation viewer was opened. See `pendingTuiAnchor` below. */
export interface PendingTuiAnchor {
  sessionId: string;
  visibleLines: string[];
  /** Do NOT gate the anchor's scroll position on this; see the anti-gate note
   *  on `TerminalScrollbackCapture.atBottom` (Claude's alt-screen TUI never
   *  moves real xterm scroll, so this is unreliable as a "user is at the tail"
   *  signal). */
  atBottom: boolean;
}

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
  /** Whether the pending `detailTaskId` was requested by an AGENT
   *  (`kangentic_browser_open_pane`) rather than by a user gesture. Set alongside
   *  `detailTaskId` by `setDetailTaskId` and read once by the window-manager
   *  bridge, which stamps the opened window `openedByAgent` so its arriving
   *  terminal cannot take the user's keyboard.
   *  See `.claude/rules/agent-driven-focus.md`. */
  detailTaskAgentInitiated: boolean;
  /** Sessions currently owned by an open task-detail window. Each window claims
   *  its own session; the bottom panel renders no terminal while this is
   *  non-empty (the panel and the windows are mutually exclusive terminal
   *  owners). Was a single scalar (`dialogSessionId`) when only one modal could
   *  be open; an array now that windows are modeless and stack. */
  dialogSessionIds: string[];
  /** Task ids whose detail is open in ANOTHER renderer (the detached Agent Monitor,
   *  or the main window as seen from a pop-out). Pushed by main, which is the only
   *  side that can see across renderers; already filtered to exclude our own.
   *
   *  `dialogSessionIds` answers "does a window in THIS renderer own the terminal",
   *  which is the right question for the focused set (we are the ones who would
   *  render the bytes). This answers the different question the bottom panel asks:
   *  "does a terminal exist for this session anywhere at all". Conflating them
   *  either let the panel mount a second xterm on a live PTY, or made main stream
   *  bytes to a renderer with nothing to paint them into. */
  remoteDetailTaskIds: string[];
  /** Sessions a paired phone holds a terminal-WANTING stream subscription for
   *  (not the list-only feed it keeps for every live session). Pushed by main's
   *  mobile bridge. The bottom panel renders a placeholder instead of an xterm
   *  for these: the resting park owns their grid (a phone mirrors it 1:1 and
   *  cannot escape a strip fit), so a panel xterm fitting them to its strip
   *  produced both the phone's sliver view and the panel's own mis-wrapped
   *  frames. A task-detail window still mounts a real terminal for them - the
   *  detail is the primary surface and its grid wins while it is open. */
  mobileTerminalStreamedSessionIds: string[];
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
  /** The Kangentic session id whose conversation viewer should be open. Set by the
   *  search palette (conversation hit), the session-summary "View conversation"
   *  button, and the task-detail kebab. The conversation window bridge opens/focuses
   *  a window for it, and mirrors the window's close back to null. Mirrors
   *  `detailTaskId` for the task-detail bridge. */
  conversationSessionId: string | null;
  /** One-shot: the `TranscriptEntry.uuid` the conversation viewer should scroll to
   *  on next load, then clear (consumed via `onConsumedScroll`). Set alongside
   *  `conversationSessionId` by a conversation search hit. Transient nav signal. */
  scrollToTurnUuid: string | null;
  /** Cross-project handoff: a conversation the search palette wants opened AFTER a
   *  project switch. `useProjectSwitchEffect` consumes it once the destination
   *  project has loaded and forwards it to `setConversationSessionId`. Mirrors
   *  `_pendingOpenTaskId`. */
  _pendingOpenConversation: string | null;
  /** Cross-project handoff companion to `_pendingOpenConversation`: the turn to
   *  scroll to once the destination project has loaded. Kept separate because the
   *  project switch resets `scrollToTurnUuid`, which would otherwise drop it. */
  _pendingScrollToTurnUuid: string | null;
  /** One-shot: captured at `TaskDetailHeader.openTaskConversation` click time
   *  from the task's terminal (if any) - the visible scrollback lines and
   *  whether it was at the live tail. `ConversationWindow` matches this to a
   *  transcript turn (`tui-anchor.ts`) so the viewer opens centered there
   *  instead of always at the bottom, when the user had scrolled up in the
   *  TUI. Consumed only by the window whose anchor matches
   *  `conversationSessionId`; cleared on project switch; loses to an explicit
   *  `scrollToTurnUuid` navigation. */
  pendingTuiAnchor: PendingTuiAnchor | null;
  sessionUsage: Record<string, SessionUsage>;
  /**
   * Shared account-wide rate-limit snapshot. Rate limits are an account-wide
   * value, but each session only sees its own status.json updates, and a
   * session whose CLI has not refreshed its rate-limit info reports a stale
   * cached value. So the renderer keeps ONE snapshot that every ContextBar
   * reads, merged MONOTONICALLY per window by `mergeRateLimitSnapshot`: within
   * a fixed window (same `resetsAt`) `usedPercentage` only rises, so a lower
   * same-window report is stale and is rejected instead of flip-flopping every
   * bar; a genuine rollover (resetsAt advanced) is taken wholesale. Provenance
   * (`capturedAt` / `sourceSessionId`) reflects the last report that actually
   * changed the merged result, so the tooltip's "Updated ..." time can lag an
   * identical repeat report - the deliberate price of preserving the snapshot's
   * object reference so a no-op report does not re-render every ContextBar.
   * Null until the first usage payload with `rateLimits` arrives.
   */
  latestRateLimits: RateLimitSnapshot | null;
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
  setDetailTaskId: (
    id: string | null,
    options?: { initialEdit?: boolean; agentInitiated?: boolean },
  ) => void;
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
  /** User-gesture variant of setActiveSession. Updates state, persists the
   *  selection to AppConfig.lastActiveTaskByProject so it survives app restart
   *  and project switch, AND claims arrival focus for the chosen session (see
   *  utils/terminal-arrival-focus.ts) so the tab the user just clicked is the
   *  terminal that takes focus when it mounts. Used by tab-click handlers; the
   *  auto-select fallback in TerminalPanel uses setActiveSession directly so
   *  default picks neither overwrite the remembered value nor claim focus. */
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
  setConversationSessionId: (id: string | null) => void;
  setScrollToTurnUuid: (uuid: string | null) => void;
  setPendingOpenConversation: (id: string | null) => void;
  setPendingScrollToTurnUuid: (uuid: string | null) => void;
  setPendingTuiAnchor: (anchor: PendingTuiAnchor | null) => void;
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

export type SessionStore = CoreSessionSlice & TaskChangesPanelSlice & TransientSessionSlice;

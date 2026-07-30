import type { Session, ActivityState } from '../../shared/types';
import { ACTIVITY_TAB } from '../../shared/types';
import { requiresUserInteraction } from '../../shared/activity-state';

export interface DeriveFocusedSessionIdsInput {
  activeView: string;
  terminalPanelVisible: boolean | undefined;
  panelSessionId: string | null;
  /** Sessions owned by open task-detail windows in THIS renderer. Each has a live
   *  xterm, so each must be focused. The panel is focused ALONGSIDE them: it now
   *  sheds only the detached tabs, not the whole surface. */
  dialogSessionIds: string[];
  commandBarVisible: boolean;
  /** Every Command Terminal session for the current project. Each visible terminal
   *  must be focused or its PTY output is suppressed by the main process. */
  transientSessionIds: string[];
  /** Sessions whose terminal window is parked off-view (Backlog-parked board
   *  layer, or occluded by a maximized same-layer window). Parked sessions are
   *  removed from the focused set so main stops emitting their PTY data; the
   *  bytes accumulate in the scrollback ring and the reveal-time
   *  reloadScrollback repaints them. See terminal-visibility.ts. */
  parkedSessionIds?: ReadonlySet<string>;
  /** Sessions whose detail window lives in ANOTHER renderer. The bottom panel
   *  renders no terminal for these (one xterm per PTY), so this renderer must not
   *  ask main to stream their bytes here - the owning renderer publishes its own
   *  focused set and gets them. Distinct from `dialogSessionIds`, which names
   *  windows in THIS renderer and therefore must stay focused. */
  remotelyOwnedSessionIds?: ReadonlySet<string>;
}

/**
 * Pure derivation of which session IDs should be in the "focused" set at any
 * given moment. The main process uses this set to decide which PTY sessions
 * receive data forwarded over IPC - any session NOT in the set has its output
 * silently suppressed.
 *
 * Extracted from useFocusedSessionsSync so the branching logic can be
 * unit-tested independently of React hooks and store subscriptions.
 *
 * Rules:
 * 1. Every session owned by a task-detail window in this renderer is focused.
 * 2. The panel session is focused too, on the board view with the panel visible.
 *    Rules 1 and 2 are INDEPENDENT, not either/or: the panel drops only the tabs
 *    whose detail is open, so it routinely keeps a live terminal for one session
 *    while a window drives another, and both need their bytes. (It used to be an
 *    else-branch, back when opening any window collapsed the whole panel.)
 * 3. Backlog view / panel hidden / no panel session - no panel session is focused.
 * 4. Command bar visible - every current-project transient session is appended
 *    (unless already in the set).
 *
 * Parked sessions (`parkedSessionIds`) are filtered out of rules 1 and 4: an
 * off-view terminal must not receive live PTY data. NOTE: an all-parked state
 * (e.g. Backlog with task-detail windows open) therefore derives an EMPTY set,
 * which the main process treats as "no focus filter - emit everything"
 * (focusedSessionIds.size === 0 in session-manager). That is safe because
 * every parked session's mounted incoming-write-queue acks-and-drops without
 * parsing (see useTerminal's shouldDrop), and it matches the already-reachable
 * empty-set state (Backlog, no windows, no command bar).
 */
export function deriveFocusedSessionIds(input: DeriveFocusedSessionIdsInput): string[] {
  const focusedIds: string[] = [];
  const isParked = (sessionId: string): boolean => input.parkedSessionIds?.has(sessionId) ?? false;

  for (const sessionId of input.dialogSessionIds) {
    if (isParked(sessionId)) continue;
    if (!focusedIds.includes(sessionId)) focusedIds.push(sessionId);
  }

  if (
    input.activeView === 'board' &&
    input.terminalPanelVisible !== false &&
    input.panelSessionId &&
    // A detail window in another renderer owns this session's terminal, so the
    // panel mounts nothing for it. Focusing it here would have main stream bytes
    // to a renderer with no xterm to paint them into.
    !input.remotelyOwnedSessionIds?.has(input.panelSessionId) &&
    !focusedIds.includes(input.panelSessionId)
  ) {
    focusedIds.push(input.panelSessionId);
  }

  if (input.commandBarVisible) {
    for (const sessionId of input.transientSessionIds) {
      if (isParked(sessionId)) continue;
      if (!focusedIds.includes(sessionId)) focusedIds.push(sessionId);
    }
  }

  return focusedIds;
}

export interface DerivePanelSessionIdInput {
  activeSessionId: string | null;
  sessions: Session[];
  currentProjectId: string | null;
  sessionActivity: Record<string, ActivityState>;
  /** Sessions whose terminal a task-detail window hosts (`derivePanelSessions().owned`).
   *  The panel shows no tab for these, so they can never be its session - and a
   *  resolution that ignored them would name a terminal that is not on screen while
   *  the one that IS goes unfocused and silent. */
  ownedSessionIds?: ReadonlySet<string>;
  /**
   * Whether the panel currently has its terminal content MOUNTED. False while the
   * panel is collapsed (user toggle or the detached/force collapse), where the tab
   * strip is still on screen but `TerminalPanel` renders no `TerminalTab` at all.
   *
   * Load-bearing for the FOCUSED set, not for rendering: a collapsed panel has no
   * xterm, so nothing acknowledges the PTY bytes main streams for it. Measured live,
   * a collapsed panel left ~6KB permanently un-acked in main's in-flight accounting;
   * an agent that emitted ~1MB that way (BACKPRESSURE_HIGH_WATER) would have had its
   * PTY paused - the agent stalls - until some unrelated focus change reset the
   * counters. Defaults true so the panel's own active-tab resolution (which must
   * still work while collapsed, so the strip shows the right tab) is unaffected.
   */
  panelShowsTerminal?: boolean;
}

/**
 * Pure derivation of the panel's focused session ID from its VISIBLE tab set.
 * Extracted from the useMemo in useFocusedSessionsSync so it can be unit-tested
 * independently; TerminalPanel resolves its active tab through the same function
 * so the two cannot drift.
 *
 * Rules:
 * 1. Panel content not mounted (collapsed) - returns null. Nothing is rendering, so
 *    nothing can ack; see `panelShowsTerminal`.
 * 2. ACTIVITY_TAB sentinel - returns null (no PTY session selected).
 * 3. activeSessionId points at a visible tab - returns activeSessionId.
 * 4. No visible tabs for the project - returns null.
 * 5. Prefer an idle visible session; fall back to the first visible session.
 */
export function derivePanelSessionId(input: DerivePanelSessionIdInput): string | null {
  if (input.panelShowsTerminal === false) return null;
  if (input.activeSessionId === ACTIVITY_TAB) return null;

  const runningSessions = input.sessions.filter(
    (session) =>
      session.status === 'running' &&
      session.projectId === input.currentProjectId &&
      !session.transient &&
      !input.ownedSessionIds?.has(session.id),
  );

  if (runningSessions.some((session) => session.id === input.activeSessionId)) {
    return input.activeSessionId;
  }

  if (runningSessions.length === 0) return null;

  return (
    runningSessions.find((session) => requiresUserInteraction(input.sessionActivity[session.id]))?.id ??
    runningSessions[0].id
  );
}

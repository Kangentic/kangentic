import type { Session, ActivityState } from '../../shared/types';
import { ACTIVITY_TAB } from '../../shared/types';
import { requiresUserInteraction } from '../../shared/activity-state';

export interface DeriveFocusedSessionIdsInput {
  activeView: string;
  terminalPanelVisible: boolean | undefined;
  panelSessionId: string | null;
  /** Sessions owned by open task-detail windows. When non-empty, the bottom
   *  panel renders no terminal, so the panel session is NOT focused. */
  dialogSessionIds: string[];
  commandBarVisible: boolean;
  transientSessionId: string | null;
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
 * Rules (in priority order):
 * 1. Task-detail window(s) open - every window-owned session is focused, and
 *    the panel session is NOT (the panel renders no terminal while a window is
 *    open; the two are mutually exclusive terminal owners).
 * 2. Board view with panel visible and no window open - the panel session is
 *    focused.
 * 3. Backlog view / panel hidden / no window - no panel session is focused.
 * 4. Command bar visible - the transient session is appended (unless already in
 *    the set).
 */
export function deriveFocusedSessionIds(input: DeriveFocusedSessionIdsInput): string[] {
  const focusedIds: string[] = [];

  if (input.dialogSessionIds.length > 0) {
    for (const sessionId of input.dialogSessionIds) {
      if (!focusedIds.includes(sessionId)) focusedIds.push(sessionId);
    }
  } else if (
    input.activeView === 'board' &&
    input.terminalPanelVisible !== false &&
    input.panelSessionId
  ) {
    focusedIds.push(input.panelSessionId);
  }

  if (
    input.commandBarVisible &&
    input.transientSessionId &&
    !focusedIds.includes(input.transientSessionId)
  ) {
    focusedIds.push(input.transientSessionId);
  }

  return focusedIds;
}

export interface DerivePanelSessionIdInput {
  activeSessionId: string | null;
  sessions: Session[];
  currentProjectId: string | null;
  sessionActivity: Record<string, ActivityState>;
}

/**
 * Pure derivation of the panel's focused session ID from the running-sessions
 * list. Extracted from the useMemo in useFocusedSessionsSync so it can be
 * unit-tested independently.
 *
 * Rules:
 * 1. ACTIVITY_TAB sentinel - returns null (no PTY session selected).
 * 2. activeSessionId points at a running non-transient session for the current
 *    project - returns activeSessionId.
 * 3. No running sessions for the project - returns null.
 * 4. Prefer an idle running session; fall back to the first running session.
 */
export function derivePanelSessionId(input: DerivePanelSessionIdInput): string | null {
  if (input.activeSessionId === ACTIVITY_TAB) return null;

  const runningSessions = input.sessions.filter(
    (session) =>
      session.status === 'running' &&
      session.projectId === input.currentProjectId &&
      !session.transient,
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

import type { Session } from '../../shared/types';
import { ACTIVITY_TAB } from '../../shared/types';

export interface DeriveFocusedSessionIdsInput {
  activeView: string;
  terminalPanelVisible: boolean | undefined;
  panelSessionId: string | null;
  dialogSessionId: string | null;
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
 * 1. Dialog open - only the dialog session is focused (dialog takes over the
 *    panel and the panel xterm is unmounted).
 * 2. Board view with panel visible - the current panel session is focused.
 * 3. Backlog view / panel hidden / no dialog - no panel session is focused.
 * 4. Command bar visible - the transient session is appended (unless it is
 *    already in the set, which happens when the dialog and transient IDs
 *    happen to be the same - effectively impossible, but guarded anyway).
 */
export function deriveFocusedSessionIds(input: DeriveFocusedSessionIdsInput): string[] {
  const focusedIds: string[] = [];

  if (input.dialogSessionId) {
    focusedIds.push(input.dialogSessionId);
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
  sessionActivity: Record<string, string>;
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
    runningSessions.find((session) => input.sessionActivity[session.id] === 'idle')?.id ??
    runningSessions[0].id
  );
}

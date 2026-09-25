import { ACTIVITY_TAB } from '../../shared/types';
import type { ActivityState, SessionStatus } from '../../shared/types';
import { requiresUserInteraction } from '../../shared/activity-state';

interface AutoFocusInput {
  sessionId: string;
  newState: ActivityState;
  /** What this session's state was before the push, so a reason-only refresh can be
   *  told from a real transition. `session:activity` carries both: main emits it on
   *  a state change AND when only the reason's kind moves mid-turn. Undefined for a
   *  session the store has not seen yet, which is a first sighting, not a no-op. */
  previousState: ActivityState | undefined;
  currentActiveSessionId: string | null;
  /** Sessions whose terminal a task-detail window hosts (`derivePanelSessions().owned`).
   *  The panel shows no tab for them, so they are not switch targets. */
  ownedSessionIds: ReadonlySet<string>;
  sessionActivity: Record<string, ActivityState>;
  // projectId is not used by auto-focus; optional so Session[] is assignable
  sessions: Array<{ id: string; status: SessionStatus; projectId?: string }>;
}

/**
 * Given a session activity change, determine whether the bottom panel should
 * auto-switch to a different tab. Returns the target session ID to switch to,
 * or null if no switch is needed.
 */
export function resolveAutoFocusTarget(input: AutoFocusInput): string | null {
  const { sessionId, newState, previousState, currentActiveSessionId, ownedSessionIds, sessionActivity, sessions } = input;

  // Activity tab is sacred -- never switch away from it
  if (currentActiveSessionId === ACTIVITY_TAB) {
    return null;
  }

  // A reason-only refresh is not a focus event. The state held, so whatever this
  // resolver decided when it last moved still stands. Without this, a session the
  // user is watching pulls the panel away on every reason kind change for as long
  // as it keeps working (176 of them across the recorded 9-way fan-out), each time
  // the user navigates back to it. A real transition always moves the value, so
  // nothing that fired before this existed stops firing.
  if (previousState === newState) {
    return null;
  }

  // This session's terminal is detached to a task-detail window, so the panel has
  // no tab to switch to. It used to be "any window is open, don't auto-switch at
  // all", which was right while a window collapsed the whole panel; now the panel
  // keeps the tabs no window took, and those should still auto-focus.
  if (ownedSessionIds.has(sessionId)) {
    return null;
  }

  // "Paused" (requires user interaction) groups 'idle' and 'permission' - the
  // agent is waiting on the human and the user should see it. The single source
  // of truth for that bucketing is shared/activity-state.ts; the renderer still
  // differentiates the two visually (lock icon vs idle dot) elsewhere.
  if (requiresUserInteraction(newState)) {
    // Don't switch if user is already viewing a running paused session
    const isViewingPausedSession =
      currentActiveSessionId !== null &&
      !ownedSessionIds.has(currentActiveSessionId) &&
      requiresUserInteraction(sessionActivity[currentActiveSessionId] ?? 'idle') &&
      sessions.some((s) => s.id === currentActiveSessionId && s.status === 'running');
    if (!isViewingPausedSession) {
      return sessionId;
    }
    return null;
  }

  // newState is active (thinking) -- only react if the viewed session went active
  if (currentActiveSessionId === sessionId) {
    const otherPaused = sessions.find(
      (s) =>
        s.id !== sessionId &&
        s.status === 'running' &&
        !ownedSessionIds.has(s.id) &&
        requiresUserInteraction(sessionActivity[s.id] ?? 'idle'),
    );
    return otherPaused?.id ?? null;
  }

  return null;
}

import { ACTIVITY_TAB } from '../../shared/types';
import type { ActivityState, SessionStatus } from '../../shared/types';
import { requiresUserInteraction } from '../../shared/activity-state';

interface AutoFocusInput {
  sessionId: string;
  newState: ActivityState;
  currentActiveSessionId: string | null;
  dialogSessionIds: string[];
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
  const { sessionId, newState, currentActiveSessionId, dialogSessionIds, sessionActivity, sessions } = input;

  // Activity tab is sacred -- never switch away from it
  if (currentActiveSessionId === ACTIVITY_TAB) {
    return null;
  }

  // A task-detail window is open -- the panel has stepped aside, don't auto-switch it
  if (dialogSessionIds.length > 0) {
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
      (s) => s.id !== sessionId && s.status === 'running' && requiresUserInteraction(sessionActivity[s.id] ?? 'idle'),
    );
    return otherPaused?.id ?? null;
  }

  return null;
}

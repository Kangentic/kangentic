import { ACTIVITY_TAB } from '../../shared/types';
import type { ActivityState, SessionStatus } from '../../shared/types';

interface AutoFocusInput {
  sessionId: string;
  newState: ActivityState;
  currentActiveSessionId: string | null;
  sessionActivity: Record<string, ActivityState>;
  sessions: Array<{ id: string; status: SessionStatus }>;
}

/**
 * Given a session activity change, determine whether the bottom panel should
 * auto-switch to a different tab. Returns the target session ID to switch to,
 * or null if no switch is needed.
 */
export function resolveAutoFocusTarget(input: AutoFocusInput): string | null {
  const { sessionId, newState, currentActiveSessionId, sessionActivity, sessions } = input;

  // Activity tab is sacred — never switch away from it
  if (currentActiveSessionId === ACTIVITY_TAB) {
    return null;
  }

  if (newState === 'idle') {
    // Don't switch if user is already viewing a running idle session
    const isViewingIdleSession =
      currentActiveSessionId !== null &&
      sessionActivity[currentActiveSessionId] === 'idle' &&
      sessions.some((s) => s.id === currentActiveSessionId && s.status === 'running');
    if (!isViewingIdleSession) {
      return sessionId;
    }
    return null;
  }

  // newState === 'thinking' — only react if the viewed session went to thinking
  if (currentActiveSessionId === sessionId) {
    const otherIdle = sessions.find(
      (s) => s.id !== sessionId && s.status === 'running' && sessionActivity[s.id] === 'idle',
    );
    return otherIdle?.id ?? null;
  }

  return null;
}

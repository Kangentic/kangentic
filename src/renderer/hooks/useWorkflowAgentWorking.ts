import type { Session } from '../../shared/types';
import { isActive } from '../../shared/activity-state';
import { useSessionStore } from '../stores/session-store';

/**
 * The workflow agent's hold on its plan, in a module of its own so the New
 * Task form (on the board's main chunk) can read it without importing the
 * Workflows view's agent pane and its terminal.
 */

/** The workflow's agent session: its live or paused one first, else the last that exited. */
export function selectAgentSession(sessions: readonly Session[], workflowId: string): Session | null {
  let exited: Session | null = null;
  for (const session of sessions) {
    if (session.workflowId !== workflowId) continue;
    if (session.status !== 'exited') return session;
    exited = session;
  }
  return exited;
}

/**
 * Whether the workflow's agent is mid-turn: what holds the plan (#732, board
 * 2c). The agent works from what it read when its turn began, so a hand edit
 * meanwhile would leave it building on a plan that no longer exists.
 */
export function useWorkflowAgentWorking(workflowId: string | null): boolean {
  return useSessionStore((state) => {
    if (!workflowId) return false;
    const session = selectAgentSession(state.sessions, workflowId);
    return session?.status === 'running' && isActive(state.sessionActivity[session.id]);
  });
}

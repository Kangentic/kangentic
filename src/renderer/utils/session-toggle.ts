import { useSessionStore } from '../stores/session-store';
import { useToastStore } from '../stores/toast-store';
import { describeIpcError } from '../lib/ipc-error';
import { sessionLifecyclePhase } from './task-progress';
import { resumeBlockMessage, sessionToggleOffer } from '../../shared/session-resume-eligibility';
import type { Session, SessionDisplayState, Task } from '../../shared/types';

/**
 * The card menu's Pause / Resume session row, shared by its three hosts (the
 * board card, the Agent Monitor row, the Workflows canvas card), plus the copy
 * the task detail's own toggle (`handleToggle` in `useTaskActions.ts`) toasts,
 * so both say the same thing.
 */

export type SessionToggleDirection = 'pause' | 'resume';

/** The Pause / Resume row a task's menu offers. */
export interface SessionToggleRow {
  direction: SessionToggleDirection;
  /** The row's `data-session-state`, in the header pill's vocabulary. */
  sessionState: 'active' | 'queued' | 'suspended';
  /** Why the Resume is refused (Done, archived), shown as the disabled row's tooltip; null leaves the row live. */
  refusal: string | null;
}

/** The row for a task, or null where the menu offers none (To Do, or no session lifecycle). */
export function sessionToggleRowFor(
  kind: SessionDisplayState['kind'],
  laneRole: string | null | undefined,
  task: Pick<Task, 'archived_at'>,
): SessionToggleRow | null {
  const offer = sessionToggleOffer({ phase: sessionLifecyclePhase(kind), laneRole, task });
  if (!offer) return null;
  if (offer.direction === 'pause') {
    return { direction: 'pause', sessionState: kind === 'queued' ? 'queued' : 'active', refusal: null };
  }
  return {
    direction: 'resume',
    sessionState: 'suspended',
    refusal: offer.blockReason ? resumeBlockMessage(offer.blockReason) : null,
  };
}

/** Main throws a refusal's copy verbatim, so the reason reads as guidance. */
export function sessionToggleFailureMessage(direction: SessionToggleDirection, error: unknown): string {
  const verb = direction === 'pause' ? 'suspend' : 'resume';
  const reason = describeIpcError(error, '');
  return reason ? `Failed to ${verb} session: ${reason}` : `Failed to ${verb} session`;
}

/**
 * Tell the user when a resume handed back the session the renderer already
 * showed. Main found it live (the renderer's view had drifted to suspended), so
 * no agent was started.
 */
export function toastIfReconnectedResume(priorSessionId: string | null, returned: Session | null): void {
  if (returned === null || returned.status !== 'running' || priorSessionId !== returned.id) return;
  useToastStore.getState().addToast({ message: 'Reconnected to running session', variant: 'info' });
}

/**
 * Pause or resume a task's session from its menu. Nothing waits on it: the
 * store's optimistic write already shows the card as paused, and a resume's
 * session arrives by push. `projectId` is the task's own project, captured
 * where the user clicked. `onSucceeded` lets a host bring its own lists up to
 * date afterwards.
 */
export async function runSessionToggle(input: {
  taskId: string;
  direction: SessionToggleDirection;
  projectId: string | null;
  onSucceeded?: () => void;
}): Promise<void> {
  const store = useSessionStore.getState();
  try {
    if (input.direction === 'pause') {
      await store.suspendSession(input.taskId, input.projectId);
    } else {
      const priorSessionId = store._sessionByTaskId.get(input.taskId)?.id ?? null;
      const returned = await store.resumeSession(input.taskId, undefined, input.projectId);
      toastIfReconnectedResume(priorSessionId, returned);
    }
  } catch (error) {
    console.error('Toggle session failed:', error);
    useToastStore.getState().addToast({
      message: sessionToggleFailureMessage(input.direction, error),
      variant: 'warning',
    });
    return;
  }
  input.onSucceeded?.();
}

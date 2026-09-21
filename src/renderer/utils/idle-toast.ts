import type { ActivityState } from '../../shared/types';
import { requiresUserInteraction } from '../../shared/activity-state';
import type { ToastVariant } from '../stores/toast-store';

export interface IdleToastInput {
  state: ActivityState;
  /** What this session's state was before the push, so a reason-only refresh can be
   *  told from a real transition. `session:activity` carries both: main emits it on
   *  a state change AND when only the reason's kind moves mid-turn, roughly 180 of
   *  the latter against 3 of the former across a long turn. Undefined for a session
   *  the store has not seen yet, which is a first sighting, not a no-op. */
  previousState: ActivityState | undefined;
  /** `config.notifications.toasts.onAgentIdle`. */
  enabled: boolean;
  /** The session belongs to the project whose board is open. A toast about a
   *  background project would name a task the user cannot see. */
  isCurrentProject: boolean;
  /** A Command Terminal. Its shell returning to a prompt is not an agent waiting
   *  on anyone, and it has no task to open. */
  transient: boolean;
  /** `derivePanelSessions().owned.has(sessionId)` - a task-detail window, the
   *  in-app or detached Agent Monitor, or a streaming phone is already rendering
   *  this terminal, so the user can see the agent stop without being told. */
  ownedByDetailSurface: boolean;
  /** Undefined when the board store has no row for the session's task yet. */
  taskTitle: string | undefined;
  /** Fallback label when there is no task row. */
  sessionIdShort: string;
}

export interface IdleToastResult {
  message: string;
  variant: ToastVariant;
  /** False when the label came from `sessionIdShort`: there is no board row to
   *  open, so the caller attaches no Open action. */
  hasTask: boolean;
}

/**
 * Given a session activity change, decide whether an in-app toast should say the
 * agent has stopped and is waiting on the user.
 *
 * This is the toast half of one event. The desktop half lives in main
 * (`src/main/notifications/desktop-notifier.ts`) and fires on the opposite
 * condition: it notifies only when the window is unfocused or a different project
 * is active, because it exists for when the user is away. The toast covers the
 * case the desktop notification deliberately skips - the user is here, on this
 * project, but is not looking at this particular agent.
 */
export function resolveIdleToast(input: IdleToastInput): IdleToastResult | null {
  const {
    state,
    previousState,
    enabled,
    isCurrentProject,
    transient,
    ownedByDetailSurface,
    taskTitle,
    sessionIdShort,
  } = input;

  if (!enabled) return null;

  // The edge into "waiting on the human", taken through the shared classifier
  // rather than a state literal (.claude/rules/activity-state-classification.md).
  // Using the bucket also gets 'permission' -> 'idle' right: the agent asked for
  // approval and then ended its turn, but the user was already interacting with
  // it, so that is not a new call for attention.
  //
  // This is the whole defence against the reason-only refreshes that ride the
  // same channel. A level check here would toast roughly 180 times per turn.
  if (!requiresUserInteraction(state)) return null;
  if (requiresUserInteraction(previousState)) return null;

  if (!isCurrentProject) return null;
  if (transient) return null;
  if (ownedByDetailSurface) return null;

  // A missing task row is NOT a reason to stay silent. The board's `tasks` only
  // reload on `loadBoard()`, so a task an agent or the MCP server created can
  // spawn, run, and go idle before this renderer has ever seen it. Fall back to a
  // short session id the way the crash toast does, and let the caller drop the
  // Open action since there is no row to open.
  // Quotes go around a real title only, matching the crash toast: a bare session
  // id fragment in quotes reads like a name the user should recognize.
  const label = taskTitle !== undefined ? `"${taskTitle}"` : sessionIdShort;

  // activity-state-ok: granular permission-vs-idle message text, not an idle-vs-active bucket
  const needsPermission = state === 'permission';

  return {
    message: needsPermission ? `${label} needs permission` : `${label} finished its turn`,
    variant: needsPermission ? 'warning' : 'info',
    hasTask: taskTitle !== undefined,
  };
}

import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { ActivityReason, ActivityState } from '../../shared/types';
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
  /** `endsOwnCallTurn(reason)`: the idle ends the turn that moved its own task or paused its own workflow. */
  endsOwnCall: boolean;
}

/**
 * Whether an idle ends the turn in which the session moved its own task or
 * paused its own workflow, as main flags it while that call takes effect. That
 * turn belongs to the call, which usually ends the session moments later, so
 * the idle raises no toast and takes no focus.
 */
export function endsOwnCallTurn(reason: ActivityReason | null | undefined): boolean {
  return reason != null && 'inOwnCall' in reason && reason.inOwnCall === true;
}

export interface IdleToastResult {
  title: string;
  message: string;
  variant: ToastVariant;
  /** False when the label came from `sessionIdShort`: there is no board row to
   *  open, so the caller gives the card nothing to open. */
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
    endsOwnCall,
  } = input;

  if (!enabled) return null;
  if (endsOwnCall) return null;

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
  // short session id the way the crash toast does, and let the caller leave the
  // card with nothing to open, since there is no row to open.
  // Quotes go around a real title only, matching the crash toast: a bare session
  // id fragment in quotes reads like a name the user should recognize. Each
  // shape is its own message, so the quotes sit inside the sentence a
  // translator sees.

  // activity-state-ok: granular permission-vs-idle message text, not an idle-vs-active bucket
  const needsPermission = state === 'permission';

  const hasTask = taskTitle !== undefined;
  if (needsPermission) {
    const message = taskTitle !== undefined
      ? i18n._(msg`"${{ taskTitle }}" is asking to run a tool.`)
      : i18n._(msg`${{ sessionIdShort }} is asking to run a tool.`);
    return { title: i18n._(msg`Needs permission`), message, variant: 'warning', hasTask };
  }
  const message = taskTitle !== undefined
    ? i18n._(msg`"${{ taskTitle }}" is waiting on you.`)
    : i18n._(msg`${{ sessionIdShort }} is waiting on you.`);
  return { title: i18n._(msg`Agent finished`), message, variant: 'info', hasTask };
}

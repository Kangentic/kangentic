import type { ActivityReason, ActivityState, PermissionWaitKind } from '../../../shared/types';
import { isActive } from '../../../shared/activity-state';
import type { ActivityMarkName } from '../ActivityMark';

/**
 * What an agent waiting on the user is waiting for, as every surface that
 * draws an agent's activity mark tells it: the kind the agent reported, or
 * `'unknown'` when its wait carries none (an agent that does not report it, or
 * a reason that has not arrived yet).
 */
export type AgentWaitKind = PermissionWaitKind | 'unknown';

/** The four marks an agent session wears: working, or one of the three waits. */
export type AgentActivityMarkName = Extract<ActivityMarkName, `agent-${string}`>;

/**
 * The mark each wait draws. An unknown kind takes the question's bubble, the
 * general "waiting on your answer", the same way its desktop notification
 * falls back to "Agent needs your input". A lookup rather than comparisons, so
 * the kind names never read as activity bucketing.
 */
const WAIT_MARKS: Record<AgentWaitKind, AgentActivityMarkName> = {
  question: 'agent-question',
  approval: 'agent-approval',
  unknown: 'agent-question',
};

/**
 * The kind of the permission wait `activity` and `reason` describe, or null
 * when the session is not in one (working, a finished turn, nothing reported).
 *
 * The state decides that a wait is open, the reason only what it is for, since
 * the reason can lag the state (the web demo seeds states with no reason, and a
 * resync can deliver one before the other).
 */
export function agentWaitKind(
  activity: ActivityState | null | undefined,
  reason: ActivityReason | null | undefined,
): AgentWaitKind | null {
  // activity-state-ok: granular, a permission wait draws its own mark; the
  // idle-vs-active bucket is still requiresUserInteraction's.
  if (activity !== 'permission') return null;
  // activity-state-ok: reads the reason's own kind to take its waitKind field.
  if (reason?.kind === 'permission' && reason.waitKind) return reason.waitKind;
  return 'unknown';
}

/**
 * The mark an agent session wears for `activity`: the working ring, or for a
 * session that needs the user the envelope (a finished turn), the speech
 * bubble (a question, or a wait of unknown kind) or the crested shield (a tool
 * or plan to approve). Every surface that draws an agent's mark asks this one
 * function, so the board card, the Workflows views and the Agent Monitor
 * cannot draw the same wait two ways.
 *
 * The sidebar count and the Monitor's Idle tile do not ask it: they keep one
 * envelope for all three waits.
 */
export function agentActivityMark(
  activity: ActivityState | null | undefined,
  reason: ActivityReason | null | undefined,
): AgentActivityMarkName {
  if (isActive(activity ?? undefined)) return 'agent-working';
  const waitKind = agentWaitKind(activity, reason);
  return waitKind ? WAIT_MARKS[waitKind] : 'agent-idle';
}

/** The mark a permission reason's own tooltip leads with. */
export function waitMarkForReason(reason: Extract<ActivityReason, { kind: 'permission' }>): AgentActivityMarkName {
  return WAIT_MARKS[reason.waitKind ?? 'unknown'];
}

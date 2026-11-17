import type { Swimlane } from '../../../shared/types';

/**
 * How a move into `toLane` ends the task's live agent, in the order
 * `handleTaskMove`'s Phase 1 branches test it:
 *
 * - `'todo'`: Priority 1 kills the session and removes the worktree.
 * - `'done'`: Priority 2 suspends the session and archives the task.
 * - `'parked'`: Priority 2.5, a column with "Start an agent here" off,
 *   suspends the session and starts none.
 *
 * Null for every other destination, where the agent stays up or is respawned
 * (Priority 3 and 4). The branches and the exit hook both read this, so the
 * exit hook's decision to skip a message can never disagree with what the
 * branch then does to the agent.
 */
export type MoveEndsAgent = 'todo' | 'done' | 'parked';

export function moveEndsAgent(toLane: Pick<Swimlane, 'role' | 'auto_spawn'> | undefined): MoveEndsAgent | null {
  if (!toLane) return null;
  if (toLane.role === 'todo') return 'todo';
  if (toLane.role === 'done') return 'done';
  if (!toLane.auto_spawn) return 'parked';
  return null;
}

/**
 * The run-log reason an exit row that needs the agent is skipped with when the
 * move ends that agent. English: agents read it through
 * `kangentic_get_automation_runs`.
 */
export function exitAgentEndingReason(
  ending: MoveEndsAgent | null,
  toLane: Pick<Swimlane, 'name'> | undefined,
): string | undefined {
  if (!ending || !toLane) return undefined;
  const toColumnName = toLane.name;
  if (ending === 'todo') return `Not sent: moving to ${toColumnName} ends the agent, so it could not act on the message.`;
  if (ending === 'done') return `Not sent: moving to ${toColumnName} stops the agent, so it could not act on the message.`;
  return `Not sent: ${toColumnName} starts no agent and stops this one, so it could not act on the message.`;
}

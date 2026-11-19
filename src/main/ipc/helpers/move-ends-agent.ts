import type { Swimlane } from '../../../shared/types';
import type { LiveSessionFate } from './live-session-fate';

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
 * (Priority 3 and 4; `LiveSessionFate` says which). The branches and the exit hook both read this, so the
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
 * move ends that agent's conversation. English: agents read it through
 * `kangentic_get_automation_runs`.
 *
 * `fate` is what Priority 3 does to a session the destination keeps an agent
 * for (`readLiveSessionFate`). A session switch and a handoff suspend it for a
 * different conversation, so a message typed now is cut off and never read, as
 * on Done. A restart and a full column resume the same conversation, so their
 * exit messages are carried on the resume instead (the exit hook in
 * `task-move.ts`), and they get no reason here.
 */
export function exitAgentEndingReason(
  ending: MoveEndsAgent | null,
  toLane: Pick<Swimlane, 'name'> | undefined,
  fate?: LiveSessionFate | null,
): string | undefined {
  if (!toLane) return undefined;
  const toColumnName = toLane.name;
  if (!ending) {
    if (fate?.kind === 'switch') return `Not sent: moving to ${toColumnName} starts a new session, so this one could not act on the message.`;
    if (fate?.kind === 'handoff') return `Not sent: moving to ${toColumnName} hands the task to another agent, so this one could not act on the message.`;
    return undefined;
  }
  if (ending === 'todo') return `Not sent: moving to ${toColumnName} ends the agent, so it could not act on the message.`;
  if (ending === 'done') return `Not sent: moving to ${toColumnName} stops the agent, so it could not act on the message.`;
  return `Not sent: ${toColumnName} starts no agent and stops this one, so it could not act on the message.`;
}

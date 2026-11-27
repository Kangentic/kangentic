/**
 * Whether an agent can be stopped and resumed now without losing anything: the checks that need no
 * transcript read. Shared by the two things that restart a running agent on their own, a move to another
 * account (`accounts/account-session-move.ts`, task #1200) and an update of an SSH host's program
 * (`remote/program-update.ts`).
 */

import { requiresUserInteraction } from '../../shared/activity-state';
import type { SessionManager } from './session-manager';

/**
 * `idle`: the turn is over. `mid-turn`: working, and maybe between two tools (only a transcript read can
 * say). null: not now.
 */
export type QuickSafePoint = 'idle' | 'mid-turn' | null;

export type SafePointReader = Pick<
  SessionManager,
  'automatedKeysBlocker' | 'getOpenWork' | 'getActivityStatsSnapshot' | 'getPendingDraft' | 'getActivityCache'
>;

/**
 * No tool in flight and no prompt or question open, no background shell or subagent alive (each dies with
 * the restart; a service the agent marked is not one), and nothing typed into its input box. The draft is
 * main's mirror, a step behind the host: a caller about to stop the agent reads it fresh
 * (`readPendingDraft`) once more.
 */
export function quickSafePoint(sessionManager: SafePointReader, sessionId: string): QuickSafePoint {
  if (sessionManager.automatedKeysBlocker(sessionId) !== null) return null;
  const openWork = sessionManager.getOpenWork(sessionId);
  if (openWork.backgroundShells.length > 0 || openWork.backgroundSubagents.length > 0) return null;
  // The ledger lists a background subagent only once its parent's turn ended; the engine counts it from its start.
  if ((sessionManager.getActivityStatsSnapshot(sessionId)?.subagentDepth ?? 0) > 0) return null;
  if ((sessionManager.getPendingDraft(sessionId) ?? '').trim() !== '') return null;
  // A permission prompt is refused above, so a session needing the user here is one whose turn is over.
  return requiresUserInteraction(sessionManager.getActivityCache()[sessionId]) ? 'idle' : 'mid-turn';
}

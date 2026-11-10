/**
 * Whether a session's shell still had an agent under it, read from one listing
 * of the host's process table (`listProcesses`). An abandoned launch report
 * carries the answer as `agent_process`: `present` is a CLI that ran and stayed
 * silent, `absent` a command that already ended.
 *
 * "An agent" means what the agent-absence sweep means by one: any descendant of
 * the shell but a console host (`hasNoNonConsoleDescendants`). Pure, so main
 * reads it from the host's answer and a test from a table it writes.
 */

import { hasNoNonConsoleDescendants, walkDescendants, type ProcessInfo } from '../../activity-engine/background-shell/process-tree';

export type AgentProcessPresence = 'present' | 'absent' | 'unknown';

/**
 * `unknown` when the listing cannot say: it is empty, which the table returns
 * for a cycle with no listing, or it does not hold the shell, so it was taken
 * after the shell had gone and its children may already be gone or re-parented.
 */
export function agentProcessPresenceOf(rows: readonly ProcessInfo[], shellPid: number): AgentProcessPresence {
  if (rows.length === 0 || !rows.some((row) => row.pid === shellPid)) return 'unknown';
  return hasNoNonConsoleDescendants(walkDescendants([...rows], shellPid)) ? 'absent' : 'present';
}

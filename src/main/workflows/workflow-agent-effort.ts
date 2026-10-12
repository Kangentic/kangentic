/**
 * The effort each running workflow agent was started with, by session id.
 *
 * A task's spend takes its effort from the session record (`applied_effort`);
 * the workflow agent has no record, and the status line does not always report
 * one, so its Stats rows read it here. Null means the CLI's own default. A
 * module of its own so the metrics capture can read it without importing the
 * agent's spawn path.
 */
const startedEffort = new Map<string, string | null>();

export function recordWorkflowAgentEffort(sessionId: string, effort: string | null): void {
  startedEffort.set(sessionId, effort);
}

export function workflowAgentEffort(sessionId: string): string | null {
  return startedEffort.get(sessionId) ?? null;
}

export function forgetWorkflowAgentEffort(sessionId: string): void {
  startedEffort.delete(sessionId);
}

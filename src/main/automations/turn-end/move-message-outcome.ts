/**
 * What a Move to column row's run says about its message (#804).
 *
 * The row's run finishes when its move does, and the message reaches the agent
 * where the task landed in the background, once that agent's turn ends
 * (`deliverMessageAfterMove`). So the run first says the message is waiting,
 * and the delivery rewrites the detail with what became of it. The run log is
 * English, as every adapter's detail is: an agent reads it.
 */

/** What became of a moved task's message. */
export type MoveMessageOutcome =
  | { kind: 'delivered' }
  | { kind: 'held' }
  | { kind: 'not-held'; reason: string }
  | { kind: 'superseded' }
  | { kind: 'handed-to-recovery' }
  | { kind: 'failed'; reason: string };

/** The run's detail while the message waits for the agent where the task landed. */
export function moveMessagePendingDetail(columnName: string): string {
  return `Moved to ${columnName}; its message waits for the agent there.`;
}

/** The run's detail once the message's fate is known. */
export function moveMessageOutcomeDetail(columnName: string, outcome: MoveMessageOutcome): string {
  switch (outcome.kind) {
    case 'delivered':
      return `Moved to ${columnName}, with a message the agent there received.`;
    case 'held':
      return `Moved to ${columnName}; no agent there could take its message, so it is held for the task's next agent.`;
    case 'not-held':
      return `Moved to ${columnName}; its message was not delivered and could not be held: ${outcome.reason}`;
    case 'superseded':
      return `Moved to ${columnName}; its message was not delivered, because the task moved on first.`;
    case 'handed-to-recovery':
      return `Moved to ${columnName}; workflow recovery sent its message in place of a nudge.`;
    case 'failed':
      return `Moved to ${columnName}; its message was not delivered: ${outcome.reason}`;
  }
}

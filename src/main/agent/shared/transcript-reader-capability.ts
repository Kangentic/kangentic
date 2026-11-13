import type { AgentAdapter } from '../agent-adapter';

/**
 * Whether Kangentic can read the user's messages of one turn back from an
 * agent's own transcript. Two readers are needed:
 *
 * - A WINDOWED reader (`parseTranscriptWindow` with `locateSessionHistoryFile`),
 *   because only a byte window can start where the turn began
 *   (`TranscriptAnchor`). A whole-file reader cannot tell this turn's messages
 *   from an earlier turn's, and an earlier "signed off" must never move a card.
 * - A reader of the messages typed while the agent was mid-turn
 *   (`readQueuedUserMessages`). Without it a "not signed off" typed during the
 *   turn would be missed, and the turn's opening "signed off" would move the
 *   card. Claude records those apart from its turns; an agent whose queued
 *   input is unread reports no user messages until someone reads it.
 *
 * A Text match on the user's message needs this (#1078). The agent list's
 * `reportsUserMessages` and the turn-end read (`readTurnUserMessages` in
 * `message-trail-read.ts`) both ask here, so they never disagree about an agent.
 */
export function canReadTurnUserMessages(
  adapter: Pick<AgentAdapter, 'parseTranscriptWindow' | 'locateSessionHistoryFile' | 'readQueuedUserMessages'>,
): boolean {
  return typeof adapter.parseTranscriptWindow === 'function'
    && typeof adapter.locateSessionHistoryFile === 'function'
    && typeof adapter.readQueuedUserMessages === 'function';
}

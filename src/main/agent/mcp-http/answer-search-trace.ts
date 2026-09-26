/**
 * What a Memory Graph answer run searched for, as it searches.
 *
 * The agent's own search is part of what the user watches happen: the chat
 * shows the query as a step line and the map rings the conversations it found.
 * That trace comes from HERE, the server side of `kangentic_search`, rather
 * than from each CLI's output stream. Every agent with the Search capability
 * calls the same tool, so every one of them gets the trace, whatever its stream
 * looks like or whether it streams at all.
 *
 * Keyed by the answer caller segment (`answer-<chatId>`), which is written into
 * the run's MCP URL, so a search is attributed to its chat by construction.
 */

export interface AnswerSearchEvent {
  query: string;
  /** Sessions whose conversations the search returned. */
  sessionIds: string[];
}

type Listener = (event: AnswerSearchEvent) => void;

const listeners = new Map<string, Listener>();

/** Watch one answer caller's searches. Returns the unsubscribe. */
export function watchAnswerSearches(callerId: string, listener: Listener): () => void {
  listeners.set(callerId, listener);
  return () => {
    if (listeners.get(callerId) === listener) listeners.delete(callerId);
  };
}

/** Called by the search tool after an answer caller's search. Never throws. */
export function publishAnswerSearch(callerId: string, event: AnswerSearchEvent): void {
  try {
    listeners.get(callerId)?.(event);
  } catch {
    // A broken listener must never fail the agent's search.
  }
}

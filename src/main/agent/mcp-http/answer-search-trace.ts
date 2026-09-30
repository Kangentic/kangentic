/**
 * What a Knowledge Graph answer run searched for, as it searches.
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
  /** Tasks the search's commit hits are linked to, whose conversations the
   *  map rings too. */
  taskIds?: string[];
}

type Listener = (event: AnswerSearchEvent) => void;

/**
 * The map documents a search found, to ring: the conversations of the sessions
 * it returned and of the tasks its commit hits are linked to, each once.
 */
export function searchDocKeys(
  event: AnswerSearchEvent,
  docKeysBySession: ReadonlyMap<string, ReadonlyArray<string>>,
  docKeysByTask: ReadonlyMap<string, ReadonlyArray<string>>,
): string[] {
  return [...new Set([
    ...event.sessionIds.flatMap((sessionId) => docKeysBySession.get(sessionId) ?? []),
    ...(event.taskIds ?? []).flatMap((taskId) => docKeysByTask.get(taskId) ?? []),
  ])];
}

/**
 * Searches one question may make.
 *
 * Measured on Grok 4.7: told to "search again with different words before
 * concluding", it made about 50 searches over 95 seconds before writing a
 * word, chasing fragments of a sentence it wanted to quote. The answer was
 * right and nobody would wait for it. The related work already hands over the
 * strongest matches, so a few searches cover a real gap. The prompt states the
 * budget; this enforces it, for every agent, whatever its prompt adherence.
 */
export const ANSWER_SEARCH_BUDGET = 4;

interface Watch {
  listener: Listener;
  used: number;
  /** The projects the question is asked across, or null for no limit. */
  projectIds: ReadonlySet<string> | null;
}

const watches = new Map<string, Watch>();

/** Watch one answer caller's searches for one question, with a fresh search
 *  budget. `projectIds`, when given, are the only projects its searches may
 *  read: the user chose them, and the answer is about them. Returns the
 *  unsubscribe. */
export function watchAnswerSearches(callerId: string, listener: Listener, projectIds?: ReadonlyArray<string>): () => void {
  const watch: Watch = { listener, used: 0, projectIds: projectIds ? new Set(projectIds) : null };
  watches.set(callerId, watch);
  return () => {
    if (watches.get(callerId) === watch) watches.delete(callerId);
  };
}

/** The projects this caller's question may search, or null when no question
 *  limits it (a probe, a run whose question already ended). */
export function answerSearchProjects(callerId: string): ReadonlySet<string> | null {
  return watches.get(callerId)?.projectIds ?? null;
}

/**
 * Claim one search for this caller's question. False once its budget is
 * spent. A caller no question is watching (a probe, a run whose question
 * already ended) is not limited here.
 */
export function claimAnswerSearch(callerId: string): boolean {
  const watch = watches.get(callerId);
  if (!watch) return true;
  if (watch.used >= ANSWER_SEARCH_BUDGET) return false;
  watch.used += 1;
  return true;
}

/** Called by the search tool after an answer caller's search. Never throws. */
export function publishAnswerSearch(callerId: string, event: AnswerSearchEvent): void {
  try {
    watches.get(callerId)?.listener(event);
  } catch {
    // A broken listener must never fail the agent's search.
  }
}

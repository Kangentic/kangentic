import type Database from 'better-sqlite3';
import type { CommandTerminalHistorySearchHit } from '../../../shared/types';
import { COMMAND_TERMINAL_CORPUS } from '../corpora';
import { escapeFtsMatchQuery } from '../fts-query';
import { markRange } from '../memory-search';
import { RetrievalStore } from '../retrieval-store';

/** Chunks read per search. One long conversation can match many times, so it is
 *  well past the conversations shown. */
const CHUNKS_PER_SEARCH = 200;
/** A rail row each; past this the user types another word. */
const CONVERSATIONS_PER_SEARCH = 50;

/**
 * The Earlier search's keyword pass, one best chunk per conversation. Runs on
 * every pause in typing, so it reads no vectors and embeds nothing. Never
 * throws: a malformed query or a missing table answers no hits.
 */
export function searchCommandTerminalConversations(db: Database.Database, query: string): CommandTerminalHistorySearchHit[] {
  const matchQuery = escapeFtsMatchQuery(query);
  if (!matchQuery) return [];
  try {
    const store = new RetrievalStore(db);
    const lexical = store.searchLexical(matchQuery, CHUNKS_PER_SEARCH, [COMMAND_TERMINAL_CORPUS]);
    const conversationByChunk = new Map<number, string>();
    for (const chunk of store.getChunks(lexical.map((hit) => hit.chunkId))) {
      if (chunk.agentSessionId) conversationByChunk.set(chunk.id, chunk.agentSessionId);
    }
    const best = new Map<string, CommandTerminalHistorySearchHit>();
    for (const hit of lexical) {
      const agentSessionId = conversationByChunk.get(hit.chunkId);
      if (!agentSessionId || best.has(agentSessionId)) continue;
      // One line, a character for a character, so the range holds on what is shown.
      const snippet = hit.snippet.replace(/\s/g, ' ');
      const range = markRange(snippet, query);
      best.set(agentSessionId, { agentSessionId, snippet, matchStart: range.start, matchEnd: range.end });
      if (best.size === CONVERSATIONS_PER_SEARCH) break;
    }
    return [...best.values()];
  } catch (error) {
    console.warn('[retrieval] Command Terminal search failed:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * What the agent is given to answer a question from: a budgeted selection of the
 * conversation passages retrieval returned.
 *
 * THE BUDGET IS THE QUALITY CEILING. Everything downstream - the prompt, the
 * answer, the citations - is bounded by which passages fit, so this is the piece
 * worth measuring rather than guessing. Measured on the real 648-conversation
 * corpus: a chunk averages 394 tokens (median 1,673 characters, capped near
 * 2,150), so the default budget carries roughly two dozen conversations. That is
 * deliberately BREADTH rather than depth - for a question asked of heterogeneous
 * sources, more distinct conversations beats more of any one of them, and a
 * chunk is standalone-readable at this size (it carries its role prefix and
 * usually a whole turn).
 *
 * Pure: the caller reads the chunks, this decides what survives. That is what
 * lets the selection be tested against real distributions without a database.
 */

import type { StoredChunk } from './types';
import type { TranscriptSearchHit } from './memory-search';

/**
 * Tokens of conversation text a single question may carry.
 *
 * Not the model's context limit, which is far larger. This is the amount past
 * which more passages stop adding answers and start adding latency and cost: at
 * roughly 394 tokens a chunk it is about thirty conversations, which is already
 * more distinct sources than a question about past work usually has.
 */
export const ANSWER_TOKEN_BUDGET = 12_000;

/**
 * Conversations a single answer may cite.
 *
 * A second bound on the same thing, in the unit the READER cares about. A budget
 * alone would happily spend itself on fifty short fragments, and an answer citing
 * fifty sources is not an answer.
 */
export const MAX_ANSWER_SOURCES = 24;

export interface AnswerSource {
  /** 1-based, and the number the answer is told to cite. */
  index: number;
  docKey: string;
  sessionId: string;
  taskId: string | null;
  title: string;
  /** Epoch ms of the passage, so a claim can be dated. */
  ts: number | null;
  /**
   * How many passages of this conversation matched the question.
   *
   * Carried into the prompt rather than used to re-rank. It is the one real
   * relevance signal the fused score does not carry (RRF is purely ordinal), and
   * the model can weigh a conversation that matched in twelve places against one
   * that matched in one far better than a re-ranking rule can.
   */
  matchCount: number;
  text: string;
  tokenEstimate: number;
}

export interface AnswerContext {
  sources: AnswerSource[];
  usedTokens: number;
  /**
   * Conversations retrieval found that the budget could not carry.
   *
   * Surfaced rather than swallowed: an answer drawn from 24 of 60 matches is a
   * different claim from one drawn from all of them, and the reader is the only
   * one who can tell whether that matters.
   */
  droppedConversations: number;
}

export interface SelectAnswerSourcesOptions {
  budgetTokens?: number;
  maxSources?: number;
}

/**
 * Take hits in retrieval order until the budget or the source cap runs out.
 *
 * A passage too large for what is left is SKIPPED rather than ending the
 * selection: chunk sizes are tightly grouped, so one outlier near the end would
 * otherwise cost several ordinary passages that still fit behind it.
 *
 * A hit whose chunk is missing is skipped silently. The index is rebuilt
 * incrementally and a chunk can be deleted between the search and this read, so
 * that is an ordinary race rather than an error worth failing an answer over.
 */
export function selectAnswerSources(
  hits: ReadonlyArray<TranscriptSearchHit>,
  chunksById: ReadonlyMap<number, StoredChunk>,
  options: SelectAnswerSourcesOptions = {},
): AnswerContext {
  const budgetTokens = options.budgetTokens ?? ANSWER_TOKEN_BUDGET;
  const maxSources = options.maxSources ?? MAX_ANSWER_SOURCES;

  const sources: AnswerSource[] = [];
  let usedTokens = 0;
  let droppedConversations = 0;

  for (const hit of hits) {
    if (sources.length >= maxSources) {
      droppedConversations += 1;
      continue;
    }
    const chunk = chunksById.get(hit.chunkId);
    if (!chunk) continue;
    const text = chunk.text.trim();
    if (!text) continue;
    // `tokenEstimate` is stored per chunk at index time. Budgeting in characters
    // instead would vary by about a fifth across chunks for the same spend.
    const cost = chunk.tokenEstimate > 0 ? chunk.tokenEstimate : Math.ceil(text.length / 4);
    if (usedTokens + cost > budgetTokens) {
      droppedConversations += 1;
      continue;
    }
    usedTokens += cost;
    sources.push({
      index: sources.length + 1,
      docKey: `${chunk.corpus}::${chunk.docId}`,
      sessionId: hit.sessionId,
      taskId: hit.taskId,
      title: hit.taskTitle,
      ts: chunk.tsEnd ?? chunk.tsStart ?? hit.turnTs,
      matchCount: hit.matchCount,
      text,
      tokenEstimate: cost,
    });
  }

  return { sources, usedTokens, droppedConversations };
}

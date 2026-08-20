/**
 * The prompt Ask sends: a question, the passages retrieval found for it, and the
 * rules that keep the answer tied to them.
 *
 * PURE, and separate from the spawn on purpose. What the agent is told is the
 * part worth reading in a diff and testing without a CLI, where the spawn is
 * plumbing every adapter already shares.
 *
 * The rules are short and each one exists because of a specific way a
 * retrieval-grounded answer goes wrong: inventing a source, answering from the
 * model's own knowledge of the codebase rather than from the excerpts, hedging
 * instead of admitting the excerpts do not cover it, and burying the answer under
 * a restatement of the question.
 */

import type { AnswerSource } from './answer-context';

/**
 * Characters of any one passage the prompt will carry.
 *
 * A backstop, not the budget: `selectAnswerSources` has already spent a token
 * allowance, and chunks cap near 2,150 characters at index time. This only
 * matters for a corpus chunked under different settings, where one enormous
 * passage could otherwise crowd out every other source's share of attention.
 */
const MAX_SOURCE_CHARACTERS = 4_000;

const RULES = [
  'Answer only from the excerpts below. They are the whole of what you know here.',
  'If they do not answer the question, say so in one line and stop. Do not guess, and do not fall back on what you know about this codebase from anywhere else.',
  'Cite the excerpts behind every claim by their number, like [3] or [1][4].',
  'Never refer to a conversation, date, file or decision that is not in an excerpt.',
  'Answer directly. No preamble, no restating the question, no summary of what you are about to say.',
].join('\n');

/** ISO date, which is unambiguous and needs no locale. */
function formatSourceDate(ts: number | null): string {
  if (ts === null) return 'date unknown';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? 'date unknown' : date.toISOString().slice(0, 10);
}

/**
 * How many passages of this conversation matched, stated only when it is more
 * than one.
 *
 * The single real relevance signal the fused score does not carry: RRF is purely
 * ordinal, so a hit at rank 1 and a hit at rank 1 look identical whether one
 * matched twelve passages and the other matched one. Given to the model rather
 * than used to re-rank, because weighing corroboration against what a passage
 * actually says is exactly the judgement a ranking rule cannot make.
 */
function formatCorroboration(matchCount: number): string {
  return matchCount > 1 ? `, matched in ${matchCount} passages` : '';
}

export function buildAnswerPrompt(question: string, sources: ReadonlyArray<AnswerSource>): string {
  const excerpts = sources.map((source) => {
    const text = source.text.length > MAX_SOURCE_CHARACTERS
      ? `${source.text.slice(0, MAX_SOURCE_CHARACTERS)}…`
      : source.text;
    const header = `[${source.index}] ${source.title || 'Untitled conversation'}`
      + ` (${formatSourceDate(source.ts)}${formatCorroboration(source.matchCount)})`;
    return `${header}\n${text}`;
  }).join('\n\n');

  return [
    'You are answering a question about a developer\'s own past work, from excerpts of their'
      + ' recorded agent conversations.',
    '',
    RULES,
    '',
    'Excerpts:',
    '',
    excerpts,
    '',
    `Question: ${question.trim()}`,
  ].join('\n');
}

/**
 * What to say when retrieval found nothing.
 *
 * Answered WITHOUT spawning an agent. Sending a question with no excerpts and
 * these rules can only produce the same sentence at the cost of a real CLI call,
 * and a surface that charges for that once will be distrusted for the rest of the
 * session.
 */
export const NO_SOURCES_ANSWER =
  'Nothing in the indexed conversations matched that question, so there is nothing to answer from.';

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
import type { AnswerTaskTable } from './answer-tasks';
import { formatTaskTable } from './answer-tasks';

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
  'Answer only from the TASKS table and the EXCERPTS below. Together they are the whole of what you know here.',
  'The TASKS table is complete and its numbers are exact: every task in this project is listed, and the costs, durations and totals are already computed. Use it for anything factual - which tasks exist, what they cost, how long they ran, how they ended, when they were last active.',
  'The EXCERPTS are what was actually said. Use them for reasoning, decisions and detail. They are a sample, not the whole index, so never conclude a task does not exist because it has no excerpt - check the table.',
  'If neither answers the question, say so in one line and stop. Do not guess, and do not fall back on what you know about this codebase from anywhere else.',
  'Cite an excerpt by its number, like [3] or [1][4]. Name a task by its ref, like T12.',
  'Answer directly. No preamble, no restating the question, no summary of what you are about to say.',
].join('\n');

/**
 * The extra rules for a question that asks to SEE tasks rather than to be told
 * something ("show me...", "which tasks...", "list...").
 *
 * Completeness is demanded explicitly because the failure mode is silent: an
 * agent asked for "all tasks matching X" will happily return a tidy ten and
 * sound authoritative, and the reader has no way to know forty matched. The
 * table is complete, so there is no excuse for a sample, and saying so is
 * cheaper than any post-hoc check.
 */
const SELECTION_RULES = [
  'This question asks WHICH tasks. Scan the whole TASKS table and return EVERY task that qualifies, not a representative sample. Completeness matters more than brevity here.',
  'Judge each task on meaning, not on wording: a task about ConPTY geometry or scrollback repaints is a terminal task whether or not it uses the word.',
  'End your reply with a final line of exactly this form, listing every qualifying task ref:',
  'SELECTED: T3, T17, T42',
  'Write that line even if only one task qualifies. If none do, write "SELECTED: none".',
  'Above that line, give one short sentence saying what you selected on. Do not list the tasks in prose as well - the interface shows them.',
].join('\n');

/**
 * Does this question want a set of tasks rather than an explanation?
 *
 * Deliberately conservative, and it costs little to be wrong in either
 * direction: a missed selection still answers in prose, and a false positive
 * adds one trailing line the renderer ignores when no refs parse. Matched
 * against the phrasings people actually type rather than against a grammar.
 */
export function wantsTaskSelection(question: string): boolean {
  return /\b(show|list|find|which|what)\b[^?]*\b(tasks?|work|conversations?|sessions?)\b/i
    .test(question.trim());
}

/**
 * The task refs an answer selected, and the answer with that line removed.
 *
 * Parsed from a trailing line rather than demanded as JSON: a CLI agent writing
 * prose emits a trailing line far more reliably than a clean JSON envelope, and
 * a malformed envelope would cost the whole answer where a missing line costs
 * only the selection.
 */
export function parseSelectedRefs(answer: string): { refs: number[]; text: string } {
  const match = answer.match(/^[ \t]*SELECTED:[ \t]*(.*)$/im);
  if (!match) return { refs: [], text: answer };
  const refs = [...match[1].matchAll(/T(\d+)/gi)]
    .map((entry) => Number.parseInt(entry[1], 10))
    .filter((value) => Number.isFinite(value));
  // Deduped and ordered: a repeated ref would be a duplicate card.
  const unique = [...new Set(refs)].sort((left, right) => left - right);
  return { refs: unique, text: answer.replace(match[0], '').trimEnd() };
}

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

/** Today, so a relative window ("the last 3 months") has an anchor the model
 *  cannot get wrong. Passed in rather than read here, so the prompt stays pure
 *  and a test can pin a date. */
export interface AnswerPromptContext {
  tasks: AnswerTaskTable;
  /** Epoch ms treated as "now". */
  nowMs: number;
}

function formatSpan(table: AnswerTaskTable, nowMs: number): string {
  const iso = (ms: number | null): string =>
    ms === null ? 'unknown' : new Date(ms).toISOString().slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const dropped = table.droppedTasks > 0
    ? ` The ${table.droppedTasks} cheapest tasks did not fit and are absent.`
    : '';
  return `Today is ${today}. The table holds ${table.rows.length} tasks`
    + ` across ${table.conversationCount} conversations,`
    + ` active from ${iso(table.earliestMs)} to ${iso(table.latestMs)}.${dropped}`;
}

export function buildAnswerPrompt(
  question: string,
  sources: ReadonlyArray<AnswerSource>,
  context: AnswerPromptContext,
): string {
  const excerpts = sources.map((source) => {
    const text = source.text.length > MAX_SOURCE_CHARACTERS
      ? `${source.text.slice(0, MAX_SOURCE_CHARACTERS)}…`
      : source.text;
    const header = `[${source.index}] ${source.title || 'Untitled conversation'}`
      + ` (${formatSourceDate(source.ts)}${formatCorroboration(source.matchCount)})`;
    return `${header}\n${text}`;
  }).join('\n\n');

  const trimmed = question.trim();
  const selecting = wantsTaskSelection(trimmed);

  return [
    'You are answering a question about a developer\'s own past work, from a complete table of'
      + ' their tasks and excerpts of their recorded agent conversations.',
    '',
    RULES,
    ...(selecting ? ['', SELECTION_RULES] : []),
    '',
    formatSpan(context.tasks, context.nowMs),
    '',
    'TASKS (complete, one row per task, costs and durations already totalled):',
    '',
    formatTaskTable(context.tasks),
    '',
    // Stated even when empty: "no excerpt matched" is information, where a
    // missing section reads as a malformed prompt and invites the model to
    // assume it was meant to have one.
    excerpts
      ? 'EXCERPTS (a sample of what was said, not the whole index):'
      : 'EXCERPTS: none matched this question. Answer from the table alone.',
    '',
    excerpts,
    '',
    `Question: ${trimmed}`,
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

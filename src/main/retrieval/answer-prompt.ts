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

import type { AnswerTaskTable } from './answer-tasks';
import { formatTaskFieldGlossary, formatTaskTable, summarizeTaskTable } from './answer-tasks';
import type {
  MemoryTaskFieldKey,
  MemoryTaskOrder,
  MemoryTaskView,
} from '../../shared/memory-task-fields';
import {
  MAX_TASK_COLUMNS,
  resolveTaskField,
  taskFieldByKey,
} from '../../shared/memory-task-fields';

const RULES = [
  'Answer only from <task_table> above and from what kangentic_search returns. Together they are the whole of what you know here.',
  '<task_table> is complete and its numbers are exact: every task in this project is listed, and the costs, durations and totals are already computed. Use it for anything factual - which tasks exist, what they cost, how long they ran, how they ended, when they were last active. A question the table answers needs no search.',
  'For anything about what was said, decided, tried or explained, search the recorded conversations with the kangentic_search tool. It is listed to you as mcp__kangentic__kangentic_search, and it is the only tool you may use. Call it with mode "hybrid" and a query describing what you are looking for; it searches by meaning and returns the matching passages, which are what you read. There is no tool for opening a transcript, so do not reach for one. If the first search does not find it, search again with different words before concluding it is not there.',
  'Never say that the conversations do not mention something unless you searched for it and the search came back empty. Guessing that a search would find nothing is not the same as searching.',
  'Before the answer, write a <grounds> block naming what it rests on: the table rows you used with their figures, and a short quote from each conversation passage you relied on. Then write the answer below it.',
  'If the grounds are empty, the sources do not cover the question. Say that in one line as the whole answer.',
  // Measured leak this wording fixes: scoped to "this codebase", the rule did
  // not cover general knowledge, and asked for the capital of France the agent
  // correctly called the question out of scope and then answered it anyway -
  // which is a literal reading of what it was told. The prohibition has to be
  // about the SOURCES, not about a subject.
  'If neither answers the question, say so in one line and stop there. Do not guess, and do not answer it anyway from anything you know outside these two sources - not about this codebase, and not about the world.',
  'Name a task by its ref, like T12. When a search result settled something, quote the passage in <grounds> so the reader can see what it said.',
  'The answer itself is direct: no preamble, no restating the question, no summary of what you are about to say. The <grounds> block carries the working, so the answer does not have to.',
  'End your reply with a line naming the TASKS columns worth showing beside each task, most important first, using the column names from the glossary:',
  'VIEW: cost_usd desc, duration, outcome',
  'Put asc or desc on the column you ranked by, and name at most three columns. Omit the line entirely if the question has no ranking and no particular column matters.',
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
export function parseSelectedRefs(answer: string): {
  refs: number[];
  mentioned: number[];
  text: string;
} {
  // Every ref the answer NAMES, wherever it names it. This is the load-bearing
  // half, and it exists because the protocol line is not reliable: asked to
  // describe mobile work, the agent wrote an essay naming 22 tasks inline as
  // `T133` and never emitted the trailing line at all. Those refs are real and
  // resolvable, and they were rendering as dead text - so the vocabulary the
  // prompt hands out is read back out of the PROSE rather than only out of a
  // format the model may decline to use.
  //
  // Bounded to 1-4 digits with word boundaries, so a `T1` inside an identifier
  // is not mistaken for a reference.
  //
  // FIRST-MENTION ORDER, which a Set gives for free by preserving insertion
  // order. Load-bearing rather than incidental: it is what the rail orders by
  // when the answer names no ranking column, and it is the one order that can
  // never look wrong, because it is the order the reader has already seen in
  // the prose above. Sorting numerically here - as this did - sorted by the
  // table's row order, which is COST order, which is a ranking nobody asked
  // for on any question that was not about cost.
  const mentioned = new Set(
    [...answer.matchAll(/\bT(\d{1,4})\b/g)].map((entry) => Number.parseInt(entry[1], 10)),
  );

  const match = answer.match(/^[ \t]*SELECTED:[ \t]*(.*)$/im);
  if (!match) {
    return { refs: [], mentioned: [...mentioned], text: answer };
  }
  const refs = [...new Set(
    [...match[1].matchAll(/T(\d+)/gi)]
      .map((entry) => Number.parseInt(entry[1], 10))
      .filter((value) => Number.isFinite(value)),
  )].sort((left, right) => left - right);
  // A task named ONLY in the line still counts as mentioned: the line is a
  // statement about the answer, not decoration on top of the prose.
  for (const ref of refs) mentioned.add(ref);
  return {
    refs,
    mentioned: [...mentioned],
    text: answer.replace(match[0], '').trimEnd(),
  };
}

/**
 * How the answer asked for its tasks to be shown.
 *
 * A second trailing line beside `SELECTED:`, and two lines rather than one
 * envelope on purpose: each degrades alone, so a mangled view can never cost
 * the refs. Cube's equivalent is JSON because its producer is a machine; ours
 * is a CLI agent writing prose, where a malformed envelope costs everything and
 * a comma-separated line costs one token.
 *
 * Reliability is not assumed. Asked for the largest mobile task the agent
 * volunteered "ranked by cost_usd" with no rule asking for it, in the table's
 * own vocabulary - far better evidence than `SELECTED:` ever had, and that one
 * it has ignored twice. Even so, EVERY failure falls back rather than throwing:
 * no line, an unknown column, a direction on something that cannot carry one.
 * The rows still render, in the order the answer named them.
 */
export function parseAnswerView(answer: string): {
  view: MemoryTaskView | null;
  text: string;
} {
  const match = answer.match(/^[ \t]*VIEW:[ \t]*(.*)$/im);
  if (!match) return { view: null, text: answer };

  const select: MemoryTaskFieldKey[] = [];
  let order: MemoryTaskOrder | null = null;
  for (const token of match[1].split(',')) {
    const parts = token.trim().split(/[ \t]+/).filter(Boolean);
    if (parts.length === 0) continue;
    const field = resolveTaskField(parts[0]);
    // An invented column is dropped rather than fatal: the rest of the line is
    // still a usable instruction.
    if (!field || !field.selectable) continue;
    if (!select.includes(field.key)) select.push(field.key);

    // A direction only means something on a field that can be ordered. A
    // dimension carries none - "agent desc" would impose a ranking nobody asked
    // for and quietly claim the first row is the most something - so the word
    // is ignored rather than obeyed.
    const written = parts[1]?.toLowerCase();
    const orderable = field.kind === 'measure' || field.kind === 'time';
    if (!order && orderable && (written === 'asc' || written === 'desc')) {
      order = { key: field.key, direction: written };
    }
  }

  const text = answer.replace(match[0], '').trimEnd();
  if (select.length === 0) return { view: null, text };

  // No direction written anywhere: rank by the first column that CAN carry
  // one, which is what "most important first" means. Not simply `select[0]` -
  // a categorical lead ("VIEW: agent, cost_usd") would then leave the rows
  // unordered while a perfectly good ranking column sat right behind it. A
  // measure defaults to largest-first and a date to newest-first, which are
  // both `desc`, so this needs no branch.
  if (!order) {
    const lead = select
      .map((key) => taskFieldByKey(key))
      .find((field) => field?.kind === 'measure' || field?.kind === 'time');
    if (lead) order = { key: lead.key, direction: 'desc' };
  }
  return { view: { select: select.slice(0, MAX_TASK_COLUMNS), order }, text };
}

/**
 * The working the answer rests on, lifted out of the reply.
 *
 * Quoting the relevant source material before answering is the documented
 * remedy for long-context prompts, where it "helps the model focus on the most
 * pertinent information and reduces the impact of irrelevant content" - which
 * is exactly the measured failure here, an answer reaching past 22k tokens of
 * task history to answer the capital of France from general knowledge.
 *
 * The grounds are STRIPPED from the answer rather than shown with it. The rail
 * is narrow and its answers are one or two lines; a paragraph of quotes above
 * every one of them would cost more than it buys. The renderer puts them behind
 * a disclosure instead, so the reader can check without having to read.
 *
 * Degrades like its siblings: no block, an unterminated block, or an empty one
 * all yield null grounds and an untouched answer. The working is worth having
 * and never worth losing the answer over.
 */
export function parseGrounds(answer: string): { grounds: string | null; text: string } {
  const match = answer.match(/<grounds>([\s\S]*?)<\/grounds>/i);
  if (!match) {
    // An unterminated opener would otherwise leave `<grounds>` and everything
    // after it rendering as the answer, which is worse than showing no working.
    const opener = answer.match(/<grounds>/i);
    if (!opener) return { grounds: null, text: answer };
    return { grounds: null, text: answer.slice(0, opener.index).trim() };
  }
  const grounds = match[1].trim();
  const text = (answer.slice(0, match.index) + answer.slice((match.index ?? 0) + match[0].length))
    .trim();
  // A model that emitted grounds and nothing else has answered with its working.
  // Showing an empty rail would be worse than showing that.
  if (!text) return { grounds: null, text: grounds || answer.trim() };
  return { grounds: grounds || null, text };
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

/**
 * The prompt an answering agent receives: the whole board as facts, the rules,
 * and the question. No transcript passages.
 *
 * Passages used to be retrieved HERE, before the agent saw the question - our
 * search chose 24 of them and the agent answered from whatever it was handed,
 * with no way to recover when the retrieval had misjudged. Now the agent holds
 * the search tool itself (see `AnswerFromContextOptions.retrieval`) and pulls
 * transcripts only when the table cannot answer, with a query it chose, and
 * again with different words if the first miss. One mechanism instead of two.
 *
 * The prompt is therefore STABLE across questions except for its last line,
 * which is exactly the shape the cache rewards: the measured prefix reuse
 * (13,302 tokens read, nothing written, on a second call sharing a prefix)
 * now covers everything above the question.
 *
 * ORDER IS LOAD-BEARING. The guidance for prompts over 20k tokens is to put
 * longform data at the top and the query last - reported as worth up to 30% of
 * response quality - and this prompt measures over 20k.
 */
export function buildAnswerPrompt(
  question: string,
  context: AnswerPromptContext,
): string {
  const trimmed = question.trim();
  const selecting = wantsTaskSelection(trimmed);

  return [
    'You are answering a question about a developer\'s own past work, from a complete table of'
      + ' their tasks and a search tool over their recorded agent conversations.',
    '',
    `<task_summary>\n${formatSpan(context.tasks, context.nowMs)}\n\n`
      + `${summarizeTaskTable(context.tasks)}\n</task_summary>`,
    '',
    `<column_glossary>\n${formatTaskFieldGlossary()}\n</column_glossary>`,
    '',
    `<task_table>\n${formatTaskTable(context.tasks)}\n</task_table>`,
    '',
    RULES,
    ...(selecting ? ['', SELECTION_RULES] : []),
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

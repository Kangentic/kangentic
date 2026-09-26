/**
 * The prompt Ask sends, and how an answer's task refs are read back.
 *
 * PURE, and separate from the spawn on purpose. What the agent is told is the
 * part worth reading in a diff and testing without a CLI, where the spawn is
 * plumbing every adapter already shares.
 *
 * ONE RESPONSE SHAPE. The agent writes chat prose that names tasks by their
 * board ticket (`#561`), and ends with one `SELECTED:` line listing the tasks
 * the answer is about. The chat renders the prose with those tickets as marks
 * and the selection as source rows. There used to be two more protocols beside
 * this one, a `VIEW:` line choosing table columns and a `<grounds>` block of
 * quoted working. Both fed UI that per-question layouts needed, and the agreed
 * design has none: every answer is prose plus rows, whatever was asked.
 */

import type { AnswerTaskTable } from './answer-tasks';
import { formatTaskFieldGlossary, formatTaskTable, summarizeTaskTable } from './answer-tasks';
import { MEMORY_TASK_FIELDS, type MemoryTaskFacts, type MemoryTaskFieldKey } from '../../shared/memory-task-fields';

/** One task of the related work, as the prompt states it. */
export interface RelatedPromptTask {
  ref: string;
  title: string;
  strength: number;
  matches: number;
  firstMs: number | null;
  lastMs: number | null;
  /** The best passage, for the first few tasks only. */
  passage: string | null;
  /** The task's facts from the table, so a superlative inside the set needs no lookup. */
  facts: MemoryTaskFacts | null;
}

/**
 * The facts each related task carries beside its match.
 *
 * Measured: asked for the most expensive task related to the mobile relay,
 * Haiku had to find each related task's cost in a 360-row table and named one
 * that three others outspent. Stated on the related row, the ranking is a read.
 */
const RELATED_FACT_KEYS: ReadonlyArray<MemoryTaskFieldKey> = ['cost_usd', 'duration', 'tokens', 'sessions', 'outcome'];
const RELATED_FACT_FIELDS = MEMORY_TASK_FIELDS.filter((field) => RELATED_FACT_KEYS.includes(field.key));

/** One earlier turn of the chat. */
export interface AnswerHistoryTurn {
  question: string;
  answer: string;
  /** Refs of the tasks that turn was about. */
  refs: string[];
}

export interface AnswerPromptContext {
  tasks: AnswerTaskTable;
  /** Epoch ms treated as "now", so a relative window has a fixed anchor. */
  nowMs: number;
  /** What the local search found for this question, strongest first. */
  related: ReadonlyArray<RelatedPromptTask>;
  /** Earlier turns, oldest first. */
  history?: ReadonlyArray<AnswerHistoryTurn>;
  /** Whether the agent holds the search tool this run. */
  canSearch: boolean;
}

/** Characters of an earlier answer carried into a follow-up. */
const HISTORY_ANSWER_CHARS = 1_200;

function rules(canSearch: boolean): string {
  const sources = canSearch
    ? '<related_work>, <task_table>, <conversation_so_far> and what kangentic_search returns'
    : '<related_work>, <task_table> and <conversation_so_far>';
  return [
    `Answer only from ${sources}. Together they are the whole of what you know here.`,
    '<related_work> is what a search of every recorded conversation found for this question, strongest first.'
      + ' Decide which of those tasks the question is really about by their titles and passages, keep those,'
      + ' and ignore the ones that only share a word. Count and rank from them together with the table.',
    '<task_table> is complete and its numbers are exact: every task in scope is listed, and costs, durations'
      + ' and totals are already computed. Use it for anything factual. A question the table answers needs no search.',
    ...(canSearch
      ? [
        'If <related_work> does not cover what the question needs, search the recorded conversations with the'
          + ' kangentic_search tool (listed to you as mcp__kangentic__kangentic_search, the only tool you may use),'
          + ' with mode "hybrid" and a query describing what you are looking for. If it misses, search again with'
          + ' different words before concluding the conversations do not cover it.',
      ]
      : []),
    'Never say the conversations do not mention something unless <related_work> and any search came back without it.',
    'Name every task by its ref exactly as the table writes it, like #561. Never invent a ref.',
    'Answer the way you would in a chat: a few direct sentences, no preamble, no restating the question, no'
      + ' headings, no bold, and no list or table. The interface lists every task on your SELECTED line as a'
      + ' row under your answer, so even when the question asks which tasks, do not list them or recite their'
      + ' titles. Name at most three tasks in the prose, the ones that matter most, and say what connects them'
      + ' or sets them apart. The rows show the rest.',
    'Never mention <task_table>, <related_work> or any tag here, and never open with "Based on": the reader'
      + ' cannot see them, so start with the answer itself.',
    'If nothing in these sources answers the question, say so in one sentence. Do not guess, and do not answer'
      + ' from anything you know outside these sources - not about this codebase, and not about the world.',
    'End with one final line of exactly this form, naming every task your answer is about. For a count or a'
      + ' "which tasks" question, name all of them, not a sample:',
    'SELECTED: #564, #561, #573',
    'Write "SELECTED: none" when the answer is not about particular tasks.',
  ].join('\n');
}

function isoDate(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString().slice(0, 10);
}

function formatSpan(table: AnswerTaskTable, nowMs: number): string {
  const today = isoDate(nowMs);
  const dropped = table.droppedTasks > 0
    ? ` The ${table.droppedTasks} cheapest tasks did not fit and are absent.`
    : '';
  const scope = table.scoped ? ' The user has filtered the map, so only tasks inside that filter are listed.' : '';
  return `Today is ${today}. The table holds ${table.rows.length} tasks`
    + ` across ${table.conversationCount} conversations,`
    + ` active from ${isoDate(table.earliestMs) || 'unknown'} to ${isoDate(table.latestMs) || 'unknown'}.${dropped}${scope}`;
}

/** The related work as a compact table, strongest first. */
export function formatRelatedWork(related: ReadonlyArray<RelatedPromptTask>): string {
  if (related.length === 0) return 'Nothing in the recorded conversations matched this question.';
  const header = [
    'ref', 'task', 'strength', 'matches', 'first', 'last',
    ...RELATED_FACT_FIELDS.map((field) => field.key),
    'passage',
  ].join('|');
  const rows = related.map((task) => [
    task.ref,
    task.title.replace(/\|/g, '/'),
    task.strength.toFixed(2),
    String(task.matches),
    isoDate(task.firstMs),
    isoDate(task.lastMs),
    ...RELATED_FACT_FIELDS.map((field) => (task.facts ? field.cell(task.facts) : '')),
    task.passage ? `"${task.passage.replace(/\|/g, '/').replace(/"/g, '\'')}"` : '',
  ].join('|'));
  return [
    'strength is how closely the task matched, relative to the best match (1.00). matches counts the passages that'
      + ' matched, and first and last are when. The facts are the same as in <task_table>. Only the strongest tasks'
      + ' show a passage.',
    header,
    ...rows,
  ].join('\n');
}

function formatHistory(history: ReadonlyArray<AnswerHistoryTurn>): string {
  return history.map((turn) => {
    const answer = turn.answer.length > HISTORY_ANSWER_CHARS
      ? `${turn.answer.slice(0, HISTORY_ANSWER_CHARS)}...`
      : turn.answer;
    const about = turn.refs.length > 0 ? `\nTasks it was about: ${turn.refs.join(', ')}` : '';
    return `Q: ${turn.question}\nA: ${answer}${about}`;
  }).join('\n\n');
}

/**
 * The prompt an answering agent receives.
 *
 * ORDER IS LOAD-BEARING, twice over. Long data goes first and the question last,
 * which the guidance for prompts over 20k tokens reports as worth up to 30% of
 * answer quality. And everything that changes per question (the related work,
 * the conversation so far, the question) goes AFTER the table and the rules, so
 * the long stable prefix (measured at about 13k tokens) stays cached across
 * questions.
 */
export function buildAnswerPrompt(question: string, context: AnswerPromptContext): string {
  const history = context.history ?? [];
  return [
    'You are answering a question about a developer\'s own past work, from a complete table of their tasks,'
      + ' the work a search found related to the question, and the chat so far.',
    '',
    `<task_summary>\n${formatSpan(context.tasks, context.nowMs)}\n\n`
      + `${summarizeTaskTable(context.tasks)}\n</task_summary>`,
    '',
    `<column_glossary>\n${formatTaskFieldGlossary()}\n</column_glossary>`,
    '',
    `<task_table>\n${formatTaskTable(context.tasks)}\n</task_table>`,
    '',
    rules(context.canSearch),
    '',
    `<related_work>\n${formatRelatedWork(context.related)}\n</related_work>`,
    ...(history.length > 0 ? ['', `<conversation_so_far>\n${formatHistory(history)}\n</conversation_so_far>`] : []),
    '',
    FINAL_REMINDER,
    '',
    `Question: ${question.trim()}`,
  ].join('\n');
}

/**
 * The reply's shape, restated where the model reads it last.
 *
 * Measured on Haiku with the same rules stated only above the tables: it
 * recited every task's title in parentheses, opened with "Based on the task
 * table", and corrected itself mid-reply ("Wait, let me correct that") in text
 * the reader watches arrive. After ~17k tokens of data the early rules lose to
 * habit; a short restatement next to the question does not.
 */
const FINAL_REMINDER = 'Reply in two to four plain sentences. Name at most three tasks, by ref alone and never with'
  + ' their titles. Work the answer out before you write it: every word appears to the reader as you write it, so'
  + ' never correct yourself in the reply. End with the SELECTED line.';

/**
 * The refs an answer names and selects, and the answer without its protocol line.
 *
 * `resolvable` maps a ref as the prompt wrote it (`#561`, `C12`) to a task key;
 * anything else is ignored. A bare `#2` in prose ("step #2") is not trusted on
 * its own: a mention counts only when it resolves AND the task is one the
 * answer could be about, which `trusted` names (the related work plus whatever
 * the SELECTED line lists).
 *
 * Mentions keep first-mention order, which is the order the reader has already
 * seen in the prose, so it is the one order the rows can never contradict.
 */
export function parseAnswerRefs(
  answer: string,
  resolvable: ReadonlyMap<string, string>,
  trusted: ReadonlySet<string>,
): { selected: string[]; mentioned: string[]; text: string } {
  const refPattern = /(?<![\w#])(#\d{1,6}|C\d{1,4})\b/g;
  const keysIn = (text: string): string[] => {
    const keys: string[] = [];
    for (const match of text.matchAll(refPattern)) {
      const key = resolvable.get(match[1]);
      if (key && !keys.includes(key)) keys.push(key);
    }
    return keys;
  };

  const line = answer.match(/^[ \t]*SELECTED:[ \t]*(.*)$/im);
  const selected = line ? keysIn(line[1]) : [];
  const text = line ? answer.replace(line[0], '').trimEnd() : answer.trimEnd();

  const trust = new Set([...trusted, ...selected]);
  const mentioned = keysIn(text).filter((key) => trust.has(key));
  return { selected, mentioned, text };
}

/**
 * What to say when there is nothing to answer from.
 *
 * Answered WITHOUT spawning an agent. Sending a question with nothing to read
 * can only produce this same sentence at the cost of a real CLI call.
 */
export const NO_SOURCES_ANSWER =
  'Nothing in the indexed conversations matched that question, so there is nothing to answer from.';

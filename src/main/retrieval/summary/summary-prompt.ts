import crypto from 'node:crypto';
import { SUMMARY_BATCH_SIZE } from '../../../shared/task-summaries';

/**
 * Task summaries: one or two sentences per finished task, written by the summary
 * agent (the Task summaries card's own choice), saying what the task set out to
 * do and what it ended up doing. A summary is searched with the task's own
 * record and shown to the answering agent beside the task, so a question finds
 * a task by what it did, not only by what its title and conversations happen
 * to say.
 *
 * The input is compact on purpose: the title, the start of the description,
 * the files the task's sessions changed, the subjects of the commits it landed
 * on the default branch, and how each of its last sessions ended. About ten
 * tasks share one call.
 */

/** Tasks per call, shared with the Task summaries card's call estimate. */
export { SUMMARY_BATCH_SIZE };

/** Bump when the input or the prompt changes, so every summary is rewritten. */
export const TASK_SUMMARY_VERSION = 1;
/** A summary longer than this is cut: it is a summary, not a report. */
export const SUMMARY_MAX_CHARS = 360;

const DESCRIPTION_CHARS = 600;
const CLOSING_MESSAGE_CHARS = 300;
const CHANGED_FILES_SHOWN = 8;
const COMMITS_SHOWN = 8;
const COMMIT_SUBJECT_CHARS = 120;

export interface SummaryInput {
  taskId: string;
  title: string;
  description: string;
  /** Repository paths the task's sessions changed, most-changed first. */
  changedFiles: ReadonlyArray<string>;
  /** Subjects of the commits it landed on the default branch, newest first. */
  commits: ReadonlyArray<string>;
  /** How each of its latest sessions ended, newest first. */
  closingMessages: ReadonlyArray<string>;
}

function clip(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

/** One task as the prompt carries it, without its label. */
export function summaryInputBlock(input: SummaryInput): string {
  const lines = [`Title: ${clip(input.title, 200)}`];
  const description = clip(input.description, DESCRIPTION_CHARS);
  if (description) lines.push(`Description: ${description}`);
  if (input.changedFiles.length > 0) lines.push(`Files changed: ${input.changedFiles.slice(0, CHANGED_FILES_SHOWN).join(', ')}`);
  // Only when there are any, so a task with no commits keeps the hash (and
  // the summary) it had before commits were part of the input.
  if (input.commits.length > 0) {
    lines.push(`Commits: ${input.commits.slice(0, COMMITS_SHOWN).map((subject) => clip(subject, COMMIT_SUBJECT_CHARS)).join('; ')}`);
  }
  for (const message of input.closingMessages) lines.push(`A session ended: ${clip(message, CLOSING_MESSAGE_CHARS)}`);
  return lines.join('\n');
}

/** What a summary was written from: when it moves, the summary is rewritten. */
export function summaryInputHash(input: SummaryInput): string {
  return crypto.createHash('sha1').update(`v${TASK_SUMMARY_VERSION}\n${summaryInputBlock(input)}`).digest('hex');
}

/** One call's prompt: the rules, then each task under a label `D1`, `D2`, ... */
export function buildSummaryPrompt(inputs: ReadonlyArray<SummaryInput>): string {
  const tasks = inputs
    .map((input, index) => `<task label="D${index + 1}">\n${summaryInputBlock(input)}\n</task>`)
    .join('\n\n');
  return [
    'You write short summaries of finished software tasks, for search.',
    '',
    'For each task below, write one or two plain sentences: what it set out to do, and what it ended up',
    'doing, naming the parts of the product it changed. Use the words a developer would search with.',
    'No markdown, no lists, no ticket or PR numbers, no preamble. At most 300 characters each.',
    '',
    'Reply with exactly one line per task, in this form and nothing else:',
    'D1: <summary>',
    'D2: <summary>',
    '',
    tasks,
  ].join('\n');
}

const MERGED_CLAUSE = /[;,]?\s*(?:and\s+)?(?:was\s+)?(?:merged|landed|shipped)\s+(?:in|as|via)?\s*(?:\w+\s+)?(?:PR|pull request)\s*#\d+/gi;
const NUMBER_REF = /\s*\(#\d+\)|\s*#\d+/g;

/**
 * A summary without its `#N` references. The answering agent names tasks as
 * `#N`, so a PR or issue number inside a summary reads as a task it could cite.
 * The rules ask for none, and about one Sonnet summary in five still ended
 * "merged in PR #306" (40 of 210 on the real board), so the reply is cleaned
 * rather than trusted. Whether a task merged is in the facts already.
 */
export function withoutNumberRefs(text: string): string {
  return text
    .replace(MERGED_CLAUSE, '')
    .replace(NUMBER_REF, '')
    .replace(/\s+([.,;])/g, '$1')
    .replace(/[,;]+\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The summaries a reply holds, by the task's position in the batch. A label the
 * reply skipped is absent, so that task is tried again in a later batch.
 */
export function parseSummaryReply(reply: string, count: number): Map<number, string> {
  const summaries = new Map<number, string>();
  for (const line of reply.split(/\r?\n/)) {
    const match = line.match(/^\s*\**D(\d+)\**\s*[:.-]\s*(.+?)\s*$/);
    if (!match) continue;
    const position = Number(match[1]) - 1;
    if (position < 0 || position >= count || summaries.has(position)) continue;
    const summary = clip(withoutNumberRefs(match[2].replace(/^["']|["']$/g, '')), SUMMARY_MAX_CHARS);
    if (summary) summaries.set(position, summary);
  }
  return summaries;
}

/**
 * The board half of what Ask is given: every task in the project, as facts.
 *
 * Ask shipped able to read only PASSAGES, which made a whole class of question
 * unanswerable in a way that looked like a bug. Asked "what was the most
 * expensive task?", retrieval correctly returned conversations that TALK about
 * cost, the agent correctly reported that they carry no cost figures, and the
 * number was sitting on every node the whole time. The excerpts answer "what did
 * we say"; this answers "what is true of the work".
 *
 * Three properties are load-bearing.
 *
 * FULL COVERAGE, not a retrieved subset. Every task is here on every question,
 * because "which tasks are X" cannot be answered from a sample - an agent shown
 * 24 of 347 tasks will confidently answer about 24. This is what makes
 * superlatives ("most expensive"), counts, and exhaustive selections correct
 * rather than plausible.
 *
 * TASKS, not conversations. A task runs several sessions and the user asks about
 * tasks, so cost and duration are SUMMED per task. Measured on the real corpus,
 * this is not cosmetic: the priciest single conversation is $155.80, while the
 * priciest task is $308.42 across four sessions - answering per-conversation
 * gets the wrong row, not just a smaller number.
 *
 * ARITHMETIC IS DONE HERE, never asked of the model. Handing it 347 rows and
 * asking for a sum invites errors that read as authoritative, so the totals,
 * the rankings, and the date windows are computed and the agent is left the
 * judgement it is actually good at: which rows the question is about.
 *
 * Pure, so the shape can be measured against real distributions without a
 * database or a CLI.
 */

import type { MemoryGraphNode, MemoryGraphProjection } from '../../shared/types';

/**
 * Tasks the table may carry.
 *
 * Measured on the real 669-conversation index: 347 tasks render to ~15k tokens,
 * which sits comfortably beside the 12k passage budget in one prompt. The cap
 * is set well above that so a corpus twice this size still gets full coverage,
 * and the caller REPORTS a truncation rather than silently answering from part
 * of the board - a hidden truncation would turn "every task" into a lie in
 * exactly the questions that depend on it.
 */
export const MAX_TASK_ROWS = 1_200;

/** A task's rolled-up facts, as the prompt will state them. */
export interface AnswerTaskRow {
  taskId: string | null;
  title: string;
  /** Sessions this task ran. Part of why its cost is what it is. */
  sessions: number;
  costUsd: number | null;
  durationMs: number | null;
  tokens: number | null;
  outcome: 'done' | 'abandoned' | 'active' | null;
  /** Most recent activity across the task's sessions, epoch ms. */
  lastActivityMs: number | null;
  /** Region label at the granularity the user is looking at. */
  region: string | null;
  agent: string | null;
  model: string | null;
}

export interface AnswerTaskTable {
  rows: ReadonlyArray<AnswerTaskRow>;
  /** Tasks that did not fit `MAX_TASK_ROWS`. Stated, never hidden. */
  droppedTasks: number;
  /** Conversations behind the rows, which is not the same number. */
  conversationCount: number;
  /** Oldest and newest activity, so a relative window has an anchor. */
  earliestMs: number | null;
  latestMs: number | null;
}

/** Adds a nullable metric without turning "never recorded" into zero. */
function addMetric(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return (current ?? 0) + next;
}

/**
 * Roll conversations up into tasks.
 *
 * Conversations with no task each stay their own row rather than being merged
 * into one bucket: they are real work, and a `no-task` row holding forty
 * unrelated conversations would be a row about nothing. Ranked by cost so a
 * truncation drops the cheapest rather than an arbitrary slice, since the
 * expensive tail is what superlative questions are about.
 */
export function buildAnswerTaskTable(
  projection: MemoryGraphProjection,
  granularity: string,
): AnswerTaskTable {
  const clustering = projection.clusterings.find((entry) => entry.granularity === granularity)
    ?? projection.clusterings[0];
  const regionLabel = (node: MemoryGraphNode): string | null => {
    if (!clustering) return null;
    const regionIndex = node.clusters[clustering.granularity];
    return clustering.regions[regionIndex]?.label ?? null;
  };

  const byTask = new Map<string, AnswerTaskRow>();
  let earliestMs: number | null = null;
  let latestMs: number | null = null;

  for (const node of projection.nodes) {
    if (node.lastActivityMs !== null) {
      if (earliestMs === null || node.lastActivityMs < earliestMs) earliestMs = node.lastActivityMs;
      if (latestMs === null || node.lastActivityMs > latestMs) latestMs = node.lastActivityMs;
    }

    // A conversation with no task keys on its own docKey, so it stays distinct.
    const key = node.taskId ?? `conversation:${node.docKey}`;
    const existing = byTask.get(key);
    if (!existing) {
      byTask.set(key, {
        taskId: node.taskId,
        title: node.title ?? 'Untitled',
        sessions: 1,
        costUsd: node.costUsd,
        durationMs: node.durationMs,
        tokens: node.tokens,
        outcome: node.outcome,
        lastActivityMs: node.lastActivityMs,
        region: regionLabel(node),
        agent: node.agent,
        model: node.model,
      });
      continue;
    }

    existing.sessions += 1;
    existing.costUsd = addMetric(existing.costUsd, node.costUsd);
    existing.durationMs = addMetric(existing.durationMs, node.durationMs);
    existing.tokens = addMetric(existing.tokens, node.tokens);
    // The task's own recency is its most recent session.
    if (node.lastActivityMs !== null
      && (existing.lastActivityMs === null || node.lastActivityMs > existing.lastActivityMs)) {
      existing.lastActivityMs = node.lastActivityMs;
      // The model that ran most recently is the one worth naming.
      existing.model = node.model;
      existing.agent = node.agent;
    }
    // An outcome is a property of the TASK, so any session that knows it is
    // authoritative over a sibling that does not.
    if (existing.outcome === null) existing.outcome = node.outcome;
    if (existing.region === null) existing.region = regionLabel(node);
  }

  const all = [...byTask.values()].sort((left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0));
  return {
    rows: all.slice(0, MAX_TASK_ROWS),
    droppedTasks: Math.max(0, all.length - MAX_TASK_ROWS),
    conversationCount: projection.nodes.length,
    earliestMs,
    latestMs,
  };
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

function formatDate(ms: number | null): string {
  if (ms === null) return '';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/**
 * The table as the prompt carries it.
 *
 * Pipe-delimited with a header rather than JSON: same information, roughly half
 * the tokens, and a model reads a column layout at least as well. Cost is to the
 * cent because these are real amounts someone may reconcile against a bill.
 *
 * Every row is numbered `T<n>` so an answer can name a task the same way it
 * cites an excerpt, and the renderer can map a mentioned task back onto the map.
 */
export function formatTaskTable(table: AnswerTaskTable): string {
  const header = 'ref|task|sessions|cost_usd|duration|tokens|outcome|last_active|region|agent|model';
  const rows = table.rows.map((row, index) => [
    `T${index + 1}`,
    // The pipe is the delimiter, so a title carrying one would shift a column.
    row.title.replace(/\|/g, '/'),
    String(row.sessions),
    row.costUsd === null ? '' : row.costUsd.toFixed(2),
    formatDuration(row.durationMs),
    formatTokens(row.tokens),
    row.outcome ?? '',
    formatDate(row.lastActivityMs),
    row.region ?? '',
    row.agent ?? '',
    row.model ?? '',
  ].join('|'));
  return [header, ...rows].join('\n');
}

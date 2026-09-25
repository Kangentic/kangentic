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
import type { MemoryTaskFacts, MemoryTaskField } from '../../shared/memory-task-fields';
import { constantFields, MEMORY_TASK_FIELDS } from '../../shared/memory-task-fields';

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

/**
 * A task's rolled-up facts, as the prompt will state them.
 *
 * The facts themselves come from `MemoryTaskFacts`, which the wire payload
 * extends too - so a field cannot reach the prompt without also reaching the
 * renderer. Only the two things the CATALOG has no business knowing are
 * declared here: which task this is, and what it is called.
 */
export interface AnswerTaskRow extends MemoryTaskFacts {
  taskId: string | null;
  title: string;
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
 * unrelated conversations would be a row about nothing.
 *
 * The cost sort is a TRUNCATION POLICY and nothing else: when a corpus exceeds
 * `MAX_TASK_ROWS` the cheapest tasks are the right ones to drop, because the
 * expensive tail is what superlative questions are about. It is emphatically
 * not a display order. It used to double as one by accident - rows are numbered
 * AFTER this sort, so `T14` means "the 14th most expensive task" and ordering
 * the rail by ref was ordering it by cost. That looked correct for exactly one
 * question. Display order now comes from the answer's own view spec.
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
        displayId: node.displayId,
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
    if (existing.displayId === null) existing.displayId = node.displayId;
    if (existing.region === null) existing.region = regionLabel(node);
  }

  // Truncation order only - see the note above. `?? 0` is correct HERE, unlike
  // everywhere else in this file: a task with no recorded cost is exactly the
  // one to drop first when the board does not fit.
  const all = [...byTask.values()].sort((left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0));
  return {
    rows: all.slice(0, MAX_TASK_ROWS),
    droppedTasks: Math.max(0, all.length - MAX_TASK_ROWS),
    conversationCount: projection.nodes.length,
    earliestMs,
    latestMs,
  };
}

/**
 * The table as the prompt carries it.
 *
 * Pipe-delimited with a header rather than JSON: same information, roughly half
 * the tokens, and a model reads a column layout at least as well.
 *
 * GENERATED from the field catalog rather than hand-written. The header used to
 * be a string literal beside eleven hand-written cell expressions, which is
 * three places to keep in step with the wire payload and the rows - and they
 * did not stay in step, which is why an answer could rank tasks by tokens above
 * rows printing dollars. Adding a column is now one catalog entry.
 *
 * Every row is numbered `T<n>` so an answer can name a task the same way it
 * cites an excerpt, and the renderer can map a mentioned task back onto the map.
 * That ref, not the ticket, stays the agent's vocabulary for REFERRING to a
 * task: it is a position in this list, which is what makes it resolvable.
 */
export function formatTaskTable(table: AnswerTaskTable): string {
  // A field that never varies is stated once in the summary instead of on every
  // row. Measured: `agent` is one distinct value across 350 tasks, so this
  // column alone was 4,200 characters of "Claude Code".
  const collapsed = new Set(constantFields(table.rows).map((field) => field.key));
  const columns = MEMORY_TASK_FIELDS.filter((field) => !collapsed.has(field.key));

  const header = ['ref', 'task', ...columns.map((field) => field.key)].join('|');
  const rows = table.rows.map((row, index) => [
    `T${index + 1}`,
    // The pipe is the delimiter, so a title carrying one would shift a column.
    row.title.replace(/\|/g, '/'),
    ...columns.map((field) => field.cell(row)),
  ].join('|'));
  return [header, ...rows].join('\n');
}

/** Sums a nullable metric, keeping "never recorded" out of the total. */
function sumOf(rows: ReadonlyArray<AnswerTaskRow>, field: MemoryTaskField): number | null {
  let total: number | null = null;
  for (const row of rows) {
    const value = field.sortValue(row);
    if (value === null) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/** Rows tied at the top of a measure, as refs. Ties are the norm on counts. */
function topRefs(
  rows: ReadonlyArray<AnswerTaskRow>,
  field: MemoryTaskField,
  limit: number,
): string {
  const ranked = rows
    .map((row, index) => ({ ref: index + 1, value: field.sortValue(row) }))
    .filter((entry) => entry.value !== null)
    .sort((left, right) => (right.value ?? 0) - (left.value ?? 0))
    .slice(0, limit);
  return ranked.map((entry) => `T${entry.ref}`).join(' ');
}

/**
 * The arithmetic, done here so the agent never has to do it.
 *
 * Measured failure this exists for: asked what every task had cost, the agent
 * summed 350 rows and answered **$14,860.99** against a true $17,117.60 - a 13%
 * error, stated with complete confidence and indistinguishable from a right
 * answer. The totals were already computed in this file and thrown away; the
 * prompt handed over the rows and asked for them back.
 *
 * It also carries the ranking heads, so a superlative is a lookup rather than a
 * scan of every row, and the values of any field that never varies, which is
 * what lets those columns leave the table entirely.
 *
 * Roughly 500 characters. It replaces several thousand and one wrong number.
 */
export function summarizeTaskTable(table: AnswerTaskTable): string {
  const rows = table.rows;
  if (rows.length === 0) return 'No tasks are indexed for this project.';

  const lines: string[] = [`tasks: ${rows.length}`];
  const collapsed = new Set(constantFields(rows).map((field) => field.key));

  for (const field of MEMORY_TASK_FIELDS) {
    if (field.key === 'ticket') continue;

    // A field that never varies: one line, and the column is gone from below.
    if (collapsed.has(field.key)) {
      lines.push(`${field.key}: ${field.cell(rows[0]) || '(none)'} for all ${rows.length}`);
      continue;
    }

    if (field.kind === 'measure' || field.kind === 'time') {
      const parts: string[] = [];
      // A total is meaningless for a date and for an id-like measure, so only
      // things that genuinely add up report one.
      if (field.kind === 'measure') {
        const total = sumOf(rows, field);
        if (total !== null) parts.push(`total ${field.cell({ ...rows[0], ...totalAs(field, total) })}`);
      }
      const head = topRefs(rows, field, 5);
      if (head) parts.push(`highest first ${head}`);
      if (parts.length > 0) lines.push(`${field.key}: ${parts.join(', ')}`);
      continue;
    }

    // A dimension: how the corpus is distributed, most common first, and the
    // rare values named by ref so a selection question can find them without
    // reading 350 rows.
    const counts = new Map<string, number[]>();
    rows.forEach((row, index) => {
      const value = field.cell(row) || '(none)';
      const refs = counts.get(value) ?? [];
      refs.push(index + 1);
      counts.set(value, refs);
    });
    const ordered = [...counts.entries()].sort((left, right) => right[1].length - left[1].length);
    const rendered = ordered.slice(0, 6).map(([value, refs]) => (
      // Fewer than five rows carry it, so naming them costs less than leaving
      // the reader to scan - and it is exactly the "which tasks are X" case.
      refs.length <= 4 ? `${value} (${refs.map((ref) => `T${ref}`).join(' ')})` : `${value} ${refs.length}`
    ));
    if (ordered.length > 6) rendered.push(`+${ordered.length - 6} more`);
    lines.push(`${field.key}: ${rendered.join(', ')}`);
  }
  return lines.join('\n');
}

/** Renders a computed total through the field's own formatter. */
function totalAs(field: MemoryTaskField, total: number): Partial<MemoryTaskFacts> {
  switch (field.key) {
    case 'cost_usd': return { costUsd: total };
    case 'duration': return { durationMs: total };
    case 'tokens': return { tokens: total };
    case 'sessions': return { sessions: total };
    default: return {};
  }
}

/**
 * The glossary that goes above the table.
 *
 * Each column explains itself in one line, which Cube calls `ai_context` and
 * its docs name as the thing that decides answer quality. Generated, so a new
 * column cannot arrive undocumented.
 */
export function formatTaskFieldGlossary(): string {
  return MEMORY_TASK_FIELDS.map((field) => `${field.key} - ${field.describe}`).join('\n');
}

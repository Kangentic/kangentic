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

import type { KnowledgeGraphNode, KnowledgeGraphProjection } from '../../shared/types';
import type { KnowledgeGraphTaskFacts, KnowledgeGraphTaskField } from '../../shared/knowledge-graph-task-fields';
import { constantFields, KNOWLEDGE_GRAPH_TASK_FIELDS } from '../../shared/knowledge-graph-task-fields';

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
 * The facts themselves come from `KnowledgeGraphTaskFacts`, which the wire payload
 * extends too - so a field cannot reach the prompt without also reaching the
 * renderer. Only the two things the CATALOG has no business knowing are
 * declared here: which task this is, and what it is called.
 */
export interface AnswerTaskRow extends KnowledgeGraphTaskFacts {
  taskId: string | null;
  title: string;
  /** The task id, or `conversation:<docKey>` for a conversation with no task:
   *  the same key the related-work rollup uses, so the two join. */
  key: string;
  /** The task's conversations in scope, so an answer row can light and open them. */
  docKeys: string[];
  /** Set on every row of a table merged across projects. */
  projectId?: string;
  /**
   * The short project name a ticket from another project leads with, so
   * `mobile#88` and the open project's `#88` stay two tasks. Absent on the open
   * project's rows, and on every row of a single-project table.
   */
  refPrefix?: string;
}

/** One project of a table merged across projects, as the summary names it. */
export interface AnswerTableProject {
  name: string;
  /** What its tickets lead with, or null when they stand bare. */
  refPrefix: string | null;
}

export interface AnswerTaskTable {
  rows: ReadonlyArray<AnswerTaskRow>;
  /** Tasks that did not fit `MAX_TASK_ROWS`. Stated, never hidden. */
  droppedTasks: number;
  /** Conversations behind the rows, which is not the same number. */
  conversationCount: number;
  /** True when the map's filters narrowed the table, so the prompt can say so. */
  scoped: boolean;
  /** Oldest and newest activity, so a relative window has an anchor. */
  earliestMs: number | null;
  latestMs: number | null;
  /** The projects behind a merged table. Absent on a single-project one. */
  projects?: ReadonlyArray<AnswerTableProject>;
}

/**
 * A board task as the board records it, conversations or not.
 *
 * The table was built from indexed conversations alone, so a task whose
 * conversations were never indexed (an old task, a pruned transcript) was
 * missing from a table the prompt calls complete. On this project that hid four
 * of the tasks that added an agent. These fill it in.
 */
export interface BoardTaskFacts extends Omit<KnowledgeGraphTaskFacts, 'region'> {
  taskId: string;
  title: string;
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
  projection: Pick<KnowledgeGraphProjection, 'nodes' | 'clusterings'>,
  granularity: string,
  /**
   * The conversations inside the map's filters, or null for all of them. The
   * filters are the scope of a question, so "the most expensive task" under an
   * Open filter ranks only the open ones.
   */
  scopeDocKeys: ReadonlySet<string> | null = null,
  /**
   * Every board task, so one with no indexed conversation still has a row.
   * Only when unscoped: the filters select conversations, and a task with none
   * cannot be inside them.
   */
  boardTasks: ReadonlyArray<BoardTaskFacts> = [],
): AnswerTaskTable {
  const clustering = projection.clusterings.find((entry) => entry.granularity === granularity)
    ?? projection.clusterings[0];
  // By region id: `regions` is ordered largest first, so a position is not an id.
  const labelsByRegionId = new Map((clustering?.regions ?? []).map((region) => [region.id, region.label]));
  const regionLabel = (node: KnowledgeGraphNode): string | null => {
    if (!clustering) return null;
    return labelsByRegionId.get(node.clusters[clustering.granularity]) ?? null;
  };

  const byTask = new Map<string, AnswerTaskRow>();
  let earliestMs: number | null = null;
  let latestMs: number | null = null;

  let conversationCount = 0;
  for (const node of projection.nodes) {
    if (scopeDocKeys && !scopeDocKeys.has(node.docKey)) continue;
    conversationCount += 1;
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
        key,
        docKeys: [node.docKey],
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
        // Task-level facts, filled from the board below.
        filesChanged: null,
        linesAdded: null,
        linesRemoved: null,
        prNumber: null,
        prState: null,
      });
      continue;
    }

    existing.sessions += 1;
    existing.docKeys.push(node.docKey);
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

  // Churn and the linked pull request belong to the TASK, not to any one
  // conversation, so every row takes them from the board's own record, scoped
  // or not.
  const boardByTask = new Map(boardTasks.map((task) => [task.taskId, task]));
  for (const row of byTask.values()) {
    const board = row.taskId ? boardByTask.get(row.taskId) : undefined;
    if (!board) continue;
    row.filesChanged = board.filesChanged;
    row.linesAdded = board.linesAdded;
    row.linesRemoved = board.linesRemoved;
    row.prNumber = board.prNumber;
    row.prState = board.prState;
  }

  if (!scopeDocKeys) {
    for (const task of boardTasks) {
      if (byTask.has(task.taskId)) continue;
      byTask.set(task.taskId, { ...task, key: task.taskId, docKeys: [], region: null });
      if (task.lastActivityMs !== null) {
        if (earliestMs === null || task.lastActivityMs < earliestMs) earliestMs = task.lastActivityMs;
        if (latestMs === null || task.lastActivityMs > latestMs) latestMs = task.lastActivityMs;
      }
    }
  }

  // Truncation order only - see the note above. `?? 0` is correct HERE, unlike
  // everywhere else in this file: a task with no recorded cost is exactly the
  // one to drop first when the board does not fit.
  const all = [...byTask.values()].sort((left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0));
  return {
    rows: all.slice(0, MAX_TASK_ROWS),
    droppedTasks: Math.max(0, all.length - MAX_TASK_ROWS),
    conversationCount,
    scoped: scopeDocKeys !== null,
    earliestMs,
    latestMs,
  };
}

/**
 * How the prompt names a task: its board ticket, `#561`, which is the mark the
 * chat renders and the number the user already knows from a card. A
 * conversation with no board task has no ticket, so it gets `C<n>`, its
 * position in the table.
 *
 * Tickets replaced `T<n>` positions. A position was resolvable but meant
 * nothing to a reader, so every answer had to be rewritten before it could be
 * shown, and a `T14` quoted in prose was a different number from the `#561`
 * on the row beneath it.
 */
export function taskRef(row: Pick<AnswerTaskRow, 'displayId' | 'refPrefix'>, index: number): string {
  return row.displayId != null ? `${row.refPrefix ?? ''}#${row.displayId}` : `C${index + 1}`;
}

/**
 * The short name a project's tickets lead with in a question asked across
 * projects: its name lowercased, with every run of other characters one dash.
 * `taken` holds the prefixes already given out, so two projects whose names
 * reduce alike still get distinct ones.
 *
 * Never ends in a dash, which `parseAnswerRefs` relies on: "tasks-#561" stays
 * the bare ticket it always was.
 */
export function refPrefixFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
    || 'project';
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** One project's table, and what its tickets lead with in the merged one. */
export interface AnswerTablePart {
  table: AnswerTaskTable;
  projectId: string;
  name: string;
  refPrefix: string | null;
}

/**
 * One table from several projects' tables, for a question asked across them.
 *
 * Every row keeps its own project's facts and gets its project's prefix, so a
 * ticket number that repeats between projects names one task. The truncation
 * rule is the single-project one, applied to the union: cheapest dropped first,
 * and the count stated.
 */
export function mergeAnswerTaskTables(parts: ReadonlyArray<AnswerTablePart>): AnswerTaskTable {
  const rows: AnswerTaskRow[] = [];
  let droppedTasks = 0;
  let conversationCount = 0;
  let earliestMs: number | null = null;
  let latestMs: number | null = null;
  for (const part of parts) {
    for (const row of part.table.rows) {
      rows.push({ ...row, projectId: part.projectId, ...(part.refPrefix ? { refPrefix: part.refPrefix } : {}) });
    }
    droppedTasks += part.table.droppedTasks;
    conversationCount += part.table.conversationCount;
    const { earliestMs: partEarliest, latestMs: partLatest } = part.table;
    if (partEarliest !== null && (earliestMs === null || partEarliest < earliestMs)) earliestMs = partEarliest;
    if (partLatest !== null && (latestMs === null || partLatest > latestMs)) latestMs = partLatest;
  }
  rows.sort((left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0));
  return {
    rows: rows.slice(0, MAX_TASK_ROWS),
    droppedTasks: droppedTasks + Math.max(0, rows.length - MAX_TASK_ROWS),
    conversationCount,
    scoped: parts.some((part) => part.table.scoped),
    earliestMs,
    latestMs,
    projects: parts.map((part) => ({ name: part.name, refPrefix: part.refPrefix })),
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
 * Every row leads with its ref (`taskRef`), so an answer names a task the way
 * the chat renders it and the renderer can map it back onto the map. The ticket
 * column is dropped as a separate field, since the ref already is the ticket.
 */
export function formatTaskTable(table: AnswerTaskTable): string {
  // A field that never varies is stated once in the summary instead of on every
  // row. Measured: `agent` is one distinct value across 350 tasks, so this
  // column alone was 4,200 characters of "Claude Code".
  const collapsed = new Set(constantFields(table.rows).map((field) => field.key));
  const columns = KNOWLEDGE_GRAPH_TASK_FIELDS.filter((field) => !collapsed.has(field.key) && field.key !== 'ticket');

  const header = ['ref', 'task', ...columns.map((field) => field.key)].join('|');
  const rows = table.rows.map((row, index) => [
    taskRef(row, index),
    // The pipe is the delimiter, so a title carrying one would shift a column,
    // and a newline would start a row of its own.
    row.title.replace(/\s+/g, ' ').replace(/\|/g, '/'),
    ...columns.map((field) => field.cell(row)),
  ].join('|'));
  return [header, ...rows].join('\n');
}

/** Sums a nullable metric, keeping "never recorded" out of the total. */
function sumOf(rows: ReadonlyArray<AnswerTaskRow>, field: KnowledgeGraphTaskField): number | null {
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
  field: KnowledgeGraphTaskField,
  limit: number,
): string {
  const ranked = rows
    .map((row, index) => ({ ref: taskRef(row, index), value: field.sortValue(row) }))
    .filter((entry) => entry.value !== null)
    .sort((left, right) => (right.value ?? 0) - (left.value ?? 0))
    .slice(0, limit);
  return ranked.map((entry) => entry.ref).join(' ');
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
  const projectsLine = summarizeProjects(table);
  if (projectsLine) lines.push(projectsLine);
  const collapsed = new Set(constantFields(rows).map((field) => field.key));

  for (const field of KNOWLEDGE_GRAPH_TASK_FIELDS) {
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
    const counts = new Map<string, string[]>();
    rows.forEach((row, index) => {
      const value = field.cell(row) || '(none)';
      const refs = counts.get(value) ?? [];
      refs.push(taskRef(row, index));
      counts.set(value, refs);
    });
    const ordered = [...counts.entries()].sort((left, right) => right[1].length - left[1].length);
    const rendered = ordered.slice(0, 6).map(([value, refs]) => (
      // Fewer than five rows carry it, so naming them costs less than leaving
      // the reader to scan - and it is exactly the "which tasks are X" case.
      refs.length <= 4 ? `${value} (${refs.join(' ')})` : `${value} ${refs.length}`
    ));
    if (ordered.length > 6) rendered.push(`+${ordered.length - 6} more`);
    lines.push(`${field.key}: ${rendered.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Each project of a merged table: how many tasks and what they cost, and how
 * its tickets are written. So "which project cost the most" is a read, and the
 * agent learns each prefix before it meets one in the table.
 */
function summarizeProjects(table: AnswerTaskTable): string | null {
  const projects = table.projects;
  if (!projects || projects.length < 2) return null;
  const costField = KNOWLEDGE_GRAPH_TASK_FIELDS.find((field) => field.key === 'cost_usd');
  const byPrefix = new Map<string, { tasks: number; cost: number | null }>();
  for (const row of table.rows) {
    const prefix = row.refPrefix ?? '';
    const entry = byPrefix.get(prefix) ?? { tasks: 0, cost: null };
    entry.tasks += 1;
    entry.cost = addMetric(entry.cost, row.costUsd);
    byPrefix.set(prefix, entry);
  }
  const parts = projects.map((project) => {
    const entry = byPrefix.get(project.refPrefix ?? '');
    const cost = entry?.cost != null && costField && table.rows[0]
      ? ` cost_usd ${costField.cell({ ...table.rows[0], costUsd: entry.cost })}`
      : '';
    return `${project.name} ${entry?.tasks ?? 0} tasks${cost}, written ${project.refPrefix ?? ''}#N`;
  });
  return `projects: ${parts.join('; ')}`;
}

/** Renders a computed total through the field's own formatter. */
function totalAs(field: KnowledgeGraphTaskField, total: number): Partial<KnowledgeGraphTaskFacts> {
  switch (field.key) {
    case 'cost_usd': return { costUsd: total };
    case 'duration': return { durationMs: total };
    case 'tokens': return { tokens: total };
    case 'sessions': return { sessions: total };
    case 'files': return { filesChanged: total };
    case 'lines_added': return { linesAdded: total };
    case 'lines_removed': return { linesRemoved: total };
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
export function formatTaskFieldGlossary(table?: AnswerTaskTable): string {
  // The ticket is the ref column now, so it is described as the ref.
  return [
    `ref - ${describeRef(table)} `
      + 'C1, C2 and so on are conversations with no board task.',
    ...KNOWLEDGE_GRAPH_TASK_FIELDS
      .filter((field) => field.key !== 'ticket')
      .map((field) => `${field.key} - ${field.describe}`),
  ].join('\n');
}

/** The ref column's line: bare tickets, and the project prefix when the table spans projects. */
function describeRef(table: AnswerTaskTable | undefined): string {
  const prefixes = (table?.projects ?? []).flatMap((project) => (project.refPrefix ? [project.refPrefix] : []));
  if (prefixes.length === 0) return 'the task\'s board ticket, written #529, which is how to name a task in the answer.';
  const hasBare = table?.projects?.some((project) => !project.refPrefix) ?? false;
  const written = prefixes.length > 1 ? `${prefixes[0]}#529 or ${prefixes[1]}#88` : `${prefixes[0]}#88`;
  return (hasBare ? 'the task\'s board ticket, written #529 for the open project. A task from another project' : 'the task\'s board ticket. Every task')
    + ` leads with its project's short name, written ${written}. Ticket numbers repeat between projects,`
    + ' so always write the ref whole: it is how to name a task in the answer.';
}

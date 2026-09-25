/**
 * The facts a task carries, declared once and consumed everywhere.
 *
 * Ask shipped able to answer exactly one question. Four places independently
 * hardcoded that question: the table builder sorted by cost, the table
 * formatter hand-wrote an eleven-column header, the wire payload carried four
 * of those eleven, and the rail hand-wrote those four as chips in a fixed
 * order. Eleven columns went in and four came out, so asking which tasks used
 * the most TOKENS produced prose naming a token figure above rows printing
 * dollar amounts, and asking about recency produced no date anywhere.
 *
 * Adding a second kind of question meant editing four files that had to agree.
 * This module is the fix: one declaration per field, and the prompt table, the
 * vocabulary handed to the agent, the ordering and the rendered rows are all
 * generated from it. Adding a field is one entry here plus one property on
 * `MemoryTaskFacts`, and the typechecker makes every producer fill it.
 *
 * The shape follows a semantic layer (Cube), which is the settled answer to
 * letting a model query a fixed schema without a template per question. Two
 * things carry over: a query is DATA validated against a catalog rather than
 * free-form, and every field carries its own one-line description for the agent
 * (Cube calls it `ai_context`, and its docs are explicit that the quality of
 * those descriptions is what decides the quality of the answers).
 *
 * What deliberately does NOT carry over is Cube's JSON envelope. Its producer
 * is a machine; ours is a CLI agent writing prose, and a malformed envelope
 * would cost the whole spec where a compact line degrades token by token.
 */

/**
 * Where a task's work ended up.
 *
 * The lane decides and archiving does not override it: finished work gets
 * archived once it leaves Done, so letting `archived_at` win reported 485 of
 * this board's 496 tasks as abandoned and painted the whole Outcome map one
 * grey. See the CASE in `documentMetadata`.
 */
export type MemoryTaskOutcome = 'done' | 'abandoned' | 'active';

/**
 * How an outcome reads to a person.
 *
 * These name the WORK, not the board. "Reached Done" described a board mechanic
 * and left the reader translating; on a board measuring 485 archived-and-Done
 * against 6 To Do it also made the distinction it drew invisible.
 *
 * `active` is "In Progress" rather than "Active" deliberately: `Active` already
 * means "an agent is running right now" everywhere else in this app (the
 * activity marks, the Monitor's Active tile, the sidebar counts, the
 * `--kng-active` token). A task last touched three weeks ago is not active in
 * that sense, but it is unfinished, which is what this field means.
 */
export const TASK_OUTCOME_LABELS: Record<MemoryTaskOutcome, string> = {
  done: 'Completed',
  active: 'In Progress',
  abandoned: 'Dropped',
};

/**
 * Everything known about one task, already totalled across its sessions.
 *
 * Extended by BOTH producers - `AnswerTaskRow` in the main process and
 * `MemoryAnswerTaskRef` on the wire - so a new field cannot reach the prompt
 * without also reaching the renderer, which is the drift this module exists to
 * prevent.
 *
 * Every metric is nullable and null means "never recorded", never zero. A task
 * whose sessions predate metric capture has not earned a `$0.00`.
 */
export interface MemoryTaskFacts {
  /** The board's `#N` (`tasks.display_id`). Null for a conversation with no
   *  task, and for a task predating the display_id backfill. */
  displayId: number | null;
  /** Sessions the task ran. Part of why its totals are what they are. */
  sessions: number;
  costUsd: number | null;
  durationMs: number | null;
  tokens: number | null;
  outcome: MemoryTaskOutcome | null;
  /** Most recent activity across the task's sessions, epoch ms. */
  lastActivityMs: number | null;
  /** Region label at the granularity the reader is looking at. */
  region: string | null;
  agent: string | null;
  model: string | null;
}

/**
 * The vocabulary the agent is given, and the only keys a view spec may name.
 *
 * These ARE the prompt table's column headers, so the agent reads a column and
 * writes back the same word. Anything outside this set is dropped rather than
 * guessed at.
 */
export type MemoryTaskFieldKey =
  | 'ticket'
  | 'cost_usd'
  | 'duration'
  | 'tokens'
  | 'sessions'
  | 'last_active'
  | 'outcome'
  | 'region'
  | 'agent'
  | 'model';

export interface MemoryTaskField {
  /** The prompt column header AND the wire name. One word, both directions. */
  key: MemoryTaskFieldKey;
  /** The column header in the rail. */
  label: string;
  /**
   * Cube's split, and it decides two things.
   *
   * A `measure` or `time` can ORDER the rows; a `dimension` cannot, because
   * sorting by `agent` would impose an order nobody asked for and quietly
   * claim the first row is the most something. A `time` defaults to
   * newest-first, where a measure defaults to largest-first.
   */
  kind: 'measure' | 'dimension' | 'time';
  /**
   * Whether the field may be chosen as a COLUMN.
   *
   * `ticket` is the row's identity and always renders as its badge, so
   * selecting it as a column would print the same number twice.
   */
  selectable: boolean;
  /**
   * One line telling the agent what this column means. Cube's `ai_context`.
   *
   * This is the difference between a column the agent uses correctly and one it
   * guesses at, and it is the single highest-leverage text in the prompt.
   */
  describe: string;
  /** The prompt table cell. Compact and machine-ish; empty string when the
   *  fact was never recorded, so a blank reads as absent rather than as zero. */
  cell(facts: MemoryTaskFacts): string;
  /** The rail value. Null when never recorded, so the cell is left empty rather
   *  than printing a zero the task has not earned. */
  display(facts: MemoryTaskFacts): string | null;
  /** Sort key. Null sorts LAST in either direction: an unmeasured task is not a
   *  cheap one, and floating it to the top of a cost ranking would be a lie. */
  sortValue(facts: MemoryTaskFacts): number | null;
}

// Every formatter and accessor below tests `== null`, which catches BOTH null
// and undefined. The types say these are always present and the wire does not
// have to agree: an answer in flight across a reload, a detached window's older
// payload, or a test fixture built before a field existed all arrive with holes.
// `=== null` let one through once already and printed `#undefined` at the user,
// and the same class of miss has unmounted this whole surface through
// PanelErrorBoundary twice by reaching `.toFixed()` on undefined.

/** Whole hours and minutes. Absent renders as nothing, never as `0m`. */
export function formatTaskDuration(milliseconds: number | null): string | null {
  if (milliseconds == null) return null;
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

/**
 * Compact token counts. Billions, millions, thousands, then the raw count.
 *
 * The billions tier is not hypothetical padding: a single heavy task on the
 * real index carries 1.66B tokens, and the corpus total runs to tens of
 * billions - which without this rendered as "600000M", a number nobody can
 * read at a glance and the summary is supposed to save them computing.
 */
export function formatTaskTokens(tokens: number | null): string | null {
  if (tokens == null) return null;
  if (tokens >= 1_000_000_000) return `${Math.round(tokens / 100_000_000) / 10}B`;
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/**
 * Cost to the CENT at every scale.
 *
 * Rounding above ten dollars hid whether "$41" was 41.02 or 41.98, and these
 * are real amounts someone may be reconciling against a bill.
 */
export function formatTaskCost(costUsd: number | null): string | null {
  if (costUsd == null) return null;
  return `$${costUsd.toFixed(2)}`;
}

/** ISO date for the prompt: unambiguous, and needs no locale. */
function isoDate(epochMs: number | null): string {
  if (epochMs == null) return '';
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** A short absolute date for the rail. Absolute rather than relative because
 *  these rows are compared against each other, not against now. */
function shortDate(epochMs: number | null): string | null {
  if (epochMs == null) return null;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The catalog.
 *
 * Order here is the order of the prompt table's columns, so it should read as
 * identity first, then what the work cost, then what it was.
 */
export const MEMORY_TASK_FIELDS: ReadonlyArray<MemoryTaskField> = [
  {
    key: 'ticket',
    label: 'Ticket',
    kind: 'dimension',
    // Not selectable: it is the row's badge, and a column would repeat it.
    selectable: false,
    describe: 'the board ticket number the user sees on a card, written #529. '
      + 'Use it to recognise a task the question names by number. Always refer '
      + 'back to a task by its T ref, never by its ticket.',
    cell: (facts) => (facts.displayId == null ? '' : `#${facts.displayId}`),
    display: (facts) => (facts.displayId == null ? null : `#${facts.displayId}`),
    sortValue: (facts) => facts.displayId ?? null,
  },
  {
    key: 'cost_usd',
    label: 'Cost',
    kind: 'measure',
    selectable: true,
    describe: 'total USD the task spent across every one of its sessions.',
    cell: (facts) => (facts.costUsd == null ? '' : facts.costUsd.toFixed(2)),
    display: (facts) => formatTaskCost(facts.costUsd),
    sortValue: (facts) => facts.costUsd ?? null,
  },
  {
    key: 'duration',
    label: 'Duration',
    kind: 'measure',
    selectable: true,
    describe: 'total wall time the task ran, summed across its sessions.',
    cell: (facts) => formatTaskDuration(facts.durationMs) ?? '',
    display: (facts) => formatTaskDuration(facts.durationMs),
    sortValue: (facts) => facts.durationMs ?? null,
  },
  {
    key: 'tokens',
    label: 'Tokens',
    kind: 'measure',
    selectable: true,
    describe: 'input plus output tokens across the task, as a compact count.',
    cell: (facts) => formatTaskTokens(facts.tokens) ?? '',
    display: (facts) => formatTaskTokens(facts.tokens),
    sortValue: (facts) => facts.tokens ?? null,
  },
  {
    key: 'sessions',
    label: 'Conversations',
    kind: 'measure',
    selectable: true,
    describe: 'how many separate agent conversations the task ran.',
    cell: (facts) => String(facts.sessions ?? 0),
    display: (facts) => (facts.sessions == null ? null : String(facts.sessions)),
    sortValue: (facts) => facts.sessions ?? null,
  },
  {
    key: 'last_active',
    label: 'Last active',
    kind: 'time',
    selectable: true,
    describe: 'the date of the task\'s most recent activity, as YYYY-MM-DD. '
      + 'Use this for anything about recency or a date window.',
    cell: (facts) => isoDate(facts.lastActivityMs),
    display: (facts) => shortDate(facts.lastActivityMs),
    sortValue: (facts) => facts.lastActivityMs ?? null,
  },
  {
    key: 'outcome',
    label: 'Status',
    kind: 'dimension',
    selectable: true,
    describe: 'where the work ended up: done means it reached a Done column, '
      + 'active means it is still unfinished on the board, abandoned means it '
      + 'was dropped without ever finishing.',
    cell: (facts) => facts.outcome ?? '',
    display: (facts) => (facts.outcome ? TASK_OUTCOME_LABELS[facts.outcome] : null),
    sortValue: () => null,
  },
  {
    key: 'region',
    label: 'Region',
    kind: 'dimension',
    selectable: true,
    describe: 'the labelled area of the memory map the task sits in, which is '
      + 'derived from what its conversations are about.',
    cell: (facts) => facts.region ?? '',
    display: (facts) => facts.region ?? null,
    sortValue: () => null,
  },
  {
    key: 'agent',
    label: 'Agent',
    kind: 'dimension',
    selectable: true,
    describe: 'the coding agent that ran the task\'s most recent session.',
    cell: (facts) => facts.agent ?? '',
    display: (facts) => facts.agent ?? null,
    sortValue: () => null,
  },
  {
    key: 'model',
    label: 'Model',
    kind: 'dimension',
    selectable: true,
    describe: 'the model that task\'s most recent session actually ran at.',
    cell: (facts) => facts.model ?? '',
    display: (facts) => facts.model ?? null,
    sortValue: () => null,
  },
];

const FIELD_BY_KEY = new Map(MEMORY_TASK_FIELDS.map((field) => [field.key, field]));

/**
 * What an agent might write for a column, beyond the column name itself.
 *
 * The rule names the header and models paraphrase anyway ("cost", "recency",
 * "duration_ms"). Accepting the obvious synonyms is far cheaper than losing the
 * spec, and an unrecognised word still falls through safely to the default.
 */
const FIELD_KEY_ALIASES: Record<string, MemoryTaskFieldKey> = {
  ticket: 'ticket', display_id: 'ticket', number: 'ticket', task_number: 'ticket',
  cost: 'cost_usd', cost_usd: 'cost_usd', spend: 'cost_usd', price: 'cost_usd', usd: 'cost_usd',
  duration: 'duration', duration_ms: 'duration', time: 'duration', elapsed: 'duration',
  runtime: 'duration', wall_time: 'duration', hours: 'duration',
  tokens: 'tokens', token: 'tokens', token_count: 'tokens',
  sessions: 'sessions', conversations: 'sessions', session_count: 'sessions',
  last_active: 'last_active', last_activity: 'last_active', recency: 'last_active',
  activity: 'last_active', date: 'last_active', last_used: 'last_active', updated: 'last_active',
  outcome: 'outcome', status: 'outcome', state: 'outcome',
  region: 'region', topic: 'region', area: 'region',
  agent: 'agent',
  model: 'model',
};

/** Resolve a written key to a field, or null when it names none. */
export function resolveTaskField(written: string | null | undefined): MemoryTaskField | null {
  if (!written) return null;
  const normalized = written
    .trim()
    .toLowerCase()
    // Trailing prose ("cost_usd."), and spaces where the header has underscores.
    .replace(/[^a-z0-9_ ]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
  const key = FIELD_KEY_ALIASES[normalized];
  return key ? FIELD_BY_KEY.get(key) ?? null : null;
}

/** Look a field up by its exact key. */
export function taskFieldByKey(key: MemoryTaskFieldKey): MemoryTaskField | null {
  return FIELD_BY_KEY.get(key) ?? null;
}

/**
 * What the rows show when the answer said nothing about how to show them.
 *
 * These are the four the surface shipped with, so an answer that declines the
 * protocol renders exactly what it renders today. `sessions` is deliberately
 * absent: a row is one TASK, and how many conversations it ran is the map's
 * unit, surfaced when the reader drills into the task rather than on the row.
 */
export const DEFAULT_TASK_FIELD_KEYS: ReadonlyArray<MemoryTaskFieldKey> = [
  'cost_usd',
  'duration',
  'outcome',
];

/** Columns a task row will ever render at once, before it stops being scannable. */
export const MAX_TASK_COLUMNS = 4;

/** One field the rows are ordered by, and which way. */
export interface MemoryTaskOrder {
  key: MemoryTaskFieldKey;
  direction: 'asc' | 'desc';
}

/** How the rows should be presented, as the answer asked for them. */
export interface MemoryTaskView {
  /** Columns, in display order. Never longer than `MAX_TASK_COLUMNS`. */
  select: MemoryTaskFieldKey[];
  /** Null when the answer named no orderable field, which means the rows keep
   *  the order the answer named them in. */
  order: MemoryTaskOrder | null;
}

export const DEFAULT_TASK_VIEW: MemoryTaskView = {
  select: [...DEFAULT_TASK_FIELD_KEYS],
  order: null,
};

/**
 * Order rows by a field, nulls last in BOTH directions.
 *
 * Nulls last is the whole point: an unmeasured task is not a cheap one, and
 * "cheapest first" must not open with every task that never recorded a cost.
 */
export function compareByField(
  field: MemoryTaskField,
  direction: 'asc' | 'desc',
): (left: MemoryTaskFacts, right: MemoryTaskFacts) => number {
  return (left, right) => {
    const leftValue = field.sortValue(left);
    const rightValue = field.sortValue(right);
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return direction === 'asc' ? leftValue - rightValue : rightValue - leftValue;
  };
}

/**
 * Fields whose value is IDENTICAL on every row.
 *
 * Measured on the real 350-task index: `agent` has exactly one distinct value,
 * so the prompt was spending 4,200 characters saying "Claude Code" three
 * hundred and fifty times. A column that never varies carries no per-row
 * information by definition - it is a fact about the corpus, and belongs in one
 * summary line rather than in every row.
 *
 * Same rule `visibleTaskColumns` applies to the rendered columns, one layer
 * earlier. Stating it once here is what keeps the two from drifting into
 * different opinions about what "carries no signal" means.
 */
export function constantFields(
  rows: ReadonlyArray<MemoryTaskFacts>,
): MemoryTaskField[] {
  if (rows.length < 2) return [];
  return MEMORY_TASK_FIELDS.filter((field) => {
    // Identity is never collapsed however uniform it looks: `ref` and `ticket`
    // are how a row is NAMED, and a summary line cannot replace them.
    if (field.key === 'ticket') return false;
    const first = field.cell(rows[0]);
    return rows.every((row) => field.cell(row) === first);
  });
}

/**
 * The columns actually worth rendering for a set of rows.
 *
 * A column whose every value is identical carries no signal: eighteen rows all
 * reading "Completed" spend width to say nothing. This is the rule the
 * Unconnected toggle, the dead facet rows and the granularity control already
 * follow, applied one level down.
 *
 * The ORDERED field is exempt, and that exemption is load-bearing: asked which
 * tasks are still in progress, every row is "In Progress" and dropping the
 * column would remove the one that answers the question.
 */
export function visibleTaskColumns(
  view: MemoryTaskView,
  rows: ReadonlyArray<MemoryTaskFacts>,
): MemoryTaskField[] {
  const columns: MemoryTaskField[] = [];
  for (const key of view.select) {
    const field = FIELD_BY_KEY.get(key);
    if (!field || !field.selectable) continue;
    if (key !== view.order?.key) {
      const values = rows.map((row) => field.display(row));
      const everyValueAbsent = values.every((value) => value === null);
      const everyValueEqual = values.length > 1
        && values.every((value) => value === values[0]);
      if (everyValueAbsent || everyValueEqual) continue;
    }
    columns.push(field);
    if (columns.length >= MAX_TASK_COLUMNS) break;
  }
  return columns;
}

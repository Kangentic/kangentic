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
 * glossary handed to the agent and the table's summary are all generated
 * from it. Adding a field is one entry here plus one property on
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
 * Where a task's work ended up: done (in a Done lane, or archived, which only
 * moving to Done does) or active (still open on the board).
 *
 * There is no third value. An "abandoned" one (archived without reaching Done)
 * shipped first, but `archive()` has exactly one caller, the move into Done, so
 * it matched no task on any real board (0 of 673 here, 0 of 73 on another) and
 * named a state the app never reaches. See the CASE in `documentMetadata`.
 */
export type MemoryTaskOutcome = 'done' | 'active';

/**
 * How a status reads to a person: the board's own words.
 *
 * "Done" is the Done column's name, and "Open" is everything still on the board.
 * The Knowledge Graph once said "Finished" and "Still open" on the map,
 * "Completed" and "In Progress" in an answer's rows, and "Dropped" for a state
 * that never happens, three vocabularies for one field. The map, its filter and
 * the rows all read these.
 *
 * `active` is "Open" rather than "Active" deliberately: `Active` already means
 * "an agent is running right now" everywhere else in this app (the activity
 * marks, the Monitor's Active tile, the sidebar counts, the `--kng-active`
 * token). A task last touched three weeks ago is not active in that sense, but
 * it is open, which is what this field means.
 */
export const TASK_OUTCOME_LABELS: Record<MemoryTaskOutcome, string> = {
  done: 'Done',
  active: 'Open',
};

/**
 * Everything known about one task, already totalled across its sessions.
 *
 * Extended by `AnswerTaskRow` in the main process.
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
  /**
   * What the task's branch changed against its base, from git when the task
   * last finalized (`captureGitChurn`). Recorded per TASK, not per conversation,
   * so these come from the board's own rows.
   */
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  /** The pull request linked to the task, and its state as last resolved. */
  prNumber: number | null;
  prState: string | null;
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
  | 'files'
  | 'lines_added'
  | 'lines_removed'
  | 'last_active'
  | 'outcome'
  | 'pr'
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
    describe: 'the board ticket number the user sees on a card, written #529.',
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
    key: 'files',
    label: 'Files',
    kind: 'measure',
    selectable: true,
    describe: 'how many files the task\'s branch changed against its base, from git. '
      + 'Blank when the task never recorded it.',
    cell: (facts) => (facts.filesChanged == null ? '' : String(facts.filesChanged)),
    display: (facts) => (facts.filesChanged == null ? null : String(facts.filesChanged)),
    sortValue: (facts) => facts.filesChanged ?? null,
  },
  {
    key: 'lines_added',
    label: 'Lines added',
    kind: 'measure',
    selectable: true,
    describe: 'lines of code the task\'s branch added against its base, from git.',
    cell: (facts) => (facts.linesAdded == null ? '' : String(facts.linesAdded)),
    display: (facts) => (facts.linesAdded == null ? null : `+${facts.linesAdded}`),
    sortValue: (facts) => facts.linesAdded ?? null,
  },
  {
    key: 'lines_removed',
    label: 'Lines removed',
    kind: 'measure',
    selectable: true,
    describe: 'lines of code the task\'s branch removed against its base, from git.',
    cell: (facts) => (facts.linesRemoved == null ? '' : String(facts.linesRemoved)),
    display: (facts) => (facts.linesRemoved == null ? null : `-${facts.linesRemoved}`),
    sortValue: (facts) => facts.linesRemoved ?? null,
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
      + 'active means it is still open on the board.',
    cell: (facts) => facts.outcome ?? '',
    display: (facts) => (facts.outcome ? TASK_OUTCOME_LABELS[facts.outcome] : null),
    sortValue: () => null,
  },
  {
    key: 'pr',
    label: 'Pull request',
    kind: 'dimension',
    selectable: true,
    // Written "PR 417", never "#417": `#N` names a TASK everywhere in the chat,
    // and a PR number in that form would render as a mark for a different task.
    describe: 'the pull request linked to the task and its state, like "PR 417 merged". '
      + 'Write a pull request as PR 417, never #417, since #N always names a task.',
    cell: (facts) => (facts.prNumber == null ? '' : `PR ${facts.prNumber}${facts.prState ? ` ${facts.prState}` : ''}`),
    display: (facts) => (facts.prNumber == null ? null : `PR ${facts.prNumber}${facts.prState ? ` ${facts.prState}` : ''}`),
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

/**
 * Fields whose value is IDENTICAL on every row.
 *
 * Measured on the real 350-task index: `agent` has exactly one distinct value,
 * so the prompt was spending 4,200 characters saying "Claude Code" three
 * hundred and fifty times. A column that never varies carries no per-row
 * information by definition - it is a fact about the corpus, and belongs in one
 * summary line rather than in every row.
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

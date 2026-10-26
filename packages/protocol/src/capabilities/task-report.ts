/**
 * The result of the `get_task_report` board tool (a `board-tool-read`
 * request): what the desktop's completed task view shows that `find_task`
 * does not. That is the task's route through the board, its span, every
 * commit the index links to it, and its per-file changes from git.
 *
 * A deliberate structural MIRROR of the desktop's `TaskReport` and
 * `GitTaskChangesResult` subsets, not an import (see events/payloads.ts for
 * why). The desktop's mapper (`toTaskReportWire` in
 * src/main/agent/commands/task-report-commands.ts) returns this type, so a
 * field renamed or removed on the desktop side is a compile error there.
 *
 * Lists are capped by the desktop and carry their full count, so a phone can
 * say "100 of 240". The caps are the desktop's, not part of the contract.
 */
import type { JsonValue } from '../wire/messages';
import { isRecord } from '../wire/json-value';
import type { BoardColumnRoleWire, DiffFileStatusWire, DiffFileWire } from '../events/payloads';
import { DIFF_FILE_STATUSES, nullableNumber, nullableString, requireNumber, requireString } from '../events/payloads';

/** One stay in a column, from the desktop's `task_moves`. */
export interface TaskReportVisitWire {
  startedAt: string;
  durationMs: number;
}

/** A working column the task passed through, in board order. */
export interface TaskReportRouteColumnWire {
  swimlaneId: string;
  name: string;
  color: string;
  /** The column's lucide icon name, or null for its role default. */
  icon: string | null;
  /** See `BoardColumnWire.role`: an unknown role passes through. */
  role: BoardColumnRoleWire | (string & {}) | null;
  /** Every stay in the column added up, including stays `visits` leaves out. */
  totalMs: number;
  /** The stays, oldest first, capped. */
  visits: TaskReportVisitWire[];
  /** How many stays there were in all. */
  visitCount: number;
}

/** A commit the desktop's index links to the task. */
export interface TaskReportCommitWire {
  sha: string;
  subject: string;
  committedAt: string;
}

/**
 * Why a task has no changes to show: it made no commits that can be found,
 * indexing is off and its branch gave no range, or its commits are not in the
 * desktop's clone.
 */
export type TaskReportChangesEmptyReasonWire = 'no-commits' | 'indexing-off' | 'not-in-clone';

/** What the task changed, read from git on the desktop. */
export interface TaskReportChangesWire {
  /** Biggest change (insertions plus deletions) first, capped. */
  files: DiffFileWire[];
  /** How many files changed in all. */
  fileCount: number;
  /**
   * The whole change's totals when one span of history holds it, else null.
   * The desktop's header strip shows these in place of the session figures
   * only when they are set.
   */
  totals: { insertions: number; deletions: number; filesChanged: number } | null;
  /** Set exactly when the task has no commits to show. */
  emptyReason: TaskReportChangesEmptyReasonWire | null;
}

/** Whether a task summary is written, and why not when it is not. */
export type TaskReportSummaryStateWire =
  | { kind: 'written'; text: string }
  | { kind: 'pending' }
  | { kind: 'off' }
  | { kind: 'indexing-off' };

export interface TaskReportWire {
  /** The task's id (a UUID), whichever id the request named. */
  taskId: string;
  /** The earlier of the first move into a working column and the first session start. */
  startedAt: string | null;
  /** The last move into Done, else the last session end. */
  endedAt: string | null;
  route: TaskReportRouteColumnWire[];
  /** Newest first, capped. Null, with `commitCount`, when the index could not be read or is off. */
  commits: TaskReportCommitWire[] | null;
  commitCount: number | null;
  /** Null when git could not be read; `changesError` then says why. */
  changes: TaskReportChangesWire | null;
  changesError: string | null;
  summaryState: TaskReportSummaryStateWire;
}

const EMPTY_REASONS: readonly string[] = ['no-commits', 'indexing-off', 'not-in-clone'];

function requireArray(record: Record<string, unknown>, field: string, context: string): JsonValue[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`${context} is missing an array "${field}"`);
  return value;
}

function parseRouteColumn(value: JsonValue, index: number): TaskReportRouteColumnWire {
  const context = `task report route column ${index}`;
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  const visits = requireArray(value, 'visits', context).map((visit, visitIndex) => {
    const visitContext = `${context} visit ${visitIndex}`;
    if (!isRecord(visit)) throw new Error(`${visitContext} must be an object`);
    return {
      startedAt: requireString(visit, 'startedAt', visitContext),
      durationMs: requireNumber(visit, 'durationMs', visitContext),
    };
  });
  return {
    swimlaneId: requireString(value, 'swimlaneId', context),
    name: requireString(value, 'name', context),
    color: requireString(value, 'color', context),
    icon: nullableString(value, 'icon'),
    role: nullableString(value, 'role'),
    totalMs: requireNumber(value, 'totalMs', context),
    visits,
    visitCount: nullableNumber(value, 'visitCount') ?? visits.length,
  };
}

function parseCommit(value: JsonValue, index: number): TaskReportCommitWire {
  const context = `task report commit ${index}`;
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return {
    sha: requireString(value, 'sha', context),
    subject: requireString(value, 'subject', context),
    committedAt: requireString(value, 'committedAt', context),
  };
}

function parseFile(value: JsonValue, index: number): DiffFileWire {
  const context = `task report file ${index}`;
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  // A status a newer desktop adds reads as modified, so the file and its
  // lines still show and the whole report does not fail.
  const status = typeof value.status === 'string' && DIFF_FILE_STATUSES.includes(value.status)
    ? value.status as DiffFileStatusWire
    : 'M';
  return {
    path: requireString(value, 'path', context),
    status,
    insertions: requireNumber(value, 'insertions', context),
    deletions: requireNumber(value, 'deletions', context),
    ...(typeof value.oldPath === 'string' ? { oldPath: value.oldPath } : {}),
    binary: value.binary === true,
  };
}

function parseChanges(value: JsonValue | undefined): TaskReportChangesWire | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error('task report changes must be an object or null');
  const files = requireArray(value, 'files', 'task report changes').map(parseFile);
  let totals: TaskReportChangesWire['totals'] = null;
  if (isRecord(value.totals)) {
    totals = {
      insertions: requireNumber(value.totals, 'insertions', 'task report totals'),
      deletions: requireNumber(value.totals, 'deletions', 'task report totals'),
      filesChanged: requireNumber(value.totals, 'filesChanged', 'task report totals'),
    };
  }
  const emptyReason = typeof value.emptyReason === 'string' && EMPTY_REASONS.includes(value.emptyReason)
    ? value.emptyReason as TaskReportChangesEmptyReasonWire
    : null;
  return {
    files,
    fileCount: nullableNumber(value, 'fileCount') ?? files.length,
    totals,
    emptyReason,
  };
}

/**
 * A summary state a newer desktop adds, or a written one with no text, reads
 * as pending. The phone then shows no summary, which is what it would show
 * anyway.
 */
function parseSummaryState(value: JsonValue | undefined): TaskReportSummaryStateWire {
  if (!isRecord(value)) return { kind: 'pending' };
  if (value.kind === 'written' && typeof value.text === 'string') return { kind: 'written', text: value.text };
  if (value.kind === 'off') return { kind: 'off' };
  if (value.kind === 'indexing-off') return { kind: 'indexing-off' };
  return { kind: 'pending' };
}

/**
 * Narrows a `get_task_report` result (`BoardToolResponsePayload.result`).
 * Throws on a malformed required field. Unknown fields are ignored, and an
 * unknown file status, summary kind or empty reason degrades instead of
 * throwing, so a newer desktop never breaks an older phone.
 */
export function parseTaskReportWire(payload: JsonValue): TaskReportWire {
  if (!isRecord(payload)) throw new Error('task report must be an object');
  const commits = Array.isArray(payload.commits) ? payload.commits.map(parseCommit) : null;
  return {
    taskId: requireString(payload, 'taskId', 'task report'),
    startedAt: nullableString(payload, 'startedAt'),
    endedAt: nullableString(payload, 'endedAt'),
    route: requireArray(payload, 'route', 'task report').map(parseRouteColumn),
    commits,
    commitCount: commits === null ? null : (nullableNumber(payload, 'commitCount') ?? commits.length),
    changes: parseChanges(payload.changes),
    changesError: nullableString(payload, 'changesError'),
    summaryState: parseSummaryState(payload.summaryState),
  };
}

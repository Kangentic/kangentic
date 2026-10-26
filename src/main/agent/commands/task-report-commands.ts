import type {
  DiffFileWire,
  TaskReportChangesWire,
  TaskReportRouteColumnWire,
  TaskReportSummaryStateWire,
  TaskReportWire,
} from '@kangentic/protocol';
import { TaskRepository } from '../../db/repositories/task-repository';
import type { GitTaskChangesFile, GitTaskChangesResult, TaskReport, TaskReportRouteColumn, TaskReportSummaryState } from '../../../shared/types';
import { resolveTask } from './task-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

/**
 * `get_task_report`: what the completed task view shows that `find_task` does
 * not, for the phone (`board-tool-read`) and for agents
 * (`kangentic_get_task_report`). The task's route through the board, its
 * span, every commit the index links to it, and its per-file changes from
 * git, in the protocol's `TaskReportWire` shape.
 *
 * The result crosses the relay, so each list is capped and carries its full
 * count. The Usage tab's ledger is left out.
 */

/** Files listed, biggest change first, as git orders them. */
export const TASK_REPORT_MAX_FILES = 200;
/** Linked commits listed, newest first. Also the index read's own limit. */
export const TASK_REPORT_MAX_COMMITS = 100;
/** Stays listed per route column, oldest first. The column's total counts them all. */
export const TASK_REPORT_MAX_VISITS = 50;

function routeColumnWire(column: TaskReportRouteColumn): TaskReportRouteColumnWire {
  return {
    swimlaneId: column.swimlaneId,
    name: column.name,
    color: column.color,
    icon: column.icon,
    role: column.role,
    totalMs: column.totalMs,
    visits: column.visits.slice(0, TASK_REPORT_MAX_VISITS).map((visit) => ({ startedAt: visit.startedAt, durationMs: visit.durationMs })),
    visitCount: column.visits.length,
  };
}

function fileWire(file: GitTaskChangesFile): DiffFileWire {
  return {
    path: file.path,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    binary: file.binary,
  };
}

function changesWire(changes: GitTaskChangesResult): TaskReportChangesWire {
  // Totals only with a range, as the view's header strip reads them. The
  // union of separate commits' diffs is no single change to total.
  const totals = changes.range && changes.totals
    ? { insertions: changes.totals.insertions, deletions: changes.totals.deletions, filesChanged: changes.totals.filesChanged }
    : null;
  return {
    files: changes.files.slice(0, TASK_REPORT_MAX_FILES).map(fileWire),
    fileCount: changes.files.length,
    totals,
    emptyReason: changes.emptyReason,
  };
}

function summaryStateWire(state: TaskReportSummaryState): TaskReportSummaryStateWire {
  switch (state.kind) {
    case 'written':
      return { kind: 'written', text: state.text };
    case 'pending':
    case 'off':
    case 'indexing-off':
      return { kind: state.kind };
  }
}

/**
 * The report and the git changes as the wire carries them. `changes` is null
 * when git could not be read, and `changesError` then says why.
 */
export function toTaskReportWire(
  taskId: string,
  report: TaskReport,
  changes: GitTaskChangesResult | null,
  changesError: string | null,
): TaskReportWire {
  const knowledge = report.knowledge;
  return {
    taskId,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    route: report.route.map(routeColumnWire),
    commits: knowledge
      ? knowledge.commits.slice(0, TASK_REPORT_MAX_COMMITS).map((commit) => ({ sha: commit.sha, subject: commit.subject, committedAt: commit.committedAt }))
      : null,
    commitCount: knowledge ? knowledge.commitCount : null,
    changes: changes ? changesWire(changes) : null,
    changesError: changes ? null : changesError,
    summaryState: summaryStateWire(report.summaryState),
  };
}

export const handleGetTaskReport: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> => {
  const rawTaskId = typeof params.taskId === 'number' ? String(params.taskId) : params.taskId;
  if (typeof rawTaskId !== 'string' || !rawTaskId) {
    return { success: false, error: 'taskId is required' };
  }
  const { readTaskReport, readTaskChanges } = context;
  if (!readTaskReport || !readTaskChanges) {
    return { success: false, error: 'The task report cannot be read here' };
  }

  const task = resolveTask(new TaskRepository(context.getProjectDb()), rawTaskId);
  if (!task) {
    return { success: false, error: `Task "${rawTaskId}" not found` };
  }

  // Both reads can wait on the index, so they run together. Git failing costs
  // the changes section only, never the report.
  const [report, changesRead] = await Promise.all([
    readTaskReport(task.id, { commitLimit: TASK_REPORT_MAX_COMMITS, includeLedger: false }),
    readTaskChanges(task.id).then(
      (changes) => ({ changes, error: null }),
      (error: unknown) => ({ changes: null, error: error instanceof Error ? error.message : String(error) }),
    ),
  ]);

  // No `message`: MCP's `callHandler` sends `data` as JSON text when there is
  // none, and the phone reads `data`, so a second copy would be thrown away.
  const wire = toTaskReportWire(task.id, report, changesRead.changes, changesRead.error);
  return { success: true, data: wire };
};

/**
 * What the leftover-process toast and list say, from a report main pushed
 * (`LeftoverProcessReport`). Pure, so every sentence is pinned by unit tests.
 *
 * The toast gives counts only; the names, and the reason each still-running
 * process was kept, live in the list. A toast that closes on its own opens the
 * list when its card is clicked, and one that stays up opens it with Review. A
 * toast that stays up leads with what is still running (or could not be
 * stopped), since that is why it stays; what stopped is in the list. It also
 * shows how long ago the report came, so one still on screen later does not
 * read as new.
 *
 * Each sentence is one message per shape: one task's title or a count of
 * tasks, and whether a clause is present, so a translator never gets a
 * sentence built from pieces. Counts are ICU plurals.
 */

import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/runtime-macro';
import type { LeftoverProcess, LeftoverProcessReport } from '../../shared/types';
import { formatTimeAgo } from './datetime';

export interface LeftoverToast {
  title: string;
  message: string;
  variant: 'info' | 'warning';
  /**
   * Stays until the user closes it. True when something is still running or
   * could not be stopped: the toast is the way into the list, so it must not
   * vanish before the user looks.
   */
  sticky: boolean;
  /** When the report came (UTC ISO), for the toast's age; only on a toast that stays up. */
  since?: string;
}

/** Where a report's processes came from: one task, named by its title, or several, counted. */
type ReportSource = { kind: 'task'; taskTitle: string } | { kind: 'tasks'; taskCount: number };

function sourceOf(processes: readonly LeftoverProcess[]): ReportSource {
  const taskIds = new Set(processes.map((entry) => entry.taskId));
  return taskIds.size === 1
    ? { kind: 'task', taskTitle: processes[0].taskTitle }
    : { kind: 'tasks', taskCount: taskIds.size };
}

/** Stopping turned off: `"Fix login" left 3 processes running.` */
function leftRunningMessage(source: ReportSource, processCount: number): string {
  if (source.kind === 'task') {
    const taskTitle = source.taskTitle;
    return i18n._(msg`${plural({ processCount }, {
      one: msg`"${{ taskTitle }}" left # process running.`,
      other: msg`"${{ taskTitle }}" left # processes running.`,
    })}`);
  }
  const taskCount = source.taskCount;
  return i18n._(msg`${plural({ processCount }, {
    one: msg`${plural({ taskCount }, { other: '# tasks' })} left # process running.`,
    other: msg`${plural({ taskCount }, { other: '# tasks' })} left # processes running.`,
  })}`);
}

/** Every one stopped: `Stopped 2 leftover processes from "Fix login".` */
function allStoppedMessage(source: ReportSource, stoppedCount: number): string {
  if (source.kind === 'task') {
    const taskTitle = source.taskTitle;
    return i18n._(msg`${plural({ stoppedCount }, {
      one: msg`Stopped # leftover process from "${{ taskTitle }}".`,
      other: msg`Stopped # leftover processes from "${{ taskTitle }}".`,
    })}`);
  }
  const taskCount = source.taskCount;
  return i18n._(msg`${plural({ stoppedCount }, {
    one: msg`Stopped # leftover process from ${plural({ taskCount }, { other: '# tasks' })}.`,
    other: msg`Stopped # leftover processes from ${plural({ taskCount }, { other: '# tasks' })}.`,
  })}`);
}

/** Some could not be stopped, and any still running after them: `Couldn't stop 1 process from "Fix login", and 1 more is still running.` */
function failedMessage(source: ReportSource, failedCount: number, keptCount: number): string {
  if (source.kind === 'task') {
    const taskTitle = source.taskTitle;
    if (keptCount === 0) {
      return i18n._(msg`${plural({ failedCount }, {
        one: msg`Couldn't stop # process from "${{ taskTitle }}".`,
        other: msg`Couldn't stop # processes from "${{ taskTitle }}".`,
      })}`);
    }
    return i18n._(msg`${plural({ failedCount }, {
      one: msg`Couldn't stop # process from "${{ taskTitle }}", and ${plural({ keptCount }, { one: '# more is still running.', other: '# more are still running.' })}`,
      other: msg`Couldn't stop # processes from "${{ taskTitle }}", and ${plural({ keptCount }, { one: '# more is still running.', other: '# more are still running.' })}`,
    })}`);
  }
  const taskCount = source.taskCount;
  if (keptCount === 0) {
    return i18n._(msg`${plural({ failedCount }, {
      one: msg`Couldn't stop # process from ${plural({ taskCount }, { other: '# tasks' })}.`,
      other: msg`Couldn't stop # processes from ${plural({ taskCount }, { other: '# tasks' })}.`,
    })}`);
  }
  return i18n._(msg`${plural({ failedCount }, {
    one: msg`Couldn't stop # process from ${plural({ taskCount }, { other: '# tasks' })}, and ${plural({ keptCount }, { one: '# more is still running.', other: '# more are still running.' })}`,
    other: msg`Couldn't stop # processes from ${plural({ taskCount }, { other: '# tasks' })}, and ${plural({ keptCount }, { one: '# more is still running.', other: '# more are still running.' })}`,
  })}`);
}

/** Some still running, none failed: `2 processes from "Fix login" are still running.` */
function stillRunningMessage(source: ReportSource, keptCount: number): string {
  if (source.kind === 'task') {
    const taskTitle = source.taskTitle;
    return i18n._(msg`${plural({ keptCount }, {
      one: msg`# process from "${{ taskTitle }}" is still running.`,
      other: msg`# processes from "${{ taskTitle }}" are still running.`,
    })}`);
  }
  const taskCount = source.taskCount;
  return i18n._(msg`${plural({ keptCount }, {
    one: msg`# process from ${plural({ taskCount }, { other: '# tasks' })} is still running.`,
    other: msg`# processes from ${plural({ taskCount }, { other: '# tasks' })} are still running.`,
  })}`);
}

/** The toast for a report, or null when it names nothing. */
export function describeLeftoverReport(report: LeftoverProcessReport): LeftoverToast | null {
  const processes = report.processes;
  if (processes.length === 0) return null;
  const source = sourceOf(processes);
  if (!report.stoppingEnabled) {
    return {
      title: i18n._(msg`Leftover processes`),
      message: leftRunningMessage(source, processes.length),
      variant: 'info',
      sticky: false,
    };
  }
  const stopped = processes.filter((entry) => entry.outcome === 'stopped').length;
  const failed = processes.filter((entry) => entry.outcome === 'failed').length;
  const kept = processes.filter((entry) => entry.outcome === 'kept').length;
  if (failed === 0 && kept === 0) {
    return {
      title: i18n._(msg`Leftover processes stopped`),
      message: allStoppedMessage(source, stopped),
      variant: 'info',
      sticky: false,
    };
  }
  if (failed > 0) {
    return {
      title: i18n._(msg`Couldn't stop processes`),
      message: failedMessage(source, failed, kept),
      variant: 'warning',
      sticky: true,
      since: report.reportedAt,
    };
  }
  return {
    title: i18n._(msg`Processes still running`),
    message: stillRunningMessage(source, kept),
    variant: 'info',
    sticky: true,
    since: report.reportedAt,
  };
}

/** The list header's line under its title: how long ago the report came ("37 minutes ago"). */
export function reportAgeOf(report: LeftoverProcessReport, now: number): string {
  return formatTimeAgo(report.reportedAt, now);
}

/** "node (vite)" as its two parts, so the list can mute the script. */
export function splitProcessLabel(label: string): { program: string; script: string | null } {
  const match = /^(.+?) \((.+)\)$/.exec(label);
  return match ? { program: match[1], script: match[2] } : { program: label, script: null };
}

/** Where a row stands: from the report, then from the user's Stop or a recheck. */
export type LeftoverRowState = 'running' | 'stopping' | 'stopped' | 'ended' | 'failed';

/** What the user's Stop, or a recheck that found the process gone (`ended`), changed a row to. */
export type LeftoverStopState = Exclude<LeftoverRowState, 'running'>;

export function rowStateOf(entry: LeftoverProcess, stopState: LeftoverStopState | undefined): LeftoverRowState {
  if (stopState) return stopState;
  if (entry.outcome === 'stopped') return 'stopped';
  if (entry.outcome === 'failed') return 'failed';
  return 'running';
}

/**
 * Whether a report's toast has stopped saying anything true: it named a
 * process that was still running or could not be stopped, and every such row
 * has since stopped or ended. A report that only ever named stopped processes
 * never settles this way; its toast closes on its own.
 */
export function reportHasSettled(report: LeftoverProcessReport, stopStates: Readonly<Record<string, LeftoverStopState>>): boolean {
  const named = report.processes.filter((entry) => entry.outcome !== 'stopped');
  return named.length > 0 && named.every((entry) => {
    const state = rowStateOf(entry, stopStates[entry.id]);
    return state === 'stopped' || state === 'ended';
  });
}

/** The recheck's pace while the youngest watched report is new: a process that outlived its task often exits seconds later. */
export const LEFTOVER_RECHECK_FAST_MS = 5_000;
/** The pace after that. A toast that waits to be closed can sit for hours. */
export const LEFTOVER_RECHECK_SLOW_MS = 30_000;
/** How long a report counts as new. */
export const LEFTOVER_RECHECK_FAST_WINDOW_MS = 60_000;

/** The wait before the next recheck, from the youngest watched report's age. */
export function recheckDelayMs(youngestReportedAt: string, now: number): number {
  const age = now - Date.parse(youngestReportedAt);
  return Number.isFinite(age) && age < LEFTOVER_RECHECK_FAST_WINDOW_MS ? LEFTOVER_RECHECK_FAST_MS : LEFTOVER_RECHECK_SLOW_MS;
}

/** What the leftover store holds that a recheck reads. */
export interface RecheckInput {
  reports: Readonly<Record<string, LeftoverProcessReport>>;
  reportToasts: Readonly<Record<string, string>>;
  openReportId: string | null;
  stopStates: Readonly<Record<string, LeftoverStopState>>;
  /** The toasts on screen now. */
  visibleToastIds: ReadonlySet<string>;
}

/**
 * The rows a recheck asks main about: those still claiming a live process
 * (`running`, or `failed`), in a report the user can see, through its toast
 * or its open list. Nothing on screen, nothing asked.
 */
export function rowsToRecheck(input: RecheckInput): { processIds: string[]; youngestReportedAt: string | null } {
  const processIds: string[] = [];
  let youngestReportedAt: string | null = null;
  for (const [reportId, report] of Object.entries(input.reports)) {
    const toastId = input.reportToasts[reportId];
    const onScreen = reportId === input.openReportId || (toastId !== undefined && input.visibleToastIds.has(toastId));
    if (!onScreen) continue;
    let watched = false;
    for (const entry of report.processes) {
      const state = rowStateOf(entry, input.stopStates[entry.id]);
      if (state !== 'running' && state !== 'failed') continue;
      processIds.push(entry.id);
      watched = true;
    }
    if (watched && (youngestReportedAt === null || Date.parse(report.reportedAt) > Date.parse(youngestReportedAt))) {
      youngestReportedAt = report.reportedAt;
    }
  }
  return { processIds, youngestReportedAt };
}

/** The line under a row's name, and whether it reads as a failure. */
export function rowDetailOf(entry: LeftoverProcess, state: LeftoverRowState): { text: string; failure: boolean } {
  if (state === 'ended') return { text: i18n._(msg`No longer running.`), failure: false };
  if (state === 'failed') return { text: i18n._(msg`Couldn't stop it. Try again, or close it yourself.`), failure: true };
  const inWorktree = entry.place === 'worktree';
  // Once stopped, a kept row reads like any stopped one: why it was kept, and
  // the warning about stopping it, no longer apply.
  if (state === 'stopped') {
    return { text: inWorktree ? i18n._(msg`Ran in the worktree.`) : i18n._(msg`Ran in the project folder.`), failure: false };
  }
  if (entry.reason === 'window') return { text: i18n._(msg`Has an open window.`), failure: false };
  if (entry.reason === 'multiplexer') return { text: i18n._(msg`A tmux server. Stopping it ends all your tmux sessions.`), failure: false };
  if (entry.reason === 'shared') return { text: i18n._(msg`Other work uses it too. Stopping it can break that work.`), failure: false };
  return { text: inWorktree ? i18n._(msg`Runs in the worktree.`) : i18n._(msg`Runs in the project folder.`), failure: false };
}

/** The list's two sections. A row stays in the section it opened in, whatever its Stop does. */
export function sectionsOf(report: LeftoverProcessReport): { stillRunning: LeftoverProcess[]; stopped: LeftoverProcess[] } {
  return {
    stillRunning: report.processes.filter((entry) => entry.outcome !== 'stopped'),
    stopped: report.processes.filter((entry) => entry.outcome === 'stopped'),
  };
}

/** Rows grouped by task, in first-seen order, for a report that spans several tasks. */
export function groupByTask(processes: readonly LeftoverProcess[]): Array<{ taskId: string; taskTitle: string; processes: LeftoverProcess[] }> {
  const groups = new Map<string, { taskId: string; taskTitle: string; processes: LeftoverProcess[] }>();
  for (const entry of processes) {
    let group = groups.get(entry.taskId);
    if (!group) {
      group = { taskId: entry.taskId, taskTitle: entry.taskTitle, processes: [] };
      groups.set(entry.taskId, group);
    }
    group.processes.push(entry);
  }
  return [...groups.values()];
}

/** The list's title: `Processes from "Fix login"` or `Processes from 3 tasks`. */
export function reportTitleOf(report: LeftoverProcessReport): string {
  const source = sourceOf(report.processes);
  if (source.kind === 'task') {
    const taskTitle = source.taskTitle;
    return i18n._(msg`Processes from "${{ taskTitle }}"`);
  }
  const taskCount = source.taskCount;
  return i18n._(msg`Processes from ${plural({ taskCount }, { other: '# tasks' })}`);
}

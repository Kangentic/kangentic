/**
 * What the leftover-process toast and list say, from a report main pushed
 * (`LeftoverProcessReport`). Pure, so every sentence is pinned by unit tests.
 *
 * The toast gives counts only and opens the list with Review; the names, and
 * the reason each still-running process was kept, live in the list. A toast
 * that stays up leads with what is still running (or could not be stopped),
 * since that is why it stays; what stopped is in the list. It also shows how
 * long ago the report came, so one still on screen later does not read as new.
 */

import type { LeftoverProcess, LeftoverProcessReport } from '../../shared/types';
import { formatTimeAgo } from './datetime';

export interface LeftoverToast {
  message: string;
  variant: 'info' | 'warning';
  /**
   * Stays until the user closes it. True when something is still running or
   * could not be stopped: Review is the only way into the list, so the toast
   * must not vanish before the user looks.
   */
  sticky: boolean;
  /** When the report came (UTC ISO), for the toast's age; only on a toast that stays up. */
  since?: string;
}

function processCount(count: number): string {
  return `${count} ${count === 1 ? 'process' : 'processes'}`;
}

function leftoverCount(count: number): string {
  return `${count} leftover ${count === 1 ? 'process' : 'processes'}`;
}

/** `"Fix login"` for one task, `3 tasks` for several. */
function sourceOf(processes: readonly LeftoverProcess[]): string {
  const taskIds = new Set(processes.map((entry) => entry.taskId));
  return taskIds.size === 1 ? `"${processes[0].taskTitle}"` : `${taskIds.size} tasks`;
}

/** The toast for a report, or null when it names nothing. */
export function describeLeftoverReport(report: LeftoverProcessReport): LeftoverToast | null {
  const processes = report.processes;
  if (processes.length === 0) return null;
  const source = sourceOf(processes);
  if (!report.stoppingEnabled) {
    return { message: `${source} left ${processCount(processes.length)} running.`, variant: 'info', sticky: false };
  }
  const stopped = processes.filter((entry) => entry.outcome === 'stopped').length;
  const failed = processes.filter((entry) => entry.outcome === 'failed').length;
  const kept = processes.filter((entry) => entry.outcome === 'kept').length;
  if (failed === 0 && kept === 0) {
    return { message: `Stopped ${leftoverCount(stopped)} from ${source}.`, variant: 'info', sticky: false };
  }
  const message = failed > 0
    ? `Couldn't stop ${processCount(failed)} from ${source}${kept > 0 ? `, and ${kept} more ${kept === 1 ? 'is' : 'are'} still running.` : '.'}`
    : `${processCount(kept)} from ${source} ${kept === 1 ? 'is' : 'are'} still running.`;
  return {
    message,
    variant: failed > 0 ? 'warning' : 'info',
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

/** Where a row stands: from the report, then from the user's Stop. */
export type LeftoverRowState = 'running' | 'stopping' | 'stopped' | 'ended' | 'failed';

/** What the user's Stop changed a row to, if anything. */
export type LeftoverStopState = Exclude<LeftoverRowState, 'running'>;

export function rowStateOf(entry: LeftoverProcess, stopState: LeftoverStopState | undefined): LeftoverRowState {
  if (stopState) return stopState;
  if (entry.outcome === 'stopped') return 'stopped';
  if (entry.outcome === 'failed') return 'failed';
  return 'running';
}

/** The line under a row's name, and whether it reads as a failure. */
export function rowDetailOf(entry: LeftoverProcess, state: LeftoverRowState): { text: string; failure: boolean } {
  if (state === 'ended') return { text: 'No longer running.', failure: false };
  if (state === 'failed') return { text: "Couldn't stop it. Try again, or close it yourself.", failure: true };
  const folder = entry.place === 'worktree' ? 'the worktree' : 'the project folder';
  // Once stopped, a kept row reads like any stopped one: why it was kept, and
  // the warning about stopping it, no longer apply.
  if (state === 'stopped') return { text: `Ran in ${folder}.`, failure: false };
  if (entry.reason === 'window') return { text: 'Has an open window.', failure: false };
  if (entry.reason === 'multiplexer') return { text: 'A tmux server. Stopping it ends all your tmux sessions.', failure: false };
  if (entry.reason === 'shared') return { text: 'Other work uses it too. Stopping it can break that work.', failure: false };
  return { text: `Runs in ${folder}.`, failure: false };
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
  return `Processes from ${sourceOf(report.processes)}`;
}

/**
 * What the leftover-process toast and list say, from a report main pushed
 * (`LeftoverProcessReport`). Pure, so every sentence is pinned by unit tests.
 *
 * The toast gives counts only and opens the list with Review; the names, and
 * the reason each still-running process was kept, live in the list.
 */

import type { LeftoverProcess, LeftoverProcessReport } from '../../shared/types';

export interface LeftoverToast {
  message: string;
  variant: 'info' | 'warning';
  /**
   * Stays until the user closes it. True when something is still running or
   * could not be stopped: Review is the only way into the list, so the toast
   * must not vanish before the user looks.
   */
  sticky: boolean;
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
  const sentences: string[] = [];
  if (stopped > 0) sentences.push(`Stopped ${leftoverCount(stopped)} from ${source}.`);
  if (failed > 0) sentences.push(stopped > 0 ? `Couldn't stop ${failed}.` : `Couldn't stop ${processCount(failed)} from ${source}.`);
  if (kept > 0) sentences.push(stopped > 0 || failed > 0 ? `${kept} still running.` : `${source} left ${processCount(kept)} running.`);
  return {
    message: sentences.join(' '),
    variant: failed > 0 ? 'warning' : 'info',
    sticky: failed > 0 || kept > 0,
  };
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
  if (entry.reason === 'window') return { text: 'Has an open window.', failure: false };
  if (entry.reason === 'multiplexer') return { text: 'A tmux server. Stopping it ends all your tmux sessions.', failure: false };
  if (entry.reason === 'shared') return { text: 'Also runs work you started. Stopping it stops that too.', failure: false };
  const folder = entry.place === 'worktree' ? 'the worktree' : 'the project folder';
  return { text: entry.outcome === 'stopped' ? `Ran in ${folder}.` : `Runs in ${folder}.`, failure: false };
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

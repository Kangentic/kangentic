/**
 * Stop what a parked task left running, through the project's Stop script.
 *
 * A pause Kangentic made (the idle timeout) parks a task nobody is watching, and
 * the stack its agent started can hold more than the agent did. So after such a
 * pause, and only such a pause, this runs the script: not for a user's Pause or
 * Stop, an `auto_spawn=false` entry, a respawn or a quit, each of which leaves
 * the stack up for the person testing it, the agent coming straight back, or the
 * next launch.
 *
 * In order, and each step is what keeps it cheap or safe:
 * - No script, or stopping off: stop here, with no host call, so a project that
 *   sets nothing behaves as it always did.
 * - Re-read the pause. This runs outside the task lock, and the user may have
 *   resumed or moved the task since. It runs again right before the script.
 * - Probe, and stop if nothing runs. A task that left nothing runs no script.
 * - A client outside the task's tree holds it off (`task-tree-probe.ts`): a
 *   browser tab on a dev server is someone using the stack. An agent's offscreen
 *   browser lane is not, and its open connection would hold the stop off for
 *   good, so the lanes go first and the probe is taken again.
 * - Run it, and probe again. The next agent is told only what really ended, so a
 *   script that stopped nothing leaves no message.
 *
 * Kangentic never restarts anything: it has no start command, and a resume may
 * not need the stack. The held message lets the next agent restart it on demand.
 * A failure changes nothing but the toast, and the terminal reap still comes.
 */

import type { StopScriptFailure } from '../../shared/types';
import type { TaskProbeEntry, ProbedProcess } from '../pty/process-tag/tagged-reap';
import type { StopScriptOutcome } from './run-stop-script';

/** How long a closed lane's connection gets to drop before the second look. */
const LANE_CLOSE_SETTLE_MS = 1_000;
/** How long what a script stopped gets to leave the process table. */
const STOP_SETTLE_MS = 1_000;
/** Names in the message, past which it counts the rest. */
const MAX_NAMED_PROCESSES = 5;

export interface ParkedStopTarget {
  projectId: string;
  projectPath: string;
  taskId: string;
}

/** A task still parked by a pause Kangentic made. */
export interface ParkedTaskFacts {
  title: string;
  worktreePath: string | null;
}

export type ParkedStopResult =
  /** No script, stopping off, or a quit. */
  | 'skipped'
  /** Resumed or moved, or the pause was not Kangentic's. */
  | 'not-paused'
  | 'already-running'
  | 'nothing-running'
  /** The host could not tell, which is never "nothing runs". */
  | 'unknown'
  | 'held-off'
  /** The script ended something. */
  | 'stopped'
  /** The script exited clean and nothing shows it ended anything. */
  | 'no-effect'
  | 'failed';

export interface ParkedStopDeps {
  scriptOf: (projectPath: string) => string | null;
  isStoppingEnabled: () => boolean;
  isShuttingDown: () => boolean;
  parkedTask: (target: ParkedStopTarget) => ParkedTaskFacts | null;
  isScriptRunning: (taskId: string) => boolean;
  probe: (target: ParkedStopTarget, worktreePath: string | null, connections: boolean) => Promise<TaskProbeEntry | null>;
  /** Close the task's offscreen browser lanes; how many there were. */
  closeOffscreenLanes: (taskId: string) => number;
  /** The worktree when it still exists, else the project folder. */
  folderOf: (target: ParkedStopTarget, worktreePath: string | null) => Promise<string>;
  runScript: (taskId: string, script: string, cwd: string) => Promise<StopScriptOutcome>;
  holdMessage: (target: ParkedStopTarget, message: string) => void;
  reportFailure: (target: ParkedStopTarget, taskTitle: string, failure: StopScriptFailure) => void;
  wait: (milliseconds: number) => Promise<void>;
}

/**
 * What the next agent reads. It goes in verbatim, with no heading or sender, as
 * every held message does: an attribution prefix made a receiving agent read one
 * as an injection and refuse it.
 */
export function stoppedProcessesMessage(labels: readonly string[]): string {
  const named = labels.slice(0, MAX_NAMED_PROCESSES).join(', ');
  const rest = labels.length - MAX_NAMED_PROCESSES;
  const list = rest > 0 ? `${named} and ${rest} more` : named;
  return `The project's Stop script stopped what this task left running while it was paused: ${list}. Start them again if you need them.`;
}

function sameProcess(left: ProbedProcess, right: ProbedProcess): boolean {
  return left.pid === right.pid && left.startKey === right.startKey;
}

/** One attempt for one parked task. */
export async function stopParkedTask(deps: ParkedStopDeps, target: ParkedStopTarget): Promise<ParkedStopResult> {
  const script = deps.scriptOf(target.projectPath);
  if (!script || !deps.isStoppingEnabled() || deps.isShuttingDown()) return 'skipped';
  const parked = deps.parkedTask(target);
  if (!parked) return 'not-paused';
  if (deps.isScriptRunning(target.taskId)) return 'already-running';

  let found = await deps.probe(target, parked.worktreePath, true);
  if (!found) return 'unknown';
  if (found.processes.length === 0) return 'nothing-running';
  if (found.connected && deps.closeOffscreenLanes(target.taskId) > 0) {
    await deps.wait(LANE_CLOSE_SETTLE_MS);
    found = await deps.probe(target, parked.worktreePath, true);
    if (!found) return 'unknown';
    if (found.processes.length === 0) return 'nothing-running';
  }
  if (found.connected) return 'held-off';

  const cwd = await deps.folderOf(target, parked.worktreePath);
  // The probe and the folder read both waited, and a Resume does not wait on this.
  // Past this point the script runs to its end, and its message reaches a resumed agent.
  if (!deps.parkedTask(target)) return 'not-paused';
  if (deps.isShuttingDown()) return 'skipped';
  const outcome = await deps.runScript(target.taskId, script, cwd);
  if (outcome.status === 'failed') {
    deps.reportFailure(target, parked.title, outcome.failure);
    return 'failed';
  }
  if (outcome.status === 'aborted') return 'failed';

  await deps.wait(STOP_SETTLE_MS);
  const after = await deps.probe(target, parked.worktreePath, false);
  if (!after) {
    console.warn(`[STOP-SCRIPT] task ${target.taskId.slice(0, 8)}: the script exited clean and the host could not say what it stopped`);
    return 'no-effect';
  }
  const ended = found.processes.filter((probed) => !after.processes.some((still) => sameProcess(probed, still)));
  if (ended.length === 0) {
    console.warn(`[STOP-SCRIPT] task ${target.taskId.slice(0, 8)}: the script exited clean and stopped nothing it could see`);
    return 'no-effect';
  }
  deps.holdMessage(target, stoppedProcessesMessage(ended.map((probed) => probed.label)));
  return 'stopped';
}

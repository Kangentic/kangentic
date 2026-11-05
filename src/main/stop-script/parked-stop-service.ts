/**
 * Wires a parked task's stop to the app: the session records, the host, the held
 * messages and the toast. The decisions live in `parked-stop.ts`.
 *
 * Everything here runs outside the task lock and is started, not awaited, by the
 * pause that fired it: a script never holds a pause up.
 */

import { destroyLanesForTask } from '../browser/browser-lane-manager';
import { getOpenProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { holdTaskMessage } from '../held-messages/held-messages';
import type { IpcContext } from '../ipc/ipc-context';
import { isShuttingDown } from '../shutdown-state';
import { HeldOffStops } from './held-off-stops';
import { stopParkedTask, type ParkedStopDeps, type ParkedStopResult, type ParkedStopTarget } from './parked-stop';
import { isStopScriptRunning, runStopScript, STOP_SCRIPT_PAUSE_TIMEOUT_MS, stopScriptFolder } from './run-stop-script';
import { reportStopScriptFailure } from './stop-script-failure';

const heldOffStops = new HeldOffStops();
/** Tasks with an attempt in progress, which spans the probes before a script starts. */
const attemptsInFlight = new Set<string>();

export function createParkedStopDeps(context: IpcContext): ParkedStopDeps {
  return {
    scriptOf: (projectPath) => context.boardConfigManager.getStopScriptForPath(projectPath),
    isStoppingEnabled: () => context.configManager.load().stopLeftoverProcesses !== false,
    isShuttingDown,
    parkedTask: ({ projectId, taskId }) => {
      const db = getOpenProjectDb(projectId);
      if (!db || context.sessionManager.findLiveSessionByTaskId(taskId)) return null;
      const record = new SessionRepository(db).getLatestForTask(taskId);
      if (record?.status !== 'suspended' || record.suspended_by !== 'auto') return null;
      const task = new TaskRepository(db).getById(taskId);
      if (!task || task.archived_at !== null) return null;
      return { title: task.title, worktreePath: task.worktree_path };
    },
    isScriptRunning: isStopScriptRunning,
    probe: async ({ projectPath, taskId }, worktreePath, connections) => {
      const entries = await context.sessionManager.probeTaskProcesses(projectPath, [{ id: taskId, worktreePath }], { connections });
      if (!entries) return null;
      return entries.find((entry) => entry.taskId === taskId) ?? { taskId, processes: [], connected: false };
    },
    closeOffscreenLanes: destroyLanesForTask,
    folderOf: ({ projectPath }, worktreePath) => stopScriptFolder(worktreePath, projectPath),
    runScript: (taskId, script, cwd) => runStopScript({ taskId, script, cwd, timeoutMs: STOP_SCRIPT_PAUSE_TIMEOUT_MS }),
    holdMessage: ({ projectId, taskId }, message) => {
      const outcome = holdTaskMessage(context, { projectId, taskId, message });
      if (outcome.status === 'refused') console.warn(`[STOP-SCRIPT] task ${taskId.slice(0, 8)}: no message held: ${outcome.error}`);
    },
    reportFailure: ({ projectId, taskId }, taskTitle, failure) => {
      reportStopScriptFailure(context, { projectId, taskId, taskTitle, failure });
    },
    wait: (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
  };
}

function targetOf(context: IpcContext, projectId: string, taskId: string): ParkedStopTarget | null {
  const projectPath = context.projectRepo.getById(projectId)?.path;
  return projectPath ? { projectId, projectPath, taskId } : null;
}

/**
 * One attempt that never rejects, remembering a task a client held off. One at a
 * time per task: a pause and a recheck can land on the same task, and two
 * attempts would each hold a message for one stop.
 */
async function attemptStop(context: IpcContext, target: ParkedStopTarget): Promise<ParkedStopResult> {
  if (attemptsInFlight.has(target.taskId)) return 'already-running';
  attemptsInFlight.add(target.taskId);
  try {
    const result = await stopParkedTask(createParkedStopDeps(context), target);
    if (result === 'held-off') heldOffStops.add(target);
    return result;
  } catch (error) {
    console.warn(`[STOP-SCRIPT] parked stop failed for task ${target.taskId.slice(0, 8)} (non-fatal):`, error);
    return 'unknown';
  } finally {
    attemptsInFlight.delete(target.taskId);
  }
}

/**
 * Start the stop after an idle pause. The record the pause wrote says which
 * pause it was, so a caller only names the task. Never throws.
 */
export function startParkedStop(context: IpcContext, projectId: string, taskId: string): void {
  try {
    const target = targetOf(context, projectId, taskId);
    if (target) void attemptStop(context, target);
  } catch (error) {
    console.warn(`[STOP-SCRIPT] could not start the parked stop for task ${taskId.slice(0, 8)} (non-fatal):`, error);
  }
}

/** The sampler's tick for stops a client held off. Costs nothing while none is. */
export function tickHeldOffStops(context: IpcContext): void {
  heldOffStops.onTick((target) => attemptStop(context, target));
}

/** Test-only: forget what is held off and what was tried. */
export function resetParkedStopsForTests(): void {
  attemptsInFlight.clear();
  heldOffStops.clear();
}

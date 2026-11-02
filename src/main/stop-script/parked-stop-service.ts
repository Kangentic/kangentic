/**
 * Wires a parked task's stop to the app: the session records, the host, the held
 * messages and the toast. The decisions live in `parked-stop.ts`.
 *
 * Everything here runs outside the task lock and is started, not awaited, by the
 * pause that fired it: a script never holds a pause up.
 */

import fsPromises from 'node:fs/promises';
import { destroyLanesForTask } from '../browser/browser-lane-manager';
import { getOpenProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { holdTaskMessage } from '../held-messages/held-messages';
import type { IpcContext } from '../ipc/ipc-context';
import { isShuttingDown } from '../shutdown-state';
import { HeldOffStops } from './held-off-stops';
import { stopParkedTask, type ParkedStopDeps, type ParkedStopResult, type ParkedStopTarget } from './parked-stop';
import { isStopScriptRunning, runStopScript, STOP_SCRIPT_PAUSE_TIMEOUT_MS } from './run-stop-script';
import { reportStopScriptFailure } from './stop-script-failure';

/**
 * How long a low-memory pass leaves a task alone after a run that freed nothing.
 * A broken script would otherwise spend every tick of a low-memory spell, and no
 * agent would ever be paused.
 */
const RELIEF_RETRY_AFTER_MS = 30 * 60_000;

const heldOffStops = new HeldOffStops();
/** When a low-memory pass last ran a script for a task that did not stop. */
const reliefAttemptAt = new Map<string, number>();

/** What one low-memory pass did: a stop started, tasks are still held off, or nothing. */
export type ParkedReliefResult = 'started' | 'held' | 'none';

export function createParkedStopDeps(context: IpcContext): ParkedStopDeps {
  return {
    scriptOf: (projectPath) => context.boardConfigManager.getStopScriptForPath(projectPath),
    isStoppingEnabled: () => context.configManager.load().stopLeftoverProcesses !== false,
    isShuttingDown,
    parkedTask: ({ projectId, taskId }) => {
      const db = getOpenProjectDb(projectId);
      if (!db || context.sessionManager.findLiveSessionByTaskId(taskId)) return null;
      const record = new SessionRepository(db).getLatestForTask(taskId);
      if (record?.status !== 'suspended' || (record.suspended_by !== 'auto' && record.suspended_by !== 'low_memory')) return null;
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
    folderOf: async ({ projectPath }, worktreePath) => {
      if (!worktreePath) return projectPath;
      return fsPromises.access(worktreePath).then(() => worktreePath, () => projectPath);
    },
    runScript: (taskId, script, cwd) => runStopScript({ taskId, script, cwd, timeoutMs: STOP_SCRIPT_PAUSE_TIMEOUT_MS }),
    holdMessage: ({ projectId, taskId }, message) => {
      const outcome = holdTaskMessage(context, { projectId, taskId, message });
      if (outcome.status === 'refused') console.warn(`[STOP-SCRIPT] task ${taskId.slice(0, 8)}: no message held: ${outcome.error}`);
    },
    reportFailure: ({ projectId, taskId }, taskTitle, failure) => {
      reportStopScriptFailure(context, { projectId, taskId, taskTitle, failure });
    },
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

function targetOf(context: IpcContext, projectId: string, taskId: string): ParkedStopTarget | null {
  const projectPath = context.projectRepo.getById(projectId)?.path;
  return projectPath ? { projectId, projectPath, taskId } : null;
}

/** One attempt that never rejects, remembering a task a client held off. */
async function attemptStop(context: IpcContext, target: ParkedStopTarget, onScriptStart?: () => void): Promise<ParkedStopResult> {
  try {
    const result = await stopParkedTask(createParkedStopDeps(context), target, { onScriptStart });
    if (result === 'held-off') heldOffStops.add(target);
    return result;
  } catch (error) {
    console.warn(`[STOP-SCRIPT] parked stop failed for task ${target.taskId.slice(0, 8)} (non-fatal):`, error);
    return 'unknown';
  }
}

/**
 * Start the stop after an idle or low-memory pause. The record the pause wrote
 * says which pause it was, so a caller only names the task. Never throws.
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

/** Every open project's parked tasks a low-memory pass may stop, for projects with a script. */
function reliefTargets(context: IpcContext, now: number): ParkedStopTarget[] {
  const targets: ParkedStopTarget[] = [];
  for (const project of context.projectRepo.list()) {
    const db = getOpenProjectDb(project.id);
    if (!db || !context.boardConfigManager.getStopScriptForPath(project.path)) continue;
    for (const taskId of new SessionRepository(db).listStopEligiblePausedTasks()) {
      const attemptedAt = reliefAttemptAt.get(taskId);
      if (attemptedAt !== undefined && now - attemptedAt < RELIEF_RETRY_AFTER_MS) continue;
      targets.push({ projectId: project.id, projectPath: project.path, taskId });
    }
  }
  return targets;
}

/**
 * One low-memory pass: stop one parked task's leftovers before another idle agent
 * is paused, since a parked stack costs more and loses less. Resolves as soon as
 * a script starts, so a long stop never holds the next tick, and a stop counts as
 * that tick's one action. Tasks a client holds off stay held off.
 */
export async function relieveParkedTasks(context: IpcContext): Promise<ParkedReliefResult> {
  if (context.configManager.load().stopLeftoverProcesses === false) return 'none';
  const now = Date.now();
  for (const target of reliefTargets(context, now)) {
    const started = await new Promise<boolean>((resolve) => {
      void attemptStop(context, target, () => {
        reliefAttemptAt.set(target.taskId, now);
        resolve(true);
      }).then(() => resolve(false));
    });
    if (started) return 'started';
  }
  return heldOffStops.size > 0 ? 'held' : 'none';
}

/** Test-only: forget what is held off and what was tried. */
export function resetParkedStopsForTests(): void {
  reliefAttemptAt.clear();
  heldOffStops.clear();
}

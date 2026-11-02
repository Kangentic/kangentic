/**
 * Run the project's Stop script before a terminal transition's reap, so a stack
 * stops itself cleanly before the reap force-kills what is left of it.
 *
 * `reapTaskLeftovers` calls this, so every terminal transition is covered and a
 * new one needs no wiring. It runs where the reap runs, which on a Done or To Do
 * move, a delete, a demote and an unarchive is inside the task lock, so its
 * budget is short and shared: `STOP_SCRIPT_TERMINAL_TIMEOUT_MS` for the whole
 * call, however many tasks a project delete names. A second move of the same task
 * aborts it (`signal`). Moving the reap out of the lock would split six teardown
 * paths around an unlocked gap, which was weighed and declined.
 *
 * No connected check: at a terminal transition a client is no evidence, as at the
 * reap. The script runs for tasks that have something running, once per folder,
 * so tasks sharing the project folder do not run it twice.
 *
 * Best-effort by contract: it never throws, and a failure, a timeout or an abort
 * leaves the reap to go on.
 */

import PQueue from 'p-queue';
import type { IpcContext } from '../ipc/ipc-context';
import { isShuttingDown } from '../shutdown-state';
import { runStopScript, STOP_SCRIPT_TERMINAL_TIMEOUT_MS, stopScriptFolder } from './run-stop-script';
import { reportStopScriptFailure } from './stop-script-failure';

/** Scripts at once in one call. A project delete can name many folders. */
const TERMINAL_STOP_CONCURRENCY = 2;

interface TerminalStopTask {
  id: string;
  worktree_path: string | null;
  title?: string;
}

export async function stopBeforeReap(
  context: IpcContext,
  projectPath: string | null,
  tasks: readonly TerminalStopTask[],
  signal?: AbortSignal,
): Promise<void> {
  if (!projectPath || tasks.length === 0) return;
  try {
    const script = context.boardConfigManager.getStopScriptForPath(projectPath);
    if (!script || isShuttingDown()) return;
    if (context.configManager.load().stopLeftoverProcesses === false) return;
    const entries = await context.sessionManager.probeTaskProcesses(
      projectPath,
      tasks.map((task) => ({ id: task.id, worktreePath: task.worktree_path })),
      { connections: false },
    );
    if (!entries) return;
    const running = new Set(entries.filter((entry) => entry.processes.length > 0).map((entry) => entry.taskId));
    const taskByFolder = new Map<string, TerminalStopTask>();
    for (const task of tasks) {
      if (!running.has(task.id)) continue;
      const folder = await stopScriptFolder(task.worktree_path, projectPath);
      if (!taskByFolder.has(folder)) taskByFolder.set(folder, task);
    }
    if (taskByFolder.size === 0) return;
    const projectId = context.projectRepo.list().find((project) => project.path === projectPath)?.id ?? null;
    const deadlineAt = Date.now() + STOP_SCRIPT_TERMINAL_TIMEOUT_MS;
    const queue = new PQueue({ concurrency: TERMINAL_STOP_CONCURRENCY });
    await Promise.all([...taskByFolder].map(([folder, task]) => queue.add(async () => {
      const timeoutMs = deadlineAt - Date.now();
      if (timeoutMs <= 0 || signal?.aborted) return;
      const outcome = await runStopScript({ taskId: task.id, script, cwd: folder, timeoutMs, signal });
      if (outcome.status === 'failed' && projectId) {
        reportStopScriptFailure(context, {
          projectId,
          taskId: task.id,
          taskTitle: task.title ?? task.id.slice(0, 8),
          failure: outcome.failure,
        });
      }
    })));
  } catch (error) {
    console.warn('[STOP-SCRIPT] could not run the Stop script before the reap (non-fatal):', error);
  }
}

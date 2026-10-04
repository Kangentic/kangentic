import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { Task, WorkflowChangedEvent } from '../../shared/types';
import { sendToRenderer } from '../ipc/send-to-renderer';

/**
 * Tell an open Workflows view that a workflow changed, whoever changed it: the
 * view itself, an agent over MCP, or the engine moving a task on.
 *
 * Coalesced per workflow: a burst (a Start that creates nine tasks, a move that
 * commits and then settles) is one push after `COALESCE_MS`, and the view
 * reloads that one workflow. The view never refetches on board churn (activity,
 * PR refresh), so this push is the whole contract.
 *
 * A module of its own holding only the window, set when the engine registers,
 * like `workflow-wake.ts`, so a handler that moves or deletes a task does not
 * import the engine to say so.
 */
const COALESCE_MS = 30;

let windowGetter: (() => BrowserWindow | null) | null = null;
const pending = new Map<string, WorkflowChangedEvent>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function setWorkflowChangedWindow(getter: (() => BrowserWindow | null) | null): void {
  windowGetter = getter;
  if (!getter) {
    pending.clear();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export function notifyWorkflowChanged(projectId: string, workflowId: string): void {
  if (!windowGetter) return;
  pending.set(workflowId, { projectId, workflowId });
  if (flushTimer) return;
  flushTimer = setTimeout(flush, COALESCE_MS);
}

/** The workflow a task belongs to, if any, changed. `projectId` is the board the task is on. */
export function notifyWorkflowOfTask(task: Pick<Task, 'workflow_id' | 'workflow_project_id'> | null | undefined, projectId: string | null): void {
  if (!task?.workflow_id) return;
  const homeProjectId = task.workflow_project_id ?? projectId;
  if (homeProjectId) notifyWorkflowChanged(homeProjectId, task.workflow_id);
}

function flush(): void {
  flushTimer = null;
  const window = windowGetter?.() ?? null;
  const events = [...pending.values()];
  pending.clear();
  if (!window) return;
  for (const event of events) sendToRenderer(window, IPC.WORKFLOW_CHANGED, event);
}

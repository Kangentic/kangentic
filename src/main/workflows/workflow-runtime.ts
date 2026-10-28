import type { IpcContext } from '../ipc/ipc-context';

/**
 * The IPC context the workflow operations act through, set once when the
 * engine registers. The MCP workflow commands run with a project-scoped
 * `CommandContext` that cannot start, pause or move a task; the operations in
 * `workflow-service.ts` need the move path and the session manager, so they
 * read the one context the app has from here rather than each command growing
 * a callback per operation.
 */
let runtimeContext: IpcContext | null = null;

export function setWorkflowRuntimeContext(context: IpcContext | null): void {
  runtimeContext = context;
}

export function requireWorkflowRuntimeContext(): IpcContext {
  if (!runtimeContext) throw new Error('Workflows are not ready yet. Try again in a moment.');
  return runtimeContext;
}

/** The same context for a reader that degrades without it: null before the engine registers. */
export function workflowRuntimeContext(): IpcContext | null {
  return runtimeContext;
}

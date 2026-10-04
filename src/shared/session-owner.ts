/**
 * Who owns a live session, in one place.
 *
 * A task's agent runs under its task. A transient session runs under no task:
 * either a Command Terminal (Ctrl+Shift+P), or a workflow's own agent, which is
 * spawned transient so it inherits everything a Command Terminal is already
 * kept out of (the `sessions` table, whose `task_id` is a foreign key to tasks,
 * turn-end automations, desktop notifications, activity intervals, idle toasts,
 * the bottom panel's tabs). What a Command Terminal has that the workflow agent
 * must NOT (a window slot, the title-bar count and tone, the Monitor's terminal
 * rows) is decided by `isCommandTerminalSession`, never by `transient` alone.
 */
export interface SessionOwnerFields {
  transient?: boolean;
  /** Set only on a workflow agent's session: the workflow it plans. */
  workflowId?: string | null;
}

/** A workflow's own agent (the Workflows view's agent pane). */
export function isWorkflowAgentSession(session: SessionOwnerFields): boolean {
  return !!session.workflowId;
}

/** A Command Terminal: transient, and no workflow's agent. */
export function isCommandTerminalSession(session: SessionOwnerFields): boolean {
  return !!session.transient && !session.workflowId;
}

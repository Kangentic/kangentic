/**
 * What a workflow guard says, in one place. Main refuses with these sentences
 * (over IPC and MCP), and the Workflows view and task detail's workflow panel
 * put the same words on the control they disable, so a disabled control's
 * tooltip and the refusal its action would get can never drift apart.
 *
 * `label` names the task the way the reader sees it: "#414" once it exists,
 * its title in quotes before Start (a planned task has no number yet).
 */
export const WORKFLOW_REFUSALS = {
  /** A link onto a task that has left To Do. */
  cannotWait: (label: string) => `${label} has started. Only a task in To Do can wait for another.`,
  /** Add blocker on a task whose every other task is done, already blocks it, or waits on it. */
  noBlockerCandidates: 'No task it can wait for.',
  /** A link from a task already in Done. */
  blockerDone: (label: string) => `${label} is done. Waiting for it changes nothing.`,
  selfLink: 'A task cannot wait for itself.',
  alreadyWaits: (blockedLabel: string, blockerLabel: string) => `${blockedLabel} already waits for ${blockerLabel}.`,
  loop: 'That link closes a loop. A workflow\'s links cannot go in a circle.',
  /** Removing a link whose waiting task has started, or whose blocker is done. */
  unlinkChangesNothing: (label: string, fact: 'is done' | 'has started') => `${label} ${fact}. Removing the link changes nothing.`,
  /** Removing a task in Done from its workflow. */
  doneStays: (label: string) => `${label} is done and stays with its workflow.`,
  routeEmpty: 'A task visits at least one column.',
  /** A route step at or before the column the task is in (finished, current, or skipped on the way). */
  stepReached: (label: string, columnName: string) => `${label} has reached ${columnName}. Only the columns after it can change.`,
  /** A plan approval change on a task past its last plan column. */
  planPassed: (label: string, columnName: string) => `${label} has passed ${columnName}. Its plan approval can no longer change.`,
  /** A plan approval change on a task in Done. */
  planDone: (label: string) => `${label} is done. Its plan approval can no longer change.`,
  /** A plan approval value outside the two, from an IPC, MCP or mobile caller. */
  planApprovalValue: 'planApproval must be "automatic", "manual", or null.',
  /** kangentic_save_workflow's removed workflow-level planApproval. */
  planApprovalPerTask: 'planApproval is set per task now. Put planApproval on each task entry.',
  /** A plan approval change, over MCP, on a task in no workflow. */
  notInWorkflow: (label: string) => `${label} is not in a workflow. Its column's Plan approval decides; change that with kangentic_update_column.`,
  /** While the workflow agent's turn runs, whatever would change its plan waits. */
  agentWorking: 'Available when the workflow agent finishes',
  /** A move of a running workflow's task that only the workflow may make. */
  locked: (label: string, workflowTitle: string) => `${label} is locked while ${workflowTitle} runs.`,
  /** A move into To Do, which would delete the task's worktree and branch. */
  toDoNeedsRemove: (label: string, workflowTitle: string) => `${label} is in ${workflowTitle}. Remove it from the workflow to move it to To Do.`,
  /** An agent's move of a paused workflow's task (a person may still move it by hand). */
  pausedForAgents: (label: string, workflowTitle: string) => `${label} is in ${workflowTitle}, which is paused. Resume it to move its tasks.`,
  /** Starting a paused workflow's task on its own (the phone's Start), which Resume does for all of them. */
  pausedStart: (label: string, workflowTitle: string) => `${label} is in ${workflowTitle}, which is paused. Resume the workflow to start its tasks again.`,
  /** Sending a workflow task to the backlog or the archive. */
  removeFirst: (label: string, workflowTitle: string) => `Remove ${label} from ${workflowTitle} first.`,
  /**
   * A workflow its home does not hold: deleted, or its home project is. A task
   * detail's workflow panel reads this sentence in a failed read to tell a
   * workflow that is gone from one that could not be read this time.
   */
  notFound: (workflowSelector: string) => `No workflow "${workflowSelector}" in this project.`,
} as const;

/** How a task is named in a refusal: its number once it exists, its title before Start. */
export function workflowTaskLabel(displayId: number | null | undefined, title: string): string {
  return displayId ? `#${displayId}` : `"${title}"`;
}

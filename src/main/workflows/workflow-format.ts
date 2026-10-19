import type { Workflow } from '../../shared/types';
import type { WorkflowTaskView, WorkflowView } from './workflow-service';

/**
 * The text an agent reads for a workflow: what `kangentic_get_workflow`
 * answers, and the saved plan a workflow agent's new conversation starts from
 * (`buildWorkflowAgentContinueMessage`). Kept apart from the MCP command shells
 * so the workflow agent can use it without importing them, which import it.
 */

/** A workflow's state as an agent reads it. */
export function describeState(workflow: Workflow): string {
  return workflow.state === 'draft' ? 'not started' : workflow.state === 'done' ? 'complete' : workflow.state;
}

/** The text an agent reads back for a workflow. */
export function formatWorkflow(view: WorkflowView): string {
  const { workflow } = view;
  const lines = [
    `Workflow "${workflow.title}" (id ${workflow.id}), ${describeState(workflow)}, revision ${workflow.revision}.`,
  ];
  if (workflow.brief) lines.push(`Brief: ${workflow.brief}`);
  // As save_workflow's own `planApproval`, so a plan read and sent back keeps it.
  lines.push(workflow.plan_approval
    ? `Plan approval: planApproval "${workflow.plan_approval}".`
    : 'Plan approval: follows the plan columns on the tasks\' routes (planApproval null).');
  if (view.tasks.length === 0) {
    lines.push('No tasks yet.');
  } else {
    const doneCount = view.tasks.filter((task) => task.place === 'done').length;
    if (workflow.state !== 'draft') lines.push(`${doneCount} of ${view.tasks.length} done.`);
    lines.push('Tasks:');
    for (const task of view.tasks) {
      const label = workflow.state === 'draft' ? `[${task.key}]` : task.key;
      const waits = task.waitsFor.length > 0 ? ` Waits for ${task.waitsFor.join(', ')}.` : '';
      const route = task.route.length > 0 ? task.route.join(' > ') : '(no columns: straight to Done)';
      const settings = workflow.state === 'draft' ? describeRunSettings(task) : '';
      // A planned task's board is in its settings, as save_workflow's `project`.
      const board = task.board !== null && workflow.state !== 'draft' ? ` on board "${task.board}"` : '';
      lines.push(`- ${label} ${task.title}. In ${task.column}${board}. Route: ${route}.${waits}${settings}`);
    }
  }
  return lines.join('\n');
}

/**
 * A planned task's run settings in kangentic_save_workflow's own parameter
 * names, so a plan read and sent back keeps them (a save replaces the whole
 * plan). Empty for the defaults: Column Settings on the board's base branch.
 */
function describeRunSettings(task: WorkflowTaskView): string {
  const settings = task.runSettings;
  const parts: string[] = [];
  if (task.board !== null) parts.push(`project "${task.board}"`);
  if (settings.base_branch) parts.push(`baseBranch "${settings.base_branch}"`);
  if (settings.use_worktree !== null) parts.push(`useWorktree ${settings.use_worktree === 1}`);
  if (task.profileName) parts.push(`profile "${task.profileName}"`);
  if (settings.run_mode === 'agent_override') parts.push('runMode "agent_override"');
  if (settings.agent_override) parts.push(`agentOverride "${settings.agent_override}"`);
  if (settings.model_override) parts.push(`modelOverride "${settings.model_override}"`);
  if (settings.effort_override) parts.push(`effortOverride "${settings.effort_override}"`);
  if (settings.permission_mode) parts.push(`permissionMode "${settings.permission_mode}"`);
  return parts.length > 0 ? ` Settings: ${parts.join(', ')}.` : '';
}

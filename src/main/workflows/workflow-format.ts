import type { Workflow } from '../../shared/types';
import { taskPlanApprovalSentence } from '../../shared/plan-approval';
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
  lines.push(describePlanApproval(view));
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
      const stalled = task.stalled ? ` Stalled: ${task.stalled}` : '';
      const held = task.automationsPaused
        ? ' Automations paused: the workflow does not judge, move or start it until they resume.'
        : '';
      // What happens and where it comes from, so an agent never reads a board's columns to learn it.
      const planApproval = ` ${taskPlanApprovalSentence(task.planApproval)}`;
      lines.push(`- ${label} ${task.title}. In ${task.column}${board}. Route: ${route}.${waits}${settings}${planApproval}${held}${stalled}`);
    }
  }
  return lines.join('\n');
}

/** The workflow's plan approval line: set per task, with how many tasks each way. */
function describePlanApproval(view: WorkflowView): string {
  const resolved = view.tasks.flatMap((task) => (task.planApproval ? [task.planApproval] : []));
  if (resolved.length === 0) return 'Plan approval: set per task (planApproval on each task). No task\'s route has a plan column.';
  const manual = resolved.filter((planApproval) => planApproval.value === 'manual').length;
  const automatic = resolved.length - manual;
  return `Plan approval: set per task. ${manual} ${manual === 1 ? 'task' : 'tasks'} Manual, ${automatic} Automatic; each task's line says why.`;
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
  // What the task carries, even with no plan column on its route: a save sends it back.
  if (task.ownPlanApproval) parts.push(`planApproval "${task.ownPlanApproval}"`);
  return parts.length > 0 ? ` Settings: ${parts.join(', ')}.` : '';
}

import type { TaskPlanApproval, Workflow } from '../../shared/types';
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
  if (view.hiddenBoards.length > 0) {
    lines.push(`Held: it has tasks on ${view.hiddenBoards.join(', ')}, whose SSH host was removed. Only adding the host again brings them back, and it cannot resume or complete until then. The tasks below are the ones that can be read.`);
  }
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
      // What happens and where it comes from, so an agent never reads a board's columns to learn it.
      const planApproval = ` ${taskPlanApprovalSentence(task.planApproval)}`;
      lines.push(`- ${label} ${task.title}. In ${task.column}${board}. Route: ${route}.${waits}${settings}${planApproval}${stalled}`);
    }
  }
  return lines.join('\n');
}

/** "a", "a and b", or "a, b and c"; empty for no items. */
export function listOf(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** A started task's number: "#12" on the home board, `"kangentic-mobile" #3` on another. */
export function boardTaskLabel(board: string | null, displayId: number): string {
  return board === null ? `#${displayId}` : `"${board}" #${displayId}`;
}

/**
 * How the reply clause names a task whose plan waits: by key while it is only
 * planned (it has no number yet, and the plan read names it so), by number
 * once started. Then where it waits: the plan column that holds it to Manual,
 * or, for an Automatic task, the agent whose plans Kangentic cannot approve
 * (the type does not say which of its plan columns that agent runs in).
 */
function waitingTaskLabel(task: WorkflowTaskView, isDraft: boolean, planApproval: TaskPlanApproval): string {
  const name = isDraft || task.displayId === null ? `[${task.key}]` : boardTaskLabel(task.board, task.displayId);
  const where = planApproval.value === 'manual' ? planApproval.column.name : `${planApproval.waitingAgentName}'s plans`;
  return `${name} (${where})`;
}

/**
 * The plan approval clause the Save and Start replies end with: the counts,
 * then the tasks whose plans wait for a person, by name. A task counted
 * Automatic still waits when a plan column on its route runs an agent
 * Kangentic cannot approve plans for, so it is named too. Empty when no
 * task's route has a plan column. Start is where a Manual plan column turns
 * into a card that stops, so the reply says so without a separate read.
 */
export function describePlanApprovalForReply(view: WorkflowView): string {
  if (!view.tasks.some((task) => task.planApproval)) return '';
  const isDraft = view.workflow.state === 'draft';
  const waitingTasks = view.tasks.flatMap((task) => {
    const planApproval = task.planApproval;
    if (!planApproval) return [];
    const waits = planApproval.value === 'manual' || planApproval.waitingAgentName !== null;
    return waits ? [waitingTaskLabel(task, isDraft, planApproval)] : [];
  });
  // The reply has no task lines, so the count ends the sentence and the
  // pointer to the why is kangentic_get_workflow, not "each task's line".
  const summary = `${planApprovalCounts(view)}.`;
  if (waitingTasks.length === 0) return summary;
  const waitsPhrase = waitingTasks.length === 1 ? 'Waits for you after its plan' : 'Wait for you after their plans';
  return `${summary} ${waitsPhrase}: ${listOf(waitingTasks)}. kangentic_get_workflow says why.`;
}

/**
 * "Plan approval: set per task. 1 task Manual, 4 Automatic", over the tasks
 * whose route has a plan column. Its callers return their own line first when
 * no task has one, so it never prints "0 tasks Manual, 0 Automatic".
 */
function planApprovalCounts(view: WorkflowView): string {
  const resolved = view.tasks.flatMap((task) => (task.planApproval ? [task.planApproval] : []));
  const manual = resolved.filter((planApproval) => planApproval.value === 'manual').length;
  const automatic = resolved.length - manual;
  return `Plan approval: set per task. ${manual} ${manual === 1 ? 'task' : 'tasks'} Manual, ${automatic} Automatic`;
}

/** The workflow's plan approval line: set per task, with how many tasks each way. */
function describePlanApproval(view: WorkflowView): string {
  if (!view.tasks.some((task) => task.planApproval)) return 'Plan approval: set per task (planApproval on each task). No task\'s route has a plan column.';
  return `${planApprovalCounts(view)}; each task's line says why.`;
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
  // A task the plan takes in at Start, by its id (an id names it on any board).
  // Without it a read and save back would plan a new task in its place.
  if (task.taskId) parts.push(`existingTask "${task.taskId}"`);
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

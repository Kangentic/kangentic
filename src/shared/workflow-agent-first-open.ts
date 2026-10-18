import type { Workflow } from './types';

/**
 * A workflow whose plan no workflow agent has seen: it has tasks and no agent
 * recorded. Usually another session (a Command Terminal, a task's agent, an
 * outside CLI) created and planned it over MCP. A workflow made in the view has
 * no tasks until its agent plans, unless its agent could not start (the setting
 * incomplete, the CLI missing, the MCP server off) and the user planned by hand,
 * which counts the same: no agent has seen that plan either. A finished
 * workflow has nothing to plan.
 *
 * Opening it starts nothing (main's `openWorkflowAgent`), and the view's pane
 * opens folded to its strip for the plan's room (`WorkflowAgentPane`). One rule
 * for both, read in the renderer from the picker's summary, so the pane folds
 * on its first frame rather than a frame after main's answer.
 *
 * `taskCount` is the plan's: the draft's tasks before Start, the board's after.
 */
export function awaitsFirstAgent(workflow: Pick<Workflow, 'state' | 'agent_name'>, taskCount: number): boolean {
  return workflow.state !== 'done' && workflow.agent_name === null && taskCount > 0;
}

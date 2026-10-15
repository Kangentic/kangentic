import type { IpcContext } from '../ipc/ipc-context';
import type { AutomationTrigger, Swimlane, Workflow } from '../../shared/types';
import type { TaskTemplateVarName } from '../../shared/task-template-vars';
import { getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { TaskMoveRepository } from '../db/repositories/task-move-repository';
import { AutomationRepository } from '../db/repositories/automation-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { buildBriefXml, escapeXml } from '../agent/shared/prompt-xml';
import { INLINE_PROMPT_BUDGET } from '../agent/shared/prompt-budget';
import { interpolateTaskTemplate } from '../agent/shared/template-utils';
import { resolveProjectDefaultBaseBranch } from '../ipc/helpers/default-base-branch';
import { resolveProjectRoot } from '../../shared/git-utils';
import { doneColumn, routeCandidates } from '../../shared/workflow-route';
import { formatWorkflow } from './workflow-format';

/**
 * The first message a workflow's own agent gets, resolved from its template
 * (`DEFAULT_WORKFLOW_AGENT_PROMPT`, or the user's own from Settings). The
 * template's own text goes in raw, since its tags are structure the agent reads,
 * and every value is escaped, as a column prompt's are.
 */

/** How many recently finished tasks `{{columns}}` counts. */
const RECENT_FINISHED_TASKS = 10;

const TRIGGER_PHRASES: Record<AutomationTrigger, string> = {
  enter: 'when a task enters',
  turn_end: 'when its agent ends a turn',
  exit: 'when a task leaves',
};

function describeRun(lane: Swimlane): string {
  if (!lane.auto_spawn) return 'No agent starts here.';
  const agent = lane.permission_mode === 'plan' ? 'An agent in plan mode' : 'An agent';
  const session = lane.session_target === 'isolated' ? ' in a session of its own' : '';
  const command = lane.auto_command?.trim() ? `, which runs ${escapeXml(lane.auto_command.trim())}` : '';
  return `${agent}${session}${command}.`;
}

/**
 * `{{columns}}`: one line per column a task can visit (those between To Do and
 * Done), in board order, with what it runs, its automations, and how many of the
 * last finished tasks went through it. The counts are left out until any task
 * has finished, so a new board says nothing it cannot back.
 */
export function describeColumnsForPlanning(projectId: string): string {
  let lanes: Swimlane[];
  try {
    lanes = new SwimlaneRepository(getProjectDb(projectId)).list();
  } catch {
    return '';
  }
  // The route's own helpers: Done is the board's archive lane (`is_archived`),
  // so a filter on that flag would lose it, and with it every count.
  const doneLane = doneColumn(lanes);
  const routeLanes = routeCandidates(lanes);
  let finished = 0;
  let visits = new Map<string, number>();
  let automationsByLane = new Map<string, string[]>();
  try {
    const database = getProjectDb(projectId);
    if (doneLane) ({ finished, visits } = new TaskMoveRepository(database).recentFinishedColumnVisits(doneLane.id, RECENT_FINISHED_TASKS));
    automationsByLane = new Map(routeLanes.map((lane) => [
      lane.id,
      new AutomationRepository(database).listForColumn(lane.id)
        .filter((automation) => automation.enabled)
        .map((automation) => `${escapeXml(automation.name)} (${TRIGGER_PHRASES[automation.trigger] ?? automation.trigger})`),
    ]));
  } catch (error) {
    // A database that cannot be read leaves the lines without counts or
    // automations; said, since the agent then plans without the board's history.
    console.warn('[WORKFLOW-AGENT] Could not read the board history for {{columns}}:', error);
  }
  return routeLanes.map((lane, index) => {
    const parts = [`${index + 1}. ${escapeXml(lane.name)}: ${describeRun(lane)}`];
    const purpose = lane.description?.trim();
    if (purpose) parts.push(`Its purpose: ${escapeXml(purpose)}`);
    const automations = automationsByLane.get(lane.id) ?? [];
    if (automations.length > 0) parts.push(`Automations: ${automations.join(', ')}.`);
    if (finished > 0) parts.push(`${visits.get(lane.id) ?? 0} of the last ${finished} finished tasks went through it.`);
    return parts.join(' ');
  }).join('\n');
}

/**
 * `{{brief_xml}}`: what the workflow was made from, or nothing for one made from
 * nothing. The brief is stored once as the source task's title, a blank line,
 * and its description, so its first line is the title.
 */
export function briefXmlOf(homeProjectId: string, workflow: Workflow): string {
  const brief = workflow.brief?.trim();
  if (!brief) return '';
  const newline = brief.indexOf('\n');
  const title = newline === -1 ? brief : brief.slice(0, newline).trim();
  const description = newline === -1 ? '' : brief.slice(newline + 1).trim();
  let sourceTaskNumber: number | null = null;
  if (workflow.source_task_id) {
    try {
      sourceTaskNumber = new TaskRepository(getProjectDb(homeProjectId)).getById(workflow.source_task_id)?.display_id ?? null;
    } catch {
      // The number is a nicety; the brief stands without it.
    }
  }
  return buildBriefXml({ sourceTaskNumber, title, description });
}

/**
 * Every variable the first message offers (`templateVarsFor('workflow')`),
 * each filled below; `workflow-agent-prompt.test.ts` holds the two lists equal.
 */
export const WORKFLOW_AGENT_VARIABLE_NAMES = [
  'projectName',
  'projectPath',
  'baseBranch',
  'columns',
  'brief_xml',
] as const satisfies readonly TaskTemplateVarName[];

/** The workflow agent's first message, from `template` with its variables filled in. */
export function buildWorkflowAgentFirstMessage(
  context: IpcContext,
  homeProjectId: string,
  workflow: Workflow,
  template: string,
): string {
  const project = context.projectRepo.getById(homeProjectId);
  const projectPath = project ? resolveProjectRoot(project.path) : '';
  const variables: Record<(typeof WORKFLOW_AGENT_VARIABLE_NAMES)[number], string> = {
    projectName: escapeXml(project?.name ?? ''),
    projectPath: escapeXml(projectPath),
    baseBranch: escapeXml(projectPath ? resolveProjectDefaultBaseBranch(context, projectPath) : 'main'),
    columns: describeColumnsForPlanning(homeProjectId),
    brief_xml: briefXmlOf(homeProjectId, workflow),
  };
  return interpolateTaskTemplate(template, variables);
}

/**
 * The first message of a new conversation for a workflow that already has a
 * plan, because its agent's earlier conversation cannot be resumed (its id was
 * never captured, or the CLI could not find it). The template's message, then
 * the saved plan and what to do with it, so the agent builds on the plan rather
 * than planning from the brief again: a save replaces the whole plan, so a fresh
 * plan saved over it would lose every task the user already shaped.
 *
 * Null when nothing is saved yet: there is nothing to continue, and the caller
 * sends the first message as for a new workflow. Not a template variable, so a
 * customized template gets it too.
 */
export async function buildWorkflowAgentContinueMessage(
  context: IpcContext,
  homeProjectId: string,
  workflow: Workflow,
  template: string,
): Promise<string | null> {
  // Loaded on use: the service ends workflow agents, so a static import here
  // would close a cycle through `workflow-agent.ts`.
  const { readWorkflow } = await import('./workflow-service');
  let savedPlan: string;
  try {
    const view = readWorkflow(context, homeProjectId, workflow.id);
    if (view.tasks.length === 0) return null;
    savedPlan = escapeXml(formatWorkflow(view));
  } catch (error) {
    console.warn('[WORKFLOW-AGENT] Could not read the saved plan for a new conversation:', error);
    return null;
  }
  const firstMessage = buildWorkflowAgentFirstMessage(context, homeProjectId, workflow, template);
  const toBuildOn = 'Build on it instead of planning again: saving replaces the whole plan, so keep every task you are not changing. Reply in one line that you have the plan, and ask what the user wants to change.';
  // The message rides the command line, 8,191 characters under a cmd.exe
  // shell, and a long plan would leave the start that recovers a lost
  // conversation unable to start. The first message counts too: a board with
  // many columns or a long custom template fills much of that line by itself.
  // Past the budget the agent reads the plan itself; `kangentic_get_workflow`
  // answers with its own workflow's.
  if (firstMessage.length + savedPlan.length > INLINE_PROMPT_BUDGET) {
    return [
      firstMessage,
      '',
      `This workflow already has a saved plan, from an earlier conversation that could not be resumed. Read it first with kangentic_get_workflow. ${toBuildOn}`,
    ].join('\n');
  }
  return [
    firstMessage,
    '',
    '<saved_plan>',
    savedPlan,
    '</saved_plan>',
    `This workflow already has the plan in <saved_plan>, from an earlier conversation that could not be resumed. ${toBuildOn}`,
  ].join('\n');
}

import type { IpcContext } from '../ipc/ipc-context';
import type { AutomationTrigger, Swimlane, Workflow } from '../../shared/types';
import type { TaskTemplateVarName } from '../../shared/task-template-vars';
import { getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { TaskMoveRepository } from '../db/repositories/task-move-repository';
import { AutomationRepository } from '../db/repositories/automation-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { buildBriefXml, escapeXml } from '../agent/shared/prompt-xml';
import { interpolateTaskTemplate } from '../agent/shared/template-utils';
import { resolveProjectDefaultBaseBranch } from '../ipc/helpers/default-base-branch';
import { resolveProjectRoot } from '../../shared/git-utils';

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
    lanes = new SwimlaneRepository(getProjectDb(projectId)).list().filter((lane) => !lane.is_archived && !lane.is_ghost);
  } catch {
    return '';
  }
  const doneLane = lanes.find((lane) => lane.role === 'done') ?? null;
  const routeLanes = lanes.filter((lane) => lane.role !== 'todo' && lane.role !== 'done');
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
  } catch {
    // A database that cannot be read leaves the lines without counts or automations.
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

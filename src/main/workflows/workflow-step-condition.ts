import type { Swimlane, Task } from '../../shared/types';
import { doneColumn, nextOnRoute, routeCandidates, routeColumns } from '../../shared/workflow-route';

/**
 * What the workflow's step check asks the Automation agent at a turn end, and
 * the route it is told. Pure: no database, no Electron, so the check's wording
 * is unit tested and measured against real final messages on its own.
 *
 * - The route always wins over the task's own words (user's call, 2026-10-04).
 *   The check is told the route, which column is its last and which it skips,
 *   so a description written before a route edit ("Done when the PR is merged")
 *   cannot hold a task whose route no longer reaches the column that merges.
 * - At the route's last column the task has reached the end of the road unless
 *   its agent's final message waits on the user, so that is all the check asks
 *   there. The check answers yes only on facts, so when it is unsure the task
 *   stays. Structured asks (a permission prompt, a question tool, a plan to
 *   approve) never get here: the agent is mid-turn, and no turn has ended.
 * - Before the last column it judges the column's work, given the route, so a
 *   turn that ends early (a progress note mid-work) does not skip the work.
 */

/** Where the task's route goes from the column it is in, for the check to read. */
export interface StepRoute {
  /** The route's columns in order, then the board's Done column. */
  steps: string[];
  /** Columns between To Do and Done the route does not visit. */
  skipped: string[];
  /** The column the task is in is the route's last: the next stop is Done. */
  isLast: boolean;
}

type StepColumn = Pick<Swimlane, 'id' | 'name' | 'position' | 'role' | 'is_archived' | 'is_ghost'>;
type StepTask = Pick<Task, 'route_start_swimlane_id' | 'route_last_swimlane_id' | 'skipped_swimlane_ids'>;

export function describeStepRoute(columns: readonly StepColumn[], task: StepTask, currentColumnId: string): StepRoute {
  const route = routeColumns(columns, task);
  const onRoute = new Set(route.map((column) => column.id));
  const done = doneColumn(columns);
  const next = nextOnRoute(columns, task, currentColumnId);
  return {
    steps: [...route.map((column) => column.name), ...(done ? [done.name] : [])],
    skipped: routeCandidates(columns).filter((column) => !onRoute.has(column.id)).map((column) => column.name),
    isLast: next === null || next.role === 'done',
  };
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function routeLine(route: StepRoute, currentName: string): string {
  const steps = route.steps.map((name) => (name === currentName ? `${name} (this step)` : name)).join(', then ');
  return route.skipped.length > 0 ? `${steps}; it skips ${listNames(route.skipped)}` : steps;
}

const WAITS_ON_NO_ONE = 'the final message is not waiting on the user for an answer, a decision or an approval';

/**
 * The last column's wording was measured (2026-10-04) on 90 real turn endings
 * from this repo's own task sessions plus 16 written ones, three runs each on
 * Haiku at low effort, against a version that asked only whether the message
 * waits on the user. That version held 22 of 29 finished reports and once
 * answered yes while its own reason said the agent was waiting; this one moved
 * every written finished report, held every written question and progress
 * note, and misjudged 2 of 68 real asks or progress notes in at least one run.
 */
export function workflowStepCondition(column: Pick<Swimlane, 'name' | 'description'>, route: StepRoute): string {
  if (route.isLast) {
    return `The ${column.name} step is the last on the task's route (${routeLine(route, column.name)}). The task is finished when `
      + 'the agent\'s final message reports its work as done, not as still under way (a progress note such as "running the tests '
      + `now" is not done), and ${WAITS_ON_NO_ONE}. Anything the task's description asks of a column the route skips does not apply.`;
  }
  const purpose = column.description?.trim();
  return `The work of the ${column.name} step is done${purpose ? ` (the column's purpose: ${purpose})` : ''}, and ${WAITS_ON_NO_ONE}. `
    + `The task's route: ${routeLine(route, column.name)}. Judge only the ${column.name} step: anything the task's `
    + 'description asks of a later step, or of a column the route skips, does not apply here.';
}

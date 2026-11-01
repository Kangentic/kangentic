import type { Swimlane, Task } from '../../shared/types';
import { finalMatchLine, lineMatchesPattern, shownFinalLine, textMatchCanMatch } from '../../shared/final-line-match';
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
 * - A column's own Text match exit rows outrank its yes (`stepExitVerdict`).
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

/**
 * What a stalled agent is stuck on, as far as its reply says: the kinds the
 * unblock nudge has a specific instruction for (`nudgeMessage`,
 * `workflow-recovery.ts`). Read by the second ask, made only when the step is
 * not done and no work of the agent's own is still running (`workflow-step.ts`).
 *
 * - `resource`: a command, a test run or the gate was stopped or failed because
 *   the machine ran low on memory or was too busy. Claude Code's memory reaper
 *   tells the agent "do not start it again on your own", and an agent that saw
 *   its gate fail on load wrote "the gate needs a run on a quieter machine".
 *   Neither is a question for the owner; the nudge says when to run it again.
 * - `main-fails-too`: the failures it is stuck on also happen on the base
 *   branch. One agent showed this and was still nudged that its gate was not
 *   green, and spent two hours fixing a race the base branch fixed on its own.
 *
 * This ask replaced the one that decided whether the agent waited on the user
 * or on running work (owner's decision, 2026-10-31). Waiting on the owner is
 * the agent's own call now, made with the `Needs owner:` line
 * (`src/shared/workflow-needs-owner.ts`); running work comes from the hook
 * events (`SessionManager.getOpenWork`), never from the reply's wording, which
 * once read one gate as still running and, three hours later, as not done.
 *
 * Unsure answers no, as every Condition does, and a reply with no named
 * blocker gets the general nudge. Both rows are one call, the cost of the ask
 * they replaced.
 */
export type WorkflowBlocker = 'resource' | 'main-fails-too';

/** The blocker rows of the second ask, each with the blocker its yes names. */
export function workflowBlockerConditions(
  column: Pick<Swimlane, 'name'>,
  baseBranch: string,
): Array<{ blocker: WorkflowBlocker; condition: string }> {
  return [
    {
      blocker: 'resource',
      condition: `The agent's final message says a command, a test run, a build or the gate it ran for the ${column.name} step `
        + 'was stopped, killed or failed because the machine ran low on memory or was too busy (other runs at the same time, '
        + 'a memory limit, a process reaper, timeouts under load), and not because of a mistake in the code.',
    },
    {
      blocker: 'main-fails-too',
      condition: `The agent's final message says that some or all of the failures it is stuck on also happen on ${baseBranch} `
        + '(the base branch, without this task\'s changes), so they are not caused by this task.',
    },
  ];
}

/** One of a column's exit rows: a turn-end row that moves the task, behind a Text match. */
export interface StepExitRow {
  /** The row's Text match. */
  finalLine: string;
  /** The column the row moves the task to, or null when its target names no column. */
  target: Pick<Swimlane, 'name' | 'position' | 'role'> | null;
}

export type StepExitVerdict = { accepted: true } | { accepted: false; reason: string };

/**
 * What a column's own exit rows make of the reply the step check judged done.
 *
 * A column that routes on exact final lines ("Verdict: Ready" on to Testing,
 * "Verdict: Blocked" back to Executing) has said what finishes its step, and a
 * measured check must not overrule it: task 916 left Code Review on "No changes
 * to review.", which neither row matched, and the check moved it on. So:
 *
 * - A final line a row that moves the task forward matches: accepted, and the
 *   check's answer stands. Forward is Done or a later column by position, not
 *   the route's next column, so a route that skips the column a row names still
 *   accepts that row's line.
 * - A final line only a row sending the task back matches: refused. The row
 *   moved the task already, unless its Frequency is spent or no row ran (a
 *   resume's catch-up, recovery), and then the step must not send it forward.
 * - No match, in a column with a forward row: refused.
 * - Null otherwise (no exit rows, or only send-back rows and no match): the
 *   check alone judges, as on a column whose forward exit is the step itself.
 *
 * The reason is a fact, never the line to type: a reviewer nudged with "end on
 * Verdict: Ready" could type just that. A row whose Text match can match no
 * line is not an exit, since it never runs.
 */
export function stepExitVerdict(
  column: Pick<Swimlane, 'name' | 'position'>,
  exitRows: readonly StepExitRow[],
  agentReply: string | null,
): StepExitVerdict | null {
  const exits = exitRows.filter((row) => textMatchCanMatch(row.finalLine));
  if (exits.length === 0) return null;
  const isForward = (row: StepExitRow): boolean => row.target !== null && (row.target.role === 'done' || row.target.position > column.position);
  const line = finalMatchLine(agentReply);
  const matched = line === null ? [] : exits.filter((row) => lineMatchesPattern(row.finalLine, line));
  if (matched.some(isForward)) return { accepted: true };
  const sendBack = matched.find((row) => row.target !== null && !isForward(row));
  if (line !== null && sendBack?.target) {
    return { accepted: false, reason: `the final line, "${shownFinalLine(line)}", sends the task back to ${sendBack.target.name}` };
  }
  if (!exits.some(isForward)) return null;
  if (line === null) return { accepted: false, reason: 'the turn ended without a final message' };
  return { accepted: false, reason: `the final line, "${shownFinalLine(line)}", is not one ${column.name} moves the task on from` };
}

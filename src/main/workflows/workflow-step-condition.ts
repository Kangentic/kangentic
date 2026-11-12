import type { ColumnAutomation, Swimlane, Task } from '../../shared/types';
import { automationMovesTask, automationMoveTargetName, canColumnRun } from '../../shared/automation-manifest';
import { finalMatchLine, shownFinalLine, textMatchCanMatch, textMatchMatches } from '../../shared/final-line-match';
import { doneColumn, isForwardOf, nextOnRoute, routeCandidates, routeColumns, type RouteFields } from '../../shared/workflow-route';
import { resolveMoveTarget } from '../automations/move-target';
import { hasFinalLine } from '../automations/row-guards';

/**
 * What the workflow's step check asks the Automation agent at a turn end, the
 * route it is told, and which of a column's rows are its exits (read by the
 * planner's `{{columns}}` too). Pure: no database, no Electron, so the check's wording
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
 * - A column whose only exit rows send a task back is a person's gate, so the
 *   check asks a different question there (`personGateCondition`).
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
 * The check in a column whose only exit rows send a task back. Its yes moves
 * nothing: it means the agent has finished what it can do alone, so the card
 * stops and the owner is told (owner's decision, 2026-11-05). The usual wording
 * asks whether the step is done, and a column that says "stays until a reviewer
 * approves" made that a coin toss: on one PR state it held six tasks and moved
 * three on, and each no sent an agent with nothing left to do a nudge to carry
 * on. So a wait on a person is a yes here, and only work the agent can still do
 * is a no. Measured with `scripts/eval-condition-check.mjs` on 15 real turn
 * endings from such a column, three runs each on Haiku at low, against hand
 * labels. It got 43 of 45 right, and the usual wording got 17 of 45.
 */
function personGateCondition(column: Pick<Swimlane, 'name' | 'description'>, route: StepRoute): string {
  const purpose = column.description?.trim();
  return `The agent has finished what it can do alone in the ${column.name} step${purpose ? ` (the column's purpose: ${purpose})` : ''}: `
    + 'what is left, if anything, waits on a person or on something outside the agent\'s control, such as a review or an approval. '
    + 'A person moves this card on, so a step that still waits for that counts as finished here. It is not finished while something the '
    + `agent can still fix or do itself is left, such as a failing check or uncommitted work. The task's route: ${routeLine(route, column.name)}.`;
}

/**
 * The last column's wording was measured (2026-10-04) on 90 real turn endings
 * from this repo's own task sessions plus 16 written ones, three runs each on
 * Haiku at low effort, against a version that asked only whether the message
 * waits on the user. That version held 22 of 29 finished reports and once
 * answered yes while its own reason said the agent was waiting; this one moved
 * every written finished report, held every written question and progress
 * note, and misjudged 2 of 68 real asks or progress notes in at least one run.
 */
export function workflowStepCondition(
  column: Pick<Swimlane, 'name' | 'description'>,
  route: StepRoute,
  options: { sendBackOnly?: boolean } = {},
): string {
  if (options.sendBackOnly) return personGateCondition(column, route);
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

/**
 * `stopsHere`: the check's yes stands, but only a person moves the card on, so
 * the task stops rather than moves.
 */
export type StepExitVerdict = { accepted: true; stopsHere?: true } | { accepted: false; reason: string };

/**
 * The column's exit rows: those of its enabled turn-end rows (`turnEndRows`)
 * that move the task behind a Text match, each with the column it sends the
 * task to, resolved as the row's own move resolves it (`move-from-row.ts`). The
 * filter is the turn-end runner's own (`automation-runner.ts`: a Text match,
 * `canColumnRun`), less Frequency and Condition, which decide whether a row
 * runs, not where it sends the task. A spent forward row still says what
 * finishes the step, and the step is what moves the task on once the row no
 * longer can. `route` is the task's route, or null for the board's own order,
 * which is what a workflow's planner reads before any task exists.
 */
export function columnExitRows(
  turnEndRows: readonly ColumnAutomation[],
  columns: readonly Swimlane[],
  column: Swimlane,
  route: RouteFields | null,
): StepExitRow[] {
  const facts = { autoSpawn: column.auto_spawn, role: column.role };
  const exitRows: StepExitRow[] = [];
  for (const row of turnEndRows) {
    if (!hasFinalLine(row) || !automationMovesTask(row.type) || !canColumnRun(row.type, facts, 'turn_end').ok) continue;
    const target = resolveMoveTarget(columns, column.id, automationMoveTargetName(row.type, row.config), route);
    exitRows.push({ finalLine: row.final_line, target: target.ok ? target.column : null });
  }
  return exitRows;
}

/** A row that can run, whose Text match can match a line. */
function liveExitRows(exitRows: readonly StepExitRow[]): StepExitRow[] {
  return exitRows.filter((row) => textMatchCanMatch(row.finalLine));
}

/**
 * Does this column say how a task goes back, and leave the way on to a person?
 * Its exit rows send a task to a known column, and none of them sends it forward.
 */
export function isSendBackOnly(column: Pick<Swimlane, 'position'>, exitRows: readonly StepExitRow[]): boolean {
  const targets = liveExitRows(exitRows).flatMap((row) => (row.target ? [row.target] : []));
  return targets.length > 0 && !targets.some((target) => isForwardOf(target, column));
}

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
 *   the route's next column. A row's target here is where the row really sends
 *   the task (`resolveMoveTarget`), so a route that skips the column a row names
 *   still accepts that row's line, and the row lands on the route's next column.
 * - A final line only a row sending the task back matches: refused. The row
 *   moved the task already, unless its Frequency is spent or no row ran (a
 *   resume's catch-up, recovery), and then the step must not send it forward.
 * - No match, in a column with a forward row: refused.
 * - No match, in a column with only send-back rows: a yes that stops the card
 *   (`stopsHere`). The step never moves a task out of such a column, so a review
 *   gate has one deterministic answer and an unattended run cannot merge past it.
 *   A board that wants that says so with a forward row. An empty reply is refused
 *   there too, as a stall: telling a person the agent finished needs a reply.
 * - Null otherwise (no exit rows, or rows with no column): the check alone
 *   judges, as on a column whose forward exit is the step itself.
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
  const exits = liveExitRows(exitRows);
  if (exits.length === 0) return null;
  const isForward = (row: StepExitRow): boolean => row.target !== null && isForwardOf(row.target, column);
  const line = finalMatchLine(agentReply);
  // The runner's own rule (`textMatchMatches`): a row with `!` patterns is an
  // exit on every line it does not rule out, as the row itself moves the task.
  const matched = line === null ? [] : exits.filter((row) => textMatchMatches(row.finalLine, line));
  if (matched.some(isForward)) return { accepted: true };
  const sendBack = matched.find((row) => row.target !== null && !isForward(row));
  if (line !== null && sendBack?.target) {
    return { accepted: false, reason: `the final line, "${shownFinalLine(line)}", sends the task back to ${sendBack.target.name}` };
  }
  const sendBackOnly = isSendBackOnly(column, exits);
  if (!sendBackOnly && !exits.some(isForward)) return null;
  if (line === null) return { accepted: false, reason: 'the turn ended without a final message' };
  if (sendBackOnly) return { accepted: true, stopsHere: true };
  return { accepted: false, reason: `the final line, "${shownFinalLine(line)}", is not one ${column.name} moves the task on from` };
}

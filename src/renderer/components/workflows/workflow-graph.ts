import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { WorkflowDetail, WorkflowRouteStep, WorkflowViewTask } from '../../../shared/types';
import { WORKFLOW_REFUSAL_MESSAGES, workflowTaskLabel } from '../../../shared/workflow-refusals';
import { UNNAMED_BLOCKER_LABEL, waitingLabel } from '../../../shared/workflow-waiting';
import { canTaskRunAutomations } from '../../../shared/automation-manifest';
import { translateText } from '../../i18n/translate';
import type { WorkflowWaiting } from './WorkflowCanvasCard';

/**
 * The workflow's rules as the view reads them, pure: why a task in To Do has
 * not started, which cards can take a link, and why an action would be
 * refused. Main enforces every one of these (`workflow-service.ts`,
 * `workflow-view-service.ts`); the view uses them to draw what is possible and
 * to say why something is not, so a refusal is a disabled control with its
 * reason rather than an error after the fact. Both sides word a refusal from
 * `WORKFLOW_REFUSALS`, so the tooltip and the error read the same (here in the
 * session's language, through `WORKFLOW_REFUSAL_MESSAGES` and `translateText`).
 */

/** Why a link or an unlink names a task the workflow no longer holds. */
function taskGoneRefusal(): string {
  return i18n._(msg`That task is no longer in this workflow.`);
}

/**
 * A workflow's color: its slot in the app's categorical palette, which is
 * already separated for color-blind readers and has light-theme steps. It
 * colors the workflow's icon and nothing else.
 */
export function workflowColor(slot: number): string {
  const clamped = Math.min(6, Math.max(1, Math.round(slot) || 1));
  return `var(--color-chart-${clamped})`;
}

/** What a board with no Done column, or one with no color, draws Done in, as the board does. */
export const DONE_COLOR_FALLBACK = 'var(--color-active)';

/**
 * The Done color of a task on ANOTHER board than the workflow's home: that
 * board's Done column color (Final 1 follows each card's own board). Null for
 * a task on the home board, which the caller draws in the home board's live
 * color, so a recolored column repaints without a reload.
 */
export function otherBoardDoneColor(
  detail: Pick<WorkflowDetail, 'homeProjectId' | 'boardEnds'>,
  task: Pick<WorkflowViewTask, 'projectId'>,
): string | null {
  if (task.projectId === detail.homeProjectId) return null;
  return detail.boardEnds[task.projectId]?.done?.color ?? DONE_COLOR_FALLBACK;
}

export function taskLabel(task: Pick<WorkflowViewTask, 'displayId' | 'title'>): string {
  return workflowTaskLabel(task.displayId, task.title);
}

export function findTask(detail: WorkflowDetail | null, key: string): WorkflowViewTask | null {
  return detail?.tasks.find((task) => task.key === key) ?? null;
}

/** The tasks this one waits for that are not done yet. */
export function pendingBlockers(detail: WorkflowDetail, key: string): WorkflowViewTask[] {
  return detail.links
    .filter((link) => link.blockedKey === key)
    .map((link) => findTask(detail, link.blockerKey))
    .filter((blocker): blocker is WorkflowViewTask => blocker !== null && blocker.place !== 'done');
}

/**
 * Why a started workflow's task in To Do has not started: what it waits for, a
 * free slot, or a pause (the workflow's, or the task's own automations). Worded
 * by `waitingLabel`, as the board card is.
 */
export function waitingOf(detail: WorkflowDetail, task: WorkflowViewTask): WorkflowWaiting | null {
  if (task.place !== 'todo' || detail.workflow.state === 'draft') return null;
  const pending = pendingBlockers(detail, task.key).map(taskLabel);
  for (let index = 0; index < task.unnamedBlockerCount; index += 1) pending.push(UNNAMED_BLOCKER_LABEL);
  const held = task.task !== null && !canTaskRunAutomations(task.task).ok;
  const waiting = waitingLabel(pending, detail.workflow.state === 'paused' || held);
  return { label: translateText(waiting.label), paused: waiting.paused };
}

/** A task can be made to wait while it has not started: planned, or in To Do. */
export function canWait(task: WorkflowViewTask): boolean {
  return task.place === 'planned' || task.place === 'todo';
}

/** A task can hold another up until it is done. */
export function canBlock(task: WorkflowViewTask): boolean {
  return task.place !== 'done';
}

/** Would `blocked` waiting for `blocker` close a loop? */
export function wouldLoop(detail: WorkflowDetail, blockerKey: string, blockedKey: string): boolean {
  // A loop exists when the blocker already (transitively) waits for the blocked task.
  const stack = [blockerKey];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === blockedKey) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const link of detail.links) if (link.blockedKey === current) stack.push(link.blockerKey);
  }
  return false;
}

/** Why `blocked` cannot be made to wait for `blocker`, or null when it can. */
export function linkRefusal(detail: WorkflowDetail, blockerKey: string, blockedKey: string): string | null {
  const blocker = findTask(detail, blockerKey);
  const blocked = findTask(detail, blockedKey);
  if (!blocker || !blocked) return taskGoneRefusal();
  if (blockerKey === blockedKey) return translateText(WORKFLOW_REFUSAL_MESSAGES.selfLink);
  if (!canWait(blocked)) return translateText(WORKFLOW_REFUSAL_MESSAGES.cannotWait(taskLabel(blocked)));
  if (!canBlock(blocker)) return translateText(WORKFLOW_REFUSAL_MESSAGES.blockerDone(taskLabel(blocker)));
  if (detail.links.some((link) => link.blockerKey === blockerKey && link.blockedKey === blockedKey)) {
    return translateText(WORKFLOW_REFUSAL_MESSAGES.alreadyWaits(taskLabel(blocked), taskLabel(blocker)));
  }
  if (wouldLoop(detail, blockerKey, blockedKey)) return translateText(WORKFLOW_REFUSAL_MESSAGES.loop);
  return null;
}

/**
 * Why removing the link changes nothing, or null while it still holds a task
 * back: one rule from either end of the link, so the X on a Blocked by row and
 * on a Blocking row agree. Live while the waiting task is in To Do (or not yet
 * started) and the blocker is not done.
 */
export function unlinkRefusal(detail: WorkflowDetail, blockerKey: string, blockedKey: string): string | null {
  const blocker = findTask(detail, blockerKey);
  const blocked = findTask(detail, blockedKey);
  if (!blocker || !blocked) return taskGoneRefusal();
  if (blocker.place === 'done') return translateText(WORKFLOW_REFUSAL_MESSAGES.unlinkChangesNothing(taskLabel(blocker), 'is done'));
  if (!canWait(blocked)) return translateText(WORKFLOW_REFUSAL_MESSAGES.unlinkChangesNothing(taskLabel(blocked), 'has started'));
  return null;
}

/**
 * Why the task cannot get a new blocker, or null while it can: it has not
 * started, and some task is left that it could wait for. With none left, Add
 * blocker is disabled rather than opening an empty list.
 */
export function addBlockerRefusal(detail: WorkflowDetail, task: WorkflowViewTask): string | null {
  if (!canWait(task)) return translateText(WORKFLOW_REFUSAL_MESSAGES.cannotWait(taskLabel(task)));
  return blockerCandidates(detail, task.key).length === 0 ? translateText(WORKFLOW_REFUSAL_MESSAGES.noBlockerCandidates) : null;
}

/** Why the task cannot be taken out of its workflow, or null while it can. */
export function removeRefusal(task: WorkflowViewTask): string | null {
  return task.place === 'done' ? translateText(WORKFLOW_REFUSAL_MESSAGES.doneStays(taskLabel(task))) : null;
}

/**
 * The route steps that can no longer change: every column at or before the
 * one the task has reached (a finished step, the current one, and any column
 * it skipped on the way). A task that has not started can change them all; a
 * task in Done, none.
 */
export function reachedStepCount(task: WorkflowViewTask): number {
  if (task.place === 'planned' || task.place === 'todo') return 0;
  if (task.place === 'done') return task.steps.length;
  const current = task.steps.findIndex((step) => step.state === 'current');
  return current >= 0 ? current + 1 : 0;
}

/** Why this step's switch is locked, or null when it can change. */
export function stepRefusal(task: WorkflowViewTask, stepIndex: number): string | null {
  if (task.place === 'done') return translateText(WORKFLOW_REFUSAL_MESSAGES.doneStays(taskLabel(task)));
  if (stepIndex >= reachedStepCount(task)) return null;
  const current = task.steps.find((step) => step.state === 'current');
  // The column's own name is data. With no current step, a stand-in phrase names it.
  const columnName = current?.name ?? i18n._(msg({ message: 'its column', comment: 'Stands in for a column name inside "has reached ..."' }));
  return translateText(WORKFLOW_REFUSAL_MESSAGES.stepReached(taskLabel(task), columnName));
}

/**
 * The route with one step switched, as the column ids it visits, or a refusal
 * when the switch would leave no column at all.
 */
export function toggledRoute(steps: WorkflowRouteStep[], swimlaneId: string): { columns: string[] } | { refusal: string } {
  const columns = steps
    .filter((step) => (step.swimlaneId === swimlaneId ? step.state === 'skipped' : step.state !== 'skipped'))
    .map((step) => step.swimlaneId);
  return columns.length > 0 ? { columns } : { refusal: translateText(WORKFLOW_REFUSAL_MESSAGES.routeEmpty) };
}

/** The tasks `key` could wait for right now: what Add blocker lists. */
export function blockerCandidates(detail: WorkflowDetail, key: string): WorkflowViewTask[] {
  return detail.tasks.filter((candidate) => candidate.key !== key && linkRefusal(detail, candidate.key, key) === null);
}

/** The tasks grouped by when they can start: each group waits only for tasks in earlier groups. */
export function runOrder(detail: WorkflowDetail): WorkflowViewTask[][] {
  const depth = new Map<string, number>();
  const blockersOf = new Map<string, string[]>();
  for (const link of detail.links) {
    const list = blockersOf.get(link.blockedKey) ?? [];
    list.push(link.blockerKey);
    blockersOf.set(link.blockedKey, list);
  }
  const visiting = new Set<string>();
  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    // A loop cannot be saved, but a stale read must not recurse forever.
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const value = Math.max(-1, ...(blockersOf.get(key) ?? []).map(depthOf)) + 1;
    visiting.delete(key);
    depth.set(key, value);
    return value;
  };
  const groups: WorkflowViewTask[][] = [];
  for (const task of detail.tasks) {
    const index = depthOf(task.key);
    (groups[index] ??= []).push(task);
  }
  return groups.filter((group) => group && group.length > 0);
}

/**
 * The task a workflow opens on: the run order's first row (its first stop's
 * first task), among the tasks the board's search leaves showing. Null when
 * the workflow has no task, or none shows.
 */
export function firstInRunOrder(detail: WorkflowDetail, visibleKeys: ReadonlySet<string> | null = null): string | null {
  for (const group of runOrder(detail)) {
    const first = group.find((task) => !visibleKeys || visibleKeys.has(task.key));
    if (first) return first.key;
  }
  return null;
}

import type { WorkflowDetail, WorkflowViewTask } from '../../../shared/types';
import type { WorkflowWaiting } from './WorkflowCanvasCard';

/**
 * The workflow's rules as the view reads them, pure: why a task in To Do has
 * not started, which cards can take a link, and why a link would be refused.
 * Main enforces every one of these (`workflow-service.ts`); the view uses them
 * to draw what is possible and to say why something is not, so a refusal is
 * a disabled control with its reason rather than an error after the fact.
 */

export function taskLabel(task: Pick<WorkflowViewTask, 'displayId' | 'title'>): string {
  return task.displayId !== null ? `#${task.displayId}` : `"${task.title}"`;
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

/** Why a started workflow's task in To Do has not started: what it waits for, a free slot, or the pause. */
export function waitingOf(detail: WorkflowDetail, task: WorkflowViewTask): WorkflowWaiting | null {
  if (task.place !== 'todo' || detail.workflow.state === 'draft') return null;
  const pending = pendingBlockers(detail, task.key);
  if (pending.length === 1) return { label: `Blocked by ${taskLabel(pending[0])}...`, paused: false };
  if (pending.length > 1) return { label: `Blocked by ${pending.length} tasks...`, paused: false };
  if (detail.workflow.state === 'paused') return { label: 'Paused', paused: true };
  return { label: 'Queued...', paused: false };
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
  if (!blocker || !blocked) return 'That task is no longer in this workflow.';
  if (blockerKey === blockedKey) return 'A task cannot wait for itself.';
  if (!canWait(blocked)) return `${taskLabel(blocked)} has started. Only a task in To Do can wait for another.`;
  if (!canBlock(blocker)) return `${taskLabel(blocker)} is done. Waiting for it changes nothing.`;
  if (detail.links.some((link) => link.blockerKey === blockerKey && link.blockedKey === blockedKey)) {
    return `${taskLabel(blocked)} already waits for ${taskLabel(blocker)}.`;
  }
  if (wouldLoop(detail, blockerKey, blockedKey)) return 'That link closes a loop. A workflow\'s links cannot go in a circle.';
  return null;
}

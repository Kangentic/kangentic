import type { Swimlane, Task } from '../../../shared/types';
import type { CommandContext, TaskRunningWork } from './types';

/**
 * Keeps an agent from ending another task's running work.
 *
 * An agent folded four filed tasks into its own commit, then deleted them. One
 * had a live agent and its own branch, and both went. The handlers asked nothing
 * but whether the task existed.
 *
 * A refusal is final over MCP. There is no parameter that overrides it, because
 * an agent could set one on its own and nothing on that path can show a person
 * asked. The agent tells the user, and the user's own delete or drag is the
 * confirmation: those reach `deleteTaskWithCleanup` and `handleTaskMove`
 * directly and never come through here.
 *
 * This stops a confused agent's tool call. An agent with a shell can still run
 * git.
 */

/** What a call would do to the task. */
export type RunningWorkTeardown =
  | { kind: 'delete' }
  | { kind: 'todo'; columnName: string }
  | { kind: 'done'; columnName: string };

/**
 * The teardown a move into this column runs, or null for a column that keeps
 * the task's work. By role, as `handleTaskMove` decides it, so a renamed To Do
 * counts. Done keeps the branch and the conversation but ends the agent and
 * deletes the worktree.
 */
export function teardownOfColumn(column: Swimlane): RunningWorkTeardown | null {
  if (column.role === 'todo') return { kind: 'todo', columnName: column.name };
  if (column.role === 'done') return { kind: 'done', columnName: column.name };
  return null;
}

/**
 * Whether this call needs the guard's read: an agent acting on a task that is
 * not its own. Synchronous, so a call that does not need it stays synchronous.
 */
export function needsRunningWorkCheck(context: CommandContext, task: Task): boolean {
  return context.callerKind === 'agent' && context.callerTaskId !== task.id;
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What the teardown would take away, for the refusal to name. Empty when nothing. */
function workAtRisk(work: TaskRunningWork, teardown: RunningWorkTeardown): string[] {
  const items: string[] = [];
  if (work.liveAgent) items.push('a live agent');
  if (!work.worktree) return items;
  if (!work.worktree.readable) {
    // Fails closed: what cannot be read might be anything, and a delete is final.
    items.push('a worktree that could not be read');
    return items;
  }
  const { branch, baseBranch, commitsNotOnBase, uncommittedFiles } = work.worktree;
  // Done keeps the branch, so its commits survive the move, counted or not.
  if (teardown.kind !== 'done') {
    if (commitsNotOnBase === null) {
      items.push('a worktree that could not be read');
    } else if (commitsNotOnBase > 0) {
      items.push(`${counted(commitsNotOnBase, 'commit')} ${branch ? `on ${branch}` : 'in its worktree'} not on ${baseBranch}`);
    }
  }
  if (uncommittedFiles > 0) items.push(counted(uncommittedFiles, 'uncommitted file'));
  return items;
}

/** The refusal an agent reads, for the items the teardown would take or that could not be read. */
function refusalFor(task: Task, items: string[], teardown: RunningWorkTeardown): string {
  const act = teardown.kind === 'delete'
    ? { doing: 'Deleting it', action: 'delete it' }
    : { doing: `Moving it to ${teardown.columnName}`, action: `move it to ${teardown.columnName}` };
  return `Refused: #${task.display_id} "${task.title}" has running work: ${listOf(items)}. `
    + `${act.doing} would end that work, so nothing was changed. `
    + `Ask the user what to do. Only they can ${act.action}, from the board. Do not retry this or work around it.`;
}

/** The refusal an agent reads, or null when the task holds nothing the teardown would take. */
export function runningWorkRefusal(task: Task, work: TaskRunningWork, teardown: RunningWorkTeardown): string | null {
  const items = workAtRisk(work, teardown);
  return items.length === 0 ? null : refusalFor(task, items, teardown);
}

/** The refusal for this call, or null to go ahead. */
export async function refuseRunningWork(
  context: CommandContext,
  task: Task,
  teardown: RunningWorkTeardown,
): Promise<string | null> {
  let work: TaskRunningWork;
  try {
    // A context built without the read fails here too, so a missing callback
    // refuses rather than turning the guard off unnoticed.
    if (!context.readTaskRunningWork) throw new Error('This context cannot read a task\'s running work.');
    work = await context.readTaskRunningWork(task);
  } catch (error) {
    console.warn(`[RUNNING-WORK] Could not read task ${task.id.slice(0, 8)}, so the call is refused:`, error);
    // Names the failed read itself: this task may hold no worktree at all.
    return refusalFor(task, ['its running work, which could not be read'], teardown);
  }
  return runningWorkRefusal(task, work, teardown);
}

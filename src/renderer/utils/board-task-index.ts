import type { Task } from '../../shared/types';

/**
 * Each board task list's index by id, built once per list. The board store
 * replaces the array on every change, so a list is an immutable snapshot and
 * its index never goes stale; a replaced list's index is dropped with it.
 */
// hmr-safe: a cache keyed by immutable store snapshots; losing it on a reload only rebuilds it.
const indexes = new WeakMap<readonly Task[], Map<string, Task>>();

/**
 * Find a board task by id in constant time. A store selector runs on every
 * board update, so 100 canvas cards each scanning 2,000 tasks with `find` is
 * 200,000 comparisons per keystroke in the search box; this is 100 lookups.
 */
export function findBoardTask(tasks: readonly Task[], taskId: string): Task | undefined {
  let index = indexes.get(tasks);
  if (!index) {
    index = new Map(tasks.map((task) => [task.id, task]));
    indexes.set(tasks, index);
  }
  return index.get(taskId);
}

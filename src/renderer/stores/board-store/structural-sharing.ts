import type { Task } from '../../../shared/types';

/**
 * Apply structural sharing to a freshly-fetched Task list: reuse the previous
 * object reference for every task whose field-by-field contents match. Every
 * `tasks.list()` IPC call returns freshly JSON-deserialized objects, so
 * without this step `React.memo` on `TaskCard` is defeated by identity churn -
 * every `loadBoard()` forces every card to re-render even when only one task
 * changed.
 *
 * This is the same optimization TanStack Query applies by default to every
 * query result; see
 * https://tanstack.com/query/latest/docs/framework/react/guides/render-optimizations
 * ("Structural Sharing" section). We implement a narrower, flat-top-level
 * version sufficient for our Task[] shape; full recursive structural sharing
 * would handle nested objects as well, which Task doesn't need.
 *
 * Trade-off: we pay an O(N) pass with a shallow field compare per task to
 * avoid O(N) expensive card renders + their subscription re-evaluations.
 * At 100 tasks the compare is microseconds; the saved renders are
 * milliseconds. Break-even is very low.
 *
 * Returns a new top-level array (callers rely on a fresh outer ref to
 * retrigger downstream `tasksPerLane` / sort memos). Individual task
 * elements are reused when equal.
 */
export function applyStructuralSharing(previousTasks: Task[], nextTasks: Task[]): Task[] {
  if (previousTasks.length === 0) return nextTasks;

  const previousById = new Map<string, Task>();
  for (const previous of previousTasks) previousById.set(previous.id, previous);

  const result: Task[] = new Array(nextTasks.length);
  for (let index = 0; index < nextTasks.length; index += 1) {
    const next = nextTasks[index];
    const previous = previousById.get(next.id);
    result[index] = previous && taskContentsMatch(previous, next) ? previous : next;
  }
  return result;
}

/**
 * Field-by-field equality for Task. Faster than JSON.stringify and avoids
 * false negatives from property-order differences. The `labels` array is
 * compared element-by-element; everything else is primitive-or-null.
 *
 * When a new field is added to the `Task` interface in `src/shared/types.ts`,
 * add it here too. `tests/unit/structural-sharing.test.ts` asserts on
 * `Object.keys(task).length` as a drift guard - if that test fails after a
 * Task change, update the field list below to match before touching the
 * guard count.
 */
function taskContentsMatch(previous: Task, next: Task): boolean {
  if (previous === next) return true;
  if (
    previous.id !== next.id ||
    previous.display_id !== next.display_id ||
    previous.title !== next.title ||
    previous.description !== next.description ||
    previous.swimlane_id !== next.swimlane_id ||
    previous.position !== next.position ||
    previous.agent !== next.agent ||
    previous.session_id !== next.session_id ||
    previous.worktree_path !== next.worktree_path ||
    previous.branch_name !== next.branch_name ||
    previous.base_branch !== next.base_branch ||
    previous.use_worktree !== next.use_worktree ||
    previous.pr_number !== next.pr_number ||
    previous.pr_url !== next.pr_url ||
    previous.priority !== next.priority ||
    previous.attachment_count !== next.attachment_count ||
    previous.archived_at !== next.archived_at ||
    previous.created_at !== next.created_at ||
    previous.updated_at !== next.updated_at
  ) return false;

  const previousLabels = previous.labels ?? [];
  const nextLabels = next.labels ?? [];
  if (previousLabels.length !== nextLabels.length) return false;
  for (let index = 0; index < previousLabels.length; index += 1) {
    if (previousLabels[index] !== nextLabels[index]) return false;
  }
  return true;
}

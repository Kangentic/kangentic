import type { Task, Swimlane } from '../../../shared/types';

/**
 * Reuse the previous object reference for every element whose field-by-field
 * contents match. Every IPC list call returns freshly JSON-deserialized
 * objects, so without this step `React.memo` is defeated by identity churn -
 * every `loadBoard()` forces every consumer to re-render even when only one
 * element changed.
 *
 * This is the same optimization TanStack Query applies by default to every
 * query result; see
 * https://tanstack.com/query/latest/docs/framework/react/guides/render-optimizations
 * ("Structural Sharing" section). We implement a narrower, flat-top-level
 * version sufficient for our row shapes; full recursive structural sharing
 * would handle nested objects as well, which our rows don't need.
 *
 * Returns a NEW top-level array (callers rely on a fresh outer ref to
 * retrigger downstream memos). Individual elements are reused when equal.
 */
function shareByContents<T extends { id: string }>(
  previous: T[],
  next: T[],
  contentsMatch: (previous: T, next: T) => boolean,
): T[] {
  if (previous.length === 0) return next;

  const previousById = new Map<string, T>();
  for (const item of previous) previousById.set(item.id, item);

  const result: T[] = new Array(next.length);
  for (let index = 0; index < next.length; index += 1) {
    const candidate = next[index];
    const prior = previousById.get(candidate.id);
    result[index] = prior && contentsMatch(prior, candidate) ? prior : candidate;
  }
  return result;
}

/**
 * Apply structural sharing to a freshly-fetched Task list: reuse the previous
 * object reference for every task whose field-by-field contents match. Without
 * this, `React.memo` on `TaskCard` is defeated by identity churn - every
 * `loadBoard()` forces every card to re-render even when only one task changed.
 *
 * Trade-off: we pay an O(N) pass with a shallow field compare per task to
 * avoid O(N) expensive card renders + their subscription re-evaluations.
 * At 100 tasks the compare is microseconds; the saved renders are
 * milliseconds. Break-even is very low.
 */
export function applyStructuralSharing(previousTasks: Task[], nextTasks: Task[]): Task[] {
  return shareByContents(previousTasks, nextTasks, taskContentsMatch);
}

/**
 * Apply structural sharing to a freshly-fetched Swimlane list. `swimlanes.list()`
 * returns fresh JSON objects on every hydration, so without this the whole array
 * and every element churn identity, defeating every `Swimlane` memo even when no
 * column changed. Tasks already get this treatment; swimlanes did not until now.
 */
export function applySwimlaneStructuralSharing(
  previousSwimlanes: Swimlane[],
  nextSwimlanes: Swimlane[],
): Swimlane[] {
  return shareByContents(previousSwimlanes, nextSwimlanes, swimlaneContentsMatch);
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
    previous.pr_state !== next.pr_state ||
    previous.head_sha !== next.head_sha ||
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

/**
 * Field-by-field equality for Swimlane. Every field is primitive-or-null (no
 * nested arrays or objects), so a flat compare is exhaustive.
 *
 * When a new field is added to the `Swimlane` interface in
 * `src/shared/types.ts`, add it here too. `tests/unit/structural-sharing.test.ts`
 * asserts on `Object.keys(swimlane).length` as a drift guard - if that test
 * fails after a Swimlane change, update the field list below to match before
 * touching the guard count.
 */
function swimlaneContentsMatch(previous: Swimlane, next: Swimlane): boolean {
  if (previous === next) return true;
  return (
    previous.id === next.id &&
    previous.name === next.name &&
    previous.description === next.description &&
    previous.role === next.role &&
    previous.position === next.position &&
    previous.color === next.color &&
    previous.icon === next.icon &&
    previous.is_archived === next.is_archived &&
    previous.is_ghost === next.is_ghost &&
    previous.permission_mode === next.permission_mode &&
    previous.auto_spawn === next.auto_spawn &&
    previous.auto_command === next.auto_command &&
    previous.plan_exit_target_id === next.plan_exit_target_id &&
    previous.agent_override === next.agent_override &&
    previous.model_override === next.model_override &&
    previous.effort_override === next.effort_override &&
    previous.handoff_context === next.handoff_context &&
    previous.session_target === next.session_target &&
    previous.session_spawn_strategy === next.session_spawn_strategy &&
    previous.created_at === next.created_at
  );
}

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
 * column changed.
 *
 * Unlike tasks, the previous ARRAY comes back too when no column changed. Nothing
 * reads a new swimlanes array as "a reload happened", and a new one on every
 * reload re-rendered everything that subscribes to it: every open task window
 * (its detail host puts `swimlanes` in a context value) and, through the
 * onboarding hook, the whole app, on every task update an agent made.
 */
export function applySwimlaneStructuralSharing(
  previousSwimlanes: Swimlane[],
  nextSwimlanes: Swimlane[],
): Swimlane[] {
  return keepIfUnchanged(previousSwimlanes, shareByContents(previousSwimlanes, nextSwimlanes, swimlaneContentsMatch));
}

/**
 * The previous array when `next` holds the same elements in the same order (by
 * reference, so call it on a structurally shared list), else `next`. A subscriber
 * re-renders on a new array identity whatever it holds.
 */
export function keepIfUnchanged<T>(previous: T[], next: T[]): T[] {
  if (previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return next;
  }
  return previous;
}

/**
 * The previous value when a reload returned the same data, else the new one. For
 * the small lists a load replaces whole (shortcuts, automations, board profiles),
 * each reloaded with every board load: comparing their JSON costs less than the
 * re-render a new identity costs every subscriber.
 */
export function keepIfSameJson<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/**
 * Field-by-field equality for Task. Faster than JSON.stringify and avoids
 * false negatives from property-order differences. The `labels` array is
 * compared element-by-element; everything else is primitive-or-null.
 *
 * EXHAUSTIVE over the `Task` interface, deliberately. It used to compare a
 * subset and lean on `updated_at` to catch the rest, which held only because
 * the generic `update()` always bumps it - so the fields written by the bespoke
 * no-bump setters (`setDetailViewState`, `recordAutoCommandOutcome`) could
 * change with the stale reference reused. Comparing everything removes that
 * reasoning step entirely; the cost is a few more primitive compares per task.
 *
 * When a new field is added to the `Task` interface in `src/shared/types.ts`,
 * add it here too. `tests/unit/structural-sharing.test.ts` derives the expected
 * field list FROM that interface and fails naming the missing field.
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
    previous.worktree_folder !== next.worktree_folder ||
    previous.worktree_skip_reason !== next.worktree_skip_reason ||
    previous.branch_name !== next.branch_name ||
    previous.base_branch !== next.base_branch ||
    previous.resolved_base_branch !== next.resolved_base_branch ||
    previous.use_worktree !== next.use_worktree ||
    previous.pr_number !== next.pr_number ||
    previous.pr_url !== next.pr_url ||
    previous.pr_state !== next.pr_state ||
    previous.pr_merge_readiness !== next.pr_merge_readiness ||
    previous.head_sha !== next.head_sha ||
    previous.pushed_branch !== next.pushed_branch ||
    previous.external_id !== next.external_id ||
    previous.external_source !== next.external_source ||
    previous.external_url !== next.external_url ||
    previous.priority !== next.priority ||
    previous.model_override !== next.model_override ||
    previous.effort_override !== next.effort_override ||
    previous.agent_override !== next.agent_override ||
    previous.permission_mode !== next.permission_mode ||
    previous.auto_command !== next.auto_command ||
    previous.profile_id !== next.profile_id ||
    previous.attachment_count !== next.attachment_count ||
    previous.run_mode !== next.run_mode ||
    // The card's strip and its menu row read it, so a write that changes only
    // this field still has to reach the card.
    previous.automations_disabled !== next.automations_disabled ||
    previous.auto_command_state !== next.auto_command_state ||
    previous.auto_command_text !== next.auto_command_text ||
    previous.auto_command_error !== next.auto_command_error ||
    previous.auto_command_at !== next.auto_command_at ||
    previous.detail_view_state !== next.detail_view_state ||
    previous.archived_at !== next.archived_at ||
    previous.created_at !== next.created_at ||
    previous.updated_at !== next.updated_at ||
    // Workflow membership, route and canvas place: a card's workflow strip
    // and lock read the first two, and the Workflows canvas the rest.
    previous.workflow_id !== next.workflow_id ||
    previous.workflow_project_id !== next.workflow_project_id ||
    previous.route_start_swimlane_id !== next.route_start_swimlane_id ||
    previous.route_last_swimlane_id !== next.route_last_swimlane_id ||
    previous.canvas_x !== next.canvas_x ||
    previous.canvas_y !== next.canvas_y ||
    // A workflow task's own plan approval, which the Workflow panel draws.
    previous.plan_approval !== next.plan_approval
  ) return false;

  return sameStrings(previous.labels ?? [], next.labels ?? [])
    && sameStrings(previous.skipped_swimlane_ids ?? [], next.skipped_swimlane_ids ?? []);
}

function sameStrings(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
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
    previous.auto_command_mode === next.auto_command_mode &&
    previous.plan_exit_target_id === next.plan_exit_target_id &&
    previous.plan_approval === next.plan_approval &&
    previous.agent_override === next.agent_override &&
    previous.model_override === next.model_override &&
    previous.effort_override === next.effort_override &&
    previous.handoff_context === next.handoff_context &&
    previous.session_target === next.session_target &&
    previous.session_spawn_strategy === next.session_spawn_strategy &&
    previous.created_at === next.created_at
  );
}

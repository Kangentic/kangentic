import type { SwimlaneRole } from './types';

/**
 * Columns that deliberately offer no Resume.
 *
 * `SwimlaneRole` is exactly 'todo' | 'done'; a custom column has `role: null`.
 * There is no live 'backlog' role - it was migrated to 'todo', and the Backlog
 * is a separate table rather than a swimlane. Typed as the union rather than
 * `string` so a typo in either literal is a compile error, not a silent miss.
 *
 * The gate is the ROLE, not `auto_spawn`: To Do and Done both default to
 * `auto_spawn = 0`, so keying off the flag would sweep in every custom column
 * a user has turned auto-spawn off for.
 */
export const RESUME_HIDDEN_ROLES: ReadonlySet<SwimlaneRole> = new Set<SwimlaneRole>(['todo', 'done']);

/** Why a task refuses an in-place resume. */
export type ResumeBlockReason = 'todo' | 'done' | 'archived';

/**
 * Whether an in-place resume (`SESSION_RESUME`) is refused for a task, and why.
 * Returns null when resume is allowed.
 *
 * A completed task lives in Done with `archived_at` set, its worktree deleted
 * and its session suspended. Resuming it in place recreates that worktree and
 * spawns a live agent on a task with no board card - real quota burn with no
 * affordance to notice it, and a task that is archived AND running at once. The
 * designed route back is to move the task OUT of Done (the recovery move in
 * `task-move.ts` / `TASK_UNARCHIVE`), which unarchives first and then spawns
 * through the normal chokepoint, so this predicate never sees it.
 *
 * `laneRole` is typed loosely so the renderer can pass a swimlane's `role`
 * straight through; the lookup narrows against the typed set above.
 */
export function resumeBlockReason(input: {
  laneRole: string | null | undefined;
  isArchived: boolean;
}): ResumeBlockReason | null {
  const laneRole = input.laneRole;
  if (laneRole && (RESUME_HIDDEN_ROLES as ReadonlySet<string>).has(laneRole)) {
    return laneRole as ResumeBlockReason;
  }
  // Checked after the role so a task in Done reports the Done message, which
  // names the move that restores it. An archived task in any other column
  // (legacy rows) still falls through to here.
  if (input.isArchived) return 'archived';
  return null;
}

/**
 * User-facing copy for a refusal. The main-process handler throws this string
 * and the task detail surfaces it verbatim in a toast, so it reads as guidance,
 * not as an internal error.
 */
export function resumeBlockMessage(reason: ResumeBlockReason): string {
  switch (reason) {
    case 'todo':
      return 'Cannot resume a session for a task in the To Do column';
    case 'done':
      return 'This task is complete. Move it out of Done to continue working on it.';
    case 'archived':
      return 'This task is archived. Restore it to the board to continue working on it.';
  }
}

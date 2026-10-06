import type { Session, SwimlaneRole, Task } from './types';
import { isLiveSessionStatus } from './session-liveness';

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
 * `resumeBlockReason` for a task row and its column's role, for callers that
 * hold the row itself (the main-process resume, start and mobile bridge paths;
 * the renderer derives `isArchived` on its own). It owns the one read of
 * `archived_at`, by truthiness, never `!== null`: a Task assembled without the
 * column (mocks, wire mappers, MCP-constructed rows) carries `undefined`, which
 * `!== null` reads as ARCHIVED and would refuse every resume.
 */
export function resumeBlockReasonForTask(input: {
  task: Pick<Task, 'archived_at'>;
  laneRole: string | null | undefined;
}): ResumeBlockReason | null {
  return resumeBlockReason({ laneRole: input.laneRole, isArchived: Boolean(input.task.archived_at) });
}

/**
 * Whether a session registry row is a task's PAUSED session: `suspended`, and
 * not a Command Terminal (which belongs to no task and is never resumed). The
 * one definition behind the mobile bridge's Resume promise: `startTaskSession`
 * takes the Resume button's path for such a row, and the board row and the
 * read-stream feed report `resumable` from it. Three call sites wrote it out by
 * hand before, and one of them missed the Command Terminal exclusion.
 */
export function isPausedTaskSession(session: Pick<Session, 'status' | 'transient'>): boolean {
  return session.status === 'suspended' && session.transient !== true;
}

/**
 * The ids of the tasks that have a paused session (`isPausedTaskSession`)
 * and no live one among the given registry rows. The one registry scan behind
 * both ends of the phone's Resume promise: read-board's `resumable` for every
 * task on a board, and `startTaskSession` choosing the Resume path for one
 * task. Reads the registry by task rather than by `task.session_id`, because a
 * pause clears that pointer while the suspended row stays.
 *
 * A task with a live row as well is not paused. A respawn queued behind the
 * concurrency limit leaves the task holding `[suspended, queued]` until the
 * queued row is promoted. The desktop card shows the queued session there and
 * offers no Resume, and `startTaskSession` finds the queued row live and
 * answers `live`, so reporting the task here would promise a Resume that
 * nothing performs.
 */
export function pausedTaskIdsOf(sessions: ReadonlyArray<Pick<Session, 'taskId' | 'status' | 'transient'>>): Set<string> {
  const pausedTaskIds = new Set<string>();
  const liveTaskIds = new Set<string>();
  for (const session of sessions) {
    if (!session.taskId) continue;
    if (isPausedTaskSession(session)) pausedTaskIds.add(session.taskId);
    else if (isLiveSessionStatus(session.status)) liveTaskIds.add(session.taskId);
  }
  for (const taskId of liveTaskIds) pausedTaskIds.delete(taskId);
  return pausedTaskIds;
}

/**
 * `pausedTaskIdsOf` for one task, for the callers that ask about a single
 * task (`startTaskSession`, the read-stream copy of `resumable`). It runs the
 * same function over that task's rows, so the rule stays defined once.
 */
export function isTaskPaused(
  sessions: ReadonlyArray<Pick<Session, 'taskId' | 'status' | 'transient'>>,
  taskId: string,
): boolean {
  return pausedTaskIdsOf(sessions.filter((session) => session.taskId === taskId)).has(taskId);
}

/**
 * Whether the desktop offers Resume for a task: its session is paused (a
 * `suspended` registry row and no live one, `pausedTaskIdsOf`) and
 * `resumeBlockReasonForTask` refuses nothing. This is the resume direction of
 * `canToggle` in the task detail (`useTaskSessionState.ts`), and the
 * `resumable` the mobile bridge sends, on the board row and the read-stream
 * feed, promising that `start-session` resumes rather than starts.
 */
export function isResumeOffered(input: {
  hasPausedSession: boolean;
  task: Pick<Task, 'archived_at'>;
  laneRole: string | null | undefined;
}): boolean {
  return input.hasPausedSession && resumeBlockReasonForTask(input) === null;
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

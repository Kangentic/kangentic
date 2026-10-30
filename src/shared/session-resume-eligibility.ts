import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { Session, SwimlaneRole, Task } from './types';
import { englishText } from './i18n/english';
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
 * takes the Resume button's path for such a row, the board row reports
 * `paused` and `resumable` from it, and the read-stream feed reports
 * `resumable`. Three call sites wrote it out by hand before, and one of them
 * missed the Command Terminal exclusion.
 */
export function isPausedTaskSession(session: Pick<Session, 'status' | 'transient'>): boolean {
  return session.status === 'suspended' && session.transient !== true;
}

/** What one registry scan yields; see `taskSessionStatesOf`. */
export interface TaskSessionStates {
  /** Tasks with a live (`running` or `queued`) session. */
  liveTaskIds: Set<string>;
  /**
   * Each task with a paused session (`isPausedTaskSession`) and no live one,
   * mapped to that paused row's registry id. A task holding two paused rows
   * maps to the one registered later.
   */
  pausedSessionIdByTaskId: Map<string, string>;
}

/**
 * The one registry scan behind the phone's Pause and Resume promises.
 * read-board reads it for every task on a board: `pausable` from
 * `liveTaskIds`, and `paused`, `paused_session_id` and `resumable` from
 * `pausedSessionIdByTaskId`. One scan, so a task can never be both live and
 * paused: a paused task has no live session.
 * Reads the registry by task rather than by `task.session_id`, because a pause
 * clears that pointer while the suspended row stays. The paused row's id is
 * the registry's, not the task's or the DB's, because a restart re-registers
 * the row under a fresh id (`registerSuspendedPlaceholder`) and the phone's
 * `send-user-message` looks the id up in the registry.
 *
 * `liveTaskIds` uses the predicate `findLiveSessionByTaskId` uses, which is
 * how `pauseTaskSession` finds the session it suspends, so a task listed there
 * is one the phone's `pause-session` pauses. A Command Terminal's row carries
 * a task id minted for it alone, so it never marks a board task live.
 *
 * A task with a live row as well is not paused. A respawn queued behind the
 * concurrency limit leaves the task holding `[suspended, queued]` until the
 * queued row is promoted. The desktop card shows the queued session there and
 * offers no Resume, and `startTaskSession` finds the queued row live and
 * answers `live`, so reporting the task as paused would promise a Resume that
 * nothing performs.
 */
export function taskSessionStatesOf(
  sessions: ReadonlyArray<Pick<Session, 'id' | 'taskId' | 'status' | 'transient'>>,
): TaskSessionStates {
  const pausedSessionIdByTaskId = new Map<string, string>();
  const liveTaskIds = new Set<string>();
  for (const session of sessions) {
    if (!session.taskId) continue;
    if (isPausedTaskSession(session)) pausedSessionIdByTaskId.set(session.taskId, session.id);
    else if (isLiveSessionStatus(session.status)) liveTaskIds.add(session.taskId);
  }
  for (const taskId of liveTaskIds) pausedSessionIdByTaskId.delete(taskId);
  return { liveTaskIds, pausedSessionIdByTaskId };
}

/**
 * The ids of the tasks that have a paused session and no live one: the keys
 * of `taskSessionStatesOf`'s paused half. `isTaskPaused` runs it over one
 * task's rows, which is how `startTaskSession` chooses the Resume path. read-board reads
 * `taskSessionStatesOf` directly, because it needs the live half as well.
 */
export function pausedTaskIdsOf(sessions: ReadonlyArray<Pick<Session, 'id' | 'taskId' | 'status' | 'transient'>>): Set<string> {
  return new Set(taskSessionStatesOf(sessions).pausedSessionIdByTaskId.keys());
}

/**
 * `pausedTaskIdsOf` for one task, for the callers that ask about a single
 * task (`startTaskSession`, the read-stream copy of `resumable`). It runs the
 * same function over that task's rows, so the rule stays defined once.
 */
export function isTaskPaused(
  sessions: ReadonlyArray<Pick<Session, 'id' | 'taskId' | 'status' | 'transient'>>,
  taskId: string,
): boolean {
  return pausedTaskIdsOf(sessions.filter((session) => session.taskId === taskId)).has(taskId);
}

/** Where a task's session sits in its lifecycle, as far as Pause and Resume care. */
export type SessionLifecyclePhase =
  /** The agent is working or on its way to working. */
  | 'active'
  /** Parked, but resumable - it still has a session behind it. */
  | 'paused'
  /** No session lifecycle at all (never started, or finished). */
  | 'ended';

/**
 * What a task's Pause / Resume control offers. A resume carries the reason main
 * would refuse it, or null when it would run: the task detail hides a refused
 * Resume, while the card menu shows it disabled with `resumeBlockMessage` as
 * its tooltip.
 */
export type SessionToggleOffer =
  | { direction: 'pause' }
  | { direction: 'resume'; blockReason: ResumeBlockReason | null };

/**
 * The one rule behind every Pause / Resume control: the task detail's header
 * pill and kebab item (`canToggle` in `useTaskSessionState.ts`), the card
 * menu's row (`TaskContextMenu`), and the phone's `pausable` and `resumable`
 * (`isPauseOffered`, `isResumeOffered`). Null means no control at all.
 *
 * To Do offers neither direction: a move into it has already torn the session
 * down, and its cards open straight into the edit form. Pause is offered in
 * Done and on an archived task, because it is the only stop for a live agent a
 * failed Done-move suspend left running; main's `pauseTaskSession` has no Done
 * or archive gate either. Resume there is refused (`resumeBlockReasonForTask`).
 *
 * Callers differ only in the phase they pass. The renderer reads it from the
 * display kind, so a spawn label with no live session is `active` and offers
 * Pause (which cancels the in-flight resume or start). The phone reads it from
 * the registry, where that state has no live session, so it is `ended`.
 */
export function sessionToggleOffer(input: {
  phase: SessionLifecyclePhase;
  laneRole: string | null | undefined;
  task: Pick<Task, 'archived_at'>;
}): SessionToggleOffer | null {
  if (input.laneRole === 'todo') return null;
  switch (input.phase) {
    case 'active':
      return { direction: 'pause' };
    case 'paused':
      return { direction: 'resume', blockReason: resumeBlockReasonForTask(input) };
    case 'ended':
      return null;
  }
}

/** Whether an offer is one the control can act on: any Pause, or a Resume nothing refuses. */
export function isSessionToggleLive(offer: SessionToggleOffer | null): boolean {
  return offer !== null && (offer.direction === 'pause' || offer.blockReason === null);
}

/**
 * Whether the desktop offers Resume for a task: its session is paused (a
 * `suspended` registry row and no live one, `pausedTaskIdsOf`) and
 * `resumeBlockReasonForTask` refuses nothing. The resume direction of
 * `sessionToggleOffer`, and the `resumable` the mobile bridge sends, on the
 * board row and the read-stream feed, promising that `start-session` resumes
 * rather than starts.
 */
export function isResumeOffered(input: {
  hasPausedSession: boolean;
  task: Pick<Task, 'archived_at'>;
  laneRole: string | null | undefined;
}): boolean {
  const offer = sessionToggleOffer({
    phase: input.hasPausedSession ? 'paused' : 'ended',
    laneRole: input.laneRole,
    task: input.task,
  });
  return offer?.direction === 'resume' && offer.blockReason === null;
}

/**
 * Whether the phone may offer Pause for a task: it has a live session
 * (`taskSessionStatesOf`) and `sessionToggleOffer` offers Pause, so not in To
 * Do. This is the mobile bridge's `pausable`, the promise that `pause-session`
 * pauses rather than refuses. A task with a spawn label up and no live session
 * reaches here as not live, so the phone is offered nothing there:
 * `pause-session` refuses a task with no live session.
 */
export function isPauseOffered(input: {
  hasLiveSession: boolean;
  laneRole: string | null | undefined;
}): boolean {
  const offer = sessionToggleOffer({
    phase: input.hasLiveSession ? 'active' : 'ended',
    laneRole: input.laneRole,
    // Pause never reads the archive state.
    task: { archived_at: null },
  });
  return offer?.direction === 'pause';
}

const RESUME_BLOCK_REASONS: readonly ResumeBlockReason[] = ['todo', 'done', 'archived'];

/** Each refusal's full sentence: where the task is, and the move that gets past it. */
const RESUME_BLOCK_MESSAGES: Readonly<Record<ResumeBlockReason, MessageDescriptor>> = {
  todo: msg`This task is in To Do. Move it to another column to start its agent.`,
  done: msg`This task is complete. Move it out of Done to continue working on it.`,
  archived: msg`This task is archived. Restore it to the board to continue working on it.`,
};

/** Each refusal as a toast body. */
const RESUME_BLOCK_TOAST_BODIES: Readonly<Record<ResumeBlockReason, MessageDescriptor>> = {
  todo: msg`The task is in To Do.`,
  done: msg`The task is in Done.`,
  archived: msg`The task is archived.`,
};

/**
 * User-facing copy for a refusal: where the task is, and the move that gets
 * past it. The main-process handler throws this string, so it is the phone's
 * error, and the card menu shows it as the disabled Resume row's tooltip. Both
 * are read on their own, with nothing else saying what to do, so each names
 * the move. A desktop toast reads the shorter `resumeBlockToastBody` instead.
 *
 * In English, because main throws it and the renderer matches it back
 * (`resumeBlockReasonOfMessage`). The renderer shows `resumeBlockRefusal`.
 */
export function resumeBlockMessage(reason: ResumeBlockReason): string {
  return englishText(RESUME_BLOCK_MESSAGES[reason]);
}

/** The same refusal as a message, for the card menu's tooltip in the session language. */
export function resumeBlockRefusal(reason: ResumeBlockReason): MessageDescriptor {
  return RESUME_BLOCK_MESSAGES[reason];
}

/**
 * The same refusal as a toast body: one sentence under the "Couldn't resume
 * session" title. The card the toast sits beside already shows the column, so
 * where the task is says enough there. Resolve it where it shows.
 */
export function resumeBlockToastBody(reason: ResumeBlockReason): MessageDescriptor {
  return RESUME_BLOCK_TOAST_BODIES[reason];
}

/**
 * The refusal whose `resumeBlockMessage` is `message`, or null when it is none.
 * Main throws the message, so this is how the renderer reads a refused resume
 * back to its reason to toast the short body. An exact match: both sides read
 * the one function above.
 */
export function resumeBlockReasonOfMessage(message: string): ResumeBlockReason | null {
  return RESUME_BLOCK_REASONS.find((reason) => resumeBlockMessage(reason) === message) ?? null;
}

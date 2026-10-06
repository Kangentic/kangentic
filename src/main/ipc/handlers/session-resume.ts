/**
 * Resume a task's paused session in place: the desktop Resume button's whole
 * path, shared by its IPC handler (`SESSION_RESUME` in `sessions.ts`) and the
 * phone's `start-session` verb for a paused task (`startTaskSession` in
 * `session-start.ts`). One function, so the two cannot drift: the same lock,
 * reconcile, eligibility gate, worktree ensure, label, and engine call.
 *
 * What it deliberately does NOT do is run the column's enter automations or
 * deliver its message. Those run only inside `spawnAgent`
 * (`engine.executeTransition(task, toLane, 'enter', ...)`), which a resume
 * never calls: `engine.resumeSuspendedSession` resumes the conversation idle,
 * with the column's model, effort and permission. A Resume on a paused task in
 * Code Review therefore does not send `/code-review` again, on the desktop or
 * from a phone.
 */
import { withTaskLock } from '../task-lifecycle-lock';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos, ensureTaskWorktree, createTransitionEngine, resolveSpawnOverrides } from '../helpers';
import { resolveProjectContext } from '../helpers/project-repos';
import { applyProfileToLane } from '../../transition-engine/column-strategy';
import { loadTaskProfile } from '../helpers/task-profile';
import { reconcileTaskSessionRef } from './session-reconcile';
import { abortInFlightResume, registerResumeController, releaseResumeController } from './session-resume-controllers';
import { claimSpawnProgress } from '../../transition-engine/spawn-progress';
import { isAbortError } from '../../../shared/abort-utils';
import { resumeBlockMessage, resumeBlockReasonForTask } from '../../../shared/session-resume-eligibility';
import type { Session, Task } from '../../../shared/types';
import type { SpawnFailureStep } from '../helpers/task-git';
import type { IpcContext } from '../ipc-context';

/** The two steps an accepted resume can fail at. */
export type ResumeFailureStep = Extract<SpawnFailureStep, 'worktree' | 'agent'>;

/** What Phase 1 decided, reported through `onAccepted`. */
export type ResumeAcceptance =
  /** A live session already exists for the task; it is returned and nothing spawns. */
  | 'live'
  /** The resume will run: the worktree ensure, then the engine's resume. */
  | 'resuming';

export interface ResumeTaskSessionOptions {
  /** The interaction-time project; falls back to the current one (project-scoped-ipc.md). */
  projectId?: string | null;
  /** Prompt the resumed CLI receives. The desktop passes it through; the phone never sends one. */
  resumePrompt?: string;
  /**
   * Called once, when Phase 1 has decided, before any git work. Not called
   * when Phase 1 throws (no project, a refused column, a missing task), or when
   * a cancel lands before Phase 1 runs, which resolves null. Lets a
   * caller with a short answer budget, the phone's `start-session`, reply on
   * acceptance and leave the slow part running, the way `move-task` replies on
   * `handleTaskMove`'s `onCommitted`.
   */
  onAccepted?: (acceptance: ResumeAcceptance) => void;
  /**
   * Called once, just before the rejection, when an accepted resume fails:
   * `'worktree'` with the git error itself (not the "Worktree setup failed"
   * wrapper the rejection carries), `'agent'` when anything in Phase 3 after
   * its refusal check fails: the profile fold, the engine setup, the engine
   * resume, or the session check after it. Not called for a refusal, in either phase,
   * or for an abort. For a caller that answered before the work ran and has
   * no rejection to show, the phone's `start-session`. The desktop Resume
   * passes none: the renderer toasts the rejection itself.
   */
  onFailed?: (step: ResumeFailureStep, error: unknown, task: Task) => void;
}

/**
 * Resolves with the resumed session, the live one Phase 1 found, or null when
 * a newer resume, a suspend, a reset, or a project relocation aborted this one.
 * Rejects with the desktop's own Resume copy for a To Do, Done, or archived
 * task, and with "Worktree setup failed: ..." when the git phase fails.
 *
 * Cancels any resume already in flight for the task first, for every caller. A
 * second Resume click replaces the first, and a phone Resume does exactly
 * what a desktop one does (decided for the phone deliberately: it mirrors the
 * desktop, rather than registering alongside the way the phone's plain Start
 * does in `autoSpawnForTask`).
 */
export function resumeTaskSession(
  context: IpcContext,
  taskId: string,
  options: ResumeTaskSessionOptions = {},
): Promise<Session | null> {
  // Cancel any in-flight resume BEFORE queueing on the lock. Moving this
  // outside the lock is required because Phase 2 (worktree git I/O) runs
  // unlocked - a second resume must be able to cancel the first's in-flight
  // fetch. Aborting inside the lock would deadlock: we'd be waiting for a
  // holder stuck in the now-unlocked git op.
  abortInFlightResume(taskId);
  const resumeController = new AbortController();
  registerResumeController(taskId, resumeController);
  const { signal } = resumeController;

  // A throwing hook must not replace the failure it reports.
  const reportFailure = (step: ResumeFailureStep, error: unknown, task: Task): void => {
    try {
      options.onFailed?.(step, error, task);
    } catch (hookError) {
      console.warn('[SESSION_RESUME] onFailed hook threw:', hookError);
    }
  };

  return (async (): Promise<Session | null> => {
    try {
      const { projectId: resolvedProjectId, projectPath: resolvedProjectPath } = resolveProjectContext(context, options.projectId);
      if (!resolvedProjectId) throw new Error('No project is currently open');

      const { tasks, automations, automationRuns, swimlanes, attachments: attachmentRepo } = getProjectRepos(context, resolvedProjectId);

      try {
        // Phase 1 (locked, short): validate task + lane, build plan.
        // Self-heal contract: if main already has a live PTY for this task,
        // return it instead of throwing. The renderer's view can drift after
        // rapid project switches (sessions[] entries with status='suspended'
        // for tasks whose registry entry is actually 'running'). Rather than
        // surfacing an error the user can't recover from without a restart,
        // we treat resume as idempotent and return the existing handle. The
        // renderer's resumeSession action replaces the stale entry and sets
        // activeSessionId, restoring the terminal attachment. That branch stays
        // AHEAD of the eligibility check below: handing back a PTY that already
        // exists spawns nothing, and it is the only path that re-attaches a
        // drifted renderer, including one drifted onto an archived task.
        const phase1Result = await withTaskLock(taskId, async () => {
          // A Pause or a newer resume can cancel this one while it waits for
          // the lock. It then stops here, before it accepts or labels the task.
          signal.throwIfAborted();
          const { task, liveSession } = reconcileTaskSessionRef(context, resolvedProjectId, taskId);
          if (liveSession) {
            return { kind: 'live' as const, session: liveSession };
          }
          const lane = swimlanes.getById(task.swimlane_id);
          const blocked = resumeBlockReasonForTask({ task, laneRole: lane?.role });
          if (blocked) throw new Error(resumeBlockMessage(blocked));
          return { kind: 'spawn' as const, task };
        });

        if (phase1Result.kind === 'live') {
          console.log(
            `[SESSION_RESUME] Self-heal: returning live session for task ${taskId.slice(0, 8)}`
            + ` (renderer view was stale)`,
          );
          options.onAccepted?.('live');
          return phase1Result.session;
        }
        const planTask = phase1Result.task;
        options.onAccepted?.('resuming');

        // Label the resume, as restoring from Done does (task-archive.ts), so
        // neither the desktop card nor a phone's reads "Paused" behind a Resume
        // button through a git phase that can take seconds. Only now: the
        // self-heal above spawns nothing. The `finally` below releases it on
        // every exit. A claim rather than a plain clear, because a phone Start
        // of the same task, or the newer resume that aborts this one, can label
        // the task before this one unwinds.
        const progress = claimSpawnProgress(context.mainWindow, taskId);
        progress.onProgress('resuming');
        // The git phase can report once more between an abort and its own
        // rejection (the post-worktree script's heartbeat). That push would
        // take the label back from the resume that aborted this one, and this
        // claim's release would then clear the newer resume's label.
        const onProgress = (phase: string): void => {
          if (!signal.aborted) progress.onProgress(phase);
        };
        try {
          // Phase 2 (unlocked, slow): git I/O. Serialized per-project by
          // WorktreeManager.projectQueues. AbortSignal cancels in-flight fetch
          // when SESSION_SUSPEND / a newer resume / SESSION_RESET fires.
          try {
            // The explicit projectId: if the user switches projects during this
            // slow git phase, a base-fetch failure's spawn warning must stamp
            // the resumed task's project, not whatever became ambient.
            await ensureTaskWorktree(context, planTask, tasks, resolvedProjectPath, { signal, onProgress, projectId: resolvedProjectId });
          } catch (worktreeError) {
            if (isAbortError(worktreeError)) throw worktreeError;
            reportFailure('worktree', worktreeError, planTask);
            const message = worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
            throw new Error(`Worktree setup failed: ${message}`, { cause: worktreeError });
          }

          // Phase 3 (locked, short): CAS-check invariants, then spawn the PTY
          // and write session_id. Re-read task because Phase 2 could have raced
          // with a concurrent handler that cleared session_id, moved the task
          // to To Do, or already spawned a session.
          return await withTaskLock(taskId, async () => {
            signal.throwIfAborted();
            // Reconcile against the registry: if a concurrent handler spawned a
            // live session during our Phase 2 gap, return it (don't duplicate).
            // If session_id is stale (registry-suspended/missing), reconcile
            // clears it so we proceed to spawn fresh.
            const { task: current, liveSession } = reconcileTaskSessionRef(context, resolvedProjectId, taskId);
            if (liveSession) return liveSession;
            // Re-read, not the Phase 1 snapshot: the task could have been moved or
            // archived (a move to Done archives in the same tick) during the
            // unlocked git I/O above. Read off the column's own row, since the
            // profile fold below passes `role` through untouched. A refusal is
            // the user's answer, not a failure, so it stays outside the try
            // that reports one.
            const currentRow = swimlanes.getById(current.swimlane_id);
            const currentBlocked = resumeBlockReasonForTask({ task: current, laneRole: currentRow?.role });
            if (currentBlocked) throw new Error(resumeBlockMessage(currentBlocked));

            // Every throw from here on is a resume that failed after a phone was
            // told `starting`: the profile fold and the engine setup as much as
            // the engine call, so all of them report through onFailed.
            try {
              // Folded through the task's Board Profile so an explicit Resume
              // restarts on the same rung the task was running, not the
              // column's base settings.
              const currentLane = applyProfileToLane(currentRow, loadTaskProfile(context, current, resolvedProjectPath));
              const db = getProjectDb(resolvedProjectId);
              const sessionRepo = new SessionRepository(db);
              const engine = createTransitionEngine(
                context, automations, automationRuns, tasks, sessionRepo, attachmentRepo,
                resolvedProjectId, resolvedProjectPath,
              );
              const project = context.projectRepo.getById(resolvedProjectId);
              const overrides = resolveSpawnOverrides(current, currentLane, project);
              await engine.resumeSuspendedSession(current, currentLane?.permission_mode, undefined, options.resumePrompt, signal, undefined, undefined, overrides);

              const updated = tasks.getById(taskId);
              if (!updated?.session_id) throw new Error('Session resume failed - no session_id on task');
              const newSession = context.sessionManager.getSession(updated.session_id);
              if (!newSession) throw new Error('Session resume failed - session not in manager');
              return newSession;
            } catch (resumeError) {
              if (!isAbortError(resumeError)) reportFailure('agent', resumeError, current);
              throw resumeError;
            }
          });
        } finally {
          progress.release();
        }
      } catch (error) {
        if (isAbortError(error)) {
          // A suspend, reset, relocation or newer resume took the task over,
          // and each settles the task under its own lock. No cleanup here,
          // deliberately, as in autoSpawnForTask's abort path: every abort
          // lands before this resume registers a row or writes session_id.
          // The engine's last checkpoint precedes sessionManager.spawn, the
          // session_id write follows it with no further checkpoint, and a
          // spawn a teardown cancels registers nothing. Removing the task's
          // rows here would drop the PAUSED row the canceller still needs;
          // docs/session-lifecycle.md records what that broke.
          console.log(`[SESSION_RESUME] Aborted stale resume for task ${taskId.slice(0, 8)}`);
          return null;
        }
        throw error;
      }
    } finally {
      releaseResumeController(taskId, resumeController);
    }
  })();
}

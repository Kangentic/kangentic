import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { simpleGit } from 'simple-git';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { WorktreeManager } from '../../git/worktree-manager';
import { slugify } from '../../../shared/slugify';
import { getProjectDb } from '../../db/database';
import {
  getProjectRepos,
  ensureTaskWorktree,
  ensureTaskBranchCheckout,
  createTransitionEngine,
  cleanupTaskResources,
  deleteTaskWorktree,
  spawnAgent,
  buildAutoCommandVars,
} from '../helpers';
import { interpolateTemplate } from '../../agent/shared';
import { trackEvent } from '../../analytics/analytics';
import { captureSessionMetrics } from './session-metrics';
import { markRecordExited, markRecordSuspended } from '../../engine/session-lifecycle';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { abortBacklogPromotion } from './backlog';
import { withTaskLock } from '../task-lifecycle-lock';
import { emitSpawnProgress, clearSpawnProgress, createProgressCallback } from '../../engine/spawn-progress';
import { resolveTargetAgent } from '../../engine/agent-resolver';
import type { Task, Swimlane } from '../../../shared/types';

/**
 * Capture git diff stats (lines added/removed, files changed) by comparing
 * the task's branch against its base branch. Best-effort, never throws.
 */
async function captureGitStats(
  task: Task,
  sessionRepo: SessionRepository,
  recordId: string,
  projectPath: string | null | undefined,
  defaultBaseBranch?: string,
): Promise<void> {
  const gitDir = task.worktree_path ?? projectPath;
  if (!gitDir) return;

  const baseBranch = task.base_branch || defaultBaseBranch || 'main';
  const git = simpleGit(gitDir);

  // Compare all changes (committed + uncommitted) against the merge-base.
  // Three-dot syntax `main...` means `git diff $(git merge-base main HEAD)`,
  // which shows only changes introduced on the task branch, excluding any
  // new commits on the base branch since the fork point.
  const diffResult = await git.diffSummary([baseBranch + '...']);

  sessionRepo.updateGitStats(recordId, {
    linesAdded: diffResult.insertions,
    linesRemoved: diffResult.deletions,
    filesChanged: diffResult.changed,
  });
}

/**
 * Guard: before checking out a branch in the main repo, verify no other
 * non-worktree task has an active PTY session. Checking out would change
 * the filesystem under a running agent.
 */
export function guardActiveNonWorktreeSessions(
  context: IpcContext,
  task: Task,
  tasks: ReturnType<typeof getProjectRepos>['tasks'],
): void {
  if (!task.base_branch || task.worktree_path) return;

  const activeSessions = context.sessionManager.listSessions()
    .filter(session => session.taskId !== task.id && (session.status === 'running' || session.status === 'queued'));

  const otherNonWorktreeSessions = activeSessions.filter(session => {
    const otherTask = tasks.getById(session.taskId);
    return otherTask && !otherTask.worktree_path;
  });

  if (otherNonWorktreeSessions.length > 0) {
    throw new Error(
      `Cannot switch to branch '${task.base_branch}': another task is running in the main repo. `
      + `Enable worktree mode for branch isolation.`
    );
  }
}

/**
 * Per-task AbortController to cancel in-flight moves when a newer move
 * supersedes the current one. Prevents orphaned sessions from spawning
 * when the user quickly moves a task back before the async spawn completes.
 * The signal propagates through the async call chain; each helper throws
 * AbortError when cancelled, and cleanup is centralized in a single catch.
 */
const taskMoveControllers = new Map<string, AbortController>();

/**
 * Core task-move logic shared by the TASK_MOVE IPC handler and the
 * plan-exit auto-move listener. Moves the task, runs transitions, and
 * manages session lifecycle based on the target column's role.
 */
/**
 * Plan returned from Phase 1 when the move needs a subsequent worktree +
 * spawn. Priorities 1 / 2 / 2.5 / 3b / 3c handle the entire move under the
 * Phase 1 lock and return null; only Priority 3a (handoff) and Priority 4
 * (no active session) carry through to Phase 2/3.
 */
type MoveSpawnPlan = {
  task: Task;
  fromSwimlaneId: string;
  originalPosition: number;
  toLane: Swimlane | undefined;
  skipPromptTemplate: boolean;
  resolvedProjectId: string;
  resolvedProjectPath: string | null;
};

export async function handleTaskMove(
  context: IpcContext,
  input: { taskId: string; targetSwimlaneId: string; targetPosition: number },
  projectId?: string | null,
  projectPath?: string | null,
): Promise<void> {
  // Abort any in-flight move or promotion BEFORE queueing on the lock - the
  // existing holder must see its abort and return so we can acquire the lock.
  taskMoveControllers.get(input.taskId)?.abort();
  abortBacklogPromotion(input.taskId);
  const moveController = new AbortController();
  taskMoveControllers.set(input.taskId, moveController);
  const { signal } = moveController;

  try {
    // === Phase 1 (locked, short) ===
    // All DB mutations and PTY kill/suspend dispatch for priorities 1-3.
    // Returns null when the move is fully handled inside Phase 1 (Priorities
    // 1, 2, 2.5, 3b, 3c), or a plan for Priority 3a / Priority 4 which need
    // slow worktree + spawn work in Phase 2/3.
    const plan = await withTaskLock(input.taskId, async (): Promise<MoveSpawnPlan | null> => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      // Use !== undefined (not ??) to distinguish "caller passed null" from "caller omitted the arg"
      const resolvedProjectPath = projectPath !== undefined ? projectPath : context.currentProjectPath;
      if (!resolvedProjectId) throw new Error('No project is currently open');

      const { tasks, swimlanes } = getProjectRepos(context, resolvedProjectId);
      const task = tasks.getById(input.taskId);
      if (!task) throw new Error(`Task ${input.taskId} not found`);

      const fromSwimlaneId = task.swimlane_id;
      const originalPosition = task.position;
      const fromLane = swimlanes.getById(fromSwimlaneId);
      const toLane = swimlanes.getById(input.targetSwimlaneId);

      // Only send the full prompt template (title + description + attachments) when
      // starting from To Do. Non-To Do sources are resuming previously-started
      // work, so re-sending the original description would duplicate context.
      const skipPromptTemplate = fromLane?.role !== 'todo';

      // Move the task in the database
      tasks.move(input);

      // Atomic archive for Done-role target: run synchronously in the same tick
      // as tasks.move so no reader can observe the intermediate state
      // (swimlane_id=Done, archived_at=NULL). better-sqlite3 is synchronous, so
      // a concurrent IPC handler cannot interleave SQL between these two calls.
      // Without this, a failure or hang in the downstream suspend/worktree-delete
      // leaves the task stuck as an active Done-column card.
      const isCrossColumnToDone = toLane?.role === 'done' && fromSwimlaneId !== input.targetSwimlaneId;
      if (isCrossColumnToDone) {
        tasks.archive(input.taskId);
        console.log(`[TASK_MOVE] Auto-archived task ${input.taskId.slice(0, 8)} (moved to Done)`);
      }

      // Within-column reorder: no side effects needed
      if (fromSwimlaneId === input.targetSwimlaneId) return null;

      const db = getProjectDb(resolvedProjectId);
      const sessionRepo = new SessionRepository(db);

      // Analytics: track critical-path transitions only.
      // Read agent from task.agent (set at spawn) and model from the latest
      // session record's metrics. Either may be missing (legacy rows, never
      // spawned, exited before status.json) - omit absent props.
      if (toLane?.role === 'done') {
        const completeProps: Record<string, string | number | boolean> = {};
        if (task.agent) completeProps.agent = task.agent;
        const latestSessionRecord = sessionRepo.getLatestForTask(task.id);
        if (latestSessionRecord?.model_id) completeProps.model = latestSessionRecord.model_id;
        trackEvent('task_complete', completeProps);
      }

      // --- Priority 1: TARGET IS TO DO → full reset (kill session, remove worktree, delete branch) ---
      if (toLane?.role === 'todo') {
        context.commandInjector.cancel(task.id);
        // Clear any lingering spawn progress label from an in-flight spawn
        // that was aborted by this move. The aborted move's catch block also
        // calls clearSpawnProgress, but doing it here too guarantees the
        // renderer's "Initializing..." indicator vanishes regardless of
        // whether the prior move reached its catch path.
        clearSpawnProgress(context.mainWindow, task.id);
        // Kill (but don't remove from map) any in-flight PTY session spawned
        // by a concurrent move that hasn't written session_id to the task
        // record yet. Using killByTaskId instead of removeByTaskId so the
        // session stays in the map - cleanupTaskResources needs it there for
        // awaitExit to wait for the process to actually die before removing
        // the worktree (Windows file handles aren't released until exit).
        context.sessionManager.killByTaskId(task.id);
        await cleanupTaskResources(context, task, tasks, resolvedProjectId, resolvedProjectPath);
        // Re-read the task to check if worktree_path was actually cleared
        const updatedTask = tasks.getById(task.id);
        if (updatedTask?.worktree_path) {
          console.warn(`[TASK_MOVE] Partial cleanup for task ${task.id.slice(0, 8)} (moved to To Do, session removed but worktree directory could not be deleted - will retry on next startup)`);
        } else {
          console.log(`[TASK_MOVE] Full cleanup for task ${task.id.slice(0, 8)} (moved to To Do, session + worktree + branch removed)`);
        }
        // Schedule background prune to clean up stale git worktree metadata
        if (resolvedProjectPath) {
          WorktreeManager.scheduleBackgroundPrune(resolvedProjectPath);
        }
        return null;
      }

      // --- Priority 2: TARGET IS DONE → suspend + archive (resumable on unarchive) ---
      if (toLane?.role === 'done') {
        context.commandInjector.cancel(task.id);
        if (task.session_id) {
          const record = sessionRepo.getLatestForTask(task.id);
          // Accept 'running' AND 'exited' -- exited covers Claude natural exit.
          // Queued sessions never started Claude CLI, so mark exited (not suspended)
          // to avoid a failed --resume attempt when the task is later moved back.
          if (record && record.agent_session_id
              && (record.status === 'running' || record.status === 'exited')) {
            // Capture metrics before suspend (caches are still populated)
            captureSessionMetrics(context.sessionManager, sessionRepo, task.session_id, record.id);
            markRecordSuspended(sessionRepo, record.id, 'system');
            console.log(`[TASK_MOVE] Suspended session record ${record.id.slice(0, 8)} for task ${task.id.slice(0, 8)}`);
          } else if (record && record.status === 'queued') {
            markRecordExited(sessionRepo, record.id);
            console.log(`[TASK_MOVE] Exited queued session record ${record.id.slice(0, 8)} for task ${task.id.slice(0, 8)}`);
          }
          await context.sessionManager.suspend(task.session_id);
          tasks.update({ id: task.id, session_id: null });
        } else {
          // No active PTY -- preserve latest exited session for future resume.
          // With the state machine, canResume() checks agent_session_id existence
          // regardless of status, so this marker is mainly for UI display.
          const record = sessionRepo.getLatestForTask(task.id);
          if (record && record.agent_session_id
              && record.session_type !== 'run_script'
              && record.status === 'exited') {
            markRecordSuspended(sessionRepo, record.id, 'system');
            console.log(`[TASK_MOVE] Preserved exited session ${record.id.slice(0, 8)} for future resume`);
          }
        }
        // Capture git diff stats (best-effort, async)
        const latestRecord = sessionRepo.getLatestForTask(task.id);
        if (latestRecord) {
          try {
            const effectiveConfig = context.configManager.getEffectiveConfig(resolvedProjectPath || undefined);
            const boardDefaultBranch = context.boardConfigManager.getDefaultBaseBranch();
            const effectiveDefaultBranch = boardDefaultBranch || effectiveConfig.git.defaultBaseBranch;
            await captureGitStats(task, sessionRepo, latestRecord.id, resolvedProjectPath, effectiveDefaultBranch);
          } catch {
            // Git stats capture is best-effort
          }
        }

        // Delete the local worktree to reclaim disk. Preserve branch_name and
        // session records so moving back out of Done can restore both.
        if (task.worktree_path) {
          const worktreeDeleted = await deleteTaskWorktree(context, task, tasks, resolvedProjectPath);
          if (worktreeDeleted) {
            console.log(`[TASK_MOVE] Deleted worktree for task ${task.id.slice(0, 8)} (moved to Done; branch + session preserved)`);
          } else {
            console.warn(`[TASK_MOVE] Partial worktree delete for task ${task.id.slice(0, 8)} (moved to Done; directory could not be deleted - will retry on next startup)`);
          }
          if (resolvedProjectPath) {
            WorktreeManager.scheduleBackgroundPrune(resolvedProjectPath);
          }
        }

        // Archive already happened synchronously right after tasks.move above.
        return null;
      }

      // --- Priority 2.5: TARGET HAS auto_spawn=false (and not backlog/done which are handled above) ---
      // → Suspend session if one exists, do NOT spawn new agent
      if (toLane && !toLane.auto_spawn) {
        context.commandInjector.cancel(task.id);
        if (task.session_id) {
          const record = sessionRepo.getLatestForTask(task.id);
          if (record && record.agent_session_id
              && (record.status === 'running' || record.status === 'exited')) {
            captureSessionMetrics(context.sessionManager, sessionRepo, task.session_id, record.id);
            markRecordSuspended(sessionRepo, record.id, 'system');
          } else if (record && record.status === 'queued') {
            markRecordExited(sessionRepo, record.id);
          }
          await context.sessionManager.suspend(task.session_id);
          tasks.update({ id: task.id, session_id: null });
          console.log(`[TASK_MOVE] Suspended session for task ${task.id.slice(0, 8)} (target column has auto_spawn=false)`);
        }
        return null;
      }

      // --- Priority 3: TASK HAS ACTIVE SESSION ---
      // Three sub-cases:
      //   a) Agent change (handoff): suspend + fall through to spawnAgent
      //   b) Same agent + auto_command: inject command directly into running session
      //   c) Same agent, no auto_command: keep session alive (no-op)
      if (task.session_id) {
        context.commandInjector.cancel(task.id);

        const project = context.projectRepo.getById(resolvedProjectId);
        const { agent: effectiveTargetAgent, isHandoff: isAgentChange } = resolveTargetAgent({
          columnAgent: toLane?.agent_override ?? null,
          taskAgent: task.agent,
          projectDefaultAgent: project?.default_agent ?? null,
        });

        if (isAgentChange) {
          // (a) Cross-agent handoff: suspend and fall through to spawnAgent.
          // Cross-agent resume is impossible (agent_session_id is agent-specific).
          const sessionRecord = sessionRepo.getLatestForTask(task.id);
          if (sessionRecord && sessionRecord.agent_session_id
              && (sessionRecord.status === 'running' || sessionRecord.status === 'exited')) {
            captureSessionMetrics(context.sessionManager, sessionRepo, task.session_id, sessionRecord.id);
            markRecordSuspended(sessionRepo, sessionRecord.id, 'system');
          } else if (sessionRecord && sessionRecord.status === 'queued') {
            markRecordExited(sessionRepo, sessionRecord.id);
          }
          await context.sessionManager.suspend(task.session_id);
          tasks.update({ id: task.id, session_id: null });
          console.log(
            `[TASK_MOVE] Suspending session for task ${task.id.slice(0, 8)}`
            + ` (agent change: ${task.agent} -> ${effectiveTargetAgent}).`
            + ` Will handoff to new agent.`,
          );
          // Fall through to Phase 2/3 (handoff spawn) by not returning null.
        } else if (toLane?.auto_command?.trim()) {
          // (b) Same agent + auto_command: inject directly into the running session.
          // No suspend/resume needed. commandInjector sends Ctrl+C to clear any
          // in-progress input, then types the command.
          const vars = buildAutoCommandVars(task);
          const interpolated = interpolateTemplate(toLane.auto_command, vars);
          context.commandInjector.schedule(task.id, task.session_id, interpolated);
          console.log(
            `[TASK_MOVE] Injecting auto_command for task ${task.id.slice(0, 8)}`
            + ` into running session: ${toLane.auto_command}`,
          );
          return null;
        } else {
          // (c) Same agent, no auto_command. Keep session alive.
          console.log(
            `[TASK_MOVE] Task ${task.id.slice(0, 8)} already has active session`
            + ` (no auto_command, same agent). Keeping session alive.`,
          );
          return null;
        }
      }

      // --- Priority 4 (or 3a fall-through): TASK HAS NO ACTIVE SESSION ---
      // Return the plan; Phase 2 creates the worktree (unlocked, serialized
      // per-project by WorktreeManager.projectQueues), Phase 3 spawns.
      return {
        task,
        fromSwimlaneId,
        originalPosition,
        toLane,
        skipPromptTemplate,
        resolvedProjectId,
        resolvedProjectPath,
      };
    });

    if (!plan) return; // Phase 1 fully handled the move

    const { task, fromSwimlaneId, originalPosition, toLane, skipPromptTemplate, resolvedProjectId, resolvedProjectPath } = plan;

    // === Phase 2 (unlocked, slow) ===
    // All async operations below receive the abort signal so a newer move
    // cancels them via AbortError. Cleanup is centralized in the outer catch.
    // Git I/O is serialized per-project by WorktreeManager.projectQueues; DB
    // writes inside ensureTaskWorktree are sync better-sqlite3 calls.
    const onProgress = createProgressCallback(context.mainWindow, task.id);
    try {
      // Create worktree if worktrees are enabled and task doesn't have one yet.
      // If worktree creation fails (e.g. duplicate branch), revert the task
      // back to its original column so it doesn't get stuck without a session.
      try {
        emitSpawnProgress(context.mainWindow, task.id, 'fetching');
        const { tasks: tasksPhase2 } = getProjectRepos(context, resolvedProjectId);
        await ensureTaskWorktree(context, task, tasksPhase2, resolvedProjectPath, { signal, onProgress });
      } catch (error) {
        // Let AbortError propagate to the outer catch for centralized handling
        if (isAbortError(error)) throw error;

        // Best-effort cleanup of stale resources that may have caused the failure
        // (e.g. leftover directory or branch from a previous partial cleanup).
        // This makes the next drag attempt succeed without requiring an app restart.
        if (resolvedProjectPath) {
          try {
            const worktreeManager = new WorktreeManager(resolvedProjectPath);
            const expectedSlug = slugify(task.title) || 'task';
            const expectedFolder = `${expectedSlug}-${task.id.slice(0, 8)}`;
            const expectedPath = path.join(resolvedProjectPath, '.kangentic', 'worktrees', expectedFolder);
            const expectedBranch = task.branch_name || expectedFolder;

            await worktreeManager.withLock(async () => {
              if (fs.existsSync(expectedPath)) {
                await worktreeManager.removeWorktree(expectedPath);
                // removeWorktree doesn't throw on failure - verify it actually worked
                if (fs.existsSync(expectedPath)) {
                  console.warn(`[TASK_MOVE] Could not remove stale worktree directory (file handles may still be held): ${expectedPath}`);
                } else {
                  console.log(`[TASK_MOVE] Cleaned stale worktree directory: ${expectedPath}`);
                }
              }
              await worktreeManager.pruneWorktrees();
              await worktreeManager.removeBranch(expectedBranch);
            });
          } catch (cleanupError) {
            console.warn('[TASK_MOVE] Stale resource cleanup failed (will retry on next attempt):', cleanupError);
          }
        }

        // Revert + session cleanup is handled by the outer catch below, which
        // runs on every non-abort failure (worktree setup, branch checkout,
        // or spawn). Wrap the error with a context message so the toast
        // surfaced to the renderer distinguishes worktree failures from
        // later spawn failures.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Worktree setup failed: ${message}`);
      }

      // Checkout the task's branch in the main repo (non-worktree tasks only).
      // Intentionally unguarded: if checkout fails, the error propagates to
      // the outer catch which also handles AbortError cleanup.
      const { tasks: tasksCheckout } = getProjectRepos(context, resolvedProjectId);
      guardActiveNonWorktreeSessions(context, task, tasksCheckout);
      if (!task.worktree_path) emitSpawnProgress(context.mainWindow, task.id, 'fetching');
      await ensureTaskBranchCheckout(task, resolvedProjectPath, { signal, onProgress });

      // === Phase 3 (locked, short) ===
      // CAS-check invariants before spawning. If a newer move ran during our
      // Phase 2 gap, task.swimlane_id / session_id will have changed and we
      // should bail out to avoid spawning for a stale target column. The
      // try/finally guarantees spawn-progress is cleared whether we spawn,
      // bail on CAS mismatch, or throw. The session-changed event would also
      // clear it via upsertSession, but fast-starting agents (Codex) race
      // with the renderer's state updates.
      await withTaskLock(input.taskId, async () => {
        try {
          signal.throwIfAborted();
          const { tasks: tasksPhase3, actions: actionsPhase3, attachments: attachmentsPhase3 } = getProjectRepos(context, resolvedProjectId);
          const current = tasksPhase3.getById(task.id);
          if (!current) {
            console.log(`[TASK_MOVE] Task ${task.id.slice(0, 8)} was deleted during Phase 2 - skipping spawn`);
            return;
          }
          if (current.swimlane_id !== input.targetSwimlaneId) {
            console.log(`[TASK_MOVE] Task ${task.id.slice(0, 8)} moved to a different column during Phase 2 - skipping spawn`);
            return;
          }
          if (current.session_id) {
            console.log(`[TASK_MOVE] Task ${task.id.slice(0, 8)} already has session ${current.session_id.slice(0, 8)} - skipping spawn`);
            return;
          }

          // Execute transition actions + ensure agent is running (handles resume/spawn/auto_command)
          emitSpawnProgress(context.mainWindow, task.id, 'starting-agent');
          const dbPhase3 = getProjectDb(resolvedProjectId);
          const sessionRepoPhase3 = new SessionRepository(dbPhase3);
          const engine = createTransitionEngine(context, actionsPhase3, tasksPhase3, sessionRepoPhase3, attachmentsPhase3, resolvedProjectId, resolvedProjectPath);
          if (toLane) {
            await spawnAgent({ context, engine, tasks: tasksPhase3, sessionRepo: sessionRepoPhase3, task: current, fromSwimlaneId, toLane, skipPromptTemplate, signal, projectId: resolvedProjectId, projectPath: resolvedProjectPath });
          }
        } finally {
          clearSpawnProgress(context.mainWindow, task.id);
        }
      });
    } catch (error) {
      clearSpawnProgress(context.mainWindow, task.id);
      const abort = isAbortError(error);

      // Unified rollback path for Phase 2/3 failures: clean up any partially
      // spawned session and revert the task move if the task is still in the
      // destination column. The CAS guard on swimlane_id means a concurrent
      // move that already relocated the task (e.g. user dragged again) keeps
      // its authoritative state - we only undo our own forward move.
      await withTaskLock(input.taskId, async () => {
        try {
          context.sessionManager.removeByTaskId(task.id);
          const { tasks: tasksRollback } = getProjectRepos(context, resolvedProjectId);
          const current = tasksRollback.getById(task.id);
          if (!current) return;
          if (current.session_id) {
            tasksRollback.update({ id: task.id, session_id: null });
          }
          if (!abort && current.swimlane_id === input.targetSwimlaneId) {
            tasksRollback.move({
              taskId: input.taskId,
              targetSwimlaneId: fromSwimlaneId,
              targetPosition: originalPosition,
            });
          }
        } catch (rollbackError) {
          console.error('[TASK_MOVE] Rollback after move failure failed:', rollbackError);
        }
      });

      if (abort) {
        console.log(`[TASK_MOVE] Aborted stale move for task ${task.id.slice(0, 8)}`);
        return;
      }
      throw error;
    }
  } finally {
    // Clean up controller if this is still the active one for this task
    if (taskMoveControllers.get(input.taskId) === moveController) {
      taskMoveControllers.delete(input.taskId);
    }
  }
}

export function registerTaskMoveHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.TASK_MOVE, async (_, input) => handleTaskMove(context, input));
}

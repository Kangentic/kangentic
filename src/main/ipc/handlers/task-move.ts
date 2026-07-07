import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import { captureGitStats } from './git-stats-capture';
import { WorktreeManager, type GitWaitProgress } from '../../git/worktree-manager';
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
import { autoLinkPRForTask } from '../../pr/pr-linking';
import { resolveProjectContext } from '../helpers/project-repos';
import { interpolateTemplate } from '../../agent/shared';
import { trackEvent } from '../../analytics/analytics';
import { parseModelId } from '../../../shared/model-id';
import { captureSessionMetrics, refineTranscriptTokens, refineTranscriptToolCounts } from './session-metrics';
import { markRecordExited, markRecordSuspended } from '../../transition-engine/session-lifecycle';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { abortBacklogPromotion } from './backlog';
import { withTaskLock } from '../task-lifecycle-lock';
import { isShuttingDown } from '../../shutdown-state';
import { runWithProjectLogContext } from '../../diagnostics/project-log-context';
import { emitSpawnProgress, emitSpawnWaiting, clearSpawnProgress, createProgressCallback, getInFlightSpawnProgress } from '../../transition-engine/spawn-progress';
import { resolveTargetAgent } from '../../transition-engine/agent-resolver';
import { agentRegistry } from '../../agent/agent-registry';
import { prepareInjectionPlan } from '../../transition-engine/injection-plan';
import { resolveIsolatedSwimlaneId, resolveForceFresh } from '../../transition-engine/session-isolation';
import type { Task, Swimlane, SessionRecord } from '../../../shared/types';

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
 * Suspend a live PTY session so Phase 3 can respawn it with new CLI flags:
 * capture metrics while caches are populated, mark the DB record suspended
 * (or exited for queued records that never started), suspend the PTY, and
 * clear task.session_id. Shared by the two same-agent respawn triggers on a
 * column move: a model change (the primary restart marker), and an effort delta
 * to a concrete target on an adapter with no live `/effort` swap.
 */
async function suspendLiveSessionForRespawn(args: {
  context: IpcContext;
  tasks: ReturnType<typeof getProjectRepos>['tasks'];
  sessionRepo: SessionRepository;
  usageHistoryRepo: UsageHistoryRepository;
  taskId: string;
  liveSessionId: string;
  record: SessionRecord | undefined | null;
}): Promise<void> {
  const { context, tasks, sessionRepo, usageHistoryRepo, taskId, liveSessionId, record } = args;
  if (record && record.agent_session_id
      && (record.status === 'running' || record.status === 'exited')) {
    captureSessionMetrics(
      context.sessionManager,
      sessionRepo,
      usageHistoryRepo,
      liveSessionId,
      record.id,
      record.started_at,
      record.session_type,
    );
    refineTranscriptTokens(context.sessionManager, sessionRepo, liveSessionId, record.id);
    refineTranscriptToolCounts(context.sessionManager, sessionRepo, liveSessionId, record.id);
    markRecordSuspended(sessionRepo, record.id, 'system');
  } else if (record && record.status === 'queued') {
    markRecordExited(sessionRepo, record.id);
  }
  await context.sessionManager.suspend(liveSessionId);
  tasks.update({ id: taskId, session_id: null });
}

/**
 * Abort the in-flight move/spawn for a task, if any. Returns true if a move
 * was actually aborted. The abort is deliberately OUTSIDE any task lock (per
 * the task-lifecycle-lock contract): the holder observes the signal and runs
 * the existing AbortError path, which clears spawn progress and rolls the move
 * back. Used by the TASK_CANCEL_SPAWN handler so the user can cancel a spawn
 * that is parked in the git queue or stuck fetching.
 */
export function abortTaskMove(taskId: string): boolean {
  const controller = taskMoveControllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

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
  /**
   * Delivered as the resumed session's next message by spawnAgent's fallback
   * when the destination column has no auto_command. Set by the plan-exit
   * auto-move so a respawned session does not sit idle. Required (not optional)
   * so every return site that builds a plan must thread it through explicitly;
   * a new respawn sub-case that forgets it is a compile error, not a silent
   * dropped continuation.
   */
  continuationPrompt: string | undefined;
  /**
   * Recovery move out of Done: spawnAgent must resume the session WITHOUT
   * injecting the destination column's auto_command. Required (not optional) so
   * every plan-return site threads it through explicitly; a new respawn sub-case
   * that forgets it is a compile error, not a silently-injected command on a
   * restore. See spawnAgent's `suppressAutoCommand`.
   */
  suppressAutoCommand: boolean;
};

export async function handleTaskMove(
  context: IpcContext,
  input: { taskId: string; targetSwimlaneId: string; targetPosition: number },
  projectId?: string | null,
  projectPath?: string | null,
  // Kept out of `input` (which flows raw from the renderer over IPC) so the
  // renderer cannot inject prompts; only main-process callers (the plan-exit
  // listener) can pass a continuation.
  options?: { continuationPrompt?: string },
): Promise<void> {
  // Abort any in-flight move or promotion BEFORE queueing on the lock - the
  // existing holder must see its abort and return so we can acquire the lock.
  taskMoveControllers.get(input.taskId)?.abort();
  abortBacklogPromotion(input.taskId);
  const moveController = new AbortController();
  taskMoveControllers.set(input.taskId, moveController);
  const { signal } = moveController;

  // Tag every project-scoped log emitted across Phases 1-3 (worktree + spawn)
  // with the project this move targets, so concurrent moves on different
  // projects stay distinguishable in the dev terminal. Resolve the name from
  // the same id Phase 1 resolves; an unresolvable id (no project open) skips
  // the tag so the body inherits no misleading ambient context.
  const logProjectId = projectId ?? context.currentProjectId;
  const logProjectName = logProjectId
    ? context.projectRepo.getById(logProjectId)?.name ?? null
    : null;
  const runMove = async (): Promise<void> => {
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

      // Recovery move: the first move OUT of Done (whatever the destination)
      // resumes the session idle without injecting the destination column's
      // auto_command. The user is restoring the task to inspect it; the next
      // move injects per column config. See spawnAgent's `suppressAutoCommand`.
      const suppressAutoCommand = fromLane?.role === 'done';

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
      const usageHistoryRepo = new UsageHistoryRepository(db);

      // Analytics: track critical-path transitions only.
      // Read agent from task.agent (set at spawn) and model from the latest
      // session record (the most recent run's CLI model id). Cost/duration/
      // token/tool metrics come from the LIFETIME summary aggregated across
      // every session row for the task (getSummaryForTask), so a task worked
      // across resume/suspend legs reports cumulative totals rather than just
      // the final leg - getLatestForTask alone would silently drop every
      // earlier leg's metrics. Any field may be missing (legacy rows, never
      // spawned, exited before any usage was recorded) - omit absent props.
      // These are properties on an existing event (budget-neutral), not new
      // events.
      if (toLane?.role === 'done') {
        const completeProps: Record<string, string | number | boolean> = {};
        if (task.agent) completeProps.agent = task.agent;
        const latestSessionRecord = sessionRepo.getLatestForTask(task.id);
        if (latestSessionRecord?.model_id) {
          completeProps.model = parseModelId(latestSessionRecord.model_id).baseId;
        }
        const lifetimeSummary = sessionRepo.getSummaryForTask(task.id);
        if (lifetimeSummary) {
          completeProps.durationSeconds = Math.round(lifetimeSummary.durationMs / 1000);
          completeProps.costUsd = Math.round(lifetimeSummary.totalCostUsd * 10000) / 10000;
          completeProps.inputTokens = lifetimeSummary.totalInputTokens;
          completeProps.outputTokens = lifetimeSummary.totalOutputTokens;
          completeProps.toolCalls = lifetimeSummary.toolCallCount;
        }
        trackEvent('task_complete', completeProps);
      }

      // --- Priority 1: TARGET IS TO DO → full reset (kill session, remove worktree, delete branch) ---
      if (toLane?.role === 'todo') {
        context.terminalSubmitScheduler.cancel(task.id);
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
        // kill() always tags the exit intentional, so this deliberate hard
        // reset's non-zero force-kill exit never surfaces a false "Session
        // crashed" toast.
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
        context.terminalSubmitScheduler.cancel(task.id);
        if (task.session_id) {
          const record = sessionRepo.getLatestForTask(task.id);
          // Accept 'running' AND 'exited' -- exited covers Claude natural exit.
          // Queued sessions never started Claude CLI, so mark exited (not suspended)
          // to avoid a failed --resume attempt when the task is later moved back.
          if (record && record.agent_session_id
              && (record.status === 'running' || record.status === 'exited')) {
            // Capture metrics before suspend (caches are still populated)
            captureSessionMetrics(
              context.sessionManager,
              sessionRepo,
              usageHistoryRepo,
              task.session_id,
              record.id,
              record.started_at,
              record.session_type,
            );
            refineTranscriptTokens(context.sessionManager, sessionRepo, task.session_id, record.id);
            refineTranscriptToolCounts(context.sessionManager, sessionRepo, task.session_id, record.id);
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
            await captureGitStats(task, sessionRepo, usageHistoryRepo, latestRecord.id, resolvedProjectPath, effectiveDefaultBranch);
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
        context.terminalSubmitScheduler.cancel(task.id);
        if (task.session_id) {
          const record = sessionRepo.getLatestForTask(task.id);
          if (record && record.agent_session_id
              && (record.status === 'running' || record.status === 'exited')) {
            captureSessionMetrics(
              context.sessionManager,
              sessionRepo,
              usageHistoryRepo,
              task.session_id,
              record.id,
              record.started_at,
              record.session_type,
            );
            refineTranscriptTokens(context.sessionManager, sessionRepo, task.session_id, record.id);
            refineTranscriptToolCounts(context.sessionManager, sessionRepo, task.session_id, record.id);
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
      // Five sub-cases (in evaluation order):
      //   a) Agent change (handoff): suspend + fall through to spawnAgent
      //   b) Same agent + permission-mode delta (destination's effective mode
      //      differs from the session record's spawn-time mode): suspend and
      //      respawn so --permission-mode / --model / --effort land as CLI
      //      flags (no adapter can switch permission mode on a live session)
      //   c) Same agent + adapter has live-swap plan: inject command(s)
      //      directly into running session (model/effort/auto_command)
      //   d) Same agent + no live-swap plan + model/effort delta: suspend
      //      and respawn so the new flags land via command-line args
      //   e) Same agent + no delta and no live-swap: keep session alive
      //      (no-op; preserves auto_command-less moves between custom columns)
      if (task.session_id) {
        context.terminalSubmitScheduler.cancel(task.id);

        // The session record for the currently-live PTY. Read once here and
        // reused by the agent-change / respawn suspend paths below (one read,
        // not three).
        const activeRecord = sessionRepo.getLatestForTask(task.id);

        // --- Session switch: suspend the live session and route to Phase 2/3,
        //     which resumes-or-spawns the TARGET session via spawnAgent(toLane)
        //     (the target track + fresh-vs-resume policy are derived from the
        //     column in resolveSpawnOverrides). Two conditions trigger it:
        //       1. The live session is on a DIFFERENT track than the target wants.
        //          A single inequality covers both transitions: entering an
        //          isolated column (active != that column's id) and leaving one
        //          back to main (active is a swimlane id, target is null). The
        //          leave case is the bug guard: without it, leaving an isolated
        //          column would mis-fire as Priority 3d keep-alive and strand the
        //          isolated session in a normal column.
        //       2. The target column forces a fresh session each entry
        //          ('always_spawn_new'), even when the track is the SAME. Phase 3
        //          carries forceFresh and spawns fresh, retiring the prior pass.
        //     Suspend preserves agent_session_id so the prior record stays
        //     retireable/resumable. The worktree is shared and already exists, so
        //     Phase 2 is a no-op; going through Phase 3 reuses the CAS + abort +
        //     rollback machinery (a PTY spawned here in Phase 1 would bypass that
        //     and could leak on a mid-spawn abort). Entering with NO live session
        //     is handled by Priority 4 below; this branch only fires for a live one.
        const targetIsolatedSwimlaneId = resolveIsolatedSwimlaneId(toLane);
        const activeIsolatedSwimlaneId = activeRecord?.isolated_swimlane_id ?? null;
        const targetForceFresh = resolveForceFresh(toLane);
        const needsSessionSwitch = toLane !== undefined
          && (activeIsolatedSwimlaneId !== targetIsolatedSwimlaneId || targetForceFresh);
        if (needsSessionSwitch && toLane) {
          if (activeRecord && activeRecord.agent_session_id
              && (activeRecord.status === 'running' || activeRecord.status === 'exited')) {
            captureSessionMetrics(
              context.sessionManager,
              sessionRepo,
              usageHistoryRepo,
              task.session_id,
              activeRecord.id,
              activeRecord.started_at,
              activeRecord.session_type,
            );
            refineTranscriptTokens(context.sessionManager, sessionRepo, task.session_id, activeRecord.id);
            refineTranscriptToolCounts(context.sessionManager, sessionRepo, task.session_id, activeRecord.id);
            markRecordSuspended(sessionRepo, activeRecord.id, 'system');
          } else if (activeRecord && activeRecord.status === 'queued') {
            markRecordExited(sessionRepo, activeRecord.id);
          }
          await context.sessionManager.suspend(task.session_id);
          tasks.update({ id: task.id, session_id: null });
          console.log(
            `[TASK_MOVE] Session switch for task ${task.id.slice(0, 8)}:`
            + ` ${activeIsolatedSwimlaneId ?? 'main'} -> ${targetIsolatedSwimlaneId ?? 'main'}`
            + ` (${targetForceFresh ? 'force-fresh' : 'resume-or-spawn'};`
            + ` suspended live session; Phase 3 will spawn/resume the target).`,
          );
          return {
            task,
            fromSwimlaneId,
            originalPosition,
            toLane,
            skipPromptTemplate,
            resolvedProjectId,
            resolvedProjectPath,
            continuationPrompt: options?.continuationPrompt,
            suppressAutoCommand,
          };
        }

        const project = context.projectRepo.getById(resolvedProjectId);
        const { agent: effectiveTargetAgent, isHandoff: isAgentChange } = resolveTargetAgent({
          taskAgentOverride: task.agent_override,
          columnAgent: toLane?.agent_override ?? null,
          taskAgent: task.agent,
          projectDefaultAgent: project?.default_agent ?? null,
        });

        if (isAgentChange) {
          // (a) Cross-agent handoff: suspend and fall through to spawnAgent.
          // Cross-agent resume is impossible (agent_session_id is agent-specific).
          const sessionRecord = activeRecord;
          if (sessionRecord && sessionRecord.agent_session_id
              && (sessionRecord.status === 'running' || sessionRecord.status === 'exited')) {
            captureSessionMetrics(
              context.sessionManager,
              sessionRepo,
              usageHistoryRepo,
              task.session_id,
              sessionRecord.id,
              sessionRecord.started_at,
              sessionRecord.session_type,
            );
            refineTranscriptTokens(context.sessionManager, sessionRepo, task.session_id, sessionRecord.id);
            refineTranscriptToolCounts(context.sessionManager, sessionRepo, task.session_id, sessionRecord.id);
            markRecordSuspended(sessionRepo, sessionRecord.id, 'system');
          } else if (sessionRecord && sessionRecord.status === 'queued') {
            markRecordExited(sessionRepo, sessionRecord.id);
          }
          await context.sessionManager.suspend(task.session_id);
          // Clear per-task model/effort overrides on cross-agent handoff.
          // Override values are model-name-specific (e.g. "claude-sonnet-4-6")
          // and effort tiers are agent-specific (e.g. Claude's "xhigh" is
          // Opus-only and has no analogue on Codex). Carrying them into a
          // different agent's spawn would either crash the CLI or be silently
          // ignored. Cleanest contract: the lock applies for the duration of
          // a single agent's tenure on the task; an explicit handoff resets it
          // and the user can re-pick on the new agent if they want.
          //
          // Skipped when `task.agent_override` is set: the user locked the
          // agent at task creation and the model/effort were picked for that
          // exact agent. Normally `resolveTargetAgent` returns the override
          // and `isHandoff` is false in that case, so this branch shouldn't
          // even execute - this guard is defensive against state drift.
          const handoffUpdates: Parameters<typeof tasks.update>[0] = {
            id: task.id,
            session_id: null,
          };
          if (!task.agent_override) {
            handoffUpdates.model_override = null;
            handoffUpdates.effort_override = null;
          }
          tasks.update(handoffUpdates);
          console.log(
            `[TASK_MOVE] Suspending session for task ${task.id.slice(0, 8)}`
            + ` (agent change: ${task.agent} -> ${effectiveTargetAgent}).`
            + (task.agent_override
                ? ` Kept model/effort overrides (task has locked agent_override).`
                : ` Cleared model/effort overrides.`)
            + ` Will handoff to new agent.`,
          );
          // Fall through to Phase 2/3 (handoff spawn) by not returning null.
        } else {
          // Same agent, live session. For this column transition:
          //   1. MODEL change  -> the ONLY restart marker: suspend + `--resume`
          //      so the resumed spawn re-applies model + effort + permission as
          //      launch flags and re-delivers the column auto_command / plan-exit
          //      continuation. A live `/model` swap is deliberately NOT used: it
          //      left the agent paused after a Planning -> Executing handoff.
          //   2. EFFORT-only change (same model) -> live `/effort` injection (or a
          //      respawn for adapters with no live effort swap and a concrete target).
          //   3. PERMISSION-only change, or no change -> keep the live session
          //      running untouched. A permission delta NEVER restarts: in the
          //      canonical Planning -> Executing flow the user already approved the
          //      plan in the terminal and Claude left plan mode in-session, so the
          //      recorded spawn-time permission mode is a stale signal that must
          //      not churn the PTY.
          //
          // Translation of the model/effort/auto_command delta is delegated to
          // prepareInjectionPlan so adapters own their slash syntax and the
          // model-restart policy stays in one place (agent-agnostic here).
          const adapter = task.agent ? agentRegistry.get(task.agent) : undefined;
          const interpolatedAuto = toLane?.auto_command?.trim()
            ? interpolateTemplate(toLane.auto_command, buildAutoCommandVars(task))
            : '';
          const plan = prepareInjectionPlan({
            adapter,
            sessionRepo,
            task,
            toLane: toLane ?? null,
            autoCommand: interpolatedAuto,
          });

          // 1. Model change -> suspend + respawn. Checked BEFORE live injection
          // so a model change never live-swaps. Phase 3 re-applies the flags and
          // delivers the auto_command / continuation via spawnAgent.
          if (plan?.needsRestartForModel) {
            await suspendLiveSessionForRespawn({
              context,
              tasks,
              sessionRepo,
              usageHistoryRepo,
              taskId: task.id,
              liveSessionId: task.session_id,
              record: activeRecord,
            });
            console.log(
              `[TASK_MOVE] Suspending session for task ${task.id.slice(0, 8)}`
              + ` (model change requires respawn). Will respawn with destination column flags.`,
            );
            return {
              task,
              fromSwimlaneId,
              originalPosition,
              toLane,
              skipPromptTemplate,
              resolvedProjectId,
              resolvedProjectPath,
              continuationPrompt: options?.continuationPrompt,
              suppressAutoCommand,
            };
          }

          // 2a. Effort-only change (and/or auto_command) with a live-swap plan ->
          // inject into the running PTY. With no model delta the sequence carries
          // at most `/effort` + the auto_command.
          if (plan) {
            context.terminalSubmitScheduler.scheduleKeystrokes(task.id, task.session_id, plan.sequence, {
              verifier: plan.verifier,
              verifiedPrefixLength: plan.verifiedPrefixLength,
            });
            // Record what the burst applied so the NEXT move diffs against the
            // session's new running value instead of re-injecting it.
            if (plan.appliedSettings) {
              sessionRepo.updateAppliedSettings(task.session_id, plan.appliedSettings);
            }
            console.log(
              `[TASK_MOVE] Injecting ${plan.sequence.length} command(s) for task ${task.id.slice(0, 8)}`
              + ` into running session${plan.verifier ? ' (with command verification)' : ''}: ${plan.sequence.join(' | ')}`,
            );
            return null;
          }

          // 2b. No live-swap plan, but an EFFORT delta to a concrete target on an
          // adapter with no live `/effort` swap -> suspend + respawn to apply the
          // new effort as a CLI flag. (Model deltas are handled in step 1 above; a
          // null target is the "Default" column, which `--resume` preserves, so no
          // respawn.) Source is the session's ACTUAL applied value (same ground
          // truth prepareInjectionPlan uses), NOT the leaving column's config - a
          // null/drifted `fromLane` would otherwise churn the PTY. Per-task
          // overrides win (no respawn when the task pinned the field). The
          // `!interpolatedAuto` guard is structurally redundant (an auto_command
          // would have produced a non-null plan above) but kept for safety.
          const sourceEffort = task.effort_override ?? activeRecord?.applied_effort ?? null;
          const targetEffort = task.effort_override ?? toLane?.effort_override ?? null;
          const restartNeededForEffort = targetEffort !== sourceEffort && targetEffort !== null;

          if (restartNeededForEffort && !interpolatedAuto) {
            await suspendLiveSessionForRespawn({
              context,
              tasks,
              sessionRepo,
              usageHistoryRepo,
              taskId: task.id,
              liveSessionId: task.session_id,
              record: activeRecord,
            });
            console.log(
              `[TASK_MOVE] Suspending session for task ${task.id.slice(0, 8)}`
              + ` (effort changed, adapter has no live swap). Will respawn with new settings.`,
            );
            // Fall through to Phase 2/3 (spawn with new settings)
            return {
              task,
              fromSwimlaneId,
              originalPosition,
              toLane,
              skipPromptTemplate,
              resolvedProjectId,
              resolvedProjectPath,
              continuationPrompt: options?.continuationPrompt,
              suppressAutoCommand,
            };
          }

          // 3. Permission-only delta, or no delta -> keep the live session alive.
          // A permission change never restarts (see header); there is no
          // model/effort delta to apply.
          console.log(
            `[TASK_MOVE] Task ${task.id.slice(0, 8)} keeping active session alive`
            + ` (no model change; permission-only or no delta, same agent).`,
          );
          return null;
        }
      }

      // --- Priority 4 (or 3a fall-through): TASK HAS NO ACTIVE SESSION ---
      // Return the plan; Phase 2 creates the worktree (unlocked, serialized
      // per-project by WorktreeManager.projectQueues), Phase 3 spawns.

      // Symmetric clear for cross-agent destinations on the no-session path.
      // Mirrors the live-handoff clear in Priority 3a (line ~336): model and
      // effort overrides are model-name-specific and don't carry across
      // agents. Without this, a task created in a Claude column with overrides
      // and dragged into a Codex column before its first spawn would pass
      // `claude-sonnet-4-6` into Codex's command builder. We do this here
      // (after the early returns above) so non-spawning destinations (Done,
      // auto_spawn=false) keep the user's overrides intact for when the task
      // moves back into a spawning column.
      //
      // Skipped when `task.agent_override` is set: the user locked the agent
      // at task creation, so the model/effort were picked for that exact
      // agent. Column moves cannot trigger an agent change in this case
      // (resolveTargetAgent returns task.agent_override regardless of column),
      // so the overrides remain valid.
      let planTask = task;
      if (!planTask.agent_override && (planTask.model_override || planTask.effort_override) && toLane) {
        const project = context.projectRepo.getById(resolvedProjectId);
        const projectDefault = project?.default_agent ?? null;
        const sourceAgent = planTask.agent ?? projectDefault;
        const targetAgent = toLane.agent_override ?? projectDefault;
        if (sourceAgent && targetAgent && sourceAgent !== targetAgent) {
          tasks.update({
            id: planTask.id,
            model_override: null,
            effort_override: null,
          });
          console.log(
            `[TASK_MOVE] Cleared model/effort overrides on task ${planTask.id.slice(0, 8)}`
            + ` (cross-agent move ${sourceAgent} -> ${targetAgent}, no live session).`,
          );
          // Refresh the snapshot so the downstream plan reflects the cleared
          // state (Phase 3 re-reads task from DB anyway, but the plan object
          // is a captured snapshot consumed by the caller).
          const refreshed = tasks.getById(planTask.id);
          if (refreshed) planTask = refreshed;
        }
      }

      return {
        task: planTask,
        fromSwimlaneId,
        originalPosition,
        toLane,
        skipPromptTemplate,
        resolvedProjectId,
        resolvedProjectPath,
        continuationPrompt: options?.continuationPrompt,
        suppressAutoCommand,
      };
    });

    if (!plan) return; // Phase 1 fully handled the move

    // Shutdown started while Phase 1 ran. Skip Phase 2 git work and Phase 3
    // spawn so we don't write to a closed DB. autoSpawnTasks on next launch
    // will spawn for the destination column.
    if (isShuttingDown()) return;

    const { task, fromSwimlaneId, originalPosition, toLane, skipPromptTemplate, resolvedProjectId, resolvedProjectPath, continuationPrompt, suppressAutoCommand } = plan;

    // === Phase 2 (unlocked, slow) ===
    // All async operations below receive the abort signal so a newer move
    // cancels them via AbortError. Cleanup is centralized in the outer catch.
    // Git I/O is serialized per-project by WorktreeManager.projectQueues; DB
    // writes inside ensureTaskWorktree are sync better-sqlite3 calls.
    const onProgress = createProgressCallback(context.mainWindow, task.id);
    // Emitted only when the git op parks in the per-project queue behind
    // another op. The 'fetching' label is emitted by the git layer itself once
    // the op actually starts, so we no longer eagerly show "Fetching latest..."
    // here (which made a queue wait masquerade as an active fetch).
    const onWaitProgress = (info: GitWaitProgress) => emitSpawnWaiting(
      context.mainWindow,
      task.id,
      info.jobsAhead,
      info.runningLabel ? { label: info.runningLabel, elapsedMs: info.runningElapsedMs } : undefined,
    );
    try {
      // Create worktree if worktrees are enabled and task doesn't have one yet.
      // If worktree creation fails (e.g. duplicate branch), revert the task
      // back to its original column so it doesn't get stuck without a session.
      try {
        const { tasks: tasksPhase2 } = getProjectRepos(context, resolvedProjectId);
        await ensureTaskWorktree(context, task, tasksPhase2, resolvedProjectPath, { signal, onProgress, onWaitProgress });
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
            }, { label: `stale-cleanup:${task.id.slice(0, 8)}` });
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
      await ensureTaskBranchCheckout(task, resolvedProjectPath, { signal, onProgress, onWaitProgress });

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
          // Shutdown started while we were waiting for the lock or Phase 2 ran.
          // The DB may already be closed; skip the spawn entirely. The
          // try/finally still calls clearSpawnProgress to clean the renderer UI.
          if (isShuttingDown()) return;
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
            await spawnAgent({ context, engine, tasks: tasksPhase3, sessionRepo: sessionRepoPhase3, task: current, fromSwimlaneId, toLane, skipPromptTemplate, signal, projectId: resolvedProjectId, projectPath: resolvedProjectPath, continuationPrompt, suppressAutoCommand });
          }
        } finally {
          clearSpawnProgress(context.mainWindow, task.id);
        }
      });
    } catch (error) {
      // Shutdown closed the DB while a Phase 1 / 2 / 3 await was in flight.
      // Both the post-await DB write inside Phase 1 (e.g. line 226's
      // tasks.update after sessionManager.suspend) and the rollback below
      // would throw against the closed connection. Bail silently - shutdown
      // is already clearing session_id on running sessions and Phase 1's
      // earlier sync writes (tasks.move, tasks.archive, markRecordSuspended)
      // are committed. The IPC wrapper's swallow is a backstop; this guard
      // also keeps the rollback's "Rollback after move failure failed" log
      // from firing during shutdown.
      if (isShuttingDown()) return;

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
  };

  return logProjectName ? runWithProjectLogContext(logProjectName, runMove) : runMove();
}

export function registerTaskMoveHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.TASK_MOVE, async (_, input, projectId?: string | null) => {
    try {
      // Prefer the renderer-stamped projectId (captured at drop time) over the
      // ambient current project, which can change if the user switches projects
      // during the FlyingCard flight. Resolve the matching projectPath too so
      // Phase 2/3 worktree + spawn work also targets the right project, not the
      // ambient one. handleTaskMove keeps the ambient fallback for main-process
      // internal callers that pass undefined.
      const { projectId: resolvedProjectId, projectPath: resolvedProjectPath } = resolveProjectContext(context, projectId);
      const result = await handleTaskMove(context, input, resolvedProjectId, resolvedProjectPath);
      // After the move's task lock has released, resolve the PR for the new lane
      // (gated on a branch + non-To Do lane inside the helper). Fire-and-forget so
      // a slow gh query never blocks the move response.
      autoLinkPRForTask(context, input.taskId, resolvedProjectId ?? context.currentProjectId);
      return result;
    } catch (error) {
      // Shutdown closes the DB synchronously; any handler that crossed an
      // await boundary will throw "database connection is not open" or an
      // AbortError when it resumes. Swallow these to keep the shutdown log
      // clean - the user already quit and Phase 1's DB writes are committed.
      if (isShuttingDown()) return;
      throw error;
    }
  });

  // Queryable snapshot of in-flight spawn-progress labels (keyed by taskId).
  // syncSessions() reconciles its spawnProgress map against this so an HMR
  // reload during the brief "Starting agent..." window cannot strand a card.
  ipcMain.handle(IPC.TASK_GET_SPAWN_PROGRESS, () => getInFlightSpawnProgress());

  // Cancel an in-flight spawn (e.g. from the "still preparing" stall toast).
  // Fire-and-forget abort, OUTSIDE any lock - the move's holder observes the
  // signal and runs the existing AbortError rollback.
  ipcMain.handle(IPC.TASK_CANCEL_SPAWN, (_event, taskId: string) => {
    abortTaskMove(taskId);
  });
}

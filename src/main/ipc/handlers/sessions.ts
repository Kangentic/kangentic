import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { withTaskLock } from '../task-lifecycle-lock';
import { SessionRepository } from '../../db/repositories/session-repository';
import { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos, ensureTaskWorktree, createTransitionEngine, resolveSpawnOverrides } from '../helpers';
import { linkPR, autoLinkPRForTask } from '../../pr/pr-linking';
import { resolveProjectContext } from '../helpers/project-repos';
import { getCachedTaskTitle } from './task-title-cache';
import { handleTaskMove } from './task-move';
import { trackEvent } from '../../analytics/analytics';
import { parseModelId } from '../../../shared/model-id';
import { captureSessionMetrics, refineTranscriptTokens, refineTranscriptToolCounts } from './session-metrics';
import { markRecordExited, markRecordSuspended, promoteRecord, recoverStaleSessionId } from '../../transition-engine/session-lifecycle';
import { isShuttingDown } from '../../shutdown-state';
import { applySuspendDbWrites, reconcileTaskSessionRef } from './session-reconcile';
import { abortInFlightResume, registerResumeController, releaseResumeController } from './session-resume-controllers';
import type { Session, TaskResolvePrResult } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { broadcast } from '../../pop-out/window-broadcast';

// Track session start times for duration calculation on exit
const sessionStartTimes = new Map<string, number>();

// Track which session ids have already fired the `session_spawn` analytics
// event so we never double-fire if `session-changed` re-emits running for the
// same id. Cleared on exit alongside `sessionStartTimes`.
const sessionSpawnAnalyticsFired = new Set<string>();

export function registerSessionHandlers(context: IpcContext): void {
  // === Sessions ===
  ipcMain.handle(IPC.SESSION_SPAWN, (_, input, projectId?: string | null) => {
    const resolvedProjectId = projectId ?? context.currentProjectId;
    if (!resolvedProjectId) throw new Error('Cannot spawn session: no project is currently open');
    return context.sessionManager.spawn({ ...input, projectId: resolvedProjectId });
  });
  ipcMain.handle(IPC.SESSION_KILL, (_, id) => {
    // Serialize against suspend/resume/reset for the same task so KILL can't
    // race with an in-flight grace-window suspend or worktree-bound resume.
    // If the session is unknown to the manager (already gone), fall through
    // to the bare kill which is a no-op.
    const taskId = context.sessionManager.getSessionTaskId(id);
    if (!taskId) return context.sessionManager.kill(id);
    return withTaskLock(taskId, async () => context.sessionManager.kill(id));
  });
  ipcMain.handle(IPC.SESSION_WRITE, (_, id, data) => context.sessionManager.write(id, data));
  // Renderer drain acknowledgement for per-session output backpressure. One-way
  // (send, not invoke): the renderer reports bytes it has consumed so main can
  // pause/resume the session's PTY. Keyed by sessionId only - not project-scoped.
  ipcMain.on(IPC.SESSION_DRAIN_ACK, (_, id: string, bytes: number) => {
    context.sessionManager.acknowledgeDrain(id, bytes);
  });
  ipcMain.handle(IPC.SESSION_RESIZE, (_, id, cols, rows) => context.sessionManager.resize(id, cols, rows));
  ipcMain.handle(IPC.SESSION_LIST, () => context.sessionManager.listSessions());
  // Targeted self-heal probe: returns the live registry session for a task
  // (or null) and clears any stale task.session_id pointer on the DB row.
  // Used by the task detail dialog to reconcile a 'suspended' renderer view
  // before committing to the resume branch. Cheaper than SESSION_LIST and
  // does not spawn anything (unlike SESSION_RESUME's self-heal). No
  // withTaskLock: this is a read-mostly probe and contention with concurrent
  // suspend/resume is acceptable.
  ipcMain.handle(IPC.SESSION_RECONCILE, (_, taskId: string, projectId?: string | null): Session | null => {
    const resolvedProjectId = projectId ?? context.currentProjectId;
    if (!resolvedProjectId) return null;
    const { liveSession } = reconcileTaskSessionRef(context, resolvedProjectId, taskId);
    return liveSession;
  });
  ipcMain.handle(IPC.SESSION_GET_SCROLLBACK, (_, id) => context.sessionManager.getScrollback(id));
  // Unscoped map of sessionId -> true for sessions that have emitted first
  // output. Lets syncSessions rebuild `sessionFirstOutput` after an HMR reload
  // (renderer state resets to {}) so a running session isn't flashed back to
  // its "Starting agent..." boot state.
  ipcMain.handle(IPC.SESSION_GET_FIRST_OUTPUT, () => context.sessionManager.getFirstOutputCache());
  ipcMain.handle(IPC.SESSION_GET_USAGE, (_, projectId?: string) =>
    projectId ? context.sessionManager.getUsageCacheForProject(projectId) : context.sessionManager.getUsageCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY, (_, projectId?: string) =>
    projectId ? context.sessionManager.getActivityCacheForProject(projectId) : context.sessionManager.getActivityCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY_REASON, (_, sessionId: string) => context.sessionManager.getActivityReason(sessionId));
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY_REASONS, (_, projectId?: string) =>
    projectId
      ? context.sessionManager.getActivityReasonsCacheForProject(projectId)
      : context.sessionManager.getActivityReasonsCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY_STATS, (_, sessionId: string) => context.sessionManager.getActivityStatsSnapshot(sessionId));
  ipcMain.handle(IPC.SESSION_GET_EVENTS, (_, sessionId: string) => context.sessionManager.getEventsForSession(sessionId));
  ipcMain.handle(IPC.SESSION_GET_EVENTS_CACHE, (_, projectId?: string) =>
    projectId ? context.sessionManager.getEventsCacheForProject(projectId) : context.sessionManager.getEventsCache());

  // === Session Suspend / Resume ===
  ipcMain.handle(IPC.SESSION_SUSPEND, (_, taskId: string, projectId?: string | null) => {
    // Cancel any in-flight resume BEFORE queueing on the lock - otherwise
    // we would deadlock waiting for a resume that is stuck in worktree I/O.
    abortInFlightResume(taskId);

    return withTaskLock(taskId, async () => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!resolvedProjectId) throw new Error('No project is currently open');

      const { tasks } = getProjectRepos(context, resolvedProjectId);
      const task = tasks.getById(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (!task.session_id) return; // nothing to suspend

      const sessionId = task.session_id;
      // DB writes first (capture metrics, mark record suspended, clear
      // task.session_id) then async PTY shutdown. Capturing metrics before
      // shutdown is required - caches are still populated; afterwards is
      // also fine, but doing it first matches task-move's order.
      applySuspendDbWrites(context, resolvedProjectId, taskId, 'user');
      await context.sessionManager.suspend(sessionId);
    });
  });

  ipcMain.handle(IPC.SESSION_RESUME, (_, taskId: string, resumePrompt?: string, projectId?: string | null) => {
    // Cancel any in-flight resume BEFORE queueing on the lock. Moving this
    // outside the lock is required because Phase 2 (worktree git I/O) runs
    // unlocked - a second resume must be able to cancel the first's in-flight
    // fetch. Aborting inside the lock would deadlock: we'd be waiting for a
    // holder stuck in the now-unlocked git op.
    abortInFlightResume(taskId);
    const resumeController = new AbortController();
    registerResumeController(taskId, resumeController);
    const { signal } = resumeController;

    return (async (): Promise<Session | null> => {
      const { projectId: resolvedProjectId, projectPath: resolvedProjectPath } = resolveProjectContext(context, projectId);
      if (!resolvedProjectId) throw new Error('No project is currently open');

      const { tasks, actions, swimlanes, attachments: attachmentRepo } = getProjectRepos(context, resolvedProjectId);

      try {
        // Phase 1 (locked, short): validate task + lane, build plan.
        // Self-heal contract: if main already has a live PTY for this task,
        // return it instead of throwing. The renderer's view can drift after
        // rapid project switches (sessions[] entries with status='suspended'
        // for tasks whose registry entry is actually 'running'). Rather than
        // surfacing an error the user can't recover from without a restart,
        // we treat resume as idempotent and return the existing handle. The
        // renderer's resumeSession action replaces the stale entry and sets
        // activeSessionId, restoring the terminal attachment.
        const phase1Result = await withTaskLock(taskId, async () => {
          const { task, liveSession } = reconcileTaskSessionRef(context, resolvedProjectId, taskId);
          if (liveSession) {
            return { kind: 'live' as const, session: liveSession };
          }
          const lane = swimlanes.getById(task.swimlane_id);
          if (lane?.role === 'todo') {
            throw new Error('Cannot resume a session for a task in the To Do column');
          }
          return { kind: 'spawn' as const, task };
        });

        if (phase1Result.kind === 'live') {
          console.log(
            `[SESSION_RESUME] Self-heal: returning live session for task ${taskId.slice(0, 8)}`
            + ` (renderer view was stale)`,
          );
          return phase1Result.session;
        }
        const planTask = phase1Result.task;

        // Phase 2 (unlocked, slow): git I/O. Serialized per-project by
        // WorktreeManager.projectQueues. AbortSignal cancels in-flight fetch
        // when SESSION_SUSPEND / a newer SESSION_RESUME / SESSION_RESET fires.
        try {
          await ensureTaskWorktree(context, planTask, tasks, resolvedProjectPath, { signal });
        } catch (worktreeError) {
          if (isAbortError(worktreeError)) throw worktreeError;
          const message = worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
          throw new Error(`Worktree setup failed: ${message}`);
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
          const currentLane = swimlanes.getById(current.swimlane_id);
          if (currentLane?.role === 'todo') {
            throw new Error('Cannot resume a session for a task in the To Do column');
          }

          const db = getProjectDb(resolvedProjectId);
          const sessionRepo = new SessionRepository(db);
          const engine = createTransitionEngine(
            context, actions, tasks, sessionRepo, attachmentRepo,
            resolvedProjectId, resolvedProjectPath,
          );

          const project = context.projectRepo.getById(resolvedProjectId);
          const overrides = resolveSpawnOverrides(current, currentLane, project);
          await engine.resumeSuspendedSession(current, currentLane?.permission_mode, undefined, resumePrompt, signal, undefined, undefined, overrides);

          const updated = tasks.getById(taskId);
          if (!updated?.session_id) throw new Error('Session resume failed - no session_id on task');
          const newSession = context.sessionManager.getSession(updated.session_id);
          if (!newSession) throw new Error('Session resume failed - session not in manager');
          return newSession;
        });
      } catch (error) {
        if (isAbortError(error)) {
          console.log(`[SESSION_RESUME] Aborted stale resume for task ${taskId.slice(0, 8)}`);
          // Clean up partial state under the lock so a concurrent handler
          // cannot observe a half-written session_id.
          await withTaskLock(taskId, async () => {
            context.sessionManager.removeByTaskId(taskId);
            tasks.update({ id: taskId, session_id: null });
          });
          return null;
        }
        throw error;
      } finally {
        releaseResumeController(taskId, resumeController);
      }
    })();
  });

  // === Session Reset (safety-net recovery for unrecoverable sessions) ===
  ipcMain.handle(IPC.SESSION_RESET, (_, taskId: string, projectId?: string | null) => {
    // Cancel any in-flight resume BEFORE queueing on the lock - otherwise
    // we would deadlock waiting for a resume that is stuck in worktree I/O.
    abortInFlightResume(taskId);

    return withTaskLock(taskId, async () => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!resolvedProjectId) throw new Error('No project is currently open');

      const { tasks } = getProjectRepos(context, resolvedProjectId);
      const task = tasks.getById(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);

      // Kill PTY if running
      if (task.session_id) {
        context.sessionManager.kill(task.session_id);
      }
      // Also remove any PTY registered by taskId (covers ghost sessions
      // that were never written to the task record)
      context.sessionManager.removeByTaskId(taskId);

      // Atomically mark latest session record as exited in DB
      const db = getProjectDb(resolvedProjectId);
      const sessionRepo = new SessionRepository(db);
      const latest = sessionRepo.getLatestForTask(taskId);
      if (latest) {
        markRecordExited(sessionRepo, latest.id);
      }

      // Clear task's session reference
      tasks.update({ id: taskId, session_id: null });
    });
  });

  // === Session Summaries ===
  ipcMain.handle(IPC.SESSION_GET_SUMMARY, (_, taskId: string) => {
    if (!context.currentProjectId) return null;
    const db = getProjectDb(context.currentProjectId);
    const sessionRepo = new SessionRepository(db);
    return sessionRepo.getSummaryForTask(taskId);
  });

  ipcMain.handle(IPC.SESSION_LIST_SUMMARIES, () => {
    if (!context.currentProjectId) return {};
    const db = getProjectDb(context.currentProjectId);
    const sessionRepo = new SessionRepository(db);
    return sessionRepo.listAllSummaries();
  });

  // Live per-tool breakdown for an active session. Unlike the summary handlers
  // above, this reads the in-memory accumulator (no DB / project lookup), so it
  // works mid-session and survives the bounded event cache.
  ipcMain.handle(IPC.SESSION_GET_TOOL_BREAKDOWN, (_, sessionId: string) => {
    return context.sessionManager.getToolBreakdown(sessionId);
  });

  // Set which sessions are visible in the renderer (terminal panel + command bar overlay).
  // Background sessions stop emitting data IPC (accumulate in scrollback only).
  ipcMain.handle(IPC.SESSION_SET_FOCUSED, (_, sessionIds: string[]) => {
    context.sessionManager.setFocusedSessions(sessionIds);
    // Immediately flush any buffered usage/events so the newly focused
    // sessions' data is up-to-date without waiting for the 2s timer.
    flushBackgroundBuffer();
  });

  // User pressed Ctrl+C in the terminal. Renderer already sent \x03 to
  // the PTY directly; this is a parallel signal so the activity engine
  // can recover quickly when the agent's hooks don't fire.
  ipcMain.handle(IPC.SESSION_NOTIFY_USER_INTERRUPT, (_, sessionId: string) => {
    context.sessionManager.signalUserInterrupt(sessionId);
  });

  // === Background IPC Buffering ===
  // Buffer usage and event IPC for non-focused sessions, flushing every 2 seconds.
  // This reduces IPC churn from O(N*freq) to O(1*freq) + trickle.
  // Activity state is NEVER buffered (drives board card states, sidebar badges, notifications).
  const BACKGROUND_FLUSH_MS = 2000;
  const bufferedUsage = new Map<string, { data: unknown; projectId: string | undefined }>();
  const bufferedEvents: Array<{ sessionId: string; event: unknown; projectId: string | undefined }> = [];
  let backgroundFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function isFocusedSession(sessionId: string): boolean {
    const focused = context.sessionManager.getFocusedSessions();
    return focused.size === 0 || focused.has(sessionId);
  }

  function scheduleBackgroundFlush(): void {
    if (backgroundFlushTimer) return;
    backgroundFlushTimer = setTimeout(flushBackgroundBuffer, BACKGROUND_FLUSH_MS);
  }

  function flushBackgroundBuffer(): void {
    backgroundFlushTimer = null;
    if (context.mainWindow.isDestroyed()) return;

    // Flush buffered usage (last-write-wins per session)
    for (const [sessionId, { data, projectId }] of bufferedUsage) {
      broadcast(context.mainWindow, IPC.SESSION_USAGE, sessionId, data, projectId);
    }
    bufferedUsage.clear();

    // Flush buffered events (in order)
    for (const entry of bufferedEvents) {
      context.mainWindow.webContents.send(IPC.SESSION_EVENT, entry.sessionId, entry.event, entry.projectId);
    }
    bufferedEvents.length = 0;
  }

  // Forward PTY events to renderer (guard against destroyed window during shutdown)
  // Each event includes the session's projectId so the renderer can filter by project.
  context.sessionManager.on('data', (sessionId: string, data: string) => {
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      context.mainWindow.webContents.send(IPC.SESSION_DATA, sessionId, data, projectId);
    }
  });

  context.sessionManager.on('first-output', (sessionId: string) => {
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      context.mainWindow.webContents.send(IPC.SESSION_FIRST_OUTPUT, sessionId, projectId);
    }
  });

  context.sessionManager.on('usage', (sessionId: string, data: unknown) => {
    if (context.mainWindow.isDestroyed()) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (isFocusedSession(sessionId)) {
      broadcast(context.mainWindow, IPC.SESSION_USAGE, sessionId, data, projectId);
    } else {
      // Buffer for background sessions (last-write-wins)
      bufferedUsage.set(sessionId, { data, projectId });
      scheduleBackgroundFlush();
    }
  });

  context.sessionManager.on('activity', (sessionId: string, state: string, reason: unknown) => {
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      const taskId = context.sessionManager.getSessionTaskId(sessionId);
      let taskTitle: string | undefined;
      if (taskId && projectId) {
        // Resolved through a short-TTL cache: this fires on every activity
        // transition (including the frequent `thinking` signal) but the title
        // is only used for the occasional notification, so a per-event DB query
        // would be pure main-loop tax. See task-title-cache.ts.
        taskTitle = getCachedTaskTitle(taskId, Date.now(), () => {
          try {
            return new TaskRepository(getProjectDb(projectId)).getById(taskId)?.title;
          } catch {
            // Project DB may not exist yet -- skip title lookup
            return undefined;
          }
        });
      }
      broadcast(context.mainWindow, IPC.SESSION_ACTIVITY, sessionId, state, reason, projectId, taskId, taskTitle);

      // A session going idle (the agent finished its turn) is the catch-all
      // signal that a PR may have just been created mid-session - the move-time
      // resolve fired before the PR existed, and the gh-command sniffer
      // (`pr-candidate`) misses a PR opened any other way. Re-resolve now so the
      // card links within seconds instead of waiting for the periodic sweep.
      // NON-force via autoLinkPRForTask, so the 60s per-task throttle coalesces
      // the repeated idles a long session emits. Skip transient (Command
      // Terminal) sessions: their synthetic taskId is not a real task row.
      //
      // Deliberately the granular 'idle' state only (turn complete), NOT the
      // idle-vs-active bucket: a 'permission' pause is mid-turn, so it did not
      // just create a PR. Check the literal first so the per-event getSession
      // registry lookup is skipped on the far-more-frequent 'thinking' events.
      // activity-state-ok: granular turn-completion check, not an idle/active bucket.
      if (state === 'idle' && taskId && projectId) {
        const session = context.sessionManager.getSession(sessionId);
        if (session && !session.transient) {
          autoLinkPRForTask(context, taskId, projectId);
        }
      }
    }
  });

  context.sessionManager.on('event', (sessionId: string, event: unknown) => {
    if (context.mainWindow.isDestroyed()) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (isFocusedSession(sessionId)) {
      context.mainWindow.webContents.send(IPC.SESSION_EVENT, sessionId, event, projectId);
    } else {
      bufferedEvents.push({ sessionId, event, projectId });
      scheduleBackgroundFlush();
    }
  });

  context.sessionManager.on('session-changed', (sessionId: string, session: Session) => {
    if (session.status === 'running') {
      sessionStartTimes.set(sessionId, Date.now());

      // Analytics: track spawn intent on the first running transition. Model
      // is not known yet (arrives later via status.json) and is omitted here -
      // session_exit / task_complete carry the model.
      if (!sessionSpawnAnalyticsFired.has(sessionId)) {
        sessionSpawnAnalyticsFired.add(sessionId);
        const spawnAgentName = context.sessionManager.getSessionAgentName(sessionId);
        if (spawnAgentName) {
          trackEvent('session_spawn', {
            agent: spawnAgentName,
            isTransient: !!session.transient,
          });
        }
      }

      // Atomically promote DB record from 'queued' to 'running'
      const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);
      if (resolvedProjectId) {
        try {
          const database = getProjectDb(resolvedProjectId);
          const sessionRepo = new SessionRepository(database);
          const managedSession = context.sessionManager.getSession(sessionId);
          if (managedSession) {
            const record = sessionRepo.getLatestForTask(managedSession.taskId);
            if (record) {
              promoteRecord(sessionRepo, record.id);
            }
          }
        } catch {
          // DB may be closed during shutdown
        }
      }
    }
    if (!context.mainWindow.isDestroyed()) {
      broadcast(context.mainWindow, IPC.SESSION_STATUS, sessionId, session, session.projectId);
    }
  });

  context.sessionManager.on('idle-timeout', (sessionId: string, taskId: string, timeoutMinutes: number) => {
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!context.mainWindow.isDestroyed()) {
      broadcast(context.mainWindow, IPC.SESSION_IDLE_TIMEOUT, sessionId, taskId, timeoutMinutes, projectId);
    }
    if (!projectId) return;

    // session-manager.suspend() (called by session-telemetry.requestSuspend) already
    // flipped the registry status synchronously. Mirror those writes into the DB
    // so task.session_id and the session record agree with the registry.
    // Without this, SESSION_RESUME's reconciliation has to recover from the
    // divergence on the next user click - cleaner to fix it here at the source.
    void withTaskLock(taskId, async () => {
      try {
        context.terminalSubmitScheduler.cancel(taskId);
        applySuspendDbWrites(context, projectId, taskId, 'system');
      } catch (error) {
        console.error('[idle-timeout] DB sync failed:', error);
      }
    });
  });

  // Stale session ID recovery: when a resuming session reports a different
  // agent session_id (from status.json), --resume failed silently and Claude
  // created a fresh session. Update the DB so the next resume uses the correct UUID.
  context.sessionManager.on('agent-session-id', (sessionId: string, taskId: string, projectId: string, agentReportedId: string) => {
    try {
      const database = getProjectDb(projectId);
      const sessionRepo = new SessionRepository(database);
      recoverStaleSessionId(sessionRepo, sessionId, taskId, agentReportedId);
    } catch {
      // DB may be closed
    }
  });

  context.sessionManager.on('exit', (sessionId: string, exitCode: number, intentional?: boolean) => {
    const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);

    // Analytics: track session exit with duration (skip recovered sessions with no start time)
    const startTime = sessionStartTimes.get(sessionId);
    if (startTime) {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      const exitProps: Record<string, string | number | boolean> = { exitCode, durationSeconds };
      const exitAgentName = context.sessionManager.getSessionAgentName(sessionId);
      if (exitAgentName) exitProps.agent = exitAgentName;
      // Read model/cost from the in-memory usage cache (still populated at
      // this point; captureSessionMetrics below clears it). The DB record's
      // fields are not written until captureSessionMetrics runs, so we
      // cannot read them from the repo here. Token counts are deliberately
      // omitted: the cache's contextWindow figures are a current-context
      // snapshot, not the cumulative lifetime totals (those are covered by
      // task_complete's DB-sourced numbers instead). toolCalls reads the
      // live UsageAccumulator counter directly (same source
      // captureSessionMetrics uses) rather than the cache's stamped
      // toolCallCount, so it never reports staler than the DB.
      const usageForExit = context.sessionManager.getUsageCache()[sessionId];
      if (usageForExit?.model?.id) exitProps.model = parseModelId(usageForExit.model.id).baseId;
      if (usageForExit?.cost?.totalCostUsd != null) {
        exitProps.costUsd = Math.round(usageForExit.cost.totalCostUsd * 10000) / 10000;
      }
      exitProps.toolCalls = context.sessionManager.getToolCallCount(sessionId);
      trackEvent('session_exit', exitProps);
      sessionStartTimes.delete(sessionId);
      sessionSpawnAnalyticsFired.delete(sessionId);
    }

    if (!context.mainWindow.isDestroyed()) {
      broadcast(context.mainWindow, IPC.SESSION_EXIT, sessionId, exitCode, resolvedProjectId, intentional);
    }

    // Persist exit status to session DB -- use the session's own projectId
    // so we write to the correct DB even if the user switched projects.
    if (resolvedProjectId) {
      try {
        const db = getProjectDb(resolvedProjectId);
        const sessionRepo = new SessionRepository(db);
        const usageHistoryRepo = new UsageHistoryRepository(db);
        // Atomically mark 'running' or 'queued' records as 'exited'.
        // compareAndUpdateStatus guards against overwriting 'suspended',
        // which is set by TASK_MOVE before the async onExit fires.
        //
        // Shutdown-race hardening: during app quit a PTY exit is NOT a natural
        // exit - the app is tearing down sessions we want resumed next launch.
        // syncShutdownCleanup normally marks running records 'suspended' before
        // killAll, but a PTY can die first and reach this listener before that
        // runs. Recording an abnormal 'exited' here would force startup recovery
        // to reinterpret it via the interrupted-exited gather; marking
        // 'suspended' keeps it on the clean resume path. Only RUNNING records
        // are redirected - queued never started a CLI (mark exited, matching
        // syncShutdownCleanup), and suspended/exited rows CAS-no-op either way.
        // (Power loss / SIGKILL leaves isShuttingDown() false; startup recovery
        // is the real fix there.)
        const shuttingDown = isShuttingDown();
        let updated = false;
        const session = context.sessionManager.getSession(sessionId);
        if (session) {
          // Resolve the EXACT record for the exiting PTY by its id (the DB record
          // id equals the PTY session id), NOT getLatestForTask: a task can hold
          // multiple session records (its main session + per-column isolated
          // sessions), so "latest for task" could mark a newer, still-running
          // session's record exited if this exit arrives out of order after a
          // session switch. The CAS still no-ops on an intentionally 'suspended'
          // record.
          const record = sessionRepo.findByAnyId(sessionId);
          if (record) {
            updated = shuttingDown && record.status === 'running'
              ? markRecordSuspended(sessionRepo, record.id, 'system')
              : markRecordExited(sessionRepo, record.id, {
                  exit_code: exitCode,
                  exited_at: new Date().toISOString(),
                });
          }
        }
        // Fallback: try matching by agent_session_id only if taskId lookup didn't find it
        if (!updated) {
          const byAgentId = db.prepare(
            `SELECT id, status FROM sessions WHERE agent_session_id = ? AND status IN ('running', 'queued') LIMIT 1`
          ).get(sessionId) as { id: string; status: string } | undefined;
          if (byAgentId) {
            if (shuttingDown && byAgentId.status === 'running') {
              markRecordSuspended(sessionRepo, byAgentId.id, 'system');
            } else {
              markRecordExited(sessionRepo, byAgentId.id, {
                exit_code: exitCode,
                exited_at: new Date().toISOString(),
              });
            }
          }
        }

        // Capture session metrics (usage/event caches are still populated at this point).
        // Determine the DB record from whichever lookup path succeeded above.
        const metricsRecord = session
          ? sessionRepo.findByAnyId(sessionId)
          : (updated ? null : (db.prepare(
              `SELECT id, started_at, session_type FROM sessions WHERE agent_session_id = ? ORDER BY started_at DESC LIMIT 1`
            ).get(sessionId) as { id: string; started_at: string; session_type: string } | undefined) ?? null);

        if (metricsRecord) {
          captureSessionMetrics(
            context.sessionManager,
            sessionRepo,
            usageHistoryRepo,
            sessionId,
            metricsRecord.id,
            metricsRecord.started_at,
            metricsRecord.session_type,
          );
          refineTranscriptTokens(context.sessionManager, sessionRepo, sessionId, metricsRecord.id);
          refineTranscriptToolCounts(context.sessionManager, sessionRepo, sessionId, metricsRecord.id);
        }
      } catch {
        // DB may be closed during shutdown
      }
    }
  });

  // Auto-link PR when an agent's `gh pr ...` command finishes (or on session
  // exit if its ToolEnd was lost). The candidate is just the hint; the
  // authoritative branch->PR query runs in linkPR, with the scrollback
  // passed through only as the gh-unavailable degradation fallback.
  context.sessionManager.on('pr-candidate', (sessionId: string, scrollback: string) => {
    void linkPR(context, { sessionId, scrollback }).catch((error) => {
      console.error(`[pr-candidate] Failed to resolve PR for session ${sessionId}:`, error);
    });
  });

  // Manual "Link / refresh PR" - on-demand authoritative resolve for a task.
  // Works with no live session (maps by task id, resolves via the confidence ladder).
  ipcMain.handle(IPC.TASK_RESOLVE_PR, async (_, taskId: string, projectId?: string | null): Promise<TaskResolvePrResult> => {
    const resolvedProjectId = projectId ?? context.currentProjectId;
    if (!resolvedProjectId) return { task: null, linked: false, reason: 'no-anchor' };
    const result = await linkPR(context, { projectId: resolvedProjectId, taskId, force: true });
    return {
      task: result.task,
      linked: result.status === 'linked' || result.status === 'unchanged',
      reason: result.status,
      message: result.message,
    };
  });

  // Auto-move task once the user APPROVES the plan (ExitPlanMode completes).
  // The upstream gate fires `plan-exit` only on the tool's PostToolUse, which
  // the CLI emits solely on approval; a rejected plan emits no completion, so
  // this handler never runs and the task stays in Planning.
  //
  // When the destination column changes the effective permission mode (the
  // common Planning -> Executing pipeline), the move suspends the PTY and
  // respawns it with --resume plus the destination's CLI flags. A bare
  // --resume leaves the CLI idle waiting for input, so the resumed session
  // needs an explicit first message: this continuation. Because the move now
  // happens only after genuine approval, the wording is factually accurate.
  // Plain English, agent-agnostic. A destination auto_command takes
  // precedence over it.
  const PLAN_EXIT_CONTINUATION_PROMPT =
    'Proceed with implementing the approved plan.';
  context.sessionManager.on('plan-exit', async (sessionId: string) => {
    // Use the session's own projectId -- not the singleton, which may have
    // changed if the user switched projects while the agent was running.
    const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!resolvedProjectId) return;
    try {
      const session = context.sessionManager.getSession(sessionId);
      if (!session) return;

      const project = context.projectRepo.getById(resolvedProjectId);
      const resolvedProjectPath = project?.path ?? null;
      const { tasks, swimlanes } = getProjectRepos(context, resolvedProjectId);
      const task = tasks.getBySessionId(sessionId);
      if (!task) return;

      const lane = swimlanes.getById(task.swimlane_id);
      if (!lane?.plan_exit_target_id) return;

      const target = swimlanes.getById(lane.plan_exit_target_id);
      if (!target) return;

      const position = tasks.list(target.id).length;
      await handleTaskMove(
        context,
        { taskId: task.id, targetSwimlaneId: target.id, targetPosition: position },
        resolvedProjectId,
        resolvedProjectPath,
        { continuationPrompt: PLAN_EXIT_CONTINUATION_PROMPT },
      );

      if (!context.mainWindow.isDestroyed()) {
        context.mainWindow.webContents.send(IPC.TASK_AUTO_MOVED, task.id, target.id, task.title, resolvedProjectId);
      }
      console.log(`[plan-exit] Auto-moved "${task.title}" -> "${target.name}"`);
      // Resolve the PR for the new (non-To Do) lane - runs after the move's lock released.
      autoLinkPRForTask(context, task.id, resolvedProjectId);
    } catch (err) {
      console.error('[plan-exit] Auto-move failed:', err);
    }
  });
}

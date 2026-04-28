import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { withTaskLock } from '../task-lifecycle-lock';
import { SessionRepository } from '../../db/repositories/session-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos, ensureTaskWorktree, createTransitionEngine } from '../helpers';
import { handleTaskMove } from './task-move';
import { trackEvent } from '../../analytics/analytics';
import { captureSessionMetrics } from './session-metrics';
import { markRecordExited, promoteRecord, recoverStaleSessionId } from '../../engine/session-lifecycle';
import { applySuspendDbWrites, reconcileTaskSessionRef } from './session-reconcile';
import type { Session, UsageTimePeriod } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { computePeriodCutoff } from '../../../shared/period-cutoff';

// Track session start times for duration calculation on exit
const sessionStartTimes = new Map<string, number>();

/**
 * Per-task AbortController to cancel in-flight resumes when the session is
 * suspended before the async resume completes. Prevents orphaned sessions
 * from spawning when the user quickly moves a task back after clicking resume.
 */
const sessionResumeControllers = new Map<string, AbortController>();

export function registerSessionHandlers(context: IpcContext): void {
  // === Sessions ===
  ipcMain.handle(IPC.SESSION_SPAWN, (_, input) => {
    if (!context.currentProjectId) throw new Error('Cannot spawn session: no project is currently open');
    return context.sessionManager.spawn({ ...input, projectId: context.currentProjectId });
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
  ipcMain.handle(IPC.SESSION_RESIZE, (_, id, cols, rows) => context.sessionManager.resize(id, cols, rows));
  ipcMain.handle(IPC.SESSION_LIST, () => context.sessionManager.listSessions());
  ipcMain.handle(IPC.SESSION_GET_SCROLLBACK, (_, id) => context.sessionManager.getScrollback(id));
  ipcMain.handle(IPC.SESSION_GET_USAGE, (_, projectId?: string) =>
    projectId ? context.sessionManager.getUsageCacheForProject(projectId) : context.sessionManager.getUsageCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY, (_, projectId?: string) =>
    projectId ? context.sessionManager.getActivityCacheForProject(projectId) : context.sessionManager.getActivityCache());
  ipcMain.handle(IPC.SESSION_GET_EVENTS, (_, sessionId: string) => context.sessionManager.getEventsForSession(sessionId));
  ipcMain.handle(IPC.SESSION_GET_EVENTS_CACHE, (_, projectId?: string) =>
    projectId ? context.sessionManager.getEventsCacheForProject(projectId) : context.sessionManager.getEventsCache());

  // === Session Suspend / Resume ===
  ipcMain.handle(IPC.SESSION_SUSPEND, (_, taskId: string) => {
    // Cancel any in-flight resume BEFORE queueing on the lock - otherwise
    // we would deadlock waiting for a resume that is stuck in worktree I/O.
    sessionResumeControllers.get(taskId)?.abort();

    return withTaskLock(taskId, async () => {
      const resolvedProjectId = context.currentProjectId;
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

  ipcMain.handle(IPC.SESSION_RESUME, (_, taskId: string, resumePrompt?: string) => {
    // Cancel any in-flight resume BEFORE queueing on the lock. Moving this
    // outside the lock is required because Phase 2 (worktree git I/O) runs
    // unlocked - a second resume must be able to cancel the first's in-flight
    // fetch. Aborting inside the lock would deadlock: we'd be waiting for a
    // holder stuck in the now-unlocked git op.
    sessionResumeControllers.get(taskId)?.abort();
    const resumeController = new AbortController();
    sessionResumeControllers.set(taskId, resumeController);
    const { signal } = resumeController;

    return (async (): Promise<Session | null> => {
      const resolvedProjectId = context.currentProjectId;
      const resolvedProjectPath = context.currentProjectPath;
      if (!resolvedProjectId) throw new Error('No project is currently open');

      const { tasks, actions, swimlanes, attachments: attachmentRepo } = getProjectRepos(context, resolvedProjectId);

      try {
        // Phase 1 (locked, short): validate task + lane, build plan.
        const plan = await withTaskLock(taskId, async () => {
          const { task, liveSession } = reconcileTaskSessionRef(context, resolvedProjectId, taskId);
          if (liveSession) {
            throw new Error(`Task ${taskId} already has an active session`);
          }
          const lane = swimlanes.getById(task.swimlane_id);
          if (lane?.role === 'todo') {
            throw new Error('Cannot resume a session for a task in the To Do column');
          }
          return { task };
        });

        // Phase 2 (unlocked, slow): git I/O. Serialized per-project by
        // WorktreeManager.projectQueues. AbortSignal cancels in-flight fetch
        // when SESSION_SUSPEND / a newer SESSION_RESUME / SESSION_RESET fires.
        try {
          await ensureTaskWorktree(context, plan.task, tasks, resolvedProjectPath, { signal });
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

          await engine.resumeSuspendedSession(current, currentLane?.permission_mode, undefined, resumePrompt, signal);

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
        if (sessionResumeControllers.get(taskId) === resumeController) {
          sessionResumeControllers.delete(taskId);
        }
      }
    })();
  });

  // === Session Reset (safety-net recovery for unrecoverable sessions) ===
  ipcMain.handle(IPC.SESSION_RESET, (_, taskId: string) => {
    // Cancel any in-flight resume BEFORE queueing on the lock - otherwise
    // we would deadlock waiting for a resume that is stuck in worktree I/O.
    sessionResumeControllers.get(taskId)?.abort();

    return withTaskLock(taskId, async () => {
      const resolvedProjectId = context.currentProjectId;
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

  ipcMain.handle(IPC.SESSION_GET_PERIOD_STATS, (_, period: UsageTimePeriod) => {
    if (!context.currentProjectId) return { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 };
    const db = getProjectDb(context.currentProjectId);
    const sessionRepo = new SessionRepository(db);
    const since = computePeriodCutoff(period);
    return sessionRepo.getStatsAfter(since);
  });

  // Set which sessions are visible in the renderer (terminal panel + command bar overlay).
  // Background sessions stop emitting data IPC (accumulate in scrollback only).
  ipcMain.handle(IPC.SESSION_SET_FOCUSED, (_, sessionIds: string[]) => {
    context.sessionManager.setFocusedSessions(sessionIds);
    // Immediately flush any buffered usage/events so the newly focused
    // sessions' data is up-to-date without waiting for the 2s timer.
    flushBackgroundBuffer();
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
      context.mainWindow.webContents.send(IPC.SESSION_USAGE, sessionId, data, projectId);
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
      context.mainWindow.webContents.send(IPC.SESSION_USAGE, sessionId, data, projectId);
    } else {
      // Buffer for background sessions (last-write-wins)
      bufferedUsage.set(sessionId, { data, projectId });
      scheduleBackgroundFlush();
    }
  });

  context.sessionManager.on('activity', (sessionId: string, state: string, isPermission: boolean) => {
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      const taskId = context.sessionManager.getSessionTaskId(sessionId);
      let taskTitle: string | undefined;
      if (taskId && projectId) {
        try {
          const db = getProjectDb(projectId);
          const taskRepository = new TaskRepository(db);
          taskTitle = taskRepository.getById(taskId)?.title;
        } catch {
          // Project DB may not exist yet -- skip title lookup
        }
      }
      context.mainWindow.webContents.send(IPC.SESSION_ACTIVITY, sessionId, state, projectId, taskId, taskTitle, isPermission);
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
      context.mainWindow.webContents.send(IPC.SESSION_STATUS, sessionId, session, session.projectId);
    }
  });

  context.sessionManager.on('idle-timeout', (sessionId: string, taskId: string, timeoutMinutes: number) => {
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!context.mainWindow.isDestroyed()) {
      context.mainWindow.webContents.send(IPC.SESSION_IDLE_TIMEOUT, sessionId, taskId, timeoutMinutes, projectId);
    }
    if (!projectId) return;

    // session-manager.suspend() (called by usage-tracker.requestSuspend) already
    // flipped the registry status synchronously. Mirror those writes into the DB
    // so task.session_id and the session record agree with the registry.
    // Without this, SESSION_RESUME's reconciliation has to recover from the
    // divergence on the next user click - cleaner to fix it here at the source.
    void withTaskLock(taskId, async () => {
      try {
        context.commandInjector.cancel(taskId);
        applySuspendDbWrites(context, projectId, taskId, 'system');
      } catch (error) {
        console.error('[idle-timeout] DB sync failed:', error);
      }
    });
  });

  // Stale session ID recovery: when a resuming session reports a different
  // agent session_id (from status.json), --resume failed silently and Claude
  // created a fresh session. Update the DB so the next resume uses the correct UUID.
  context.sessionManager.on('agent-session-id', (_sessionId: string, taskId: string, projectId: string, agentReportedId: string) => {
    try {
      const database = getProjectDb(projectId);
      const sessionRepo = new SessionRepository(database);
      recoverStaleSessionId(sessionRepo, taskId, agentReportedId);
    } catch {
      // DB may be closed
    }
  });

  context.sessionManager.on('exit', (sessionId: string, exitCode: number) => {
    const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);

    // Analytics: track session exit with duration (skip recovered sessions with no start time)
    const startTime = sessionStartTimes.get(sessionId);
    if (startTime) {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      trackEvent('session_exit', { exitCode, durationSeconds });
      sessionStartTimes.delete(sessionId);
    }

    if (!context.mainWindow.isDestroyed()) {
      context.mainWindow.webContents.send(IPC.SESSION_EXIT, sessionId, exitCode, resolvedProjectId);
    }

    // Persist exit status to session DB -- use the session's own projectId
    // so we write to the correct DB even if the user switched projects.
    if (resolvedProjectId) {
      try {
        const db = getProjectDb(resolvedProjectId);
        const sessionRepo = new SessionRepository(db);
        // Atomically mark 'running' or 'queued' records as 'exited'.
        // compareAndUpdateStatus guards against overwriting 'suspended',
        // which is set by TASK_MOVE before the async onExit fires.
        let updated = false;
        const session = context.sessionManager.getSession(sessionId);
        if (session) {
          const record = sessionRepo.getLatestForTask(session.taskId);
          if (record) {
            updated = markRecordExited(sessionRepo, record.id, {
              exit_code: exitCode,
              exited_at: new Date().toISOString(),
            });
          }
        }
        // Fallback: try matching by agent_session_id only if taskId lookup didn't find it
        if (!updated) {
          const byAgentId = db.prepare(
            `SELECT id FROM sessions WHERE agent_session_id = ? AND status IN ('running', 'queued') LIMIT 1`
          ).get(sessionId) as { id: string } | undefined;
          if (byAgentId) {
            markRecordExited(sessionRepo, byAgentId.id, {
              exit_code: exitCode,
              exited_at: new Date().toISOString(),
            });
          }
        }

        // Capture session metrics (usage/event caches are still populated at this point).
        // Determine the DB record ID from whichever lookup path succeeded above.
        const metricsRecordId = session
          ? sessionRepo.getLatestForTask(session.taskId)?.id
          : (updated ? undefined : (db.prepare(
              `SELECT id FROM sessions WHERE agent_session_id = ? ORDER BY started_at DESC LIMIT 1`
            ).get(sessionId) as { id: string } | undefined)?.id);

        if (metricsRecordId) {
          captureSessionMetrics(context.sessionManager, sessionRepo, sessionId, metricsRecordId);
        }
      } catch {
        // DB may be closed during shutdown
      }
    }
  });

  // Auto-link PR URL when agent runs a gh pr command
  context.sessionManager.on('pr-detected', (sessionId: string, prUrl: string, prNumber: number) => {
    const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!resolvedProjectId) return;
    try {
      const { tasks } = getProjectRepos(context, resolvedProjectId);
      const task = tasks.getBySessionId(sessionId);
      if (!task) return;

      // Update the task with the detected PR info
      tasks.update({ id: task.id, pr_url: prUrl, pr_number: prNumber });
      console.log(`[pr-detected] Linked PR #${prNumber} to "${task.title}": ${prUrl}`);

      // Notify renderer so the board refreshes with the PR badge/pill
      if (!context.mainWindow.isDestroyed()) {
        context.mainWindow.webContents.send(IPC.TASK_UPDATED_BY_AGENT, task.id, task.title, resolvedProjectId);
      }
    } catch (error) {
      console.error(`[pr-detected] Failed to link PR for session ${sessionId}:`, error);
    }
  });

  // Auto-move task when agent exits plan mode (ExitPlanMode tool)
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
      await handleTaskMove(context, { taskId: task.id, targetSwimlaneId: target.id, targetPosition: position }, resolvedProjectId, resolvedProjectPath);

      if (!context.mainWindow.isDestroyed()) {
        context.mainWindow.webContents.send(IPC.TASK_AUTO_MOVED, task.id, target.id, task.title, resolvedProjectId);
      }
      console.log(`[plan-exit] Auto-moved "${task.title}" -> "${target.name}"`);
    } catch (err) {
      console.error('[plan-exit] Auto-move failed:', err);
    }
  });
}

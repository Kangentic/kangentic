import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos, ensureTaskWorktree, ensureTaskBranchCheckout, buildAutoCommandVars, createTransitionEngine } from '../helpers';
import { handleTaskMove, guardActiveNonWorktreeSessions } from './tasks';
import { trackEvent } from '../../analytics/analytics';
import { captureSessionMetrics } from './session-metrics';
import type { Session } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

// Track session start times for duration calculation on exit
const sessionStartTimes = new Map<string, number>();

export function registerSessionHandlers(context: IpcContext): void {
  // === Sessions ===
  ipcMain.handle(IPC.SESSION_SPAWN, (_, input) => {
    if (!context.currentProjectId) throw new Error('Cannot spawn session: no project is currently open');
    return context.sessionManager.spawn({ ...input, projectId: context.currentProjectId });
  });
  ipcMain.handle(IPC.SESSION_KILL, (_, id) => context.sessionManager.kill(id));
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
  ipcMain.handle(IPC.SESSION_SUSPEND, async (_, taskId: string) => {
    const resolvedProjectId = context.currentProjectId;
    if (!resolvedProjectId) throw new Error('No project is currently open');

    const { tasks } = getProjectRepos(context, resolvedProjectId);
    const task = tasks.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (!task.session_id) return; // nothing to suspend

    const db = getProjectDb(resolvedProjectId);
    const sessionRepo = new SessionRepository(db);

    // Mark session record as suspended in DB
    const record = sessionRepo.getLatestForTask(task.id);
    if (record && record.claude_session_id
        && (record.status === 'running' || record.status === 'exited')) {
      // Capture metrics before suspend (caches are still populated)
      captureSessionMetrics(context.sessionManager, sessionRepo, task.session_id!, record.id);
      sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString(), suspended_by: 'user' });
    }

    // Kill PTY but preserve session files
    context.sessionManager.suspend(task.session_id);

    // Clear task's active session reference
    tasks.update({ id: task.id, session_id: null });
  });

  ipcMain.handle(IPC.SESSION_RESUME, async (_, taskId: string, resumePrompt?: string) => {
    const resolvedProjectId = context.currentProjectId;
    const resolvedProjectPath = context.currentProjectPath;
    if (!resolvedProjectId) throw new Error('No project is currently open');

    const { tasks, actions, swimlanes, attachments: attachmentRepo } = getProjectRepos(context, resolvedProjectId);
    const task = tasks.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Guard: don't resume if already has an active session
    if (task.session_id) throw new Error(`Task ${taskId} already has an active session`);

    const lane = swimlanes.getById(task.swimlane_id);

    // Backlog tasks cannot have sessions -- reject resume
    if (lane?.role === 'backlog') {
      throw new Error('Cannot resume a session for a task in the backlog');
    }

    // Create worktree if needed
    try {
      await ensureTaskWorktree(context, task, tasks, resolvedProjectPath);
    } catch (worktreeError) {
      const message = worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
      throw new Error(`Worktree setup failed: ${message}`);
    }

    const db = getProjectDb(resolvedProjectId);
    const sessionRepo = new SessionRepository(db);
    const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachmentRepo, resolvedProjectId, resolvedProjectPath);

    await engine.resumeSuspendedSession(task, lane?.permission_mode, undefined, resumePrompt);

    // Re-read task to get the new session_id
    const updated = tasks.getById(taskId);
    if (!updated?.session_id) throw new Error('Session resume failed -- no session_id on task');

    // Return the new session object
    const newSession = context.sessionManager.getSession(updated.session_id);
    if (!newSession) throw new Error('Session resume failed -- session not in manager');
    return newSession;
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
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      context.mainWindow.webContents.send(IPC.SESSION_USAGE, sessionId, data, projectId);
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
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      context.mainWindow.webContents.send(IPC.SESSION_EVENT, sessionId, event, projectId);
    }
  });

  context.sessionManager.on('session-changed', (sessionId: string, session: Session) => {
    if (session.status === 'running') {
      sessionStartTimes.set(sessionId, Date.now());

      // Update DB record from 'queued' to 'running' when promoted
      const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);
      if (resolvedProjectId) {
        try {
          const database = getProjectDb(resolvedProjectId);
          const sessionRepo = new SessionRepository(database);
          const session = context.sessionManager.getSession(sessionId);
          if (session) {
            const record = sessionRepo.getLatestForTask(session.taskId);
            if (record && record.status === 'queued') {
              sessionRepo.updateStatus(record.id, 'running');
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
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      context.mainWindow.webContents.send(IPC.SESSION_IDLE_TIMEOUT, sessionId, taskId, timeoutMinutes, projectId);
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
        // Look up by task ID from the in-memory session.
        // Only mark 'running' or 'queued' records as 'exited' -- never
        // overwrite 'suspended' status, which is set by TASK_MOVE before
        // the async onExit fires and is needed for resume on re-entry.
        let updated = false;
        const session = context.sessionManager.getSession(sessionId);
        if (session) {
          const record = sessionRepo.getLatestForTask(session.taskId);
          if (record && (record.status === 'running' || record.status === 'queued')) {
            sessionRepo.updateStatus(record.id, 'exited', {
              exit_code: exitCode,
              exited_at: new Date().toISOString(),
            });
            updated = true;
          }
        }
        // Fallback: try matching by claude_session_id only if taskId lookup didn't find it
        if (!updated) {
          const byClaudeId = db.prepare(
            `SELECT id FROM sessions WHERE claude_session_id = ? AND status IN ('running', 'queued') LIMIT 1`
          ).get(sessionId) as { id: string } | undefined;
          if (byClaudeId) {
            sessionRepo.updateStatus(byClaudeId.id, 'exited', {
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
              `SELECT id FROM sessions WHERE claude_session_id = ? ORDER BY started_at DESC LIMIT 1`
            ).get(sessionId) as { id: string } | undefined)?.id);

        if (metricsRecordId) {
          captureSessionMetrics(context.sessionManager, sessionRepo, sessionId, metricsRecordId);
        }
      } catch {
        // DB may be closed during shutdown
      }
    }
  });

  // Forward task-created-by-agent events to renderer and trigger auto_spawn
  context.sessionManager.on('task-created', async (sessionId: string, task: { id: string; title: string }, columnName: string, swimlaneId: string) => {
    const projectId = context.sessionManager.getSessionProjectId(sessionId);

    // Notify renderer (board refresh + toast)
    if (!context.mainWindow.isDestroyed()) {
      context.mainWindow.webContents.send(IPC.TASK_CREATED_BY_AGENT, task.id, task.title, columnName, projectId);
    }

    // Auto-spawn: if the target column has auto_spawn, start an agent session
    if (!projectId) return;
    try {
      const db = getProjectDb(projectId);
      const swimlaneRepo = new SwimlaneRepository(db);
      const toLane = swimlaneRepo.getById(swimlaneId);
      if (!toLane?.auto_spawn) return;

      const project = context.projectRepo.getById(projectId);
      const projectPath = project?.path ?? null;
      if (!projectPath) return;

      const { tasks, actions, attachments } = getProjectRepos(context, projectId);
      const fullTask = tasks.getById(task.id);
      if (!fullTask) return;

      try {
        await ensureTaskWorktree(context, fullTask, tasks, projectPath);
      } catch (worktreeError) {
        console.error('[MCP auto-spawn] Worktree creation failed:', worktreeError);
        return;
      }

      // Checkout branch for non-worktree tasks (may fail if another session is active)
      if (fullTask.base_branch && !fullTask.worktree_path) {
        try {
          guardActiveNonWorktreeSessions(context, fullTask, tasks);
          await ensureTaskBranchCheckout(fullTask, projectPath);
        } catch (checkoutError) {
          console.error('[MCP auto-spawn] Branch checkout failed:', checkoutError);
          return;
        }
      }

      const sessionRepo = new SessionRepository(db);
      const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachments, projectId, projectPath);

      try {
        await engine.executeTransition(fullTask, '*', toLane.id, toLane.permission_mode);
      } catch (err) {
        console.error('[MCP auto-spawn] Transition engine error:', err);
      }

      // Re-read task; if still no session, resume suspended or spawn fresh
      let finalTask = tasks.getById(task.id);
      if (finalTask && !finalTask.session_id && toLane.auto_spawn) {
        try {
          await engine.resumeSuspendedSession(finalTask, toLane.permission_mode);
          finalTask = tasks.getById(task.id);
        } catch (err) {
          console.error('[MCP auto-spawn] Failed to start session:', err);
        }
      }

      // Schedule auto-command for freshly spawned session
      if (finalTask?.session_id && toLane.auto_command) {
        const vars = buildAutoCommandVars(finalTask);
        const interpolated = context.commandBuilder.interpolateTemplate(toLane.auto_command, vars);
        context.commandInjector.schedule(finalTask.id, finalTask.session_id, interpolated, { freshlySpawned: true });
      }

      console.log(`[MCP auto-spawn] Spawned agent for "${task.title}" in ${columnName}`);
    } catch (err) {
      console.error('[MCP auto-spawn] Failed:', err);
    }
  });

  // Forward task-updated-by-agent events to renderer for board refresh
  context.sessionManager.on('task-updated', (sessionId: string, task: { id: string; title: string }) => {
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      context.mainWindow.webContents.send(IPC.TASK_UPDATED_BY_AGENT, task.id, task.title, projectId);
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

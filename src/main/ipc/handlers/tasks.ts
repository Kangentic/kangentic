import fs from 'node:fs';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { WorktreeManager } from '../../git/worktree-manager';
import { getProjectDb } from '../../db/database';
import {
  getProjectRepos,
  buildAutoCommandVars,
  ensureTaskWorktree,
  createTransitionEngine,
  cleanupTaskSession,
  cleanupTaskResources,
} from '../helpers';
import type { IpcContext } from '../ipc-context';

/**
 * Core task-move logic shared by the TASK_MOVE IPC handler and the
 * plan-exit auto-move listener. Moves the task, runs transitions, and
 * manages session lifecycle based on the target column's role.
 */
export async function handleTaskMove(
  context: IpcContext,
  input: { taskId: string; targetSwimlaneId: string; targetPosition: number },
  projectId?: string | null,
  projectPath?: string | null,
): Promise<void> {
  const resolvedProjectId = projectId ?? context.currentProjectId;
  // Use !== undefined (not ??) to distinguish "caller passed null" from "caller omitted the arg"
  const resolvedProjectPath = projectPath !== undefined ? projectPath : context.currentProjectPath;
  if (!resolvedProjectId) throw new Error('No project is currently open');

  const { tasks, actions, swimlanes, attachments } = getProjectRepos(context, resolvedProjectId);
  const task = tasks.getById(input.taskId);
  if (!task) throw new Error(`Task ${input.taskId} not found`);

  const fromSwimlaneId = task.swimlane_id;
  const toLane = swimlanes.getById(input.targetSwimlaneId);

  // Move the task in the database
  tasks.move(input);

  // Within-column reorder — no side effects needed
  if (fromSwimlaneId === input.targetSwimlaneId) return;

  const db = getProjectDb(resolvedProjectId);
  const sessionRepo = new SessionRepository(db);

  // --- Priority 1: TARGET IS BACKLOG → kill session, preserve worktree ---
  if (toLane?.role === 'backlog') {
    context.commandInjector.cancel(task.id);
    await cleanupTaskSession(context, task, tasks, resolvedProjectId, resolvedProjectPath);
    console.log(`[TASK_MOVE] Killed session for task ${task.id.slice(0, 8)} (moved to Backlog, worktree preserved)`);
    return;
  }

  // --- Priority 2: TARGET IS DONE → suspend + archive (resumable on unarchive) ---
  if (toLane?.role === 'done') {
    context.commandInjector.cancel(task.id);
    if (task.session_id) {
      const record = sessionRepo.getLatestForTask(task.id);
      // Accept 'running' AND 'exited' — exited covers Claude natural exit
      if (record && record.claude_session_id
          && (record.status === 'running' || record.status === 'exited')) {
        sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString() });
        console.log(`[TASK_MOVE] Suspended session record ${record.id.slice(0, 8)} for task ${task.id.slice(0, 8)}`);
      }
      context.sessionManager.suspend(task.session_id);
      tasks.update({ id: task.id, session_id: null });
    } else {
      // No active PTY — preserve latest exited session for future resume
      const record = sessionRepo.getLatestForTask(task.id);
      if (record && record.claude_session_id
          && record.session_type === 'claude_agent'
          && record.status === 'exited') {
        sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString() });
        console.log(`[TASK_MOVE] Preserved exited session ${record.id.slice(0, 8)} for future resume`);
      }
    }
    tasks.archive(input.taskId);
    console.log(`[TASK_MOVE] Auto-archived task ${input.taskId.slice(0, 8)} (moved to Done)`);
    return;
  }

  // --- Priority 2.5: TARGET HAS auto_spawn=false (and not backlog/done which are handled above) ---
  // → Suspend session if one exists, do NOT spawn new agent
  if (toLane && !toLane.auto_spawn) {
    context.commandInjector.cancel(task.id);
    if (task.session_id) {
      const record = sessionRepo.getLatestForTask(task.id);
      if (record && record.claude_session_id
          && (record.status === 'running' || record.status === 'exited')) {
        sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString() });
      }
      context.sessionManager.suspend(task.session_id);
      tasks.update({ id: task.id, session_id: null });
      console.log(`[TASK_MOVE] Suspended session for task ${task.id.slice(0, 8)} (target column has auto_spawn=false)`);
    }
    return;
  }

  // --- Priority 3: TASK HAS ACTIVE SESSION → keep alive, skip transitions ---
  // If the agent is already running, moving between non-terminal columns
  // (e.g. Review → Running) should NOT kill and respawn — just let it continue.
  if (task.session_id) {
    context.commandInjector.cancel(task.id);
    if (toLane?.auto_command) {
      const vars = buildAutoCommandVars(task);
      const interpolated = context.commandBuilder.interpolateTemplate(toLane.auto_command, vars);
      context.commandInjector.schedule(task.id, task.session_id, interpolated, { freshlySpawned: false });
    }
    console.log(`[TASK_MOVE] Task ${task.id.slice(0, 8)} already has active session -- skipping transitions`);
    return;
  }

  // --- Priority 4: TASK HAS NO ACTIVE SESSION ---
  // Create worktree if worktrees are enabled and task doesn't have one yet.
  await ensureTaskWorktree(context, task, tasks, resolvedProjectPath);

  // Execute transition actions (may fire spawn_agent which handles resume internally)
  const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachments, resolvedProjectId, resolvedProjectPath);

  try {
    await engine.executeTransition(task, fromSwimlaneId, input.targetSwimlaneId, toLane?.permission_strategy);
  } catch (err) {
    console.error('Transition engine error:', err);
  }

  // Re-read task from DB — transition engine may have spawned a session
  let finalTask = tasks.getById(task.id);

  // If task STILL has no session, resume a suspended session or spawn fresh.
  if (finalTask && !finalTask.session_id && toLane?.auto_spawn) {
    console.log(`[TASK_MOVE] Ensuring agent for task ${task.id.slice(0, 8)}`);
    try {
      await engine.resumeSuspendedSession(finalTask, toLane.permission_strategy);
      finalTask = tasks.getById(task.id);
    } catch (err) {
      console.error('Failed to start session:', err);
    }
  }

  // Schedule auto-command for freshly spawned session
  if (finalTask?.session_id && toLane?.auto_command) {
    const vars = buildAutoCommandVars(finalTask);
    const interpolated = context.commandBuilder.interpolateTemplate(toLane.auto_command, vars);
    context.commandInjector.schedule(finalTask.id, finalTask.session_id, interpolated, { freshlySpawned: true });
  }
}

export function registerTaskHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.TASK_LIST, (_, swimlaneId?) => {
    const { tasks } = getProjectRepos(context);
    return tasks.list(swimlaneId);
  });

  ipcMain.handle(IPC.TASK_CREATE, (_, input) => {
    const { tasks, attachments } = getProjectRepos(context);
    const { pendingAttachments, ...taskInput } = input;
    const task = tasks.create(taskInput);

    // Save any pending attachments from the dialog
    if (pendingAttachments?.length && context.currentProjectPath) {
      for (const att of pendingAttachments) {
        attachments.add(context.currentProjectPath, task.id, att.filename, att.data, att.media_type);
      }
    }

    return task;
  });

  ipcMain.handle(IPC.TASK_UPDATE, async (_, input) => {
    const resolvedProjectId = context.currentProjectId;
    const resolvedProjectPath = context.currentProjectPath;
    const { tasks } = getProjectRepos(context, resolvedProjectId);
    const existing = tasks.getById(input.id);

    // If title changed and task has a worktree branch, try to rename the branch
    if (input.title && existing?.branch_name && existing?.worktree_path
        && input.title !== existing.title && resolvedProjectPath
        && !existing.pr_url) {
      // Guard: skip if the agent is actively thinking (git operations may be in flight)
      const taskSession = context.sessionManager.listSessions()
        .find(s => s.taskId === input.id && (s.status === 'running' || s.status === 'queued'));
      const activityCache = context.sessionManager.getActivityCache();
      const isThinking = taskSession && activityCache[taskSession.id] === 'thinking';

      if (isThinking) {
        console.log(`[TASK_UPDATE] Skipping branch rename -- task ${input.id.slice(0, 8)} agent is thinking`);
      } else if (!fs.existsSync(existing.worktree_path)) {
        console.log(`[TASK_UPDATE] Skipping branch rename -- worktree path missing: ${existing.worktree_path}`);
      } else {
        const worktreeManager = new WorktreeManager(resolvedProjectPath);
        const newBranchName = await worktreeManager.renameBranch(
          input.id, existing.branch_name, input.title,
        );
        if (newBranchName) {
          console.log(`[TASK_UPDATE] Branch renamed: ${existing.branch_name} -> ${newBranchName}`);
          input.branch_name = newBranchName;
        } else {
          console.log(`[TASK_UPDATE] Branch rename skipped (same slug or failed) for ${existing.branch_name}`);
        }
      }
    }

    return tasks.update(input);
  });

  ipcMain.handle(IPC.TASK_DELETE, async (_, id) => {
    const resolvedProjectId = context.currentProjectId;
    const resolvedProjectPath = context.currentProjectPath;
    const { tasks, attachments } = getProjectRepos(context, resolvedProjectId);
    const task = tasks.getById(id);
    if (task) {
      attachments.deleteByTaskId(id);
      await cleanupTaskResources(context, task, tasks, resolvedProjectId, resolvedProjectPath);
    }
    tasks.delete(id);
  });

  ipcMain.handle(IPC.TASK_MOVE, async (_, input) => handleTaskMove(context, input));

  ipcMain.handle(IPC.TASK_LIST_ARCHIVED, () => {
    const { tasks } = getProjectRepos(context);
    return tasks.listArchived();
  });

  ipcMain.handle(IPC.TASK_UNARCHIVE, async (_, input: { id: string; targetSwimlaneId: string }) => {
    const resolvedProjectId = context.currentProjectId;
    const resolvedProjectPath = context.currentProjectPath;
    if (!resolvedProjectId) throw new Error('No project is currently open');

    const { tasks, swimlanes, actions, attachments: attachmentRepo } = getProjectRepos(context, resolvedProjectId);

    // Determine position at end of target lane
    const laneTasks = tasks.list(input.targetSwimlaneId);
    const position = laneTasks.length;

    const task = tasks.unarchive(input.id, input.targetSwimlaneId, position);

    const toLane = swimlanes.getById(input.targetSwimlaneId);

    // Guard: don't resume if target doesn't auto-spawn (backlog, done, or custom with auto_spawn=false)
    if (!toLane?.auto_spawn) {
      return tasks.getById(input.id);
    }

    // Create worktree if needed (any non-backlog column gets an agent)
    await ensureTaskWorktree(context, task, tasks, resolvedProjectPath);

    // Execute transition actions (from Done → target) for ALL non-kill columns
    if (resolvedProjectPath) {
      const doneLane = swimlanes.list().find((l) => l.role === 'done');
      if (doneLane) {
        const db = getProjectDb(resolvedProjectId);
        const sessionRepo = new SessionRepository(db);
        const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachmentRepo, resolvedProjectId, resolvedProjectPath);

        try {
          await engine.executeTransition(task, doneLane.id, input.targetSwimlaneId, toLane?.permission_strategy);
        } catch (err) {
          console.error('Transition engine error during unarchive:', err);
        }

        // Re-read task; if still no session, resume suspended or spawn fresh.
        let finalTask = tasks.getById(task.id);
        if (finalTask && !finalTask.session_id && toLane?.auto_spawn) {
          console.log(`[TASK_UNARCHIVE] Ensuring agent for task ${task.id.slice(0, 8)}`);
          try {
            await engine.resumeSuspendedSession(finalTask, toLane.permission_strategy);
            finalTask = tasks.getById(task.id);
          } catch (err) {
            console.error('Failed to start session during unarchive:', err);
          }
        }

        // Schedule auto-command for freshly spawned session
        if (finalTask?.session_id && toLane?.auto_command) {
          const vars = buildAutoCommandVars(finalTask);
          const interpolated = context.commandBuilder.interpolateTemplate(toLane.auto_command, vars);
          context.commandInjector.schedule(finalTask.id, finalTask.session_id, interpolated, { freshlySpawned: true });
        }
      }
    }

    return tasks.getById(input.id);
  });
}

/**
 * Builds a CommandContext for a given project ID. Captures all the IPC
 * broadcasts and side effects (auto-spawn, worktree cleanup, renderer
 * notifications) that the in-process MCP HTTP server fires when an
 * agent tool call mutates the board.
 */
import { IPC } from '../../shared/ipc-channels';
import { getProjectDb } from '../db/database';
import { autoSpawnForTask } from '../ipc/helpers';
import { handleTaskMove } from '../ipc/handlers/task-move';
import { WorktreeManager } from '../git/worktree-manager';
import type { CommandContext } from './commands';
import type { IpcContext } from '../ipc/ipc-context';
import type { AppConfig } from '../../shared/types';
import { RequestResolver } from './mcp-http/project-resolver';

/**
 * Resolve a project ID to a CommandContext, or return null if the project
 * isn't recognised. The HTTP server calls this once per request to scope
 * tool execution to the requested project.
 */
export function buildCommandContextForProject(
  ipcContext: IpcContext,
  projectId: string,
): CommandContext | null {
  const project = ipcContext.projectRepo.getById(projectId);
  if (!project) return null;
  const projectPath = project.path;

  return {
    getProjectDb: () => getProjectDb(projectId),
    getProjectPath: () => projectPath,

    onTaskCreated: (task, columnName, swimlaneId) => {
      if (!ipcContext.mainWindow.isDestroyed()) {
        ipcContext.mainWindow.webContents.send(
          IPC.TASK_CREATED_BY_AGENT, task.id, task.title, columnName, projectId,
        );
      }
      // Auto-spawn fire-and-forget so the tool call returns immediately
      // and Claude doesn't block on a multi-second PTY spawn.
      autoSpawnForTask(ipcContext, projectId, task, swimlaneId).catch((err) => {
        console.error('[mcp-http auto-spawn] Failed:', err);
      });
    },

    onTaskUpdated: (task) => {
      if (!ipcContext.mainWindow.isDestroyed()) {
        ipcContext.mainWindow.webContents.send(
          IPC.TASK_UPDATED_BY_AGENT, task.id, task.title, projectId,
        );
      }
    },

    onTaskDeleted: (task) => {
      // Kill any live PTY for the task
      if (task.session_id) {
        try {
          ipcContext.sessionManager.kill(task.session_id);
          ipcContext.sessionManager.remove(task.session_id);
        } catch { /* may already be dead */ }
      }
      ipcContext.sessionManager.removeByTaskId(task.id);

      // Best-effort worktree + branch cleanup
      if (task.worktree_path) {
        const worktreeManager = new WorktreeManager(projectPath);
        worktreeManager.withLock(async () => {
          const removed = await worktreeManager.removeWorktree(task.worktree_path!);
          if (removed && task.branch_name) {
            const config = ipcContext.configManager.getEffectiveConfig(projectPath);
            if (config.git.autoCleanup) {
              try { await worktreeManager.pruneWorktrees(); } catch { /* best effort */ }
              await worktreeManager.removeBranch(task.branch_name);
            }
          }
        }).catch((error) => {
          console.error(`[mcp-http delete] Worktree cleanup failed for task ${task.id.slice(0, 8)}:`, error);
        });
      }

      if (!ipcContext.mainWindow.isDestroyed()) {
        ipcContext.mainWindow.webContents.send(
          IPC.TASK_DELETED_BY_AGENT, task.id, task.title, projectId,
        );
      }
    },

    onTaskMove: async (input) => {
      await handleTaskMove(ipcContext, input, projectId, projectPath);
      // Notify renderer to reload board (handleTaskMove assumes UI initiated)
      const movedTask = getProjectDb(projectId)
        .prepare('SELECT id, title FROM tasks WHERE id = ?')
        .get(input.taskId) as { id: string; title: string } | undefined;
      if (movedTask && !ipcContext.mainWindow.isDestroyed()) {
        ipcContext.mainWindow.webContents.send(
          IPC.TASK_UPDATED_BY_AGENT, movedTask.id, movedTask.title, projectId,
        );
      }
    },

    onSwimlaneUpdated: (swimlane) => {
      if (!ipcContext.mainWindow.isDestroyed()) {
        ipcContext.mainWindow.webContents.send(
          IPC.SWIMLANE_UPDATED_BY_AGENT, swimlane.id, swimlane.name, projectId,
        );
      }
    },

    onBacklogChanged: () => {
      if (!ipcContext.mainWindow.isDestroyed()) {
        ipcContext.mainWindow.webContents.send(IPC.BACKLOG_CHANGED_BY_AGENT, projectId);
      }
    },

    onLabelColorsChanged: (colors) => {
      ipcContext.configManager.save({ backlog: { labelColors: colors } } as Partial<AppConfig>);
      if (!ipcContext.mainWindow.isDestroyed()) {
        ipcContext.mainWindow.webContents.send(IPC.BACKLOG_LABEL_COLORS_CHANGED);
      }
    },
  };
}

/**
 * Build a `RequestResolver` bound to the given URL-path project. Each MCP
 * HTTP request gets its own resolver so per-tool `project` arguments can
 * swap the active context while the URL remains stable. Returns null when
 * the project is unknown - the HTTP server responds 404 in that case.
 */
export function createRequestResolver(
  ipcContext: IpcContext,
  defaultProjectId: string,
): RequestResolver | null {
  const project = ipcContext.projectRepo.getById(defaultProjectId);
  if (!project) return null;
  const defaultContext = buildCommandContextForProject(ipcContext, defaultProjectId);
  if (!defaultContext) return null;
  return new RequestResolver({
    ipcContext,
    defaultContext,
    defaultProjectId,
    defaultProjectName: project.name,
  });
}

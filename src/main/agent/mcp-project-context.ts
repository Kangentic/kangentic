/**
 * Builds a CommandContext for a given project ID. Captures all the IPC
 * broadcasts and side effects (auto-spawn, worktree cleanup, renderer
 * notifications) that the in-process MCP HTTP server fires when an
 * agent tool call mutates the board.
 */
import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getProjectDb } from '../db/database';
import { autoSpawnForTask } from '../ipc/helpers';
import { handleTaskMove } from '../ipc/handlers/task-move';
import { WorktreeManager } from '../git/worktree-manager';
import { recordPush } from '../diagnostics/ipc-recorder';
import {
  propagateBoardProfileChange,
  propagateStrategyToLiveSessions,
  buildColumnStrategyChanges,
} from '../ipc/handlers/strategy-propagation';
import type { CommandContext } from './commands';
import type { IpcContext } from '../ipc/ipc-context';
import type { AppConfig } from '../../shared/types';
import { RequestResolver } from './mcp-http/project-resolver';

/**
 * Send a main -> renderer push, guarding against a destroyed window and
 * mirroring the send into the IPC traffic recorder. This is the single
 * chokepoint for the agent-driven board-invalidation pushes issued from
 * `buildCommandContextForProject`, so the dev IPC log
 * (`kangentic_get_ipc_log`) sees the whole outbound pipeline that the
 * renderer-side board reload depends on. A dropped push (window destroyed)
 * is still recorded, with a `PushDropped` marker, so a lost event leaves a
 * trace instead of vanishing silently.
 */
function sendToRenderer(mainWindow: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (mainWindow.isDestroyed()) {
    recordPush(channel, args, { dropped: true });
    return;
  }
  mainWindow.webContents.send(channel, ...args);
  recordPush(channel, args);
}

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
    // Explicit path, not the active project: a cross-project tool call must
    // resolve its profile selector against the board it is targeting. The same
    // reason applies to the write - an agent syncing profiles between projects
    // targets a board that is usually not the one on screen.
    getBoardProfiles: () => ipcContext.boardConfigManager.getBoardProfiles(projectPath),
    setBoardProfiles: (profiles) => {
      const previousProfiles = ipcContext.boardConfigManager.getBoardProfiles(projectPath);
      ipcContext.boardConfigManager.setBoardProfiles(profiles, projectPath);
      // Profiles are config-only, so no board-changed event covers them; without
      // this push an open Board Manager would keep showing the pre-edit list.
      // The renderer filters on projectId and ignores other projects' writes.
      sendToRenderer(ipcContext.mainWindow, IPC.BOARD_CONFIG_BOARD_PROFILES_CHANGED, projectId);
      // The same live-session propagation the Board Manager's own save runs: an
      // agent retuning a profile ("swap Opus 4.8 for Opus 5 everywhere") has to
      // reach in-flight sessions exactly as a human edit does. Scoped to the
      // ACTIVE project - `propagateStrategyToLiveSessions` resolves sessions
      // through the active context, and a background project has no live PTYs to
      // update; its tasks pick the change up from config when they next spawn.
      if (projectId === ipcContext.currentProjectId) {
        propagateBoardProfileChange(ipcContext, previousProfiles, profiles, projectId);
      }
    },

    onTaskCreated: (task, columnName, swimlaneId) => {
      sendToRenderer(
        ipcContext.mainWindow, IPC.TASK_CREATED_BY_AGENT, task.id, task.title, columnName, projectId,
      );
      ipcContext.boardEvents.emitBoardChanged({ projectId, change: 'task-created', ids: [task.id] });
      // Auto-spawn fire-and-forget so the tool call returns immediately
      // and Claude doesn't block on a multi-second PTY spawn.
      autoSpawnForTask(ipcContext, projectId, task, swimlaneId).catch((err) => {
        console.error('[mcp-http auto-spawn] Failed:', err);
      });
    },

    onTaskUpdated: (task) => {
      sendToRenderer(ipcContext.mainWindow, IPC.TASK_UPDATED_BY_AGENT, task.id, task.title, projectId);
      ipcContext.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [task.id] });
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
        }, { label: `mcp-worktree:${task.id.slice(0, 8)}` }).catch((error) => {
          console.error(`[mcp-http delete] Worktree cleanup failed for task ${task.id.slice(0, 8)}:`, error);
        });
      }

      sendToRenderer(ipcContext.mainWindow, IPC.TASK_DELETED_BY_AGENT, task.id, task.title, projectId);
      ipcContext.boardEvents.emitBoardChanged({ projectId, change: 'task-deleted', ids: [task.id] });
    },

    onTaskMove: async (input) => {
      await handleTaskMove(ipcContext, input, projectId, projectPath);
      // Notify renderer to reload board (handleTaskMove assumes UI initiated)
      const movedTask = getProjectDb(projectId)
        .prepare('SELECT id, title FROM tasks WHERE id = ?')
        .get(input.taskId) as { id: string; title: string } | undefined;
      if (movedTask) {
        sendToRenderer(ipcContext.mainWindow, IPC.TASK_UPDATED_BY_AGENT, movedTask.id, movedTask.title, projectId);
        ipcContext.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [movedTask.id] });
      }
    },

    onSwimlaneUpdated: (swimlane, previous) => {
      sendToRenderer(ipcContext.mainWindow, IPC.SWIMLANE_UPDATED_BY_AGENT, swimlane.id, swimlane.name, projectId);
      ipcContext.boardEvents.emitBoardChanged({ projectId, change: 'swimlane-updated', ids: [swimlane.id] });
      // Persist team-shared column fields (color, model/effort/permission
      // overrides, auto-command, ...) to kangentic.json so an agent's column
      // edit survives a restart and reaches teammates via git. Project-scoped
      // so a cross-project update_column reaches the right project's file, not
      // just the currently-active one. Best-effort: writeBackForProject never
      // throws.
      ipcContext.boardConfigManager.writeBackForProject(projectId, projectPath);
      // The same live-session propagation the Board Manager's own save runs. This
      // path used to do NOTHING here, so an agent editing a column missed even
      // the model/effort injection the UI path has, on top of the auto_spawn
      // reconcile.
      //
      // Scoped to the ACTIVE project deliberately, and NOT because a background
      // project has no live sessions - it can have them, which is what the
      // cross-project Agent Monitor and the sidebar's per-project agent counts
      // are built on. The reason is blast radius: this reconcile SPAWNS, and a
      // spawn creates a worktree and checks out a branch in a checkout the user
      // is not looking at. A background project's tasks pick the new column
      // config up when they next spawn. The cost is that an agent turning
      // auto_spawn off on a non-focused project leaves that project's agents
      // running until it is next opened.
      if (previous && projectId === ipcContext.currentProjectId) {
        propagateStrategyToLiveSessions(
          ipcContext,
          'MCP_UPDATE_COLUMN',
          buildColumnStrategyChanges({ context: ipcContext, projectId, before: previous, after: swimlane }),
          projectId,
        );
      }
    },

    onSwimlaneDeleted: (swimlane) => {
      // Reuses SWIMLANE_UPDATED_BY_AGENT rather than adding a delete channel:
      // the renderer's only consumer (useAgentDrivenInvalidation) treats it as
      // "this project's columns changed, re-read them", which is exactly right
      // for a delete.
      sendToRenderer(ipcContext.mainWindow, IPC.SWIMLANE_UPDATED_BY_AGENT, swimlane.id, swimlane.name, projectId);
      ipcContext.boardEvents.emitBoardChanged({ projectId, change: 'swimlane-updated', ids: [swimlane.id] });
      // Load-bearing, not just for teammates: kangentic.json re-seeds the DB on
      // project open (applyConfigOnOpen runs before the export), so without this
      // the deleted column is re-created from the stale file entry - with the
      // same uuid - the next time the project is opened.
      ipcContext.boardConfigManager.writeBackForProject(projectId, projectPath);
    },

    onBacklogChanged: () => {
      sendToRenderer(ipcContext.mainWindow, IPC.BACKLOG_CHANGED_BY_AGENT, projectId);
      ipcContext.boardEvents.emitBoardChanged({ projectId, change: 'backlog-changed', ids: [] });
    },

    onLabelColorsChanged: (colors) => {
      ipcContext.configManager.save({ backlog: { labelColors: colors } } as Partial<AppConfig>);
      sendToRenderer(ipcContext.mainWindow, IPC.BACKLOG_LABEL_COLORS_CHANGED);
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

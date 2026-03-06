import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { recoverSessions, reconcileSessions, pruneOrphanedWorktrees } from '../../engine/session-recovery';
import { WorktreeManager, isGitRepo, isInsideWorktree, isKangenticWorktree } from '../../git/worktree-manager';
import { stripKangenticHooks } from '../../agent/hook-manager';
import { getProjectDb, closeProjectDb } from '../../db/database';
import { PATHS } from '../../config/paths';
import { ensureGitignore, getProjectRepos } from '../helpers';
import type { Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Detach Kangentic from a project: kill PTY sessions, cleanly remove git
 * worktrees (branches with user code are preserved), strip our injected
 * activity hooks from `.claude/settings.local.json`, remove `.kangentic/`,
 * and delete the per-project database file from app data.
 *
 * Does NOT touch the `.claude/` directory, git branches, or any user data.
 */
export async function cleanupProject(context: IpcContext, projectId: string, projectPath: string): Promise<void> {
  // Guard: project path must exist
  if (!fs.existsSync(projectPath)) {
    console.warn(`[PROJECT_DELETE] Project path does not exist: ${projectPath} -- skipping filesystem cleanup`);
    closeProjectDb(projectId);
    const dbPath = PATHS.projectDb(projectId);
    try { fs.unlinkSync(dbPath); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* may not exist */ }
    if (context.currentProjectId === projectId) {
      context.currentProjectId = null;
      context.currentProjectPath = null;
    }
    return;
  }

  // 1. Kill all active PTY sessions belonging to this project's tasks
  let allTasks: Task[] = [];
  try {
    const db = getProjectDb(projectId);
    const taskRepo = new TaskRepository(db);
    allTasks = taskRepo.list();
  } catch (err) {
    console.error('[PROJECT_DELETE] Failed to read tasks:', err);
  }

  for (const task of allTasks) {
    if (task.session_id) {
      try { context.sessionManager.remove(task.session_id); } catch { /* may already be dead */ }
    }
  }

  // 2. Cleanly detach git worktrees (keeps branches with user code intact)
  if (isGitRepo(projectPath)) {
    for (const task of allTasks) {
      if (task.worktree_path && fs.existsSync(task.worktree_path)) {
        try {
          const worktreeManager = new WorktreeManager(projectPath);
          await worktreeManager.removeWorktree(task.worktree_path);
        } catch (err) {
          console.error(`[PROJECT_DELETE] Failed to detach worktree for task ${task.id.slice(0, 8)}:`, err);
        }
      }
    }
  }

  // 3. Strip our hooks from .claude/settings.local.json (legacy cleanup --
  //    new sessions use --settings and don't write to settings.local.json,
  //    but existing worktrees from before the change may still have our hooks)
  stripKangenticHooks(projectPath);
  const worktreesDir = path.join(projectPath, '.kangentic', 'worktrees');
  if (fs.existsSync(worktreesDir)) {
    try {
      for (const entry of fs.readdirSync(worktreesDir)) {
        stripKangenticHooks(path.join(worktreesDir, entry));
      }
    } catch { /* best effort */ }
  }

  // 4. Remove empty .claude/ directory if it only contained our hooks file.
  const claudeDir = path.join(projectPath, '.claude');
  try {
    const entries = fs.readdirSync(claudeDir);
    const isOnlyOurs = entries.every((e) => e === 'settings.local.json');
    if (entries.length === 0 || isOnlyOurs) {
      fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  } catch { /* may not exist or not readable -- skip */ }

  // 5. Close the project DB connection before deleting files
  closeProjectDb(projectId);

  // Steps 6–7 modify the project's .gitignore and .kangentic/ directory.
  // Skip for worktrees -- their .gitignore is inherited from the parent branch
  // and should not be modified by ephemeral cleanup.
  const isWorktree = isInsideWorktree(projectPath);

  // 6. Remove our `.kangentic/` entry from .gitignore (delete file if it becomes empty)
  if (!isWorktree) {
    try {
      const gitignorePath = path.join(projectPath, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const filtered = content.split('\n').filter(
          (l) => l.trim() !== '.kangentic' && l.trim() !== '.kangentic/'
            && l.trim() !== '.claude/settings.local.json',
        );
        const newContent = filtered.join('\n');
        if (newContent.replace(/\s/g, '').length === 0) {
          fs.unlinkSync(gitignorePath);
        } else {
          fs.writeFileSync(gitignorePath, newContent);
        }
      }
    } catch { /* non-fatal */ }
  }

  // 7. Remove .kangentic/ directory (ours entirely)
  if (!isWorktree) {
    const kangenticDir = path.join(projectPath, '.kangentic');
    if (fs.existsSync(kangenticDir)) {
      try {
        fs.rmSync(kangenticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (err) {
        console.error(`[PROJECT_DELETE] Failed to remove ${kangenticDir}:`, err);
      }
    }
  }

  // 8. Delete the per-project database file from app data
  const dbPath = PATHS.projectDb(projectId);
  try { fs.unlinkSync(dbPath); } catch { /* may not exist */ }
  try { fs.unlinkSync(dbPath + '-wal'); } catch { /* may not exist */ }
  try { fs.unlinkSync(dbPath + '-shm'); } catch { /* may not exist */ }

  // 9. Clear current project if this was the active one
  if (context.currentProjectId === projectId) {
    context.currentProjectId = null;
    context.currentProjectPath = null;
  }

  console.log(`[PROJECT_DELETE] Cleaned up project at ${projectPath}`);
}

/**
 * Delete a project record from the global index DB.
 */
export function deleteProjectFromIndex(context: IpcContext, id: string): void {
  context.projectRepo.delete(id);
}

/**
 * Prune all worktree-based preview projects from the global index.
 * Any project whose path contains `.kangentic/worktrees/` is ephemeral --
 * created by `/preview` and should not persist across app restarts.
 */
export async function pruneStaleWorktreeProjects(context: IpcContext): Promise<void> {
  const projects = context.projectRepo.list();
  for (const project of projects) {
    if (!isKangenticWorktree(project.path)) continue;

    console.log(`[PRUNE] Removing ephemeral preview project: ${project.name} (${project.path})`);

    // Lightweight cleanup: only delete DB records, not worktree filesystem.
    closeProjectDb(project.id);
    const dbPath = PATHS.projectDb(project.id);
    try { fs.unlinkSync(dbPath); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* may not exist */ }

    context.projectRepo.delete(project.id);
  }
}

/**
 * Find an existing project by path, or create one and open it.
 * Returns the project object.
 */
export async function openProjectByPath(context: IpcContext, projectPath: string) {
  // Normalize the path for comparison
  const normalized = path.resolve(projectPath);

  // Check if a project with this path already exists
  const projects = context.projectRepo.list();
  let project = projects.find((p) => path.resolve(p.path) === normalized);

  if (!project) {
    // Create a new project using the directory name
    const name = path.basename(normalized);
    project = context.projectRepo.create({ name, path: normalized });
    // Initialize the project database (creates tables + default swimlanes)
    getProjectDb(project.id);
  }

  // Skip full recovery if re-opening the same project
  const isReopen = context.currentProjectId === project.id;

  // Open the project
  context.currentProjectId = project.id;
  context.currentProjectPath = project.path;
  context.projectRepo.updateLastOpened(project.id);
  ensureGitignore(project.path);

  const config = context.configManager.getEffectiveConfig(project.path);
  context.sessionManager.setMaxConcurrent(config.claude.maxConcurrentSessions);
  context.sessionManager.setShell(config.terminal.shell);

  if (!isReopen) {
    // Prune tasks whose worktrees have been deleted externally
    const db = getProjectDb(project.id);
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    pruneOrphanedWorktrees(project.path, taskRepo, sessionRepo, context.sessionManager);

    // Recover suspended/orphaned sessions, then reconcile missing ones
    await recoverSessions(project.id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager);
    await reconcileSessions(project.id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager);
  }

  return project;
}

/**
 * Activate all projects on startup: run session recovery/reconciliation
 * for every project so agent sessions start immediately, not just when
 * the user navigates to a project board.
 */
export async function activateAllProjects(context: IpcContext): Promise<void> {
  const config = context.configManager.load();
  if (!config.activateAllProjectsOnStartup) return;

  const projects = context.projectRepo.list();
  for (const project of projects) {
    // Skip the currently active project -- it already ran recovery via PROJECT_OPEN
    if (project.id === context.currentProjectId) continue;

    try {
      ensureGitignore(project.path);
      const db = getProjectDb(project.id);
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      pruneOrphanedWorktrees(project.path, taskRepo, sessionRepo, context.sessionManager);
      await recoverSessions(project.id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager);
      await reconcileSessions(project.id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager);
    } catch (err) {
      console.error(`Failed to activate project ${project.name}:`, err);
    }
  }
}

export function registerProjectHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.PROJECT_LIST, () => context.projectRepo.list());

  ipcMain.handle(IPC.PROJECT_CREATE, (_, input) => {
    const project = context.projectRepo.create(input);
    // Initialize the project database (creates tables + default swimlanes)
    getProjectDb(project.id);
    return project;
  });

  ipcMain.handle(IPC.PROJECT_DELETE, async (_, id) => {
    const project = context.projectRepo.getById(id);
    if (project) {
      await cleanupProject(context, id, project.path);
    }
    context.projectRepo.delete(id);
  });

  ipcMain.handle(IPC.PROJECT_OPEN, async (_, id) => {
    const project = context.projectRepo.getById(id);
    if (!project) throw new Error(`Project ${id} not found`);

    // Skip full recovery if re-opening the same project (e.g. Vite hot-reload
    // causes the renderer to re-mount and call PROJECT_OPEN again).
    const isReopen = context.currentProjectId === id;

    context.currentProjectId = id;
    context.currentProjectPath = project.path;
    context.projectRepo.updateLastOpened(id);
    ensureGitignore(project.path);

    // Apply project config overrides (always -- config may have changed)
    const config = context.configManager.getEffectiveConfig(project.path);
    context.sessionManager.setMaxConcurrent(config.claude.maxConcurrentSessions);
    context.sessionManager.setShell(config.terminal.shell);

    if (!isReopen) {
      // Prune tasks whose worktrees have been deleted externally
      const db = getProjectDb(id);
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      pruneOrphanedWorktrees(project.path, taskRepo, sessionRepo, context.sessionManager);

      // Recover any suspended/orphaned sessions, then reconcile missing ones
      await recoverSessions(id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager);
      await reconcileSessions(id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager);
    }
  });

  ipcMain.handle(IPC.PROJECT_GET_CURRENT, () => {
    if (!context.currentProjectId) return null;
    return context.projectRepo.getById(context.currentProjectId) || null;
  });

  ipcMain.handle(IPC.PROJECT_REORDER, (_, ids: string[]) => {
    context.projectRepo.reorder(ids);
  });

  ipcMain.handle(IPC.PROJECT_OPEN_BY_PATH, async (_, projectPath: string) => {
    return openProjectByPath(context, projectPath);
  });
}

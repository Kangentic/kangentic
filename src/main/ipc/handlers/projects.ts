import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { recoverSessions, reconcileSessions } from '../../engine/session-recovery';
import { cleanupStaleResources } from '../../engine/resource-cleanup';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { WorktreeManager, isGitRepo, isInsideWorktree, isKangenticWorktree } from '../../git/worktree-manager';
import { stripKangenticHooks } from '../../agent/hook-manager';
import { getProjectDb, closeProjectDb } from '../../db/database';
import { CommandBridge } from '../../agent/command-bridge';
import { PATHS } from '../../config/paths';
import { ensureGitignore, autoSpawnForTask } from '../helpers';
import { searchProjectEntries } from '../helpers/project-entry-search';
import { trackEvent } from '../../analytics/analytics';
import { isShuttingDown } from '../../shutdown-state';
import type { Project, Task, AppConfig, ProjectSearchEntriesInput } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import type { ProjectRepository } from '../../db/repositories/project-repository';
import type { ConfigManager } from '../../config/config-manager';

/**
 * Detach Kangentic from a project: kill PTY sessions, cleanly remove git
 * worktrees (branches with user code are preserved), strip our injected
 * activity hooks from `.claude/settings.local.json`, remove `.kangentic/`,
 * and delete the per-project database file from app data.
 *
 * Does NOT touch the `.claude/` directory, git branches, or any user data.
 */
export async function cleanupProject(context: IpcContext, projectId: string, projectPath: string): Promise<void> {
  // Detach board config manager and external MCP bridge before cleanup
  context.boardConfigManager.detach();
  context.externalCommandBridge?.stop();
  context.externalCommandBridge = null;

  // Guard: project path must exist
  if (!fs.existsSync(projectPath)) {
    console.warn(`[PROJECT_DELETE] Project path does not exist: ${projectPath} -- skipping filesystem cleanup`);
    closeProjectDb(projectId);
    const dbPath = PATHS.projectDb(projectId);
    try { fs.unlinkSync(dbPath); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* may not exist */ }
    WorktreeManager.clearQueue(projectPath);
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
    const worktreeManager = new WorktreeManager(projectPath);
    for (const task of allTasks) {
      if (task.worktree_path && fs.existsSync(task.worktree_path)) {
        try {
          await worktreeManager.withLock(() => worktreeManager.removeWorktree(task.worktree_path!));
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
            && l.trim() !== '.claude/settings.local.json'
            && l.trim() !== 'kangentic.local.json',
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

  // 6b. Remove kangentic.json and kangentic.local.json from project root
  if (!isWorktree) {
    try { fs.unlinkSync(path.join(projectPath, 'kangentic.json')); } catch { /* may not exist */ }
    try { fs.unlinkSync(path.join(projectPath, 'kangentic.local.json')); } catch { /* may not exist */ }
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

  // 9. Clear git queue and current project state
  WorktreeManager.clearQueue(projectPath);
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
 * Find the project-overridable settings from the most recently opened
 * project that has overrides. Used to seed new projects so they inherit
 * settings from the last configured project rather than from global defaults.
 * Falls back to getProjectOverridableDefaults() if no projects have overrides.
 */
function getLastProjectOverrides(
  projectRepo: ProjectRepository,
  configManager: ConfigManager,
  excludePath?: string,
): Partial<AppConfig> {
  const projects = projectRepo.list()
    .sort((a, b) => (b.last_opened || '').localeCompare(a.last_opened || ''));
  for (const project of projects) {
    if (project.path === excludePath) continue;
    const overrides = configManager.loadProjectOverrides(project.path);
    if (overrides && Object.keys(overrides).length > 0) return overrides;
  }
  return configManager.getProjectOverridableDefaults();
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
    // Clone settings from the last modified project (or global defaults if none).
    const defaults = getLastProjectOverrides(context.projectRepo, context.configManager, normalized);
    context.configManager.saveProjectOverrides(normalized, defaults);
  }

  // Skip full recovery if re-opening the same project
  const isReopen = context.currentProjectId === project.id;

  // Open the project
  context.currentProjectId = project.id;
  context.currentProjectPath = project.path;
  context.projectRepo.updateLastOpened(project.id);
  ensureGitignore(project.path);

  // Attach board config manager for file watching and reconciliation
  context.boardConfigManager.attach(project.id, project.path, context.mainWindow);
  if (context.boardConfigManager.exists()) {
    const configWarnings = context.boardConfigManager.initialReconcile();
    for (const warning of configWarnings) {
      console.warn('[BOARD_CONFIG] Initial reconcile:', warning);
    }
  }
  // Always export DB state to kangentic.json so teams can commit it
  context.boardConfigManager.exportFromDb();

  // Start external MCP command bridge so Claude Code sessions running
  // outside Kangentic can interact with this project's board.
  // Config file at .kangentic/mcp-config.json (written by scripts/dev.js).
  if (!isReopen) {
    context.externalCommandBridge?.stop();
    const externalBridgeDirectory = path.join(project.path, '.kangentic', '_mcp-bridge');
    context.externalCommandBridge = new CommandBridge({
      commandsPath: path.join(externalBridgeDirectory, 'commands.jsonl'),
      responsesDir: path.join(externalBridgeDirectory, 'responses'),
      projectId: project.id,
      getProjectDb: () => getProjectDb(project.id),
      getProjectPath: () => project.path,
      onTaskCreated: (task, columnName, swimlaneId) => {
        if (!context.mainWindow.isDestroyed()) {
          context.mainWindow.webContents.send(
            IPC.TASK_CREATED_BY_AGENT, task.id, task.title, columnName, project.id
          );
        }
        // Auto-spawn agent if target column has auto_spawn enabled
        autoSpawnForTask(context, project.id, task, swimlaneId).catch(err => {
          console.error('[CommandBridge auto-spawn] Failed:', err);
        });
      },
      onTaskUpdated: (task) => {
        if (!context.mainWindow.isDestroyed()) {
          context.mainWindow.webContents.send(
            IPC.TASK_UPDATED_BY_AGENT, task.id, task.title, project.id
          );
        }
      },
      onBacklogChanged: () => {
        if (!context.mainWindow.isDestroyed()) {
          context.mainWindow.webContents.send(IPC.BACKLOG_CHANGED_BY_AGENT, project.id);
        }
      },
      onLabelColorsChanged: (colors) => {
        context.configManager.save({ backlog: { labelColors: colors } } as Partial<AppConfig>);
        if (!context.mainWindow.isDestroyed()) {
          context.mainWindow.webContents.send(IPC.BACKLOG_LABEL_COLORS_CHANGED);
        }
      },
    });
    context.externalCommandBridge.start();
  }

  const config = context.configManager.getEffectiveConfig(project.path);
  context.sessionManager.setMaxConcurrent(config.claude.maxConcurrentSessions);
  context.sessionManager.setShell(config.terminal.shell);

  if (!isReopen) {
    // Async fire-and-forget: resource cleanup then session recovery, serialized.
    const db = getProjectDb(project.id);
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    const swimlaneRepo = new SwimlaneRepository(db);
    cleanupStaleResources(project.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager)
      .then(() => recoverSessions(project.id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager))
      .catch((err) => console.error('[PROJECT_OPEN] Session recovery failed:', err))
      .then(() => reconcileSessions(project.id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager))
      .catch((err) => console.error('[PROJECT_OPEN] Session reconciliation failed:', err));
  }

  return project;
}

/**
 * Activate all projects on startup: run session recovery/reconciliation
 * for every project so agent sessions start immediately, not just when
 * the user navigates to a project board.
 */
export async function activateAllProjects(context: IpcContext): Promise<void> {
  if (isShuttingDown()) return;

  const config = context.configManager.load();
  if (!config.activateAllProjectsOnStartup) return;

  const projects = context.projectRepo.list();
  const otherProjects = projects.filter(p => p.id !== context.currentProjectId);
  if (otherProjects.length === 0) return;

  const results = await Promise.allSettled(
    otherProjects.map(async (project) => {
      if (isShuttingDown()) return;
      ensureGitignore(project.path);
      const db = getProjectDb(project.id);
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const swimlaneRepo = new SwimlaneRepository(db);
      await cleanupStaleResources(project.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager);
      await recoverSessions(project.id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager);
      await reconcileSessions(project.id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager);
    }),
  );

  for (let index = 0; index < results.length; index++) {
    if (results[index].status === 'rejected') {
      console.error(`[PROJECT_OPEN] Failed to activate project ${otherProjects[index].name}:`, (results[index] as PromiseRejectedResult).reason);
    }
  }
}

export function getLastOpenedProject(context: IpcContext): Project | undefined {
  return context.projectRepo.getLastOpened();
}

export function registerProjectHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.PROJECT_LIST, () => context.projectRepo.list());

  ipcMain.handle(IPC.PROJECT_CREATE, (_, input) => {
    const project = context.projectRepo.create(input);
    // Initialize the project database (creates tables + default swimlanes)
    getProjectDb(project.id);
    // Clone settings from the last modified project (or global defaults if none).
    const defaults = getLastProjectOverrides(context.projectRepo, context.configManager, project.path);
    context.configManager.saveProjectOverrides(project.path, defaults);
    trackEvent('project_create');
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

    // Attach board config manager for file watching and reconciliation
    context.boardConfigManager.attach(id, project.path, context.mainWindow);
    if (context.boardConfigManager.exists()) {
      const configWarnings = context.boardConfigManager.initialReconcile();
      for (const warning of configWarnings) {
        console.warn('[BOARD_CONFIG] Initial reconcile:', warning);
      }
    }
    // Always export DB state to kangentic.json so teams can commit it
    context.boardConfigManager.exportFromDb();

    // Apply project config overrides (always -- config may have changed)
    const config = context.configManager.getEffectiveConfig(project.path);
    context.sessionManager.setMaxConcurrent(config.claude.maxConcurrentSessions);
    context.sessionManager.setShell(config.terminal.shell);

    if (!isReopen) {
      const db = getProjectDb(id);
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const swimlaneRepo = new SwimlaneRepository(db);
      cleanupStaleResources(project.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager)
        .then(() => recoverSessions(id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager))
        .catch((err) => console.error('[PROJECT_OPEN] Session recovery failed:', err))
        .then(() => reconcileSessions(id, project.path, context.sessionManager, context.claudeDetector, context.commandBuilder, context.configManager))
        .catch((err) => console.error('[PROJECT_OPEN] Session reconciliation failed:', err));
    }
  });

  ipcMain.handle(IPC.PROJECT_GET_CURRENT, () => {
    if (!context.currentProjectId) return null;
    return context.projectRepo.getById(context.currentProjectId) || null;
  });

  ipcMain.handle(IPC.PROJECT_REORDER, (_, ids: string[]) => {
    context.projectRepo.reorder(ids);
  });

  ipcMain.handle(IPC.PROJECT_SET_GROUP, (_, projectId: string, groupId: string | null) => {
    context.projectRepo.setGroup(projectId, groupId);
  });

  ipcMain.handle(IPC.PROJECT_RENAME, (_, id: string, name: string) => {
    return context.projectRepo.rename(id, name);
  });

  ipcMain.handle(IPC.PROJECT_OPEN_BY_PATH, async (_, projectPath: string) => {
    return openProjectByPath(context, projectPath);
  });

  ipcMain.handle(IPC.PROJECT_SEARCH_ENTRIES, async (_, input: ProjectSearchEntriesInput) => {
    const resolvedCwd = path.resolve(input.cwd);
    const stat = await fs.promises.stat(resolvedCwd).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Project search path is not a directory: ${resolvedCwd}`);
    }
    return searchProjectEntries({ ...input, cwd: resolvedCwd });
  });

  // Project Groups
  ipcMain.handle(IPC.PROJECT_GROUP_LIST, () => context.projectGroupRepo.list());

  ipcMain.handle(IPC.PROJECT_GROUP_CREATE, (_, input: { name: string }) => {
    return context.projectGroupRepo.create(input);
  });

  ipcMain.handle(IPC.PROJECT_GROUP_UPDATE, (_, id: string, name: string) => {
    return context.projectGroupRepo.update(id, name);
  });

  ipcMain.handle(IPC.PROJECT_GROUP_DELETE, (_, id: string) => {
    context.projectGroupRepo.delete(id);
  });

  ipcMain.handle(IPC.PROJECT_GROUP_REORDER, (_, ids: string[]) => {
    context.projectGroupRepo.reorder(ids);
  });

  ipcMain.handle(IPC.PROJECT_GROUP_SET_COLLAPSED, (_, id: string, collapsed: boolean) => {
    context.projectGroupRepo.setCollapsed(id, collapsed);
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { resumeSuspendedSessions, autoSpawnTasks } from '../../engine/session-startup';
import { cleanupStaleResourcesAsync, pruneOrphanedWorktreeTasks } from '../../engine/resource-cleanup';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { TranscriptRepository } from '../../db/repositories/transcript-repository';
import { WorktreeManager } from '../../git/worktree-manager';
import { isGitRepo, isInsideWorktree, isKangenticWorktree } from '../../git/git-checks';
import { agentRegistry } from '../../agent/agent-registry';
import { getProjectDb, closeProjectDb } from '../../db/database';
import { PATHS } from '../../config/paths';
import { ensureGitignore } from '../helpers';
import { searchProjectEntries } from '../helpers/project-entry-search';
import { trackEvent } from '../../analytics/analytics';
import { isShuttingDown } from '../../shutdown-state';
import { DEFAULT_AGENT } from '../../../shared/types';
import type { Project, Task, AppConfig, ProjectSearchEntriesInput } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import type { ProjectRepository } from '../../db/repositories/project-repository';
import type { ConfigManager } from '../../config/config-manager';

/**
 * Sync the project-level MCP config file with the current settings.
 * Honors the global Settings → MCP Server → Kangentic MCP Server toggle:
 *
 * - When enabled: writes `<project>/.kangentic/mcp-config.json` with the
 *   in-process HTTP MCP server URL + per-launch token. External Claude
 *   sessions launched via `claude --mcp-config <path>` pick up this file
 *   and gain the kangentic_* tools.
 *
 * - When disabled: deletes any existing file so external Claude sessions
 *   stop seeing the tools. The HTTP server itself stays bound (it costs
 *   nothing) -- without a config file, no client knows the URL or token.
 *
 * Called from PROJECT_OPEN and from the global config save handler when
 * the user flips the MCP Server toggle in Settings.
 */
export function syncProjectMcpConfig(context: IpcContext, projectId: string, projectPath: string): void {
  const config = context.configManager.getEffectiveConfig(projectPath);
  const mcpConfigPath = path.join(projectPath, '.kangentic', 'mcp-config.json');
  const enabled = config.mcpServer?.enabled ?? true;

  if (!enabled || !context.mcpServerHandle) {
    try {
      fs.unlinkSync(mcpConfigPath);
    } catch (err) {
      // ENOENT is the common case (toggle was already off, no file to
      // delete). Anything else (EACCES, EBUSY from a transient antivirus
      // lock on Windows) means the stale file is still on disk and could
      // still grant access -- log so the user can investigate.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error('[syncProjectMcpConfig] Failed to delete mcp-config.json:', err);
      }
    }
    return;
  }

  try {
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    const mcpConfig = {
      mcpServers: {
        kangentic: {
          type: 'http' as const,
          url: context.mcpServerHandle.urlForProject(projectId),
          headers: { 'X-Kangentic-Token': context.mcpServerHandle.token },
        },
      },
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  } catch (err) {
    console.error('[syncProjectMcpConfig] Failed to write mcp-config.json:', err);
  }
}

/**
 * Detach Kangentic from a project: kill PTY sessions, cleanly remove git
 * worktrees (branches with user code are preserved), strip our injected
 * activity hooks from `.claude/settings.local.json`, remove `.kangentic/`,
 * and delete the per-project database file from app data.
 *
 * Does NOT touch the `.claude/` directory, git branches, or any user data.
 */
export async function cleanupProject(context: IpcContext, projectId: string, projectPath: string): Promise<void> {
  // Detach board config manager. The MCP HTTP server is global to main
  // and shared across projects -- it has no per-project state to tear
  // down. Once the project row is removed below, the server's per-request
  // factory stops resolving CommandContexts for this project.
  context.boardConfigManager.detach();

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

  // 3. Strip injected hooks from all registered agents (legacy cleanup --
  //    new sessions use --settings and don't write to settings.local.json,
  //    but existing worktrees from before the change may still have our hooks)
  const directories = [projectPath];
  const worktreesDir = path.join(projectPath, '.kangentic', 'worktrees');
  if (fs.existsSync(worktreesDir)) {
    try {
      for (const entry of fs.readdirSync(worktreesDir)) {
        directories.push(path.join(worktreesDir, entry));
      }
    } catch { /* best effort */ }
  }
  for (const directory of directories) {
    for (const adapterName of agentRegistry.list()) {
      const adapter = agentRegistry.get(adapterName);
      if (adapter) adapter.removeHooks(directory);
    }
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
 * Detect installed agents and return the first one found.
 * Falls back to DEFAULT_AGENT ('claude') if none are detected.
 */
async function resolveDefaultAgent(configManager: ConfigManager): Promise<string> {
  const { agentRegistry } = await import('../../agent/agent-registry');
  const config = configManager.load();
  const cliPaths = config.agent.cliPaths;
  for (const name of agentRegistry.list()) {
    try {
      const adapter = agentRegistry.getOrThrow(name);
      const info = await adapter.detect(cliPaths[name] ?? null);
      if (info.found) return name;
    } catch {
      // Detection failed for this agent (corrupt binary, permission error, etc.) - skip it
    }
  }
  return DEFAULT_AGENT;
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
    const defaultAgent = await resolveDefaultAgent(context.configManager);
    project = context.projectRepo.create({ name, path: normalized, default_agent: defaultAgent });
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
    const configWarnings = context.boardConfigManager.applyConfigOnOpen();
    for (const warning of configWarnings) {
      console.warn('[BOARD_CONFIG] Initial reconcile:', warning);
    }
  }
  // Always export DB state to kangentic.json so teams can commit it
  context.boardConfigManager.exportFromDb();

  // Sync the project-level MCP config file with the current settings.
  // Honors the global Settings → MCP Server → Kangentic MCP Server toggle:
  // when enabled, writes <project>/.kangentic/mcp-config.json with the
  // in-process HTTP server URL + per-launch token; when disabled, deletes
  // any existing file so external Claude sessions stop seeing the tools.
  syncProjectMcpConfig(context, project.id, project.path);

  const config = context.configManager.getEffectiveConfig(project.path);
  context.sessionManager.setMaxConcurrent(config.agent.maxConcurrentSessions);
  context.sessionManager.setShell(config.terminal.shell);

  // Enable transcript capture for cross-agent handoffs
  context.sessionManager.setTranscriptRepository(new TranscriptRepository(getProjectDb(project.id)));

  if (!isReopen) {
    const db = getProjectDb(project.id);
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    const swimlaneRepo = new SwimlaneRepository(db);

    // Prune orphan-worktree tasks synchronously so session recovery below
    // sees a clean DB. The remaining passes (backlog cleanup + orphan
    // directory removal) run hundreds of filesystem ops on repos with
    // leftover worktrees and previously blocked recovery for minutes, so
    // they are fired in the background.
    pruneOrphanedWorktreeTasks(project.path, taskRepo, sessionRepo, context.sessionManager);
    cleanupStaleResourcesAsync(project.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager)
      .catch((err) => console.error(`[PROJECT_OPEN] Resource cleanup failed for ${project.name}:`, err));

    resumeSuspendedSessions(project.id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle)
      .catch((err) => console.error('[PROJECT_OPEN] Session recovery failed:', err))
      .then(() => autoSpawnTasks(project.id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle))
      .catch((err) => console.error('[PROJECT_OPEN] Session reconciliation failed:', err));
  }

  return project;
}

/**
 * Activate all projects on startup: run session recovery/reconciliation
 * for every project so agent sessions start immediately, not just when
 * the user navigates to a project board.
 *
 * Post-condition: resolves once every project's suspended sessions have
 * been resumed and auto-spawns have been dispatched. The slow resource
 * cleanup passes (backlog cleanup + orphan directory removal) run in the
 * background and may still be in flight when this resolves. Callers
 * that need cleanup-complete must not rely on this function's resolution.
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

      // See openProjectByPath for rationale: sync prune ensures recovery
      // reads a clean DB; the slow async passes run in the background and
      // may still be in flight when activateAllProjects resolves.
      pruneOrphanedWorktreeTasks(project.path, taskRepo, sessionRepo, context.sessionManager);
      cleanupStaleResourcesAsync(project.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager)
        .catch((err) => console.error(`[PROJECT_OPEN] Resource cleanup failed for ${project.name}:`, err));

      await resumeSuspendedSessions(project.id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle);
      await autoSpawnTasks(project.id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle);
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

    // Attach board config manager for file watching (must be synchronous --
    // wires the watcher the renderer needs).
    context.boardConfigManager.attach(id, project.path, context.mainWindow);

    // Defer reconcile + disk export off the IPC critical path so the
    // renderer can begin loading the new board immediately. The DB is the
    // source of truth, so a deferred kangentic.json export is safe.
    setImmediate(() => {
      // Guard against rapid project switching: if the user has already
      // switched to a different project, the boardConfigManager singleton
      // is now attached to that project -- skip the deferred work to
      // avoid exporting the wrong project's state.
      if (context.currentProjectId !== id) return;
      try {
        if (context.boardConfigManager.exists()) {
          const configWarnings = context.boardConfigManager.applyConfigOnOpen();
          for (const warning of configWarnings) {
            console.warn('[BOARD_CONFIG] Initial reconcile:', warning);
          }
        }
        context.boardConfigManager.exportFromDb();
      } catch (err) {
        console.error('[PROJECT_OPEN] Deferred board config work failed:', err);
      }
    });

    // Apply project config overrides (always -- config may have changed)
    const config = context.configManager.getEffectiveConfig(project.path);
    context.sessionManager.setMaxConcurrent(config.agent.maxConcurrentSessions);
    context.sessionManager.setShell(config.terminal.shell);

    if (!isReopen) {
      const db = getProjectDb(id);
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const swimlaneRepo = new SwimlaneRepository(db);

      // Same split as openProjectByPath: sync prune guarantees recovery
      // reads a clean DB, and the slow filesystem passes run in the
      // background so session spawn is not blocked on them.
      pruneOrphanedWorktreeTasks(project.path, taskRepo, sessionRepo, context.sessionManager);
      cleanupStaleResourcesAsync(project.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager)
        .catch((err) => console.error(`[PROJECT_OPEN] Resource cleanup failed for ${project.name}:`, err));

      resumeSuspendedSessions(id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle)
        .catch((err) => console.error('[PROJECT_OPEN] Session recovery failed:', err))
        .then(() => autoSpawnTasks(id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle))
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

  ipcMain.handle(IPC.PROJECT_SET_DEFAULT_AGENT, async (_, id: string, agentName: string) => {
    const { agentRegistry } = await import('../../agent/agent-registry');
    if (!agentRegistry.has(agentName)) {
      throw new Error(`Unknown agent: "${agentName}"`);
    }
    return context.projectRepo.setDefaultAgent(id, agentName);
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

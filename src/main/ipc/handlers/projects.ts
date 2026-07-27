import path from 'node:path';
import fs from '../../git/original-fs';
import { ipcMain } from 'electron';
import { IPC, PROJECT_PATH_MISSING_PREFIX } from '../../../shared/ipc-channels';
import { relocateProject } from './project-relocate';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { resumeSuspendedSessions, autoSpawnTasks } from '../../transition-engine/session-startup';
import { cleanupStaleResourcesAsync, pruneOrphanedWorktreeTasks } from '../../transition-engine/resource-cleanup';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { TranscriptRepository } from '../../db/repositories/transcript-repository';
import { WorktreeManager } from '../../git/worktree-manager';
import { isGitRepo, isInsideWorktree, isKangenticWorktree, ensureGitRepo } from '../../git/git-checks';
import { readWorktreeHeadUnqueued } from '../../git/worktree-head';
import { agentRegistry } from '../../agent/agent-registry';
import { getProjectDb, closeProjectDb } from '../../db/database';
import { PATHS } from '../../config/paths';
import { applyRuntimeConfig } from '../../config/apply-runtime-config';
import { ensureGitignore } from '../helpers';
import { searchProjectEntries } from '../helpers/project-entry-search';
import { trackEvent } from '../../analytics/analytics';
import { isShuttingDown } from '../../shutdown-state';
import { runWithProjectLogContext } from '../../diagnostics/project-log-context';
import { prRefreshScheduler } from '../../pr/pr-refresh-scheduler';
import { retrievalService } from '../../retrieval/retrieval-service';
import { DEFAULT_AGENT } from '../../../shared/types';
import type { Project, Task, AppConfig, ProjectSearchEntriesInput, ProjectRelocateOptions, ProjectPathProbe, ProjectEnsureGitResult, ProjectOpenByPathOverrides } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import type { ProjectRepository } from '../../db/repositories/project-repository';
import type { ConfigManager } from '../../config/config-manager';
import { pickOverridableSubset } from '../../config/config-manager';

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

  // Stop this project's background PR-refresh timer (no-op if it is not the
  // active one). Before the path-exists guard so both cleanup paths tear it down.
  prRefreshScheduler.stop(projectId);
  retrievalService.stop(projectId);

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
      retrievalService.reconcileEmbedWorker(context);
    }
    context.recoveredProjects.delete(projectId);
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
          await worktreeManager.withLock(
            () => worktreeManager.removeWorktree(task.worktree_path!),
            { label: 'project-delete-worktree' },
          );
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
    retrievalService.reconcileEmbedWorker(context);
  }
  context.recoveredProjects.delete(projectId);

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
 *
 * Only the project-overridable subset (theme/git/permissionMode - terminal.* is
 * global-only, see pickOverridableSubset) is returned - never project-specific
 * data that also lives in config.json such as
 * `importSources` or `browser.defaultUrl`. Cloning the raw config.json here is
 * what previously leaked one project's import sources into every project created
 * after it.
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
    if (!overrides) continue;
    const subset = pickOverridableSubset(overrides);
    if (Object.keys(subset).length > 0) return subset;
  }
  return configManager.getProjectOverridableDefaults();
}

/**
 * The model / effort defaults a NEW project should start with, taken from the
 * most recently opened project that has either set.
 *
 * These live on the `projects` row, not in `.kangentic/config.json`, so
 * `getLastProjectOverrides` above never covered them and a new project always
 * started at "Agent default" - visibly different from every existing project
 * even when the user had configured the same preference everywhere. It shows up
 * most sharply in an ephemeral `/preview` project, where the placeholders in the
 * New Task dialog read differently than in the instance being previewed.
 *
 * Same inheritance rule as the config subset: prefer the last configured
 * project, fall back to nothing (which resolves to the agent's own default).
 * `default_agent` is deliberately NOT inherited here - it is resolved by
 * detection (`resolveDefaultAgent`), so an installed-agent change is picked up
 * rather than a stale name being copied forward.
 */
export function getLastProjectAgentDefaults(
  projectRepo: Pick<ProjectRepository, 'list'>,
  excludePath?: string,
): { default_model: string | null; default_effort: string | null } {
  const projects = projectRepo.list()
    .sort((a, b) => (b.last_opened || '').localeCompare(a.last_opened || ''));
  for (const project of projects) {
    if (project.path === excludePath) continue;
    if (project.default_model || project.default_effort) {
      return {
        default_model: project.default_model ?? null,
        default_effort: project.default_effort ?? null,
      };
    }
  }
  return { default_model: null, default_effort: null };
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
 * Await the orphan-worktree prune for a project and, when it actually deleted
 * rows, push a TASK_SESSION_RESYNC so the renderer reloads (or invalidates)
 * that project's board. The prune runs off the awaited open path now, so the
 * renderer's first task-list load can race it and briefly show a task the
 * prune is about to delete; the push closes that window. Never rejects -
 * a prune failure must not block session recovery.
 */
async function pruneOrphanedTasksAndNotify(
  context: IpcContext,
  project: Project,
  taskRepo: TaskRepository,
  sessionRepo: SessionRepository,
): Promise<void> {
  const pruned = await pruneOrphanedWorktreeTasks(project.path, taskRepo, sessionRepo, context.sessionManager)
    .catch((error) => {
      console.error(`[PROJECT_OPEN] Worktree prune failed for ${project.name}:`, error);
      return 0;
    });
  if (pruned > 0 && context.mainWindow && !context.mainWindow.isDestroyed()) {
    context.mainWindow.webContents.send(IPC.TASK_SESSION_RESYNC, project.id);
  }
}

/**
 * Defer the board-config reconcile + kangentic.json export off the open/switch
 * critical path. Guarded against rapid project switching: if the user has
 * already switched again by the time the deferred tick runs, the
 * boardConfigManager singleton is attached to the newer project, so the work
 * is skipped to avoid exporting the wrong project's state. Safe to skip: the
 * DB is the source of truth and the next open of that project re-runs this.
 */
function deferBoardConfigReconcile(context: IpcContext, projectId: string, projectName: string): void {
  setImmediate(() => {
    if (context.currentProjectId !== projectId) return;
    runWithProjectLogContext(projectName, () => {
      try {
        if (context.boardConfigManager.exists()) {
          const configWarnings = context.boardConfigManager.applyConfigOnOpen();
          for (const warning of configWarnings) {
            console.warn('[BOARD_CONFIG] Initial reconcile:', warning);
          }
        }
        // Always export DB state to kangentic.json so teams can commit it
        context.boardConfigManager.exportFromDb();
      } catch (error) {
        console.error('[PROJECT_OPEN] Deferred board config work failed:', error);
      }
    });
  });
}

/**
 * Find an existing project by path, or create one and open it.
 * Returns the project object.
 */
export async function openProjectByPath(context: IpcContext, projectPath: string, overrides?: ProjectOpenByPathOverrides) {
  // Normalize the path for comparison
  const normalized = path.resolve(projectPath);

  // Check if a project with this path already exists
  const projects = context.projectRepo.list();
  let project = projects.find((p) => path.resolve(p.path) === normalized);

  // Guard BEFORE any directory-creating side effect (saveProjectOverrides,
  // ensureGitignore, syncProjectMcpConfig all mkdir under the project path).
  // A registered project whose folder vanished means it was moved or renamed
  // on disk: silently recreating an empty folder there loses the project.
  // The sentinel lets the renderer offer the "Locate Folder..." flow.
  if (!fs.existsSync(normalized)) {
    if (project) {
      throw new Error(PROJECT_PATH_MISSING_PREFIX + normalized);
    }
    throw new Error(`Project path does not exist: ${normalized}`);
  }

  if (!project) {
    // Create a new project. overrides comes from the Add project dialog
    // (editable name, chosen default agent); falls back to the folder's
    // basename and detection-order resolution when absent (e.g. the
    // sidebar's direct-open flow, which skips the dialog).
    const name = overrides?.name?.trim() || path.basename(normalized);
    const defaultAgent = overrides?.defaultAgent ?? await resolveDefaultAgent(context.configManager);
    project = context.projectRepo.create({
      name,
      path: normalized,
      default_agent: defaultAgent,
      ...getLastProjectAgentDefaults(context.projectRepo, normalized),
    });
    // Initialize the project database (creates tables + default swimlanes)
    getProjectDb(project.id);
    // Clone settings from the last modified project (or global defaults if none).
    const defaults = getLastProjectOverrides(context.projectRepo, context.configManager, normalized);
    context.configManager.saveProjectOverrides(normalized, defaults);
  }

  // Skip full recovery on warm reopens: any project we've already recovered
  // this process lifetime has live PTYs in the registry and DB rows that
  // cannot drift without going through our handlers. App restart clears
  // the set (new IpcContext); PROJECT_DELETE clears the project's entry.
  const isWarmReopen = context.recoveredProjects.has(project.id);

  // Open the project
  context.currentProjectId = project.id;
  context.currentProjectPath = project.path;
  context.projectRepo.updateLastOpened(project.id);
  // Fire-and-forget: nothing downstream reads its effect, it never rejects,
  // and its git tracked-file probe must not block the open critical path.
  void ensureGitignore(project.path);

  // Attach board config manager for file watching (must be synchronous -
  // wires the watcher the renderer needs).
  context.boardConfigManager.attach(project.id, project.path, context.mainWindow);

  deferBoardConfigReconcile(context, project.id, project.name);

  // Sync the project-level MCP config file with the current settings.
  // Honors the global Settings → MCP Server → Kangentic MCP Server toggle:
  // when enabled, writes <project>/.kangentic/mcp-config.json with the
  // in-process HTTP server URL + per-launch token; when disabled, deletes
  // any existing file so external Claude sessions stop seeing the tools.
  syncProjectMcpConfig(context, project.id, project.path);

  applyRuntimeConfig(context.sessionManager, context.configManager, project.path);

  // Enable transcript capture for cross-agent handoffs
  context.sessionManager.setTranscriptRepository(new TranscriptRepository(getProjectDb(project.id)));

  if (!isWarmReopen) {
    // Stays synchronous: guards a rapid double-open from re-running recovery.
    context.recoveredProjects.add(project.id);

    const db = getProjectDb(project.id);
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    const swimlaneRepo = new SwimlaneRepository(db);

    // Ordering contract (see pruneOrphanedWorktreeTasks): the prune completes
    // before session recovery reads the DB, but the whole chain runs off the
    // awaited open path. The remaining passes (backlog cleanup + orphan
    // directory removal) run hundreds of filesystem ops on repos with
    // leftover worktrees and previously blocked recovery for minutes, so
    // they are fired without awaiting.
    const openedProject = project;
    runWithProjectLogContext(project.name, () =>
      pruneOrphanedTasksAndNotify(context, openedProject, taskRepo, sessionRepo)
        .then(() => {
          cleanupStaleResourcesAsync(openedProject.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager)
            .catch((error) => console.error(`[PROJECT_OPEN] Resource cleanup failed for ${openedProject.name}:`, error));
          return resumeSuspendedSessions(openedProject.id, openedProject.path, context.sessionManager, context.configManager, openedProject.default_agent, context.mcpServerHandle, openedProject.default_model, openedProject.default_effort, context.boardConfigManager.getBoardProfiles(openedProject.path));
        })
        .catch((err) => console.error('[PROJECT_OPEN] Session recovery failed:', err))
        .then(() => autoSpawnTasks(openedProject.id, openedProject.path, context.sessionManager, context.configManager, openedProject.default_agent, context.mcpServerHandle, openedProject.default_model, openedProject.default_effort, context.boardConfigManager.getBoardProfiles(openedProject.path)))
        .catch((err) => console.error('[PROJECT_OPEN] Session reconciliation failed:', err)),
    );
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

  const projects = context.projectRepo.list();
  const otherProjects = projects.filter(p => p.id !== context.currentProjectId);
  if (otherProjects.length === 0) return;

  const results = await Promise.allSettled(
    // Each project gets its own ALS log-tag context so the concurrently
    // emitted recovery/auto-spawn lines (resumeSuspendedSessions /
    // autoSpawnTasks fired in parallel across all projects) are each tagged
    // with the project that produced them, not the focused project.
    otherProjects.map((project) => runWithProjectLogContext(project.name, async () => {
      if (isShuttingDown()) return;
      // A missing folder means the project was moved or renamed on disk.
      // Skip activation entirely: ensureGitignore would recreate an empty
      // folder at the stale path, and session recovery would retire the
      // suspended session records because their cwds no longer exist.
      if (!fs.existsSync(project.path)) {
        console.warn(`[PROJECT_OPEN] Skipping activation, path missing: ${project.path}`);
        return;
      }
      // Awaited (not fire-and-forget) to keep per-project sequencing
      // deterministic; this whole closure already runs in the background.
      await ensureGitignore(project.path);
      const db = getProjectDb(project.id);
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const swimlaneRepo = new SwimlaneRepository(db);

      // See openProjectByPath for rationale: the awaited prune ensures
      // recovery reads a clean DB; the slow async passes run in the
      // background and may still be in flight when activateAllProjects
      // resolves.
      await pruneOrphanedTasksAndNotify(context, project, taskRepo, sessionRepo);
      cleanupStaleResourcesAsync(project.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager)
        .catch((err) => console.error(`[PROJECT_OPEN] Resource cleanup failed for ${project.name}:`, err));

      await resumeSuspendedSessions(project.id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle, project.default_model, project.default_effort, context.boardConfigManager.getBoardProfiles(project.path));
      await autoSpawnTasks(project.id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle, project.default_model, project.default_effort, context.boardConfigManager.getBoardProfiles(project.path));
      // Deliberately AFTER the chain (unlike the open paths, which mark up
      // front to guard rapid double-opens): a failed background activation
      // stays cold, so the user's next explicit open retries recovery.
      context.recoveredProjects.add(project.id);
    })),
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
    // Explicit input wins; the inherited defaults only fill what it left unset.
    const project = context.projectRepo.create({
      ...getLastProjectAgentDefaults(context.projectRepo, input.path),
      ...input,
    });
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

    // The project folder was moved or renamed on disk. Bail before any
    // directory-creating side effect below recreates an empty folder at the
    // stale path; the sentinel triggers the renderer's "Locate Folder..." flow.
    if (!fs.existsSync(project.path)) {
      throw new Error(PROJECT_PATH_MISSING_PREFIX + project.path);
    }

    // Skip full recovery on warm reopens: any project we've already recovered
    // this process lifetime has live PTYs in the registry and DB rows that
    // cannot drift without going through our handlers. App restart clears
    // the set (new IpcContext); PROJECT_DELETE clears the project's entry.
    const isWarmReopen = context.recoveredProjects.has(id);

    context.currentProjectId = id;
    context.currentProjectPath = project.path;
    context.projectRepo.updateLastOpened(id);
    // Fire-and-forget: nothing downstream reads its effect, it never rejects,
    // and its git tracked-file probe must not block the switch critical path.
    void ensureGitignore(project.path);

    // Attach board config manager for file watching (must be synchronous -
    // wires the watcher the renderer needs).
    context.boardConfigManager.attach(id, project.path, context.mainWindow);

    deferBoardConfigReconcile(context, id, project.name);

    // Apply project config overrides (always -- config may have changed)
    applyRuntimeConfig(context.sessionManager, context.configManager, project.path);

    // Background PR-state refresh: an immediate (deferred) sweep + the periodic
    // timer. Runs on EVERY open (cold restart AND warm switch-back) so a PR
    // merged off-app while away is reflected on return; the sweep is deferred off
    // the IPC critical path and the timer is torn down on switch/delete/shutdown.
    prRefreshScheduler.startForProject(context, project);

    // Background conversation-memory indexing: a deferred, switch-guarded
    // backfill sweep of unindexed sessions. Live sessions are indexed via the
    // finalize hooks attached here on first open.
    retrievalService.startForProject(context, project);

    if (!isWarmReopen) {
      // Stays synchronous: guards a rapid double-open from re-running recovery.
      context.recoveredProjects.add(id);

      // The whole cold-open block is deferred off the awaited IPC body: the
      // SQLite open + migrations, the orphan prune, and session recovery are
      // all main-thread-heavy and nothing in the PROJECT_OPEN response
      // depends on them. Deliberately NO currentProjectId switch guard here:
      // recovery for a project the user immediately left must still run
      // (matching the previous fire-and-forget behavior); the guard belongs
      // only on the board-config block above, which is tied to the singleton
      // attach.
      setImmediate(() => {
        runWithProjectLogContext(project.name, async () => {
          const db = getProjectDb(id);
          const taskRepo = new TaskRepository(db);
          const sessionRepo = new SessionRepository(db);
          const swimlaneRepo = new SwimlaneRepository(db);

          // Ordering contract (see pruneOrphanedWorktreeTasks): the prune
          // completes before session recovery reads the DB; the slow
          // filesystem passes are fired without awaiting.
          await pruneOrphanedTasksAndNotify(context, project, taskRepo, sessionRepo);
          cleanupStaleResourcesAsync(project.path, taskRepo, swimlaneRepo, sessionRepo, context.sessionManager)
            .catch((error) => console.error(`[PROJECT_OPEN] Resource cleanup failed for ${project.name}:`, error));

          await resumeSuspendedSessions(id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle, project.default_model, project.default_effort, context.boardConfigManager.getBoardProfiles(project.path))
            .catch((error) => console.error('[PROJECT_OPEN] Session recovery failed:', error));
          await autoSpawnTasks(id, project.path, context.sessionManager, context.configManager, project.default_agent, context.mcpServerHandle, project.default_model, project.default_effort, context.boardConfigManager.getBoardProfiles(project.path))
            .catch((error) => console.error('[PROJECT_OPEN] Session reconciliation failed:', error));
        });
      });
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

  ipcMain.handle(IPC.PROJECT_RELOCATE, async (_, id: string, newPath: string, options?: ProjectRelocateOptions) => {
    return relocateProject(context, id, newPath, options);
  });

  ipcMain.handle(IPC.PROJECT_SET_DEFAULT_AGENT, async (_, id: string, agentName: string) => {
    const { agentRegistry } = await import('../../agent/agent-registry');
    if (!agentRegistry.has(agentName)) {
      throw new Error(`Unknown agent: "${agentName}"`);
    }
    return context.projectRepo.setDefaultAgent(id, agentName);
  });

  ipcMain.handle(IPC.PROJECT_SET_DEFAULT_MODEL, (_, id: string, model: string | null) => {
    return context.projectRepo.setDefaultModel(id, model);
  });

  ipcMain.handle(IPC.PROJECT_SET_DEFAULT_EFFORT, (_, id: string, effort: string | null) => {
    return context.projectRepo.setDefaultEffort(id, effort);
  });

  ipcMain.handle(IPC.PROJECT_OPEN_BY_PATH, async (_, projectPath: string, overrides?: ProjectOpenByPathOverrides) => {
    return openProjectByPath(context, projectPath, overrides);
  });

  const probeFolder = async (folderPath: string): Promise<ProjectPathProbe> => {
    const normalized = path.resolve(folderPath);
    const exists = fs.existsSync(normalized);
    const isDirectory = exists && fs.statSync(normalized).isDirectory();
    const isGit = isDirectory && isGitRepo(normalized);
    const insideWorktree = isDirectory && isInsideWorktree(normalized);
    const { branch } = isGit ? await readWorktreeHeadUnqueued(normalized) : { branch: null };
    const existingProject = context.projectRepo.list().find((p) => path.resolve(p.path) === normalized);
    return {
      exists,
      isDirectory,
      isGitRepo: isGit,
      isInsideWorktree: insideWorktree,
      currentBranch: branch,
      suggestedName: path.basename(normalized),
      alreadyRegisteredProjectId: existingProject?.id ?? null,
    };
  };

  ipcMain.handle(IPC.PROJECT_PROBE_PATH, async (_, folderPath: string): Promise<ProjectPathProbe> => {
    return probeFolder(folderPath);
  });

  ipcMain.handle(IPC.PROJECT_ENSURE_GIT, async (_, folderPath: string): Promise<ProjectEnsureGitResult> => {
    return ensureGitRepo(path.resolve(folderPath));
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

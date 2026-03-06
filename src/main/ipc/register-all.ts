import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { ProjectRepository } from '../db/repositories/project-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { ActionRepository } from '../db/repositories/action-repository';
import { SessionManager } from '../pty/session-manager';
import { ConfigManager } from '../config/config-manager';
import { ClaudeDetector } from '../agent/claude-detector';
import { ShellResolver } from '../pty/shell-resolver';
import { TransitionEngine } from '../engine/transition-engine';
import { CommandBuilder } from '../agent/command-builder';
import { SessionRepository } from '../db/repositories/session-repository';
import { AttachmentRepository } from '../db/repositories/attachment-repository';
import { recoverSessions, reconcileSessions, pruneOrphanedWorktrees } from '../engine/session-recovery';
import { CommandInjector } from '../engine/command-injector';
import { WorktreeManager, isGitRepo, isInsideWorktree, isKangenticWorktree, isFileTracked } from '../git/worktree-manager';
import { stripKangenticHooks } from '../agent/hook-manager';
import { getProjectDb, closeProjectDb } from '../db/database';
import { PATHS } from '../config/paths';
import type { Task } from '../../shared/types';

/**
 * Ensure `.kangentic/` and `.claude/settings.local.json` are listed in the
 * project's `.gitignore`.  Fully wrapped in try-catch — a read-only project
 * directory or permission issue must never prevent the app from opening.
 */
function ensureGitignore(projectPath: string): void {
  if (!isGitRepo(projectPath)) return;
  try {
    const gitignorePath = path.join(projectPath, '.gitignore');
    let content = '';
    try {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    } catch {
      // No .gitignore yet — we'll create one
    }

    // 1. Ensure .kangentic/ is ignored
    const lines = content.split('\n');
    const kangenticIgnored = lines.some(
      (l) => l.trim() === '.kangentic' || l.trim() === '.kangentic/',
    );
    if (!kangenticIgnored) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      content = content + separator + '.kangentic/\n';
      fs.writeFileSync(gitignorePath, content);
    }

    // 2. Ensure .claude/settings.local.json is ignored — but only if the project
    //    hasn't intentionally committed it (e.g. to accumulate permission allowlists).
    const linesAfter = content.split('\n');
    const settingsIgnored = linesAfter.some(
      (l) => l.trim() === '.claude/settings.local.json',
    );
    if (!settingsIgnored) {
      const settingsTracked = isFileTracked(projectPath, '.claude/settings.local.json');
      if (!settingsTracked) {
        const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(gitignorePath, content + separator + '.claude/settings.local.json\n');
      }
    }
  } catch (err) {
    // Non-fatal: log and continue. Project may be read-only or on a network drive.
    console.warn(`Could not update .gitignore at ${projectPath}:`, err);
  }
}

let currentProjectId: string | null = null;
let currentProjectPath: string | null = null;

// Singleton services
const projectRepo = new ProjectRepository();
const sessionManager = new SessionManager();
const configManager = new ConfigManager();
const claudeDetector = new ClaudeDetector();
const shellResolver = new ShellResolver();
const commandBuilder = new CommandBuilder();
const commandInjector = new CommandInjector(sessionManager);

/** Build template variables for auto-command interpolation. */
function buildAutoCommandVars(task: Task): Record<string, string> {
  return {
    title: task.title,
    description: task.description,
    taskId: task.id,
    worktreePath: task.worktree_path || '',
    branchName: task.branch_name || '',
  };
}

/**
 * Create a worktree for a task if needed and update the DB + task object in place.
 * No-ops silently when worktrees are disabled, project isn't a git repo, etc.
 */
async function ensureTaskWorktree(task: Task, tasks: TaskRepository): Promise<void> {
  if (!currentProjectPath) return;
  try {
    const config = configManager.getEffectiveConfig(currentProjectPath);
    const wm = new WorktreeManager(currentProjectPath);
    const result = await wm.ensureWorktree(task, config.git);
    if (result) {
      tasks.update({ id: task.id, worktree_path: result.worktreePath, branch_name: result.branchName });
      Object.assign(task, tasks.getById(task.id));
    }
  } catch (err) {
    console.error('Worktree creation failed:', err);
  }
}

/** Create a TransitionEngine wired to the current project singletons. */
function createTransitionEngine(
  actions: ActionRepository,
  tasks: TaskRepository,
  sessionRepo: SessionRepository,
  attachments: AttachmentRepository,
): TransitionEngine {
  return new TransitionEngine(
    sessionManager, actions, tasks, claudeDetector, commandBuilder,
    () => {
      const config = configManager.getEffectiveConfig(currentProjectPath || undefined);
      return {
        permissionMode: config.claude.permissionMode,
        claudePath: config.claude.cliPath,
        projectPath: currentProjectPath,
        projectId: currentProjectId ?? '',
        gitConfig: config.git,
      };
    },
    sessionRepo,
    attachments,
  );
}

function getProjectRepos(): { tasks: TaskRepository; swimlanes: SwimlaneRepository; actions: ActionRepository; attachments: AttachmentRepository } {
  if (!currentProjectId) throw new Error('No project is currently open');
  const db = getProjectDb(currentProjectId);
  return {
    tasks: new TaskRepository(db),
    swimlanes: new SwimlaneRepository(db),
    actions: new ActionRepository(db),
    attachments: new AttachmentRepository(db),
  };
}

/**
 * Kill the PTY session and wipe session records for a task.
 * Preserves the worktree and branch so code is not lost.
 *
 * Used by TASK_MOVE → Backlog ("shelve this task").
 */
async function cleanupTaskSession(
  task: { id: string; session_id: string | null; worktree_path: string | null; branch_name: string | null },
  tasks: TaskRepository,
): Promise<void> {
  // Kill active PTY session
  if (task.session_id) {
    try { sessionManager.remove(task.session_id); } catch { /* may already be dead */ }
    tasks.update({ id: task.id, session_id: null });
  }

  // Remove session DB records + directories from disk
  if (currentProjectId) {
    const db = getProjectDb(currentProjectId);
    const sessionRepo = new SessionRepository(db);

    // Best-effort disk cleanup (non-fatal — DB records are the source of truth)
    if (currentProjectPath) {
      const records = db.prepare(
        'SELECT claude_session_id FROM sessions WHERE task_id = ? AND claude_session_id IS NOT NULL'
      ).all(task.id) as Array<{ claude_session_id: string }>;
      for (const { claude_session_id } of records) {
        const sessionDir = path.join(currentProjectPath, '.kangentic', 'sessions', claude_session_id);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* may not exist */ }
      }
    }

    // Always delete DB records — this must succeed for task DELETE to pass FK check
    sessionRepo.deleteByTaskId(task.id);
  }
}

/**
 * Full cleanup: kill session, remove worktree + branch, wipe session records.
 *
 * Used by TASK_DELETE (permanent removal).
 */
async function cleanupTaskResources(
  task: { id: string; session_id: string | null; worktree_path: string | null; branch_name: string | null },
  tasks: TaskRepository,
): Promise<void> {
  await cleanupTaskSession(task, tasks);

  // Remove worktree + branch
  if (task.worktree_path && currentProjectPath) {
    try {
      const wm = new WorktreeManager(currentProjectPath);
      await wm.removeWorktree(task.worktree_path);
      if (task.branch_name) {
        const config = configManager.getEffectiveConfig(currentProjectPath);
        if (config.git.autoCleanup) {
          await wm.removeBranch(task.branch_name);
        }
      }
    } catch (err) {
      console.error(`Failed to clean up worktree for task ${task.id.slice(0, 8)}:`, err);
    }
    tasks.update({ id: task.id, worktree_path: null, branch_name: null });
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
export async function cleanupProject(projectId: string, projectPath: string): Promise<void> {
  // Guard: project path must exist
  if (!fs.existsSync(projectPath)) {
    console.warn(`[PROJECT_DELETE] Project path does not exist: ${projectPath} -- skipping filesystem cleanup`);
    closeProjectDb(projectId);
    const dbPath = PATHS.projectDb(projectId);
    try { fs.unlinkSync(dbPath); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* may not exist */ }
    if (currentProjectId === projectId) {
      currentProjectId = null;
      currentProjectPath = null;
    }
    return;
  }

  // 1. Kill all active PTY sessions belonging to this project's tasks
  let allTasks: any[] = [];
  try {
    const db = getProjectDb(projectId);
    const taskRepo = new TaskRepository(db);
    allTasks = taskRepo.list();
  } catch (err) {
    console.error('[PROJECT_DELETE] Failed to read tasks:', err);
  }

  for (const task of allTasks) {
    if (task.session_id) {
      try { sessionManager.remove(task.session_id); } catch { /* may already be dead */ }
    }
  }

  // 2. Cleanly detach git worktrees (keeps branches with user code intact)
  if (isGitRepo(projectPath)) {
    for (const task of allTasks) {
      if (task.worktree_path && fs.existsSync(task.worktree_path)) {
        try {
          const wm = new WorktreeManager(projectPath);
          await wm.removeWorktree(task.worktree_path);
        } catch (err) {
          console.error(`[PROJECT_DELETE] Failed to detach worktree for task ${task.id.slice(0, 8)}:`, err);
        }
      }
    }
  }

  // 3. Strip our hooks from .claude/settings.local.json (legacy cleanup —
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
  //    stripKangenticHooks deletes settings.local.json, but on Windows the file
  //    may still be pending delete when rmdirSync runs. Use rmSync with retries
  //    and only remove if no user files (CLAUDE.md, settings.json, etc.) exist.
  const claudeDir = path.join(projectPath, '.claude');
  try {
    const entries = fs.readdirSync(claudeDir);
    const isOnlyOurs = entries.every((e) => e === 'settings.local.json');
    if (entries.length === 0 || isOnlyOurs) {
      fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  } catch { /* may not exist or not readable — skip */ }

  // 5. Close the project DB connection before deleting files
  closeProjectDb(projectId);

  // Steps 6–7 modify the project's .gitignore and .kangentic/ directory.
  // Skip for worktrees — their .gitignore is inherited from the parent branch
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
  if (currentProjectId === projectId) {
    currentProjectId = null;
    currentProjectPath = null;
  }

  console.log(`[PROJECT_DELETE] Cleaned up project at ${projectPath}`);
}

/**
 * Delete a project record from the global index DB.
 */
export function deleteProjectFromIndex(id: string): void {
  projectRepo.delete(id);
}

/**
 * Prune all worktree-based preview projects from the global index.
 * Any project whose path contains `.kangentic/worktrees/` is ephemeral —
 * created by `/preview` and should not persist across app restarts.
 * Uses lightweight DB-only cleanup (no filesystem changes) so it's safe
 * even if the worktree is still in use by an active preview instance.
 */
export async function pruneStaleWorktreeProjects(): Promise<void> {
  const projects = projectRepo.list();
  for (const project of projects) {
    if (!isKangenticWorktree(project.path)) continue;

    console.log(`[PRUNE] Removing ephemeral preview project: ${project.name} (${project.path})`);

    // Lightweight cleanup: only delete DB records, not worktree filesystem.
    // The worktree directory belongs to the main project's tasks — don't touch it.
    closeProjectDb(project.id);
    const dbPath = PATHS.projectDb(project.id);
    try { fs.unlinkSync(dbPath); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* may not exist */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* may not exist */ }

    projectRepo.delete(project.id);
  }
}

export function registerAllIpc(mainWindow: BrowserWindow): void {
  // === Projects ===
  ipcMain.handle(IPC.PROJECT_LIST, () => projectRepo.list());

  ipcMain.handle(IPC.PROJECT_CREATE, (_, input) => {
    const project = projectRepo.create(input);
    // Initialize the project database (creates tables + default swimlanes)
    getProjectDb(project.id);
    return project;
  });

  ipcMain.handle(IPC.PROJECT_DELETE, async (_, id) => {
    const project = projectRepo.getById(id);
    if (project) {
      await cleanupProject(id, project.path);
    }
    projectRepo.delete(id);
  });

  ipcMain.handle(IPC.PROJECT_OPEN, async (_, id) => {
    const project = projectRepo.getById(id);
    if (!project) throw new Error(`Project ${id} not found`);

    // Skip full recovery if re-opening the same project (e.g. Vite hot-reload
    // causes the renderer to re-mount and call PROJECT_OPEN again).
    const isReopen = currentProjectId === id;

    currentProjectId = id;
    currentProjectPath = project.path;
    projectRepo.updateLastOpened(id);
    ensureGitignore(project.path);

    // Apply project config overrides (always — config may have changed)
    const config = configManager.getEffectiveConfig(project.path);
    sessionManager.setMaxConcurrent(config.claude.maxConcurrentSessions);
    sessionManager.setShell(config.terminal.shell);

    if (!isReopen) {
      // Prune tasks whose worktrees have been deleted externally
      const db = getProjectDb(id);
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      pruneOrphanedWorktrees(project.path, taskRepo, sessionRepo, sessionManager);

      // Recover any suspended/orphaned sessions, then reconcile missing ones
      await recoverSessions(id, project.path, sessionManager, claudeDetector, commandBuilder, configManager);
      await reconcileSessions(id, project.path, sessionManager, claudeDetector, commandBuilder, configManager);
    }
  });

  ipcMain.handle(IPC.PROJECT_GET_CURRENT, () => {
    if (!currentProjectId) return null;
    return projectRepo.getById(currentProjectId) || null;
  });

  ipcMain.handle(IPC.PROJECT_OPEN_BY_PATH, async (_, projectPath: string) => {
    return openProjectByPath(projectPath);
  });

  // === Tasks ===
  ipcMain.handle(IPC.TASK_LIST, (_, swimlaneId?) => {
    const { tasks } = getProjectRepos();
    return tasks.list(swimlaneId);
  });

  ipcMain.handle(IPC.TASK_CREATE, (_, input) => {
    const { tasks, attachments } = getProjectRepos();
    const { pendingAttachments, ...taskInput } = input;
    const task = tasks.create(taskInput);

    // Save any pending attachments from the dialog
    if (pendingAttachments?.length && currentProjectPath) {
      for (const att of pendingAttachments) {
        attachments.add(currentProjectPath, task.id, att.filename, att.data, att.media_type);
      }
    }

    return task;
  });

  ipcMain.handle(IPC.TASK_UPDATE, async (_, input) => {
    const { tasks } = getProjectRepos();
    const existing = tasks.getById(input.id);

    // If title changed and task has a worktree branch, try to rename the branch
    if (input.title && existing?.branch_name && existing?.worktree_path
        && input.title !== existing.title && currentProjectPath
        && !existing.pr_url) {
      // Guard: skip if the agent is actively thinking (git operations may be in flight)
      const taskSession = sessionManager.listSessions()
        .find(s => s.taskId === input.id && (s.status === 'running' || s.status === 'queued'));
      const activityCache = sessionManager.getActivityCache();
      const isThinking = taskSession && activityCache[taskSession.id] === 'thinking';

      if (isThinking) {
        console.log(`[TASK_UPDATE] Skipping branch rename -- task ${input.id.slice(0, 8)} agent is thinking`);
      } else if (!fs.existsSync(existing.worktree_path)) {
        console.log(`[TASK_UPDATE] Skipping branch rename -- worktree path missing: ${existing.worktree_path}`);
      } else {
        const wm = new WorktreeManager(currentProjectPath);
        const newBranchName = await wm.renameBranch(
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
    const { tasks, attachments } = getProjectRepos();
    const task = tasks.getById(id);
    if (task) {
      attachments.deleteByTaskId(id);
      await cleanupTaskResources(task, tasks);
    }
    tasks.delete(id);
  });

  /**
   * Core task-move logic shared by the TASK_MOVE IPC handler and the
   * plan-exit auto-move listener. Moves the task, runs transitions, and
   * manages session lifecycle based on the target column's role.
   */
  async function handleTaskMove(input: { taskId: string; targetSwimlaneId: string; targetPosition: number }): Promise<void> {
    const { tasks, actions, swimlanes, attachments } = getProjectRepos();
    const task = tasks.getById(input.taskId);
    if (!task) throw new Error(`Task ${input.taskId} not found`);

    const fromSwimlaneId = task.swimlane_id;
    const toLane = swimlanes.getById(input.targetSwimlaneId);

    // Move the task in the database
    tasks.move(input);

    // Within-column reorder — no side effects needed
    if (fromSwimlaneId === input.targetSwimlaneId) return;

    const db = getProjectDb(currentProjectId!);
    const sessionRepo = new SessionRepository(db);

    // --- Priority 1: TARGET IS BACKLOG → kill session, preserve worktree ---
    if (toLane?.role === 'backlog') {
      commandInjector.cancel(task.id);
      await cleanupTaskSession(task, tasks);
      console.log(`[TASK_MOVE] Killed session for task ${task.id.slice(0, 8)} (moved to Backlog, worktree preserved)`);
      return;
    }

    // --- Priority 2: TARGET IS DONE → suspend + archive (resumable on unarchive) ---
    if (toLane?.role === 'done') {
      commandInjector.cancel(task.id);
      if (task.session_id) {
        const record = sessionRepo.getLatestForTask(task.id);
        // Accept 'running' AND 'exited' — exited covers Claude natural exit
        if (record && record.claude_session_id
            && (record.status === 'running' || record.status === 'exited')) {
          sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString() });
          console.log(`[TASK_MOVE] Suspended session record ${record.id.slice(0, 8)} for task ${task.id.slice(0, 8)}`);
        }
        sessionManager.suspend(task.session_id);
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
      commandInjector.cancel(task.id);
      if (task.session_id) {
        const record = sessionRepo.getLatestForTask(task.id);
        if (record && record.claude_session_id
            && (record.status === 'running' || record.status === 'exited')) {
          sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString() });
        }
        sessionManager.suspend(task.session_id);
        tasks.update({ id: task.id, session_id: null });
        console.log(`[TASK_MOVE] Suspended session for task ${task.id.slice(0, 8)} (target column has auto_spawn=false)`);
      }
      return;
    }

    // --- Priority 3: TASK HAS ACTIVE SESSION → keep alive, skip transitions ---
    // If the agent is already running, moving between non-terminal columns
    // (e.g. Review → Running) should NOT kill and respawn — just let it continue.
    if (task.session_id) {
      commandInjector.cancel(task.id);
      if (toLane?.auto_command) {
        const vars = buildAutoCommandVars(task);
        const interpolated = commandBuilder.interpolateTemplate(toLane.auto_command, vars);
        commandInjector.schedule(task.id, task.session_id, interpolated, { freshlySpawned: false });
      }
      console.log(`[TASK_MOVE] Task ${task.id.slice(0, 8)} already has active session -- skipping transitions`);
      return;
    }

    // --- Priority 4: TASK HAS NO ACTIVE SESSION ---
    // Create worktree if worktrees are enabled and task doesn't have one yet.
    // Needed for agent-active columns AND non-agent columns that will spawn
    // a fresh session (e.g. Backlog → Review).
    await ensureTaskWorktree(task, tasks);

    // Execute transition actions (may fire spawn_agent which handles resume internally)
    const engine = createTransitionEngine(actions, tasks, sessionRepo, attachments);

    try {
      await engine.executeTransition(task, fromSwimlaneId, input.targetSwimlaneId, toLane?.permission_strategy);
    } catch (err) {
      console.error('Transition engine error:', err);
    }

    // Re-read task from DB — transition engine may have spawned a session
    let finalTask = tasks.getById(task.id);

    // If task STILL has no session, resume a suspended session or spawn fresh.
    // resumeSuspendedSession handles both cases internally via executeSpawnAgent.
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
      const interpolated = commandBuilder.interpolateTemplate(toLane.auto_command, vars);
      commandInjector.schedule(finalTask.id, finalTask.session_id, interpolated, { freshlySpawned: true });
    }
  }

  ipcMain.handle(IPC.TASK_MOVE, async (_, input) => handleTaskMove(input));

  ipcMain.handle(IPC.TASK_LIST_ARCHIVED, () => {
    const { tasks } = getProjectRepos();
    return tasks.listArchived();
  });

  ipcMain.handle(IPC.TASK_UNARCHIVE, async (_, input: { id: string; targetSwimlaneId: string }) => {
    const { tasks, swimlanes, actions, attachments: attachmentRepo } = getProjectRepos();

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
    await ensureTaskWorktree(task, tasks);

    // Execute transition actions (from Done → target) for ALL non-kill columns
    if (currentProjectPath) {
      const doneLane = swimlanes.list().find((l) => l.role === 'done');
      if (doneLane) {
        const db = getProjectDb(currentProjectId!);
        const sessionRepo = new SessionRepository(db);
        const engine = createTransitionEngine(actions, tasks, sessionRepo, attachmentRepo);

        try {
          await engine.executeTransition(task, doneLane.id, input.targetSwimlaneId, toLane?.permission_strategy);
        } catch (err) {
          console.error('Transition engine error during unarchive:', err);
        }

        // Re-read task; if still no session, resume suspended or spawn fresh.
        // resumeSuspendedSession handles both cases internally via executeSpawnAgent.
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
          const interpolated = commandBuilder.interpolateTemplate(toLane.auto_command, vars);
          commandInjector.schedule(finalTask.id, finalTask.session_id, interpolated, { freshlySpawned: true });
        }
      }
    }

    return tasks.getById(input.id);
  });

  // === Attachments ===
  ipcMain.handle(IPC.ATTACHMENT_LIST, (_, taskId: string) => {
    const { attachments } = getProjectRepos();
    return attachments.list(taskId);
  });

  ipcMain.handle(IPC.ATTACHMENT_ADD, (_, input: { task_id: string; filename: string; data: string; media_type: string }) => {
    if (!currentProjectPath) throw new Error('No project open');
    const maxSize = 10 * 1024 * 1024; // 10MB
    const dataSize = Buffer.byteLength(input.data, 'base64');
    if (dataSize > maxSize) throw new Error(`Attachment exceeds 10MB limit (${(dataSize / 1024 / 1024).toFixed(1)}MB)`);
    const { attachments } = getProjectRepos();
    return attachments.add(currentProjectPath, input.task_id, input.filename, input.data, input.media_type);
  });

  ipcMain.handle(IPC.ATTACHMENT_REMOVE, (_, id: string) => {
    const { attachments } = getProjectRepos();
    attachments.remove(id);
  });

  ipcMain.handle(IPC.ATTACHMENT_GET_DATA_URL, (_, id: string) => {
    const { attachments } = getProjectRepos();
    return attachments.getDataUrl(id);
  });

  // === Swimlanes ===
  ipcMain.handle(IPC.SWIMLANE_LIST, () => {
    const { swimlanes } = getProjectRepos();
    return swimlanes.list();
  });

  ipcMain.handle(IPC.SWIMLANE_CREATE, (_, input) => {
    const { swimlanes } = getProjectRepos();
    return swimlanes.create(input);
  });

  ipcMain.handle(IPC.SWIMLANE_UPDATE, (_, input) => {
    const { swimlanes } = getProjectRepos();
    return swimlanes.update(input);
  });

  ipcMain.handle(IPC.SWIMLANE_DELETE, (_, id) => {
    const { swimlanes } = getProjectRepos();
    swimlanes.delete(id);
  });

  ipcMain.handle(IPC.SWIMLANE_REORDER, (_, ids) => {
    const { swimlanes } = getProjectRepos();
    swimlanes.reorder(ids);
  });

  // === Actions ===
  ipcMain.handle(IPC.ACTION_LIST, () => {
    const { actions } = getProjectRepos();
    return actions.list();
  });

  ipcMain.handle(IPC.ACTION_CREATE, (_, input) => {
    const { actions } = getProjectRepos();
    return actions.create(input);
  });

  ipcMain.handle(IPC.ACTION_UPDATE, (_, input) => {
    const { actions } = getProjectRepos();
    return actions.update(input);
  });

  ipcMain.handle(IPC.ACTION_DELETE, (_, id) => {
    const { actions } = getProjectRepos();
    actions.delete(id);
  });

  // === Transitions ===
  ipcMain.handle(IPC.TRANSITION_LIST, () => {
    const { actions } = getProjectRepos();
    return actions.listTransitions();
  });

  ipcMain.handle(IPC.TRANSITION_SET, (_, fromId, toId, actionIds) => {
    const { actions } = getProjectRepos();
    actions.setTransitions(fromId, toId, actionIds);
  });

  ipcMain.handle(IPC.TRANSITION_GET_FOR, (_, fromId, toId) => {
    const { actions } = getProjectRepos();
    return actions.getTransitionsFor(fromId, toId);
  });

  // === Sessions ===
  ipcMain.handle(IPC.SESSION_SPAWN, (_, input) => {
    if (!currentProjectId) throw new Error('Cannot spawn session: no project is currently open');
    return sessionManager.spawn({ ...input, projectId: currentProjectId });
  });
  ipcMain.handle(IPC.SESSION_KILL, (_, id) => sessionManager.kill(id));
  ipcMain.handle(IPC.SESSION_WRITE, (_, id, data) => sessionManager.write(id, data));
  ipcMain.handle(IPC.SESSION_RESIZE, (_, id, cols, rows) => sessionManager.resize(id, cols, rows));
  ipcMain.handle(IPC.SESSION_LIST, () => sessionManager.listSessions());
  ipcMain.handle(IPC.SESSION_GET_SCROLLBACK, (_, id) => sessionManager.getScrollback(id));
  ipcMain.handle(IPC.SESSION_GET_USAGE, (_, projectId?: string) =>
    projectId ? sessionManager.getUsageCacheForProject(projectId) : sessionManager.getUsageCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY, (_, projectId?: string) =>
    projectId ? sessionManager.getActivityCacheForProject(projectId) : sessionManager.getActivityCache());
  ipcMain.handle(IPC.SESSION_GET_EVENTS, (_, sessionId: string) => sessionManager.getEventsForSession(sessionId));
  ipcMain.handle(IPC.SESSION_GET_EVENTS_CACHE, (_, projectId?: string) =>
    projectId ? sessionManager.getEventsCacheForProject(projectId) : sessionManager.getEventsCache());

  // === Session Suspend / Resume ===
  ipcMain.handle(IPC.SESSION_SUSPEND, async (_, taskId: string) => {
    const { tasks } = getProjectRepos();
    const task = tasks.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (!task.session_id) return; // nothing to suspend

    const db = getProjectDb(currentProjectId!);
    const sessionRepo = new SessionRepository(db);

    // Mark session record as suspended in DB
    const record = sessionRepo.getLatestForTask(task.id);
    if (record && record.claude_session_id
        && (record.status === 'running' || record.status === 'exited')) {
      sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString() });
    }

    // Kill PTY but preserve session files
    sessionManager.suspend(task.session_id);

    // Clear task's active session reference
    tasks.update({ id: task.id, session_id: null });
  });

  ipcMain.handle(IPC.SESSION_RESUME, async (_, taskId: string) => {
    const { tasks, actions, swimlanes, attachments: attachmentRepo } = getProjectRepos();
    const task = tasks.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Guard: don't resume if already has an active session
    if (task.session_id) throw new Error(`Task ${taskId} already has an active session`);

    const lane = swimlanes.getById(task.swimlane_id);

    // Create worktree if needed
    await ensureTaskWorktree(task, tasks);

    const db = getProjectDb(currentProjectId!);
    const sessionRepo = new SessionRepository(db);
    const engine = createTransitionEngine(actions, tasks, sessionRepo, attachmentRepo);

    await engine.resumeSuspendedSession(task, lane?.permission_strategy);

    // Re-read task to get the new session_id
    const updated = tasks.getById(taskId);
    if (!updated?.session_id) throw new Error('Session resume failed — no session_id on task');

    // Return the new session object
    const newSession = sessionManager.getSession(updated.session_id);
    if (!newSession) throw new Error('Session resume failed — session not in manager');
    return newSession;
  });

  // Forward PTY events to renderer (guard against destroyed window during shutdown)
  // Each event includes the session's projectId so the renderer can filter by project.
  sessionManager.on('data', (sessionId: string, data: string) => {
    if (!mainWindow.isDestroyed()) {
      const projectId = sessionManager.getSessionProjectId(sessionId);
      mainWindow.webContents.send(IPC.SESSION_DATA, sessionId, data, projectId);
    }
  });

  sessionManager.on('usage', (sessionId: string, data: unknown) => {
    if (!mainWindow.isDestroyed()) {
      const projectId = sessionManager.getSessionProjectId(sessionId);
      mainWindow.webContents.send(IPC.SESSION_USAGE, sessionId, data, projectId);
    }
  });

  sessionManager.on('activity', (sessionId: string, state: string) => {
    if (!mainWindow.isDestroyed()) {
      const projectId = sessionManager.getSessionProjectId(sessionId);
      mainWindow.webContents.send(IPC.SESSION_ACTIVITY, sessionId, state, projectId);
    }
  });

  sessionManager.on('event', (sessionId: string, event: unknown) => {
    if (!mainWindow.isDestroyed()) {
      const projectId = sessionManager.getSessionProjectId(sessionId);
      mainWindow.webContents.send(IPC.SESSION_EVENT, sessionId, event, projectId);
    }
  });

  sessionManager.on('status', (sessionId: string, status: string) => {
    if (!mainWindow.isDestroyed()) {
      const projectId = sessionManager.getSessionProjectId(sessionId);
      mainWindow.webContents.send(IPC.SESSION_STATUS, sessionId, status, projectId);
    }
  });

  sessionManager.on('exit', (sessionId: string, exitCode: number) => {
    if (!mainWindow.isDestroyed()) {
      const projectId = sessionManager.getSessionProjectId(sessionId);
      mainWindow.webContents.send(IPC.SESSION_EXIT, sessionId, exitCode, projectId);
    }

    // Persist exit status to session DB
    if (currentProjectId) {
      try {
        const db = getProjectDb(currentProjectId);
        const sessionRepo = new SessionRepository(db);
        // Look up by task ID from the in-memory session.
        // Only mark 'running' records as 'exited' — never overwrite
        // 'suspended' status, which is set by TASK_MOVE before the
        // async onExit fires and is needed for resume on re-entry.
        let updated = false;
        const session = sessionManager.getSession(sessionId);
        if (session) {
          const record = sessionRepo.getLatestForTask(session.taskId);
          if (record && record.status === 'running') {
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
            `SELECT id FROM sessions WHERE claude_session_id = ? AND status = 'running' LIMIT 1`
          ).get(sessionId) as { id: string } | undefined;
          if (byClaudeId) {
            sessionRepo.updateStatus(byClaudeId.id, 'exited', {
              exit_code: exitCode,
              exited_at: new Date().toISOString(),
            });
          }
        }
      } catch {
        // DB may be closed during shutdown
      }
    }
  });

  // Auto-move task when agent exits plan mode (ExitPlanMode tool)
  sessionManager.on('plan-exit', async (sessionId: string) => {
    if (!currentProjectId) return;
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session) return;

      const { tasks, swimlanes } = getProjectRepos();
      const task = tasks.getBySessionId(sessionId);
      if (!task) return;

      const lane = swimlanes.getById(task.swimlane_id);
      if (!lane?.plan_exit_target_id) return;

      const target = swimlanes.getById(lane.plan_exit_target_id);
      if (!target) return;

      const pos = tasks.list(target.id).length;
      await handleTaskMove({ taskId: task.id, targetSwimlaneId: target.id, targetPosition: pos });

      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.TASK_AUTO_MOVED, task.id, target.id, task.title);
      }
      console.log(`[plan-exit] Auto-moved "${task.title}" -> "${target.name}"`);
    } catch (err) {
      console.error('[plan-exit] Auto-move failed:', err);
    }
  });

  // === Config ===
  ipcMain.handle(IPC.CONFIG_GET, () => configManager.getEffectiveConfig(currentProjectPath || undefined));
  ipcMain.handle(IPC.CONFIG_GET_GLOBAL, () => configManager.load());

  ipcMain.handle(IPC.CONFIG_SET, (_, config) => {
    configManager.save(config);
    // Apply runtime changes
    const effective = configManager.getEffectiveConfig(currentProjectPath || undefined);
    sessionManager.setMaxConcurrent(effective.claude.maxConcurrentSessions);
    sessionManager.setShell(effective.terminal.shell);
  });

  ipcMain.handle(IPC.CONFIG_GET_PROJECT, () => {
    if (!currentProjectPath) return null;
    return configManager.loadProjectOverrides(currentProjectPath);
  });

  ipcMain.handle(IPC.CONFIG_SET_PROJECT, (_, overrides) => {
    if (!currentProjectPath) throw new Error('No project open');
    configManager.saveProjectOverrides(currentProjectPath, overrides);
  });

  ipcMain.handle(IPC.CONFIG_GET_PROJECT_BY_PATH, (_, projectPath: string) => {
    const known = projectRepo.list().some((p) => p.path === projectPath);
    if (!known) throw new Error('Unknown project path');
    return configManager.loadProjectOverrides(projectPath);
  });

  ipcMain.handle(IPC.CONFIG_SET_PROJECT_BY_PATH, (_, projectPath: string, overrides) => {
    const known = projectRepo.list().some((p) => p.path === projectPath);
    if (!known) throw new Error('Unknown project path');
    configManager.saveProjectOverrides(projectPath, overrides);
  });

  // === Claude ===
  ipcMain.handle(IPC.CLAUDE_DETECT, () => {
    const config = configManager.load();
    return claudeDetector.detect(config.claude.cliPath);
  });

  // === Shell ===
  ipcMain.handle(IPC.SHELL_GET_AVAILABLE, () => shellResolver.getAvailableShells());
  ipcMain.handle(IPC.SHELL_GET_DEFAULT, () => shellResolver.getDefaultShell());
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_, dirPath: string) => shell.openPath(dirPath));
  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, (_, url: string) => shell.openExternal(url));

  // === Git ===
  ipcMain.handle(IPC.GIT_LIST_BRANCHES, async () => {
    if (!currentProjectPath || !isGitRepo(currentProjectPath)) return [];
    try {
      const wm = new WorktreeManager(currentProjectPath);
      return await wm.listRemoteBranches();
    } catch { return []; }
  });

  // === Dialog ===
  ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // === Window ===
  ipcMain.on(IPC.WINDOW_MINIMIZE, () => mainWindow.minimize());
  ipcMain.on(IPC.WINDOW_MAXIMIZE, () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.on(IPC.WINDOW_CLOSE, () => mainWindow.close());
  ipcMain.on(IPC.WINDOW_FLASH_FRAME, (_event, flash: boolean) => mainWindow.flashFrame(flash));
}

/**
 * Activate all projects on startup: run session recovery/reconciliation
 * for every project so agent sessions start immediately, not just when
 * the user navigates to a project board.
 */
export async function activateAllProjects(): Promise<void> {
  const config = configManager.load();
  if (!config.activateAllProjectsOnStartup) return;

  const projects = projectRepo.list();
  for (const project of projects) {
    // Skip the currently active project — it already ran recovery via PROJECT_OPEN
    if (project.id === currentProjectId) continue;

    try {
      ensureGitignore(project.path);
      const db = getProjectDb(project.id);
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      pruneOrphanedWorktrees(project.path, taskRepo, sessionRepo, sessionManager);
      await recoverSessions(project.id, project.path, sessionManager, claudeDetector, commandBuilder, configManager);
      await reconcileSessions(project.id, project.path, sessionManager, claudeDetector, commandBuilder, configManager);
    } catch (err) {
      console.error(`Failed to activate project ${project.name}:`, err);
    }
  }
}

export function getSessionManager(): SessionManager {
  return sessionManager;
}

export function getCommandInjector(): CommandInjector {
  return commandInjector;
}

export function getCurrentProjectId(): string | null {
  return currentProjectId;
}

/**
 * Find an existing project by path, or create one and open it.
 * Returns the project object.
 *
 * Awaits session recovery and reconciliation so that by the time the
 * caller uses the returned project, any tasks sitting in agent columns
 * already have live PTY sessions.
 */
export async function openProjectByPath(projectPath: string) {
  // Normalize the path for comparison
  const normalized = path.resolve(projectPath);

  // Check if a project with this path already exists
  const projects = projectRepo.list();
  let project = projects.find((p: any) => path.resolve(p.path) === normalized);

  if (!project) {
    // Create a new project using the directory name
    const name = path.basename(normalized);
    project = projectRepo.create({ name, path: normalized });
    // Initialize the project database (creates tables + default swimlanes)
    getProjectDb(project.id);
  }

  // Skip full recovery if re-opening the same project
  const isReopen = currentProjectId === project.id;

  // Open the project
  currentProjectId = project.id;
  currentProjectPath = project.path;
  projectRepo.updateLastOpened(project.id);
  ensureGitignore(project.path);

  const config = configManager.getEffectiveConfig(project.path);
  sessionManager.setMaxConcurrent(config.claude.maxConcurrentSessions);
  sessionManager.setShell(config.terminal.shell);

  if (!isReopen) {
    // Prune tasks whose worktrees have been deleted externally
    const db = getProjectDb(project.id);
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    pruneOrphanedWorktrees(project.path, taskRepo, sessionRepo, sessionManager);

    // Recover suspended/orphaned sessions, then reconcile missing ones
    await recoverSessions(project.id, project.path, sessionManager, claudeDetector, commandBuilder, configManager);
    await reconcileSessions(project.id, project.path, sessionManager, claudeDetector, commandBuilder, configManager);
  }

  return project;
}

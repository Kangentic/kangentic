import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type Database from 'better-sqlite3';
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
import { WorktreeManager } from '../git/worktree-manager';
import { stripActivityHooks } from '../agent/hook-manager';
import { getProjectDb, closeProjectDb } from '../db/database';
import { PATHS } from '../config/paths';
import type { AppConfig } from '../../shared/types';

/**
 * Resolve the base branch for worktree creation: task override > config default > 'main'.
 */
function resolveBaseBranch(task: { base_branch?: string | null }, config: AppConfig): string {
  return task.base_branch || config.git.defaultBaseBranch || 'main';
}

/**
 * Ensure `.kangentic/` and `.claude/settings.local.json` are listed in the
 * project's `.gitignore`.  Fully wrapped in try-catch — a read-only project
 * directory or permission issue must never prevent the app from opening.
 */
function ensureGitignore(projectPath: string): void {
  if (!WorktreeManager.isGitRepo(projectPath)) return;
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

    // 2. Ensure .claude/settings.local.json is ignored
    const linesAfter = content.split('\n');
    const settingsIgnored = linesAfter.some(
      (l) => l.trim() === '.claude/settings.local.json',
    );
    if (!settingsIgnored) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(gitignorePath, content + separator + '.claude/settings.local.json\n');
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
    try { sessionManager.kill(task.session_id); } catch { /* may already be dead */ }
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
    console.warn(`[PROJECT_DELETE] Project path does not exist: ${projectPath} — skipping filesystem cleanup`);
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
  if (WorktreeManager.isGitRepo(projectPath)) {
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

  // 3. Strip our activity-bridge hooks from .claude/settings.local.json
  //    (project root and any worktree dirs that may still exist)
  stripActivityHooks(projectPath);
  const worktreesDir = path.join(projectPath, '.kangentic', 'worktrees');
  if (fs.existsSync(worktreesDir)) {
    try {
      for (const entry of fs.readdirSync(worktreesDir)) {
        stripActivityHooks(path.join(worktreesDir, entry));
      }
    } catch { /* best effort */ }
  }

  // 4. Remove empty .claude/ directory if it only contained our hooks file.
  //    stripActivityHooks deletes settings.local.json, but on Windows the file
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

  // 6. Remove our `.kangentic/` entry from .gitignore (delete file if it becomes empty)
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

  // 7. Remove .kangentic/ directory (ours entirely)
  const kangenticDir = path.join(projectPath, '.kangentic');
  if (fs.existsSync(kangenticDir)) {
    try {
      fs.rmSync(kangenticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (err) {
      console.error(`[PROJECT_DELETE] Failed to remove ${kangenticDir}:`, err);
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
 * Prune stale worktree-based projects whose paths no longer exist on disk.
 * Catches leftovers from crashed/force-killed preview instances.
 */
export async function pruneStaleWorktreeProjects(): Promise<void> {
  const projects = projectRepo.list();
  for (const project of projects) {
    const normalized = project.path.replace(/\\/g, '/');
    if (!normalized.includes('.kangentic/worktrees/')) continue;
    if (fs.existsSync(project.path)) continue;

    console.log(`[PRUNE] Removing stale worktree project: ${project.name} (${project.path})`);
    await cleanupProject(project.id, project.path);
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
        console.log(`[TASK_UPDATE] Skipping branch rename — task ${input.id.slice(0, 8)} agent is thinking`);
      } else if (!fs.existsSync(existing.worktree_path)) {
        console.log(`[TASK_UPDATE] Skipping branch rename — worktree path missing: ${existing.worktree_path}`);
      } else {
        const wm = new WorktreeManager(currentProjectPath);
        const newBranchName = await wm.renameBranch(
          input.id, existing.branch_name, input.title,
        );
        if (newBranchName) {
          console.log(`[TASK_UPDATE] Branch renamed: ${existing.branch_name} → ${newBranchName}`);
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

  ipcMain.handle(IPC.TASK_MOVE, async (_, input) => {
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
      await cleanupTaskSession(task, tasks);
      console.log(`[TASK_MOVE] Killed session for task ${task.id.slice(0, 8)} (moved to Backlog, worktree preserved)`);
      return;
    }

    // --- Priority 2: TARGET IS DONE → suspend + archive (resumable on unarchive) ---
    if (toLane?.role === 'done') {
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

    // --- Priority 3: TASK HAS ACTIVE SESSION → keep alive, skip transitions ---
    // If the agent is already running, moving between non-terminal columns
    // (e.g. Review → Running) should NOT kill and respawn — just let it continue.
    if (task.session_id) {
      console.log(`[TASK_MOVE] Task ${task.id.slice(0, 8)} already has active session — skipping transitions`);
      return;
    }

    // --- Priority 4: TASK HAS NO ACTIVE SESSION ---
    // Create worktree if worktrees are enabled and task doesn't have one yet.
    // Needed for agent-active columns AND non-agent columns that will spawn
    // a fresh session (e.g. Backlog → Review).
    if (!task.worktree_path && currentProjectPath) {
      const config = configManager.getEffectiveConfig(currentProjectPath);
      if (config.git.worktreesEnabled && WorktreeManager.isGitRepo(currentProjectPath) && !WorktreeManager.isInsideWorktree(currentProjectPath)) {
        try {
          const wm = new WorktreeManager(currentProjectPath);
          const { worktreePath, branchName } = await wm.createWorktree(
            task.id, task.title, resolveBaseBranch(task, config), config.git.copyFiles,
          );
          tasks.update({ id: task.id, worktree_path: worktreePath, branch_name: branchName });
          const updated = tasks.getById(task.id);
          if (updated) Object.assign(task, updated);
        } catch (err) {
          console.error('Worktree creation failed:', err);
        }
      }
    }

    // Execute transition actions (may fire spawn_agent which handles resume internally)
    const engine = new TransitionEngine(
      sessionManager, actions, tasks, claudeDetector, commandBuilder,
      () => {
        const config = configManager.getEffectiveConfig(currentProjectPath || undefined);
        return {
          permissionMode: config.claude.permissionMode,
          claudePath: config.claude.cliPath,
          projectPath: currentProjectPath,
          gitConfig: config.git,
        };
      },
      sessionRepo,
      attachments,
    );

    try {
      await engine.executeTransition(task, fromSwimlaneId, input.targetSwimlaneId);
    } catch (err) {
      console.error('Transition engine error:', err);
    }

    // Re-read task from DB — transition engine may have spawned a session
    const updatedTask = tasks.getById(task.id);

    // If task STILL has no session, resume a suspended session or spawn fresh.
    // resumeSuspendedSession handles both cases internally via executeSpawnAgent.
    if (updatedTask && !updatedTask.session_id) {
      console.log(`[TASK_MOVE] Ensuring agent for task ${task.id.slice(0, 8)}`);
      try {
        await engine.resumeSuspendedSession(updatedTask);
      } catch (err) {
        console.error('Failed to start session:', err);
      }
    }
  });

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

    // Guard: don't resume if target is Backlog (shouldn't happen, but safe)
    if (toLane?.role === 'backlog') {
      return tasks.getById(input.id);
    }

    // Create worktree if needed (any non-backlog column gets an agent)
    if (!task.worktree_path && currentProjectPath) {
      const config = configManager.getEffectiveConfig(currentProjectPath);
      if (config.git.worktreesEnabled && WorktreeManager.isGitRepo(currentProjectPath) && !WorktreeManager.isInsideWorktree(currentProjectPath)) {
        try {
          const wm = new WorktreeManager(currentProjectPath);
          const { worktreePath, branchName } = await wm.createWorktree(
            task.id, task.title, resolveBaseBranch(task, config), config.git.copyFiles,
          );
          tasks.update({ id: task.id, worktree_path: worktreePath, branch_name: branchName });
          Object.assign(task, tasks.getById(task.id));
        } catch (err) {
          console.error('Worktree creation failed during unarchive:', err);
        }
      }
    }

    // Execute transition actions (from Done → target) for ALL non-kill columns
    if (currentProjectPath) {
      const doneLane = swimlanes.list().find((l) => l.role === 'done');
      if (doneLane) {
        const db = getProjectDb(currentProjectId!);
        const sessionRepo = new SessionRepository(db);
        const engine = new TransitionEngine(
          sessionManager, actions, tasks, claudeDetector, commandBuilder,
          () => {
            const config = configManager.getEffectiveConfig(currentProjectPath || undefined);
            return {
              permissionMode: config.claude.permissionMode,
              claudePath: config.claude.cliPath,
              projectPath: currentProjectPath,
              gitConfig: config.git,
            };
          },
          sessionRepo,
          attachmentRepo,
        );

        try {
          await engine.executeTransition(task, doneLane.id, input.targetSwimlaneId);
        } catch (err) {
          console.error('Transition engine error during unarchive:', err);
        }

        // Re-read task; if still no session, resume suspended or spawn fresh.
        // resumeSuspendedSession handles both cases internally via executeSpawnAgent.
        const updatedTask = tasks.getById(task.id);
        if (updatedTask && !updatedTask.session_id) {
          console.log(`[TASK_UNARCHIVE] Ensuring agent for task ${task.id.slice(0, 8)}`);
          try {
            await engine.resumeSuspendedSession(updatedTask);
          } catch (err) {
            console.error('Failed to start session during unarchive:', err);
          }
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
  ipcMain.handle(IPC.SESSION_SPAWN, (_, input) => sessionManager.spawn(input));
  ipcMain.handle(IPC.SESSION_KILL, (_, id) => sessionManager.kill(id));
  ipcMain.handle(IPC.SESSION_WRITE, (_, id, data) => sessionManager.write(id, data));
  ipcMain.handle(IPC.SESSION_RESIZE, (_, id, cols, rows) => sessionManager.resize(id, cols, rows));
  ipcMain.handle(IPC.SESSION_LIST, () => sessionManager.listSessions());
  ipcMain.handle(IPC.SESSION_GET_SCROLLBACK, (_, id) => sessionManager.getScrollback(id));
  ipcMain.handle(IPC.SESSION_GET_USAGE, () => sessionManager.getUsageCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY, () => sessionManager.getActivityCache());
  ipcMain.handle(IPC.SESSION_GET_EVENTS, (_, sessionId: string) => sessionManager.getEventsForSession(sessionId));

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
    const { tasks, actions, attachments: attachmentRepo } = getProjectRepos();
    const task = tasks.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Guard: don't resume if already has an active session
    if (task.session_id) throw new Error(`Task ${taskId} already has an active session`);

    // Create worktree if needed
    if (!task.worktree_path && currentProjectPath) {
      const config = configManager.getEffectiveConfig(currentProjectPath);
      if (config.git.worktreesEnabled && WorktreeManager.isGitRepo(currentProjectPath) && !WorktreeManager.isInsideWorktree(currentProjectPath)) {
        try {
          const wm = new WorktreeManager(currentProjectPath);
          const { worktreePath, branchName } = await wm.createWorktree(
            task.id, task.title, resolveBaseBranch(task, config), config.git.copyFiles,
          );
          tasks.update({ id: task.id, worktree_path: worktreePath, branch_name: branchName });
          Object.assign(task, tasks.getById(task.id));
        } catch (err) {
          console.error('Worktree creation failed during session resume:', err);
        }
      }
    }

    const db = getProjectDb(currentProjectId!);
    const sessionRepo = new SessionRepository(db);

    const engine = new TransitionEngine(
      sessionManager, actions, tasks, claudeDetector, commandBuilder,
      () => {
        const config = configManager.getEffectiveConfig(currentProjectPath || undefined);
        return {
          permissionMode: config.claude.permissionMode,
          claudePath: config.claude.cliPath,
          projectPath: currentProjectPath,
          gitConfig: config.git,
        };
      },
      sessionRepo,
      attachmentRepo,
    );

    await engine.resumeSuspendedSession(task);

    // Re-read task to get the new session_id
    const updated = tasks.getById(taskId);
    if (!updated?.session_id) throw new Error('Session resume failed — no session_id on task');

    // Return the new session object
    const newSession = sessionManager.getSession(updated.session_id);
    if (!newSession) throw new Error('Session resume failed — session not in manager');
    return newSession;
  });

  // Forward PTY events to renderer (guard against destroyed window during shutdown)
  sessionManager.on('data', (sessionId: string, data: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SESSION_DATA, sessionId, data);
    }
  });

  sessionManager.on('usage', (sessionId: string, data: any) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SESSION_USAGE, sessionId, data);
    }
  });

  sessionManager.on('activity', (sessionId: string, state: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SESSION_ACTIVITY, sessionId, state);
    }
  });

  sessionManager.on('event', (sessionId: string, event: any) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SESSION_EVENT, sessionId, event);
    }
  });

  sessionManager.on('exit', (sessionId: string, exitCode: number) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SESSION_EXIT, sessionId, exitCode);
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

  // === Config ===
  ipcMain.handle(IPC.CONFIG_GET, () => configManager.load());

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

  // === Claude ===
  ipcMain.handle(IPC.CLAUDE_DETECT, () => {
    const config = configManager.load();
    return claudeDetector.detect(config.claude.cliPath);
  });

  // === Shell ===
  ipcMain.handle(IPC.SHELL_GET_AVAILABLE, () => shellResolver.getAvailableShells());
  ipcMain.handle(IPC.SHELL_GET_DEFAULT, () => shellResolver.getDefaultShell());
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_, dirPath: string) => shell.openPath(dirPath));

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
}

export function getSessionManager(): SessionManager {
  return sessionManager;
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

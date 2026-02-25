import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, BrowserWindow, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type Database from 'better-sqlite3';
import { ProjectRepository } from '../db/repositories/project-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { SkillRepository } from '../db/repositories/skill-repository';
import { SessionManager } from '../pty/session-manager';
import { ConfigManager } from '../config/config-manager';
import { ClaudeDetector } from '../agent/claude-detector';
import { ShellResolver } from '../pty/shell-resolver';
import { TransitionEngine } from '../engine/transition-engine';
import { CommandBuilder } from '../agent/command-builder';
import { SessionRepository } from '../db/repositories/session-repository';
import { recoverSessions, reconcileSessions, pruneOrphanedWorktrees } from '../engine/session-recovery';
import { WorktreeManager } from '../git/worktree-manager';
import { getProjectDb } from '../db/database';

/**
 * Ensure `.kangentic/` is listed in the project's `.gitignore`.
 * Fully wrapped in try-catch — a read-only project directory or
 * permission issue must never prevent the app from opening.
 */
function ensureGitignore(projectPath: string): void {
  try {
    const gitignorePath = path.join(projectPath, '.gitignore');
    let content = '';
    try {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    } catch {
      // No .gitignore yet — we'll create one
    }

    const lines = content.split('\n');
    const alreadyIgnored = lines.some(
      (l) => l.trim() === '.kangentic' || l.trim() === '.kangentic/',
    );
    if (alreadyIgnored) return;

    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, content + separator + '.kangentic/\n');
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

function getProjectRepos(): { tasks: TaskRepository; swimlanes: SwimlaneRepository; skills: SkillRepository } {
  if (!currentProjectId) throw new Error('No project is currently open');
  const db = getProjectDb(currentProjectId);
  return {
    tasks: new TaskRepository(db),
    swimlanes: new SwimlaneRepository(db),
    skills: new SkillRepository(db),
  };
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

  ipcMain.handle(IPC.PROJECT_DELETE, (_, id) => projectRepo.delete(id));

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
    const { tasks } = getProjectRepos();
    return tasks.create(input);
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
    const { tasks } = getProjectRepos();
    const task = tasks.getById(id);

    // Kill any active PTY session before deleting DB records
    if (task?.session_id) {
      try {
        sessionManager.kill(task.session_id);
      } catch (err) {
        console.error('Failed to kill session during task delete:', err);
      }
    }

    // Clean up worktree and branch if present
    if (task?.worktree_path && currentProjectPath) {
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
        console.error('Failed to clean up worktree during task delete:', err);
      }
    }

    // Clean up session directories from disk before deleting DB records
    const db = getProjectDb(currentProjectId!);
    const sessionRepo = new SessionRepository(db);

    if (currentProjectPath) {
      const records = db.prepare(
        `SELECT claude_session_id FROM sessions WHERE task_id = ? AND claude_session_id IS NOT NULL`
      ).all(id) as Array<{ claude_session_id: string }>;
      for (const { claude_session_id } of records) {
        const sessionDir = path.join(currentProjectPath, '.kangentic', 'sessions', claude_session_id);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* may not exist */ }
      }
    }

    // Delete session DB records before the task to avoid FK constraint errors
    sessionRepo.deleteByTaskId(id);

    tasks.delete(id);
  });

  ipcMain.handle(IPC.TASK_MOVE, async (_, input) => {
    const { tasks, skills, swimlanes } = getProjectRepos();
    const task = tasks.getById(input.taskId);
    if (!task) throw new Error(`Task ${input.taskId} not found`);

    const fromSwimlaneId = task.swimlane_id;
    const toLane = swimlanes.getById(input.targetSwimlaneId);
    const agentLaneIds = skills.getAgentSwimlaneIds();
    const toIsActive = agentLaneIds.has(input.targetSwimlaneId);

    // Move the task in the database
    tasks.move(input);

    const db = getProjectDb(currentProjectId!);
    const sessionRepo = new SessionRepository(db);

    // --- Priority 1: TARGET IS BACKLOG → full kill (no future resume) ---
    if (toLane?.role === 'backlog') {
      if (task.session_id) {
        const record = sessionRepo.getLatestForTask(task.id);
        if (record && record.status === 'running') {
          sessionRepo.updateStatus(record.id, 'exited', { exited_at: new Date().toISOString() });
        }
        sessionManager.kill(task.session_id);
        tasks.update({ id: task.id, session_id: null });
        console.log(`[TASK_MOVE] Killed session for task ${task.id.slice(0, 8)} (moved to Backlog)`);
      }
      return;
    }

    // --- Priority 2: TARGET IS DONE → suspend + archive (resumable on unarchive) ---
    if (toLane?.role === 'done') {
      if (task.session_id) {
        const record = sessionRepo.getLatestForTask(task.id);
        if (record && record.status === 'running') {
          sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString() });
          console.log(`[TASK_MOVE] Suspended session record ${record.id.slice(0, 8)} for task ${task.id.slice(0, 8)}`);
        }
        sessionManager.suspend(task.session_id);
        tasks.update({ id: task.id, session_id: null });
      }
      tasks.archive(input.taskId);
      console.log(`[TASK_MOVE] Auto-archived task ${input.taskId.slice(0, 8)} (moved to Done)`);
      return;
    }

    // --- Priority 3: TASK HAS ACTIVE SESSION → keep alive ---
    if (task.session_id) {
      const engine = new TransitionEngine(
        sessionManager, skills, tasks, claudeDetector, commandBuilder,
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
      );
      try {
        await engine.executeTransition(task, fromSwimlaneId, input.targetSwimlaneId);
      } catch (err) {
        console.error('Transition engine error:', err);
      }
      return;
    }

    // --- Priority 4: TASK HAS NO ACTIVE SESSION ---
    // Create worktree if worktrees are enabled and task doesn't have one yet.
    // Needed for agent-active columns AND non-agent columns that will spawn
    // a fresh session (e.g. Backlog → Review).
    if (!task.worktree_path && currentProjectPath) {
      const config = configManager.getEffectiveConfig(currentProjectPath);
      if (config.git.worktreesEnabled) {
        try {
          const wm = new WorktreeManager(currentProjectPath);
          const { worktreePath, branchName } = await wm.createWorktree(
            task.id, task.title, config.git.defaultBaseBranch, config.git.copyFiles,
          );
          tasks.update({ id: task.id, worktree_path: worktreePath, branch_name: branchName });
          const updated = tasks.getById(task.id);
          if (updated) Object.assign(task, updated);
        } catch (err) {
          console.error('Worktree creation failed:', err);
        }
      }
    }

    // Execute transition skills (may fire spawn_agent which handles resume internally)
    const engine = new TransitionEngine(
      sessionManager, skills, tasks, claudeDetector, commandBuilder,
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
    );

    try {
      await engine.executeTransition(task, fromSwimlaneId, input.targetSwimlaneId);
    } catch (err) {
      console.error('Transition engine error:', err);
    }

    // Re-read task from DB — transition engine may have spawned a session
    const updatedTask = tasks.getById(task.id);

    // If task STILL has no session, try to resume a suspended session or spawn fresh
    if (updatedTask && !updatedTask.session_id) {
      const previousSession = sessionRepo.getLatestForTask(task.id);
      if (
        previousSession
        && previousSession.claude_session_id
        && previousSession.session_type === 'claude_agent'
        && previousSession.status === 'suspended'
      ) {
        // Suspended session exists — resume it
        console.log(`[TASK_MOVE] Auto-resuming suspended session for task ${task.id.slice(0, 8)}`);
        try {
          await engine.resumeSuspendedSession(updatedTask);
        } catch (err) {
          console.error('Failed to resume suspended session:', err);
        }
      } else if (!toIsActive) {
        // No transition fired spawn_agent (non-agent column) and no suspended
        // session to resume — spawn a fresh agent so the task isn't left idle.
        // This covers moves like Backlog → Review/PR/custom.
        console.log(`[TASK_MOVE] Spawning fresh session for task ${task.id.slice(0, 8)} (non-agent column, no prior session)`);
        try {
          await engine.resumeSuspendedSession(updatedTask);
        } catch (err) {
          console.error('Failed to spawn fresh session:', err);
        }
      }
    }
  });

  ipcMain.handle(IPC.TASK_LIST_ARCHIVED, () => {
    const { tasks } = getProjectRepos();
    return tasks.listArchived();
  });

  ipcMain.handle(IPC.TASK_UNARCHIVE, async (_, input: { id: string; targetSwimlaneId: string }) => {
    const { tasks, swimlanes, skills } = getProjectRepos();

    // Determine position at end of target lane
    const laneTasks = tasks.list(input.targetSwimlaneId);
    const position = laneTasks.length;

    const task = tasks.unarchive(input.id, input.targetSwimlaneId, position);

    const toLane = swimlanes.getById(input.targetSwimlaneId);

    // Guard: don't resume if target is Backlog (shouldn't happen, but safe)
    if (toLane?.role === 'backlog') {
      return tasks.getById(input.id);
    }

    const agentLaneIds = skills.getAgentSwimlaneIds();
    const toIsActive = agentLaneIds.has(input.targetSwimlaneId);

    // Create worktree if needed when moving to an agent-active column
    if (toIsActive && !task.worktree_path && currentProjectPath) {
      const config = configManager.getEffectiveConfig(currentProjectPath);
      if (config.git.worktreesEnabled) {
        try {
          const wm = new WorktreeManager(currentProjectPath);
          const { worktreePath, branchName } = await wm.createWorktree(
            task.id, task.title, config.git.defaultBaseBranch, config.git.copyFiles,
          );
          tasks.update({ id: task.id, worktree_path: worktreePath, branch_name: branchName });
          Object.assign(task, tasks.getById(task.id));
        } catch (err) {
          console.error('Worktree creation failed during unarchive:', err);
        }
      }
    }

    // Execute transition skills (from Done → target) for ALL non-kill columns
    if (currentProjectPath) {
      const doneLane = swimlanes.list().find((l) => l.role === 'done');
      if (doneLane) {
        const db = getProjectDb(currentProjectId!);
        const sessionRepo = new SessionRepository(db);
        const engine = new TransitionEngine(
          sessionManager, skills, tasks, claudeDetector, commandBuilder,
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
        );

        try {
          await engine.executeTransition(task, doneLane.id, input.targetSwimlaneId);
        } catch (err) {
          console.error('Transition engine error during unarchive:', err);
        }

        // Re-read task; if still no session and a suspended record exists, auto-resume
        const updatedTask = tasks.getById(task.id);
        if (updatedTask && !updatedTask.session_id) {
          const previousSession = sessionRepo.getLatestForTask(task.id);
          if (
            previousSession
            && previousSession.claude_session_id
            && previousSession.session_type === 'claude_agent'
            && previousSession.status === 'suspended'
          ) {
            console.log(`[TASK_UNARCHIVE] Auto-resuming suspended session for task ${task.id.slice(0, 8)}`);
            try {
              await engine.resumeSuspendedSession(updatedTask);
            } catch (err) {
              console.error('Failed to resume suspended session during unarchive:', err);
            }
          }
        }
      }
    }

    return tasks.getById(input.id);
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

  // === Skills ===
  ipcMain.handle(IPC.SKILL_LIST, () => {
    const { skills } = getProjectRepos();
    return skills.list();
  });

  ipcMain.handle(IPC.SKILL_CREATE, (_, input) => {
    const { skills } = getProjectRepos();
    return skills.create(input);
  });

  ipcMain.handle(IPC.SKILL_UPDATE, (_, input) => {
    const { skills } = getProjectRepos();
    return skills.update(input);
  });

  ipcMain.handle(IPC.SKILL_DELETE, (_, id) => {
    const { skills } = getProjectRepos();
    skills.delete(id);
  });

  // === Transitions ===
  ipcMain.handle(IPC.TRANSITION_LIST, () => {
    const { skills } = getProjectRepos();
    return skills.listTransitions();
  });

  ipcMain.handle(IPC.TRANSITION_SET, (_, fromId, toId, skillIds) => {
    const { skills } = getProjectRepos();
    skills.setTransitions(fromId, toId, skillIds);
  });

  ipcMain.handle(IPC.TRANSITION_GET_FOR, (_, fromId, toId) => {
    const { skills } = getProjectRepos();
    return skills.getTransitionsFor(fromId, toId);
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

import { ipcMain, BrowserWindow } from 'electron';
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
import { recoverSessions, reconcileSessions } from '../engine/session-recovery';
import { WorktreeManager } from '../git/worktree-manager';
import { getProjectDb } from '../db/database';

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

    // Apply project config overrides (always — config may have changed)
    const config = configManager.getEffectiveConfig(project.path);
    sessionManager.setMaxConcurrent(config.claude.maxConcurrentSessions);
    sessionManager.setShell(config.terminal.shell);

    if (!isReopen) {
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

  ipcMain.handle(IPC.TASK_UPDATE, (_, input) => {
    const { tasks } = getProjectRepos();
    return tasks.update(input);
  });

  ipcMain.handle(IPC.TASK_DELETE, (_, id) => {
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

    // Delete session DB records before the task to avoid FK constraint errors
    const db = getProjectDb(currentProjectId!);
    const sessionRepo = new SessionRepository(db);
    sessionRepo.deleteByTaskId(id);

    tasks.delete(id);
  });

  ipcMain.handle(IPC.TASK_MOVE, async (_, input) => {
    const { tasks, skills, swimlanes } = getProjectRepos();
    const task = tasks.getById(input.taskId);
    if (!task) throw new Error(`Task ${input.taskId} not found`);

    const fromSwimlaneId = task.swimlane_id;

    // Determine if source/target are session-active columns (Planning=1, Running=2)
    const fromLane = swimlanes.getById(fromSwimlaneId);
    const toLane = swimlanes.getById(input.targetSwimlaneId);
    const fromIsActive = fromLane && (fromLane.position === 1 || fromLane.position === 2);
    const toIsActive = toLane && (toLane.position === 1 || toLane.position === 2);

    // Move the task in the database
    tasks.move(input);

    // If leaving an active column for a non-active column, suspend the session.
    // Mark as 'suspended' in the DB BEFORE killing the PTY so the async
    // onExit handler sees 'suspended' and doesn't overwrite it with 'exited'.
    if (fromIsActive && !toIsActive && task.session_id) {
      const db = getProjectDb(currentProjectId!);
      const sessionRepo = new SessionRepository(db);
      const record = sessionRepo.getLatestForTask(task.id);
      if (record && record.status === 'running') {
        sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: new Date().toISOString() });
        console.log(`[TASK_MOVE] Suspended session record ${record.id.slice(0, 8)} (claude_id=${record.claude_session_id?.slice(0, 8)}) for task ${task.id.slice(0, 8)}`);
      } else {
        console.log(`[TASK_MOVE] No running session record to suspend for task ${task.id.slice(0, 8)} (latest record: ${record ? `status=${record.status}` : 'none'})`);
      }

      sessionManager.kill(task.session_id);
      tasks.update({ id: task.id, session_id: null });
      return;
    }

    // Create worktree if moving into Planning and worktrees are enabled
    if (toLane && toLane.position === 1 && !task.worktree_path && currentProjectPath) {
      const config = configManager.getEffectiveConfig(currentProjectPath);
      if (config.git.worktreesEnabled) {
        try {
          const wm = new WorktreeManager(currentProjectPath);
          const { worktreePath, branchName } = await wm.createWorktree(
            task.id,
            task.title,
            config.git.defaultBaseBranch,
            config.git.copyFiles,
          );
          tasks.update({ id: task.id, worktree_path: worktreePath, branch_name: branchName });
          // Re-read task so downstream transition engine uses the updated worktree_path
          const updated = tasks.getById(task.id);
          if (updated) Object.assign(task, updated);
        } catch (err) {
          console.error('Worktree creation failed:', err);
        }
      }
    }

    // Execute transition skills (handles spawning agents, etc.)
    const db = getProjectDb(currentProjectId!);
    const sessionRepo = new SessionRepository(db);
    const engine = new TransitionEngine(
      sessionManager,
      skills,
      tasks,
      claudeDetector,
      commandBuilder,
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

  // Forward PTY events to renderer
  sessionManager.on('data', (sessionId: string, data: string) => {
    mainWindow.webContents.send(IPC.SESSION_DATA, sessionId, data);
  });

  sessionManager.on('exit', (sessionId: string, exitCode: number) => {
    mainWindow.webContents.send(IPC.SESSION_EXIT, sessionId, exitCode);

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
  const path = require('node:path');

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

  const config = configManager.getEffectiveConfig(project.path);
  sessionManager.setMaxConcurrent(config.claude.maxConcurrentSessions);
  sessionManager.setShell(config.terminal.shell);

  if (!isReopen) {
    // Recover suspended/orphaned sessions, then reconcile missing ones
    await recoverSessions(project.id, project.path, sessionManager, claudeDetector, commandBuilder, configManager);
    await reconcileSessions(project.id, project.path, sessionManager, claudeDetector, commandBuilder, configManager);
  }

  return project;
}

import { type BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { trackEvent, sanitizeErrorMessage } from '../analytics/analytics';
import { ProjectRepository } from '../db/repositories/project-repository';
import { ProjectGroupRepository } from '../db/repositories/project-group-repository';
import { SessionManager } from '../pty/session-manager';
import { ConfigManager } from '../config/config-manager';
import { BoardConfigManager } from '../config/board-config-manager';
import { GitDetector } from '../agent/git-detector';
import { ShellResolver } from '../pty/shell-resolver';
import { CommandInjector } from '../engine/command-injector';
import {
  registerProjectHandlers,
  cleanupProject as cleanupProjectImpl,
  deleteProjectFromIndex as deleteProjectFromIndexImpl,
  pruneStaleWorktreeProjects as pruneStaleWorktreeProjectsImpl,
  openProjectByPath as openProjectByPathImpl,
  activateAllProjects as activateAllProjectsImpl,
  getLastOpenedProject as getLastOpenedProjectImpl,
} from './handlers/projects';
import { registerTaskHandlers } from './handlers/tasks';
import { registerSessionHandlers } from './handlers/sessions';
import { registerTransientSessionHandlers } from './handlers/transient-sessions';
import { registerBoardHandlers } from './handlers/board';
import { registerSystemHandlers } from './handlers/system';
import { registerBacklogHandlers } from './handlers/backlog';
import { registerGitDiffHandlers } from './handlers/git-diff';
import type { IpcContext } from './ipc-context';

let context: IpcContext | null = null;

function requireContext(): IpcContext {
  if (!context) throw new Error('IPC not initialized -- call registerAllIpc first');
  return context;
}

export function registerAllIpc(mainWindow: BrowserWindow): void {
  // Idempotent: on macOS, activate → createWindow() may call this again.
  // Just update the window reference and return. ipcMain.handle calls
  // must NOT run twice (throws "Attempted to register a second handler").
  if (context) {
    context.mainWindow = mainWindow;
    return;
  }

  // Eagerly create SessionManager + CommandInjector + BoardConfigManager (lightweight, needed early)
  const sessionManager = new SessionManager();
  const commandInjector = new CommandInjector(sessionManager);
  const boardConfigManager = new BoardConfigManager({
    ephemeral: process.argv.includes('--ephemeral'),
  });

  // Lazy-initialize heavy objects on first access
  let projectRepo: ProjectRepository | null = null;
  let projectGroupRepo: ProjectGroupRepository | null = null;
  let configManager: ConfigManager | null = null;
  let gitDetector: GitDetector | null = null;
  let shellResolver: ShellResolver | null = null;

  context = {
    mainWindow,
    get projectRepo() {
      if (!projectRepo) projectRepo = new ProjectRepository();
      return projectRepo;
    },
    get projectGroupRepo() {
      if (!projectGroupRepo) projectGroupRepo = new ProjectGroupRepository();
      return projectGroupRepo;
    },
    sessionManager,
    boardConfigManager,
    get configManager() {
      if (!configManager) configManager = new ConfigManager();
      return configManager;
    },
    get gitDetector() {
      if (!gitDetector) gitDetector = new GitDetector();
      return gitDetector;
    },
    get shellResolver() {
      if (!shellResolver) shellResolver = new ShellResolver();
      return shellResolver;
    },
    commandInjector,
    currentProjectId: null,
    currentProjectPath: null,
    externalCommandBridge: null,
  };

  registerProjectHandlers(context);
  registerTaskHandlers(context);
  registerSessionHandlers(context);
  registerTransientSessionHandlers(context);
  registerBoardHandlers(context);
  registerBacklogHandlers(context);
  registerGitDiffHandlers(context);
  registerSystemHandlers(context);

  // Analytics: renderer error tracking (fire-and-forget from renderer)
  ipcMain.on(IPC.TRACK_RENDERER_ERROR, (_event, message: string) => {
    trackEvent('app_error', {
      source: 'error_boundary',
      message: sanitizeErrorMessage(message),
    });
  });
}

// Thin wrappers -- same signatures as before, zero changes in index.ts
export function getSessionManager(): SessionManager {
  return requireContext().sessionManager;
}

export function getCommandInjector(): CommandInjector {
  return requireContext().commandInjector;
}

export function getBoardConfigManager(): BoardConfigManager {
  return requireContext().boardConfigManager;
}

export function getCurrentProjectId(): string | null {
  return requireContext().currentProjectId;
}

export async function cleanupProject(projectId: string, projectPath: string): Promise<void> {
  return cleanupProjectImpl(requireContext(), projectId, projectPath);
}

export function deleteProjectFromIndex(id: string): void {
  return deleteProjectFromIndexImpl(requireContext(), id);
}

export async function pruneStaleWorktreeProjects(): Promise<void> {
  return pruneStaleWorktreeProjectsImpl(requireContext());
}

export async function openProjectByPath(projectPath: string) {
  return openProjectByPathImpl(requireContext(), projectPath);
}

export async function activateAllProjects(): Promise<void> {
  return activateAllProjectsImpl(requireContext());
}

export function getLastOpenedProject() {
  return getLastOpenedProjectImpl(requireContext());
}

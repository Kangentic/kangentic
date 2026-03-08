import type { BrowserWindow } from 'electron';
import { ProjectRepository } from '../db/repositories/project-repository';
import { SessionManager } from '../pty/session-manager';
import { ConfigManager } from '../config/config-manager';
import { ClaudeDetector } from '../agent/claude-detector';
import { ShellResolver } from '../pty/shell-resolver';
import { CommandBuilder } from '../agent/command-builder';
import { CommandInjector } from '../engine/command-injector';
import {
  registerProjectHandlers,
  cleanupProject as cleanupProjectImpl,
  deleteProjectFromIndex as deleteProjectFromIndexImpl,
  pruneStaleWorktreeProjects as pruneStaleWorktreeProjectsImpl,
  openProjectByPath as openProjectByPathImpl,
  activateAllProjects as activateAllProjectsImpl,
} from './handlers/projects';
import { registerTaskHandlers } from './handlers/tasks';
import { registerSessionHandlers } from './handlers/sessions';
import { registerBoardHandlers } from './handlers/board';
import { registerSystemHandlers } from './handlers/system';
import type { IpcContext } from './ipc-context';

let context: IpcContext | null = null;

function requireContext(): IpcContext {
  if (!context) throw new Error('IPC not initialized -- call registerAllIpc first');
  return context;
}

export function registerAllIpc(mainWindow: BrowserWindow): void {
  // Eagerly create SessionManager + CommandInjector (lightweight, needed early)
  const sessionManager = new SessionManager();
  const commandInjector = new CommandInjector(sessionManager);

  // Lazy-initialize heavy objects on first access
  let projectRepo: ProjectRepository | null = null;
  let configManager: ConfigManager | null = null;
  let claudeDetector: ClaudeDetector | null = null;
  let shellResolver: ShellResolver | null = null;
  let commandBuilder: CommandBuilder | null = null;

  context = {
    mainWindow,
    get projectRepo() {
      if (!projectRepo) projectRepo = new ProjectRepository();
      return projectRepo;
    },
    sessionManager,
    get configManager() {
      if (!configManager) configManager = new ConfigManager();
      return configManager;
    },
    get claudeDetector() {
      if (!claudeDetector) claudeDetector = new ClaudeDetector();
      return claudeDetector;
    },
    get shellResolver() {
      if (!shellResolver) shellResolver = new ShellResolver();
      return shellResolver;
    },
    get commandBuilder() {
      if (!commandBuilder) commandBuilder = new CommandBuilder();
      return commandBuilder;
    },
    commandInjector,
    currentProjectId: null,
    currentProjectPath: null,
  };

  registerProjectHandlers(context);
  registerTaskHandlers(context);
  registerSessionHandlers(context);
  registerBoardHandlers(context);
  registerSystemHandlers(context);
}

// Thin wrappers -- same signatures as before, zero changes in index.ts
export function getSessionManager(): SessionManager {
  return requireContext().sessionManager;
}

export function getCommandInjector(): CommandInjector {
  return requireContext().commandInjector;
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

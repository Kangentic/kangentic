import type { BrowserWindow } from 'electron';
import type { ProjectRepository } from '../db/repositories/project-repository';
import type { SessionManager } from '../pty/session-manager';
import type { ConfigManager } from '../config/config-manager';
import type { ClaudeDetector } from '../agent/claude-detector';
import type { ShellResolver } from '../pty/shell-resolver';
import type { CommandBuilder } from '../agent/command-builder';
import type { CommandInjector } from '../engine/command-injector';

export interface IpcContext {
  mainWindow: BrowserWindow;
  projectRepo: ProjectRepository;
  sessionManager: SessionManager;
  configManager: ConfigManager;
  claudeDetector: ClaudeDetector;
  shellResolver: ShellResolver;
  commandBuilder: CommandBuilder;
  commandInjector: CommandInjector;
  currentProjectId: string | null;
  currentProjectPath: string | null;
}

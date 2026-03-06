import path from 'node:path';
import { ipcMain, Notification, app, dialog, shell } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { WorktreeManager, isGitRepo } from '../../git/worktree-manager';
import type { NotificationInput } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

export function registerSystemHandlers(context: IpcContext): void {
  // === Config ===
  ipcMain.handle(IPC.CONFIG_GET, () => context.configManager.getEffectiveConfig(context.currentProjectPath || undefined));
  ipcMain.handle(IPC.CONFIG_GET_GLOBAL, () => context.configManager.load());

  ipcMain.handle(IPC.CONFIG_SET, (_, config) => {
    context.configManager.save(config);
    // Apply runtime changes
    const effective = context.configManager.getEffectiveConfig(context.currentProjectPath || undefined);
    context.sessionManager.setMaxConcurrent(effective.claude.maxConcurrentSessions);
    context.sessionManager.setShell(effective.terminal.shell);
  });

  ipcMain.handle(IPC.CONFIG_GET_PROJECT, () => {
    if (!context.currentProjectPath) return null;
    return context.configManager.loadProjectOverrides(context.currentProjectPath);
  });

  ipcMain.handle(IPC.CONFIG_SET_PROJECT, (_, overrides) => {
    if (!context.currentProjectPath) throw new Error('No project open');
    context.configManager.saveProjectOverrides(context.currentProjectPath, overrides);
  });

  ipcMain.handle(IPC.CONFIG_GET_PROJECT_BY_PATH, (_, projectPath: string) => {
    const known = context.projectRepo.list().some((p) => p.path === projectPath);
    if (!known) throw new Error('Unknown project path');
    return context.configManager.loadProjectOverrides(projectPath);
  });

  ipcMain.handle(IPC.CONFIG_SET_PROJECT_BY_PATH, (_, projectPath: string, overrides) => {
    const known = context.projectRepo.list().some((p) => p.path === projectPath);
    if (!known) throw new Error('Unknown project path');
    context.configManager.saveProjectOverrides(projectPath, overrides);
  });

  // === Claude ===
  ipcMain.handle(IPC.CLAUDE_DETECT, () => {
    const config = context.configManager.load();
    return context.claudeDetector.detect(config.claude.cliPath);
  });

  // === Shell ===
  ipcMain.handle(IPC.SHELL_GET_AVAILABLE, () => context.shellResolver.getAvailableShells());
  ipcMain.handle(IPC.SHELL_GET_DEFAULT, () => context.shellResolver.getDefaultShell());
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_, dirPath: string) => shell.openPath(dirPath));
  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, (_, url: string) => shell.openExternal(url));

  // === Git ===
  ipcMain.handle(IPC.GIT_LIST_BRANCHES, async () => {
    if (!context.currentProjectPath || !isGitRepo(context.currentProjectPath)) return [];
    try {
      const worktreeManager = new WorktreeManager(context.currentProjectPath);
      return await worktreeManager.listRemoteBranches();
    } catch { return []; }
  });

  // === Dialog ===
  ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog(context.mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // === Window ===
  ipcMain.on(IPC.WINDOW_MINIMIZE, () => context.mainWindow.minimize());
  ipcMain.on(IPC.WINDOW_MAXIMIZE, () => {
    if (context.mainWindow.isMaximized()) {
      context.mainWindow.unmaximize();
    } else {
      context.mainWindow.maximize();
    }
  });
  ipcMain.on(IPC.WINDOW_CLOSE, () => context.mainWindow.close());
  ipcMain.on(IPC.WINDOW_FLASH_FRAME, (_event, flash: boolean) => context.mainWindow.flashFrame(flash));

  // === Notifications ===
  ipcMain.on(IPC.NOTIFICATION_SHOW, (_event, input: NotificationInput) => {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'resources', 'icon.png');

    const notification = new Notification({
      title: input.title,
      body: input.body,
      icon: iconPath,
    });

    notification.on('click', () => {
      context.mainWindow.show();
      context.mainWindow.focus();
      context.mainWindow.webContents.send(IPC.NOTIFICATION_CLICKED, input.projectId, input.taskId);
    });

    notification.show();
  });
}

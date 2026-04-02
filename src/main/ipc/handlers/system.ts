import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, ipcMain, Notification, dialog, shell } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { WorktreeManager, isGitRepo } from '../../git/worktree-manager';
import { deepMergeConfig } from '../../../shared/object-utils';
import type { NotificationInput, AgentCommand, AgentDetectionInfo } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

export function registerSystemHandlers(context: IpcContext): void {
  // === App ===
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion());

  // === Config ===
  ipcMain.handle(IPC.CONFIG_GET, () => {
    const config = context.configManager.getEffectiveConfig(context.currentProjectPath || undefined);
    // Overlay board config's defaultBaseBranch (team-shared) onto the effective config.
    // Spread to avoid mutating the cached config object from ConfigManager.
    const boardDefaultBranch = context.boardConfigManager.getDefaultBaseBranch();
    if (boardDefaultBranch) {
      return { ...config, git: { ...config.git, defaultBaseBranch: boardDefaultBranch } };
    }
    return config;
  });
  ipcMain.handle(IPC.CONFIG_GET_GLOBAL, () => context.configManager.load());

  ipcMain.handle(IPC.CONFIG_SET, (_, config) => {
    context.configManager.save(config);
    // Apply runtime changes
    const effective = context.configManager.getEffectiveConfig(context.currentProjectPath || undefined);
    context.sessionManager.setMaxConcurrent(effective.claude.maxConcurrentSessions);
    context.sessionManager.setShell(effective.terminal.shell);
    context.sessionManager.setIdleTimeout(effective.claude.idleTimeoutMinutes);
    // Invalidate cached detection so the next detect() call picks up the new cliPath
    if (config.claude) {
      context.claudeDetector.invalidateCache();
    }
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

  ipcMain.handle(IPC.CONFIG_SYNC_DEFAULT_TO_PROJECTS, (_, partial) => {
    const projects = context.projectRepo.list();
    let updatedCount = 0;
    for (const project of projects) {
      const existing = context.configManager.loadProjectOverrides(project.path) || {};
      const merged = deepMergeConfig(existing, partial);
      context.configManager.saveProjectOverrides(project.path, merged);
      updatedCount++;
    }
    return updatedCount;
  });

  // === Agent ===
  ipcMain.handle(IPC.AGENT_DETECT, () => {
    const config = context.configManager.load();
    return context.claudeDetector.detect(config.claude.cliPath);
  });

  // === Agents ===
  ipcMain.handle(IPC.AGENT_LIST, async (): Promise<AgentDetectionInfo[]> => {
    const { agentRegistry } = await import('../../agent/agent-registry');
    const config = context.configManager.load();
    // Map agent names to user-configured CLI path overrides.
    // Extend this when adding new agents with configurable paths.
    const cliPathOverrides: Record<string, string | null> = {
      claude: config.claude.cliPath,
    };
    const results: AgentDetectionInfo[] = [];
    for (const agentName of agentRegistry.list()) {
      const adapter = agentRegistry.getOrThrow(agentName);
      const info = await adapter.detect(cliPathOverrides[agentName] ?? null);
      results.push({ name: agentName, displayName: adapter.displayName, found: info.found, path: info.path, version: info.version, permissions: adapter.permissions });
    }
    return results;
  });

  ipcMain.handle(IPC.AGENT_LIST_COMMANDS, (_, cwd?: string): AgentCommand[] => {
    const projectPath = context.currentProjectPath;
    if (!projectPath) return [];

    const startDir = cwd || projectPath;
    const homeDir = app.getPath('home');

    // Walk from startDir upward to filesystem root, collecting .claude/<subdirectory>
    // paths. Closest directories come first so nearer entries win on dedup.
    function collectSearchRoots(subdirectory: string): string[] {
      const roots: string[] = [];
      let directory = path.resolve(startDir);
      const fsRoot = path.parse(directory).root;
      while (directory !== fsRoot) {
        roots.push(path.join(directory, '.claude', subdirectory));
        const parentDirectory = path.dirname(directory);
        if (parentDirectory === directory) break;
        directory = parentDirectory;
      }
      roots.push(path.join(homeDir, '.claude', subdirectory));
      return roots;
    }

    // Parse YAML frontmatter from a markdown file's content.
    // Returns extracted description and argument-hint values.
    function parseFrontmatter(content: string): { description: string; argumentHint: string } {
      let description = '';
      let argumentHint = '';
      if (content.startsWith('---')) {
        const endIndex = content.indexOf('---', 3);
        if (endIndex !== -1) {
          const frontmatter = content.slice(3, endIndex);
          for (const line of frontmatter.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('description:')) {
              description = trimmed.slice('description:'.length).trim().replace(/^['"]|['"]$/g, '');
            } else if (trimmed.startsWith('argument-hint:')) {
              argumentHint = trimmed.slice('argument-hint:'.length).trim().replace(/^['"]|['"]$/g, '');
            }
          }
        }
      }
      return { description, argumentHint };
    }

    const seen = new Set<string>(); // names already collected (closest wins)
    const commands: AgentCommand[] = [];

    // Scan .claude/commands/ directories (legacy format: flat .md files)
    function walkCommandsDirectory(directory: string, prefix: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walkCommandsDirectory(fullPath, prefix ? `${prefix}${entry.name}:` : `${entry.name}:`);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const baseName = entry.name.slice(0, -3);
          const commandName = prefix + baseName;
          if (seen.has(commandName)) continue;
          seen.add(commandName);

          let description = '';
          let argumentHint = '';
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            ({ description, argumentHint } = parseFrontmatter(content));
          } catch {
            // Skip files that can't be read
          }

          commands.push({ name: commandName, displayName: `/${commandName}`, description, argumentHint, source: 'command' });
        }
      }
    }

    for (const commandsDir of collectSearchRoots('commands')) {
      walkCommandsDirectory(commandsDir, '');
    }

    // Scan .claude/skills/ directories (new format: subdirectory with SKILL.md)
    for (const skillsDir of collectSearchRoots('skills')) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillName = entry.name;
        if (seen.has(skillName)) continue;

        const skillMdPath = path.join(skillsDir, skillName, 'SKILL.md');
        try {
          fs.accessSync(skillMdPath, fs.constants.R_OK);
        } catch {
          continue; // no SKILL.md in this directory
        }

        seen.add(skillName);
        let description = '';
        let argumentHint = '';

        try {
          const content = fs.readFileSync(skillMdPath, 'utf-8');
          ({ description, argumentHint } = parseFrontmatter(content));
          // Fall back to first paragraph after heading if no frontmatter description
          if (!description) {
            const lines = content.split('\n');
            let pastHeading = false;
            for (const line of lines) {
              if (line.startsWith('#')) {
                pastHeading = true;
                continue;
              }
              if (pastHeading && line.trim()) {
                description = line.trim();
                break;
              }
            }
          }
        } catch {
          // Skip files that can't be read
        }

        commands.push({
          name: skillName,
          displayName: `/${skillName}`,
          description,
          argumentHint,
          source: 'skill',
        });
      }
    }

    commands.sort((a, b) => a.name.localeCompare(b.name));
    return commands;
  });

  // === Shell ===
  ipcMain.handle(IPC.SHELL_GET_AVAILABLE, () => context.shellResolver.getAvailableShells());
  ipcMain.handle(IPC.SHELL_GET_DEFAULT, () => context.shellResolver.getDefaultShell());
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_, dirPath: string) => shell.openPath(dirPath));
  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, (_, url: string) => shell.openExternal(url));

  ipcMain.handle(IPC.SHELL_EXEC, (_, command: string, cwd: string) => {
    if (!command || typeof command !== 'string' || !command.trim()) {
      throw new Error('shell:exec requires a non-empty command string');
    }
    if (!cwd || typeof cwd !== 'string' || !fs.existsSync(cwd)) {
      throw new Error(`shell:exec requires a valid cwd directory (got "${cwd}")`);
    }
    console.log(`[shell:exec] command="${command}" cwd="${cwd}"`);
    const child = spawn(command, [], {
      cwd,
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { pid: child.pid };
  });

  // === Git ===
  ipcMain.handle(IPC.GIT_DETECT, () => context.gitDetector.detect());

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
  ipcMain.handle(IPC.WINDOW_IS_FOCUSED, () => context.mainWindow.isFocused());

  // === Notifications ===
  const activeNotifications = new Set<Notification>();

  ipcMain.on(IPC.NOTIFICATION_SHOW, (_event, input: NotificationInput) => {
    if (!Notification.isSupported()) {
      console.warn('[NOTIFICATION] Notifications not supported on this system');
      return;
    }

    const notification = new Notification({
      title: input.title,
      body: input.body,
    });

    activeNotifications.add(notification);

    const cleanup = () => {
      activeNotifications.delete(notification);
    };

    notification.on('click', () => {
      cleanup();

      const mainWindow = context.mainWindow;
      if (mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();

      const sendClickEvent = () => {
        mainWindow.webContents.send(IPC.NOTIFICATION_CLICKED, input.projectId, input.taskId);
      };

      if (mainWindow.isFocused()) {
        sendClickEvent();
      } else {
        mainWindow.once('focus', sendClickEvent);
      }
    });

    notification.on('close', cleanup);

    notification.show();
  });

  // === Clipboard ===
  // Matches Claude API vision input: image/jpeg, image/png, image/gif, image/webp
  const ALLOWED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, (_, data: string, extension: string) => {
    if (!ALLOWED_IMAGE_EXTENSIONS.includes(extension.toLowerCase())) {
      throw new Error(`Unsupported image extension: ${extension}`);
    }
    const tempDir = path.join(os.tmpdir(), 'kangentic-clipboard');
    fs.mkdirSync(tempDir, { recursive: true });
    const filename = `pasted-image-${Date.now()}${extension.toLowerCase()}`;
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  });
}

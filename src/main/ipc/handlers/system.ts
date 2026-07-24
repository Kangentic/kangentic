import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, ipcMain, Notification, dialog, shell, globalShortcut, clipboard } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { comboToAccelerator } from '../../../shared/keybindings';
import { WorktreeManager } from '../../git/worktree-manager';
import { isGitRepo } from '../../git/git-checks';
import { deepMergeConfig } from '../../../shared/object-utils';
import { getProjectDb } from '../../db/database';
import { HandoffRepository } from '../../db/repositories/handoff-repository';
import { syncProjectMcpConfig } from './projects';
import { applyRuntimeConfig } from '../../config/apply-runtime-config';
import { listAgents, invalidateAgentListCache } from '../../agent/agent-list';
import { agentRegistry } from '../../agent/agent-registry';
import { broadcast } from '../../pop-out/window-broadcast';
import { resolveRelayUrl } from '../../../shared/relay';
import type {
  NotificationInput,
  AgentCommand,
  AgentDetectionInfo,
  AgentSummarizeInput,
  AgentSummarizeResult,
  HandoffRecord,
  RemoteServerStatus,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

// Held only so a shown Notification is not garbage-collected before the user
// interacts with it (Electron's Notification has no other owner).
const activeNotifications = new Set<Notification>();

/**
 * Shows a native OS notification and wires its click round-trip back to the
 * renderer (restore/show/focus, then NOTIFICATION_CLICKED once the window is
 * focused). Shared by the renderer-driven NOTIFICATION_SHOW IPC channel
 * (spawn-stall, plan-complete) and the main-process desktop notifier
 * (src/main/notifications/desktop-notifier.ts, idle and crash), which decides
 * to notify without an IPC round-trip and calls this directly.
 */
export function showDesktopNotification(context: IpcContext, input: NotificationInput): void {
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
}

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
    applyRuntimeConfig(context.sessionManager, context.configManager, context.currentProjectPath);
    // Invalidate cached detection for all agents so the next detect() call picks up new cliPaths,
    // and drop the cached agents.list() result so it rebuilds against the new config.
    if (config.agent) {
      invalidateAgentListCache();
      import('../../agent/agent-registry').then(({ agentRegistry }) => {
        for (const agentName of agentRegistry.list()) {
          agentRegistry.getOrThrow(agentName).invalidateDetectionCache();
        }
      });
    }
    // If the user toggled the Kangentic MCP Server in Settings, refresh the
    // current project's mcp-config.json on disk so external Claude sessions
    // pick up the new state without needing to reopen the project. The
    // in-process HTTP server itself also reads the toggle per request
    // (defense in depth -- see startMcpHttpServer factory in main/index.ts),
    // so even a stale mcp-config.json wouldn't actually grant access.
    if (config.mcpServer && context.currentProjectId && context.currentProjectPath) {
      syncProjectMcpConfig(context, context.currentProjectId, context.currentProjectPath);
    }
    // Re-evaluate the embed-worker warm-hold: toggling memory.semanticEnabled off
    // should release the resident worker promptly rather than waiting for its
    // next idle-recycle window.
    if (config.memory) {
      void import('../../retrieval/retrieval-service').then(({ retrievalService }) => {
        retrievalService.reconcileEmbedWorker(context);
      });
    }
    // Toggling the mobile bridge on/off, or changing the relay URL, takes
    // effect immediately without reopening the app.
    if (config.mobileBridge) {
      const effectiveConfig = context.configManager.getEffectiveConfig(context.currentProjectPath || undefined);
      context.mobileBridgeService.reconcile({
        // Dev-only until the mobile app launches (mirrors register-all.ts).
        enabled: __KANGENTIC_DEV__ && (effectiveConfig.mobileBridge?.enabled ?? false),
        relayUrl: resolveRelayUrl(effectiveConfig.mobileBridge),
      });
    }
    // Bare-signal broadcast so every open pop-out window re-fetches via config:get and
    // stays in theme/settings sync (they subscribe through config.onChanged in
    // usePopOutBootstrap). The main window is a harmless extra recipient: it does not
    // subscribe, updating its own config store optimistically at the config.set call site.
    broadcast(context.mainWindow, IPC.CONFIG_CHANGED);
  });

  // Synchronous sibling of CONFIG_SET for the renderer's quit/unload flush: an async
  // invoke() can be dropped if the renderer tears down before the main process drains it,
  // so the final window-layout write goes through sendSync, which blocks the renderer until
  // configManager.save() (a synchronous fs write) has persisted it. Intentionally minimal:
  // no runtime re-apply or detection invalidation, both irrelevant during shutdown.
  ipcMain.on(IPC.CONFIG_SET_SYNC, (event, config) => {
    context.configManager.save(config);
    event.returnValue = true;
  });

  ipcMain.handle(IPC.CONFIG_GET_PROJECT, () => {
    if (!context.currentProjectPath) return null;
    return context.configManager.loadProjectOverrides(context.currentProjectPath);
  });

  ipcMain.handle(IPC.CONFIG_SET_PROJECT, (_, overrides) => {
    if (!context.currentProjectPath) throw new Error('No project open');
    context.configManager.saveProjectOverrides(context.currentProjectPath, overrides);
    applyRuntimeConfig(context.sessionManager, context.configManager, context.currentProjectPath);
    // A per-project override changes the EFFECTIVE config open pop-outs read (the Changes
    // surface reads git.defaultBaseBranch, which is project-overridable), so fan the same
    // bare signal CONFIG_SET does so they re-fetch instead of diffing a stale base branch.
    broadcast(context.mainWindow, IPC.CONFIG_CHANGED);
  });

  ipcMain.handle(IPC.CONFIG_GET_PROJECT_BY_PATH, (_, projectPath: string) => {
    const known = context.projectRepo.list().some((p) => p.path === projectPath);
    if (!known) throw new Error('Unknown project path');
    return context.configManager.loadProjectOverrides(projectPath);
  });

  ipcMain.handle(IPC.CONFIG_SET_PROJECT_BY_PATH, (_, projectPath: string, overrides) => {
    const project = context.projectRepo.list().find((p) => p.path === projectPath);
    if (!project) throw new Error('Unknown project path');
    context.configManager.saveProjectOverrides(projectPath, overrides);
    // Background projects pick up changes when they next open; only the
    // currently-open project needs its in-memory state refreshed now.
    if (projectPath === context.currentProjectPath) {
      applyRuntimeConfig(context.sessionManager, context.configManager, projectPath);
      // Sync open pop-outs of the current project to the changed effective config (see
      // the CONFIG_SET_PROJECT broadcast note). Scoped to the current project since only
      // its pop-outs are open.
      broadcast(context.mainWindow, IPC.CONFIG_CHANGED);
      // Re-arm the PR-refresh timer so a changed interval (Git tab) takes effect
      // immediately without reopening the project. Imported lazily so registering
      // the system handlers does not pull the gh-backed PR runtime into this
      // module's graph (keeps unit tests that stub node:child_process light).
      void import('../../pr/pr-refresh-scheduler').then(({ prRefreshScheduler }) => {
        prRefreshScheduler.startForProject(context, project);
      });
      // Re-run the conversation-memory sweep so toggling memory.indexingEnabled
      // on takes effect without reopening the project.
      void import('../../retrieval/retrieval-service').then(({ retrievalService }) => {
        retrievalService.startForProject(context, project);
      });
    }
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
    if (context.currentProjectPath) {
      applyRuntimeConfig(context.sessionManager, context.configManager, context.currentProjectPath);
    }
    return updatedCount;
  });

  // === Keybindings ===
  // Probe whether each combo can be claimed as a system-wide global shortcut.
  // Registration silently fails (returns false) when the OS or another app
  // already owns the accelerator, which is a strong signal the in-renderer
  // keydown would never reach Kangentic. We register only to test, then
  // immediately unregister so Kangentic holds no real global shortcuts.
  // Electron's macOS Accessibility-permission caveat for globalShortcut applies
  // only to media-key accelerators (Media Play/Pause, etc.), which
  // comboToAccelerator never emits (modifier + letter/digit/F-key only), so the
  // probe is not subject to that false-'taken' case.
  ipcMain.handle(
    IPC.KEYBINDINGS_PROBE_GLOBAL,
    (_, combos: string[]): Record<string, 'available' | 'taken' | 'unsupported'> => {
      const result: Record<string, 'available' | 'taken' | 'unsupported'> = {};
      for (const combo of combos) {
        const accelerator = comboToAccelerator(combo);
        if (!accelerator) {
          result[combo] = 'unsupported';
          continue;
        }
        try {
          // If we (or anything in-process) already hold it, treat as available:
          // it is not owned by another app, which is what matters here.
          if (globalShortcut.isRegistered(accelerator)) {
            result[combo] = 'available';
            continue;
          }
          const registered = globalShortcut.register(accelerator, () => {});
          if (registered) {
            globalShortcut.unregister(accelerator);
            result[combo] = 'available';
          } else {
            result[combo] = 'taken';
          }
        } catch {
          // Malformed accelerator or platform refusal: cannot probe.
          result[combo] = 'unsupported';
        }
      }
      return result;
    },
  );

  // === Agents ===
  // The inventory is cached across calls (bootstrap, welcome screen, Settings,
  // and the column manager all request it) and rebuilt only on agent-config
  // change or an explicit forceRefresh (the Agent settings "re-detect" button).
  // See src/main/agent/agent-list.ts.
  ipcMain.handle(IPC.AGENT_LIST, async (_event, forceRefresh?: boolean): Promise<AgentDetectionInfo[]> => {
    const config = context.configManager.load();
    return listAgents(config.agent.cliPaths, forceRefresh ?? false);
  });

  // "Test connection" in the Agent settings tab. Reads the server record
  // (url + auth, including the password) directly from config rather than
  // accepting one from the renderer, so the password never has to round-trip
  // through the renderer process. Never throws: an agent with no
  // remoteExecution capability, or no configured server, reports unreachable
  // with a clear reason instead of an IPC error.
  ipcMain.handle(IPC.AGENT_PROBE_EXECUTION_SERVER, async (_event, agentName: string): Promise<RemoteServerStatus> => {
    const adapter = agentRegistry.get(agentName);
    if (!adapter?.remoteExecution) {
      return { reachable: false, reason: `${agentName} does not support remote execution` };
    }
    const config = context.configManager.load();
    const server = config.agent.executionServers[agentName];
    if (!server) {
      return { reachable: false, reason: 'No server configured' };
    }
    try {
      return await adapter.remoteExecution.probeServer(server);
    } catch (error) {
      return { reachable: false, reason: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Sliding-window rate limit for summarize calls. Each entry is a Date.now()
  // timestamp. We expire entries older than 1 hour on every check. A burst of
  // task creation can otherwise spam the agent CLI and burn the user's
  // subscription quota; this caps the damage. The window is in-memory only -
  // a restart clears the limit, which is the correct behavior (the user has
  // explicitly chosen to start a new session).
  const summarizeRateLimitWindow: number[] = [];
  const ONE_HOUR_MS = 60 * 60 * 1000;

  // Summarize a free-form prompt into a short task title via the active
  // project's default agent (or `input.agentName` if provided). Returns a
  // discriminated result so renderer code can show a graceful error toast
  // instead of throwing. Adapters without the `summarize` capability or
  // CLIs that fail detection produce `{ ok: false, reason }`.
  ipcMain.handle(
    IPC.AGENT_SUMMARIZE,
    async (_, input: AgentSummarizeInput): Promise<AgentSummarizeResult> => {
      try {
        const prompt = (input?.prompt ?? '').trim();
        if (!prompt) return { ok: false, reason: 'empty prompt' };

        const { agentRegistry } = await import('../../agent/agent-registry');
        const config = context.configManager.load();

        // Apply the sliding-window rate limit before doing any work.
        const limit = config.autoNameRateLimitPerHour ?? 60;
        if (limit > 0) {
          const now = Date.now();
          const cutoff = now - ONE_HOUR_MS;
          while (summarizeRateLimitWindow.length > 0 && summarizeRateLimitWindow[0] < cutoff) {
            summarizeRateLimitWindow.shift();
          }
          if (summarizeRateLimitWindow.length >= limit) {
            return {
              ok: false,
              reason: `rate limit reached (${limit}/hour); try again later or raise the cap in Settings`,
            };
          }
          summarizeRateLimitWindow.push(now);
        }

        // Resolve which adapter to ask. Caller may name a specific agent
        // (e.g. for transient sessions); otherwise fall back to the active
        // project's default agent, then to the registry's first entry.
        let agentName = input.agentName;
        if (!agentName && context.currentProjectId) {
          const project = context.projectRepo
            .list()
            .find((entry) => entry.id === context.currentProjectId);
          agentName = project?.default_agent ?? undefined;
        }
        if (!agentName) {
          const list = agentRegistry.list();
          agentName = list[0];
        }
        if (!agentName) return { ok: false, reason: 'no agents registered' };

        const adapter = agentRegistry.get(agentName);
        if (!adapter) return { ok: false, reason: `unknown agent: ${agentName}` };
        if (typeof adapter.summarize !== 'function') {
          return { ok: false, reason: `${adapter.displayName} does not support summarize` };
        }

        const cliPathOverride = config.agent.cliPaths[agentName] ?? null;
        const info = await adapter.detect(cliPathOverride);
        if (!info.found || !info.path) {
          return { ok: false, reason: `${adapter.displayName} CLI not found` };
        }

        const cwd = context.currentProjectPath ?? process.cwd();
        const title = await adapter.summarize(prompt, info.path, cwd);
        if (!title) return { ok: false, reason: 'summarize produced empty output' };
        return { ok: true, title };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: message };
      }
    },
  );

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

  // === Fonts ===
  ipcMain.handle(IPC.FONT_GET_AVAILABLE, () => context.fontResolver.getAvailableFonts());

  // Normalize so a path the renderer joined with forward slashes (git paths use
  // '/') opens correctly on Windows, which needs native backslash separators -
  // matching the SHELL_SHOW_ITEM_IN_FOLDER handler below.
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_, dirPath: string) => shell.openPath(path.normalize(dirPath)));
  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, (_, url: string) => shell.openExternal(url));
  // Normalize so a worktree-relative path joined with forward slashes in the
  // renderer (git paths use '/') resolves correctly on Windows, where
  // showItemInFolder needs native backslash separators.
  ipcMain.handle(IPC.SHELL_SHOW_ITEM_IN_FOLDER, (_, fullPath: string) => { shell.showItemInFolder(path.normalize(fullPath)); });

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
  // Resolve the window that actually sent the IPC message (falling back to the main
  // window for a channel invoked outside a BrowserWindow's webContents, which should
  // not happen in practice). This is what lets frameless pop-out windows draw their own
  // custom minimize/maximize/close controls and have them operate on themselves rather
  // than always hitting the main window.
  function resolveSenderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): Electron.BrowserWindow {
    return BrowserWindow.fromWebContents(event.sender) ?? context.mainWindow;
  }
  ipcMain.on(IPC.WINDOW_MINIMIZE, (event) => resolveSenderWindow(event).minimize());
  ipcMain.on(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = resolveSenderWindow(event);
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.on(IPC.WINDOW_CLOSE, (event) => resolveSenderWindow(event).close());
  ipcMain.on(IPC.WINDOW_FLASH_FRAME, (event, flash: boolean) => resolveSenderWindow(event).flashFrame(flash));
  ipcMain.handle(IPC.WINDOW_IS_FOCUSED, (event) => resolveSenderWindow(event).isFocused());

  // === Notifications ===
  ipcMain.on(IPC.NOTIFICATION_SHOW, (_event, input: NotificationInput) => showDesktopNotification(context, input));

  // === Clipboard ===
  // Read the clipboard image natively in the main process rather than via the web
  // `navigator.clipboard.read()`. The native path avoids the document-focus
  // requirement (the terminal may not hold document focus when Ctrl+V fires) and
  // behaves identically on Windows/macOS/Linux, where the web Clipboard API's image
  // support is inconsistent. Returns the saved PNG file path, or null when the
  // clipboard holds no image. Always PNG: a NativeImage is a still bitmap, so an
  // animated GIF copied from a browser is reduced to a single static frame, matching
  // how OS "copy screenshot" already populates the clipboard.
  ipcMain.handle(IPC.CLIPBOARD_READ_IMAGE, (): string | null => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const tempDir = path.join(os.tmpdir(), 'kangentic-clipboard');
    fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `pasted-image-${Date.now()}.png`);
    fs.writeFileSync(filePath, image.toPNG());
    return filePath;
  });

  // Write text to the clipboard natively in the main process rather than via the web
  // `navigator.clipboard.writeText()`. Electron's clipboard module is synchronous and
  // focus- and permission-independent, whereas the web API rejects with NotAllowedError
  // when the document does not hold focus - exactly the state during a native context-menu
  // click (Menu.popup steals focus) and the case a TUI app's OSC 52 copy sequence hits.
  // Same rationale as CLIPBOARD_READ_IMAGE above.
  ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, (_event, text: string): void => {
    if (typeof text !== 'string' || text.length === 0) return;
    clipboard.writeText(text);
  });

  // === Handoffs ===
  ipcMain.handle(IPC.HANDOFF_LIST, (_, taskId: string): HandoffRecord[] => {
    const projectId = context.currentProjectId;
    if (!projectId) return [];
    const db = getProjectDb(projectId);
    const handoffRepo = new HandoffRepository(db);
    return handoffRepo.listByTaskId(taskId);
  });
}

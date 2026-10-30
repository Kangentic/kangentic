import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, ipcMain, Notification, dialog, shell, globalShortcut, clipboard, nativeImage } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { comboToAccelerator } from '../../../shared/keybindings';
import { WorktreeManager } from '../../git/worktree-manager';
import { gitFetchScheduler } from '../../git/git-fetch-scheduler';
import { isGitRepo } from '../../git/git-checks';
import { deepMergeConfig } from '../../../shared/object-utils';
import { getProjectDb } from '../../db/database';
import { HandoffRepository } from '../../db/repositories/handoff-repository';
import { syncProjectMcpConfig } from './projects';
import { applyRuntimeConfig } from '../../config/apply-runtime-config';
import { refreshPlanApprovals } from '../../plan-approval/plan-approval-writer';
import { listAgents, invalidateAgentListCache, nameLearnedModels } from '../../agent/agent-list';
import { agentRegistry } from '../../agent/agent-registry';
import { tryAcquireSummarizeSlot } from '../../agent/shared/summarize-rate-limit';
import { resolveAutomationAgent, runNamingCall } from '../../automations/automation-agent';
import { automationAgentDeps } from '../helpers/automation-agent-deps';
import { backgroundCallSink } from '../helpers/background-call-sink';
import { broadcast } from '../../pop-out/window-broadcast';
import { resolveRelayUrl } from '../../../shared/relay';
import { EXTERNAL_OPEN_SCHEMES, isAllowedExternalUrl } from '../../../shared/external-url';
import { readClipboardImage, writePastedImage } from '../helpers/clipboard-image';
import { openPathBounded } from '../helpers/open-path';
import { resolveShellLaunch } from '../../pty/spawn/shell-launch';
import { childProcessEnv } from '../../shared/child-env';
import { COMMAND_TERMINAL_NOTIFICATION_TASK_ID } from '../../../shared/notification-constants';
import type {
  NotificationInput,
  AgentCommand,
  AgentDetectionInfo,
  AgentSummarizeInput,
  AgentSummarizeResult,
  HandoffRecord,
  RemoteServerStatus,
  SelectFolderOptions,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

// Held only so a shown Notification is not garbage-collected before the user
// interacts with it (Electron's Notification has no other owner).
const activeNotifications = new Set<Notification>();

/**
 * The OS identity of a task's toast. `id` (the Windows toast Tag, the macOS
 * UNNotificationRequest identifier) is the task id, so a new toast for a task
 * REPLACES the one already in Action Center or Notification Center instead of
 * stacking beside it: the newest state (finished, crashed, waiting) is the only
 * one worth acting on. `groupId` is the project, so a project's toasts group
 * together. Task and project ids are uuidv4, 36 characters, under the 64 Windows
 * allows for a Tag or a Group.
 *
 * The Command Terminal sentinel takes no `id`: it stands for every Command
 * Terminal in every project, so one shared id would collapse them all into a
 * single toast. Electron then gives each a random id, as before.
 */
export function notificationIdentity(input: NotificationInput): { id?: string; groupId: string } {
  if (input.taskId === COMMAND_TERMINAL_NOTIFICATION_TASK_ID) return { groupId: input.projectId };
  return { id: input.taskId, groupId: input.projectId };
}

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
    ...notificationIdentity(input),
  });

  activeNotifications.add(notification);

  const cleanup = () => {
    activeNotifications.delete(notification);
  };

  // Since Electron 42 macOS notifications go through UNNotification, which
  // needs a signed app and the user's permission: an unsigned `npm start` or a
  // user who denied notifications gets `failed` and never `close`. Without this
  // the toast vanished with no trace and its object stayed in
  // activeNotifications for the rest of the run.
  notification.on('failed', (_failedEvent, error) => {
    console.warn('[NOTIFICATION] The OS did not show a notification:', error);
    cleanup();
  });

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

interface CaptureRect { x: number; y: number; width: number; height: number }

/** A rect the renderer sent: four finite numbers, with a size to capture. */
function isCaptureRect(value: unknown): value is CaptureRect {
  if (typeof value !== 'object' || value === null) return false;
  const rect = value as Record<string, unknown>;
  return [rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === 'number' && Number.isFinite(part))
    && (rect.width as number) > 0 && (rect.height as number) > 0;
}

export function registerSystemHandlers(context: IpcContext): void {
  // === App ===
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion());

  // === Config ===
  ipcMain.handle(IPC.CONFIG_GET, (_event, projectId?: string | null) => {
    // Another registered project's, for a workflow's planned task on its board
    // (its default base branch and Worktrees switch); the open project's otherwise.
    const otherProject = projectId && projectId !== context.currentProjectId ? context.projectRepo.getById(projectId) : undefined;
    if (projectId && projectId !== context.currentProjectId && !otherProject) throw new Error('Unknown project');
    const config = context.configManager.getEffectiveConfig(otherProject ? otherProject.path : context.currentProjectPath || undefined);
    // Overlay board config's defaultBaseBranch (team-shared) onto the effective config.
    // Spread to avoid mutating the cached config object from ConfigManager.
    const boardDefaultBranch = otherProject
      ? context.boardConfigManager.getDefaultBaseBranchForPath(otherProject.path)
      : context.boardConfigManager.getDefaultBaseBranch();
    if (boardDefaultBranch) {
      return { ...config, git: { ...config.git, defaultBaseBranch: boardDefaultBranch } };
    }
    return config;
  });
  ipcMain.handle(IPC.CONFIG_GET_GLOBAL, () => context.configManager.load());

  ipcMain.handle(IPC.CONFIG_SET, (_, config) => {
    // `persisted` is returned rather than discarded so the ONE caller that represents a
    // deliberate user gesture - the settings panel's `updateSetting` - can say "this
    // setting did not save". It cannot be decided here: this channel also carries the
    // window-layout blobs, the discovered-model caches, and announcement dismissals, so
    // treating every CONFIG_SET as user-initiated would just move the bounds-timer spam
    // up a layer. The machine-level condition is reported separately and once, through
    // config:writeFailed (see write-failure-notice.ts).
    const persisted = context.configManager.save(config);
    applyRuntimeConfig(context.sessionManager, context.configManager, context.currentProjectPath);
    // Invalidate cached detection for all agents so the next detect() call picks up new cliPaths,
    // and drop the cached agents.list() result so it rebuilds against the new config.
    if (config.agent) {
      // The global permission mode is what an approved plan continues in when
      // its task stays in plan mode.
      refreshPlanApprovals();
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
    // Re-evaluate the embed-worker warm-hold: toggling knowledgeGraph.enabled off
    // should release the resident worker promptly rather than waiting for its
    // next idle-recycle window.
    if (config.knowledgeGraph) {
      void import('../../retrieval/retrieval-service').then(({ retrievalService }) => {
        retrievalService.reconcileEmbedWorker(context);
      });
    }
    // Toggling the mobile bridge on/off, or changing the relay URL, takes
    // effect immediately without reopening the app.
    if (config.mobileBridge) {
      const effectiveConfig = context.configManager.getEffectiveConfig(context.currentProjectPath || undefined);
      context.mobileBridgeService.reconcile({
        enabled: effectiveConfig.mobileBridge?.enabled ?? false,
        relayUrl: resolveRelayUrl(effectiveConfig.mobileBridge),
      });
    }
    // Bare-signal broadcast so every open pop-out window re-fetches via config:get and
    // stays in theme/settings sync (they subscribe through config.onChanged in
    // usePopOutBootstrap). The main window is a harmless extra recipient: it does not
    // subscribe, updating its own config store optimistically at the config.set call site.
    //
    // Fires regardless of whether the write reached disk: the in-memory config changed
    // either way (configManager.save() keeps serving it - see write-failure-notice.ts),
    // so every window's optimistic read should still match. A write failure is reported
    // separately, through config:writeFailed, not by skipping this broadcast.
    broadcast(context.mainWindow, IPC.CONFIG_CHANGED);
    return { persisted };
  });

  // Synchronous sibling of CONFIG_SET for the renderer's quit/unload flush: an async
  // invoke() can be dropped if the renderer tears down before the main process drains it,
  // so the final window-layout write goes through sendSync, which blocks the renderer until
  // configManager.save() (a synchronous fs write) has persisted it. Intentionally minimal:
  // no runtime re-apply or detection invalidation, both irrelevant during shutdown.
  //
  // returnValue carries whether the write actually reached disk (previously hardcoded
  // true): a throw here used to leave returnValue unassigned, so the channel reported
  // success and failure identically. Nothing reads it yet: the preload bridge discards the
  // sendSync result and `ElectronAPI.config.setSync` returns void. The user-facing half is
  // the CONFIG_WRITE_FAILED toast safeWriteJson already pushes.
  ipcMain.on(IPC.CONFIG_SET_SYNC, (event, config) => {
    event.returnValue = context.configManager.save(config);
  });

  ipcMain.handle(IPC.CONFIG_GET_PROJECT, () => {
    if (!context.currentProjectPath) return null;
    return context.configManager.loadProjectOverrides(context.currentProjectPath);
  });

  ipcMain.handle(IPC.CONFIG_SET_PROJECT, (_, overrides) => {
    if (!context.currentProjectPath) throw new Error('No project open');
    const persisted = context.configManager.saveProjectOverrides(context.currentProjectPath, overrides);
    applyRuntimeConfig(context.sessionManager, context.configManager, context.currentProjectPath);
    // The project's permission mode is what an approved plan continues in when
    // its task stays in plan mode, as in CONFIG_SET.
    if (overrides?.agent) refreshPlanApprovals();
    // A per-project override changes the EFFECTIVE config open pop-outs read (the Changes
    // surface reads git.defaultBaseBranch, which is project-overridable), so fan the same
    // bare signal CONFIG_SET does so they re-fetch instead of diffing a stale base branch.
    // Same "fires either way" reasoning as CONFIG_SET's broadcast above.
    broadcast(context.mainWindow, IPC.CONFIG_CHANGED);
    return { persisted };
  });

  ipcMain.handle(IPC.CONFIG_GET_PROJECT_BY_PATH, (_, projectPath: string) => {
    const known = context.projectRepo.list().some((p) => p.path === projectPath);
    if (!known) throw new Error('Unknown project path');
    return context.configManager.loadProjectOverrides(projectPath);
  });

  ipcMain.handle(IPC.CONFIG_SET_PROJECT_BY_PATH, (_, projectPath: string, overrides) => {
    const project = context.projectRepo.list().find((p) => p.path === projectPath);
    if (!project) throw new Error('Unknown project path');
    const persisted = context.configManager.saveProjectOverrides(projectPath, overrides);
    // Every project's live sessions keep a decision file, a background
    // project's too, so this one does not wait for the project to open.
    if (overrides?.agent) refreshPlanApprovals();
    // Background projects pick up changes when they next open; only the
    // currently-open project needs its in-memory state refreshed now.
    if (projectPath === context.currentProjectPath) {
      applyRuntimeConfig(context.sessionManager, context.configManager, projectPath);
      // Sync open pop-outs of the current project to the changed effective config (see
      // the CONFIG_SET_PROJECT broadcast note). Scoped to the current project since only
      // its pop-outs are open.
      broadcast(context.mainWindow, IPC.CONFIG_CHANGED);
      // Restart the PR-refresh queue so a flipped Auto-refresh PRs switch (Git
      // tab) takes effect immediately without reopening the project. Imported lazily so registering
      // the system handlers does not pull the gh-backed PR runtime into this
      // module's graph (keeps unit tests that stub node:child_process light).
      void import('../../pr/pr-refresh-scheduler').then(({ prRefreshScheduler }) => {
        prRefreshScheduler.startForProject(context, project);
      });
      // Restart the background remote-fetch clock for the same reason. A static
      // import: the scheduler's graph (worktree manager, fetch throttle) is
      // already part of this module's, so there is no runtime to keep out.
      gitFetchScheduler.startForProject(context, project);
      // Re-run the conversation-memory sweep so toggling knowledgeGraph.indexingEnabled
      // on takes effect without reopening the project.
      void import('../../retrieval/retrieval-service').then(({ retrievalService }) => {
        retrievalService.startForProject(context, project);
      });
    }
    return { persisted };
  });

  // Left returning a bare count on purpose, not { persisted }: one user click here writes
  // one file PER PROJECT, so routing it through the settings panel's failure toast would
  // fire N times for a single condition. It already reports honestly - the per-project
  // check below keeps `updatedCount` truthful when some projects are unwritable.
  ipcMain.handle(IPC.CONFIG_SYNC_DEFAULT_TO_PROJECTS, (_, partial) => {
    const projects = context.projectRepo.list();
    let updatedCount = 0;
    for (const project of projects) {
      const existing = context.configManager.loadProjectOverrides(project.path) || {};
      const merged = deepMergeConfig(existing, partial);
      // One unwritable project's directory must not abort the sync for its siblings,
      // and must not count as "updated" - saveProjectOverrides() no longer throws
      // (see write-failure-notice.ts), so this loop needs its own per-project check
      // to keep the returned count honest.
      if (context.configManager.saveProjectOverrides(project.path, merged)) {
        updatedCount++;
      }
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
  // comboToAccelerator never emits (modifier + letter, digit, F-key, Tab or `
  // only), so the probe is not subject to that false-'taken' case.
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
  // See src/main/agent/agent-list.ts. The labels for telemetry-learned model
  // ids go on per call, outside the cache, so a newly learned id is named on
  // the next request without a rebuild.
  // CLI paths are per project: the list is detected against the effective paths
  // of the project the caller names (the Agent tab editing another project), else
  // the open project's. With no project open it falls back to the global values.
  ipcMain.handle(IPC.AGENT_LIST, async (_event, forceRefresh?: boolean, projectPath?: string): Promise<AgentDetectionInfo[]> => {
    const globalConfig = context.configManager.load();
    const targetProjectPath = projectPath ?? context.currentProjectPath ?? undefined;
    const effectiveConfig = targetProjectPath ? context.configManager.getEffectiveConfig(targetProjectPath) : globalConfig;
    const agents = await listAgents(effectiveConfig.agent.cliPaths, forceRefresh ?? false);
    return nameLearnedModels(agents, globalConfig.discoveredModelsByAgent);
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

  // Summarize a free-form prompt into a short task title on the Automation
  // agent (`AppConfig.automation`), its model and effort. With no Automation
  // agent naming is off: the renderer hides its affordances on the same
  // predicate (`namingAgentReady`), and this refuses with the reason, so the
  // two cannot disagree. Returns a discriminated result so renderer code can
  // show a graceful error toast instead of throwing.
  ipcMain.handle(
    IPC.AGENT_SUMMARIZE,
    async (_, input: AgentSummarizeInput): Promise<AgentSummarizeResult> => {
      try {
        const prompt = (input?.prompt ?? '').trim();
        if (!prompt) return { ok: false, reason: 'empty prompt' };

        const config = context.configManager.load();
        // Resolved BEFORE the rate limit, so a refusal spends no slot.
        const projectPath = input.projectId ? context.projectRepo.getById(input.projectId)?.path ?? null : context.currentProjectPath;
        const resolved = await resolveAutomationAgent(automationAgentDeps(context, projectPath), 'naming');
        if (!resolved.ok) return { ok: false, reason: resolved.reason };

        // The sliding-window rate limit, shared with main's Command Terminal
        // namer (summarize-rate-limit.ts).
        const limit = config.autoNameRateLimitPerHour ?? 60;
        if (!tryAcquireSummarizeSlot(limit)) {
          return {
            ok: false,
            reason: `rate limit reached (${limit}/hour); try again later or raise the cap in Settings`,
          };
        }

        // Recorded in the ledger of the project the title is for, read when
        // the request was made rather than whatever is open now.
        const title = await runNamingCall(resolved, prompt, backgroundCallSink(context), {
          projectId: input.projectId ?? context.currentProjectId ?? null,
          job: 'task_title',
          taskId: input.taskId ?? null,
        });
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
  // matching the SHELL_SHOW_ITEM_IN_FOLDER handler below. Bounded because a
  // raw shell.openPath can outlive this invoke on Linux, where it waits on
  // xdg-open, and Electron then raises "reply was never sent" in the renderer.
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_, dirPath: string) => openPathBounded(path.normalize(dirPath)));
  // shell.openExternal is ShellExecute on Windows and will launch any
  // registered protocol handler, so this is a process trust boundary -
  // reject anything outside the allowlist instead of passing it straight to
  // the OS. A rejected URL is silently inert (warn + no-op) rather than
  // thrown, because several callers invoke this as a bare `void` with no
  // .catch (e.g. MarkdownRenderer's link handler on agent-authored markdown).
  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, (_, url: string) => {
    if (!isAllowedExternalUrl(url, EXTERNAL_OPEN_SCHEMES)) {
      console.warn(`[SHELL_OPEN_EXTERNAL] Blocked disallowed URL: ${url}`);
      return;
    }
    return shell.openExternal(url);
  });
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
    // Detached and never killed, so a dev server started here can outlive the
    // app. resolveShellLaunch keeps it from holding Crashpad's port on macOS,
    // and childProcessEnv from carrying its pipe name on Windows.
    const launch = resolveShellLaunch({ command });
    const child = spawn(launch.file, launch.args, {
      cwd,
      env: childProcessEnv(),
      shell: launch.shell,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { pid: child.pid };
  });

  // === Git ===
  ipcMain.handle(IPC.GIT_DETECT, (_event, forceRefresh?: boolean) => {
    if (forceRefresh) context.gitDetector.invalidateCache();
    return context.gitDetector.detect();
  });

  // The open project's branches, or another registered project's for a
  // workflow's planned task on its board (an unknown one has none).
  ipcMain.handle(IPC.GIT_LIST_BRANCHES, async (_event, projectId?: string | null) => {
    const projectPath = projectId && projectId !== context.currentProjectId
      ? context.projectRepo.getById(projectId)?.path ?? null
      : context.currentProjectPath;
    if (!projectPath || !isGitRepo(projectPath)) return [];
    try {
      const worktreeManager = new WorktreeManager(projectPath);
      return await worktreeManager.listRemoteBranches();
    } catch { return []; }
  });

  // === Dialog ===
  // The parent of the last folder this dialog returned. Electron 43 stopped letting the OS
  // remember where a folder dialog was last left: with no defaultPath it now opens in
  // Downloads. This puts the remembering back for the session.
  let lastPickedFolderParent: string | null = null;
  ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async (_event, options?: SelectFolderOptions) => {
    // Both additions are scoped to callers that actually pass options (today: Add project).
    // The no-argument callers - relocating a project, locating one whose folder moved - are
    // pointing at a folder that already exists, so they start where the user last picked a
    // folder (home before the first pick, never Downloads), and offering "New folder" there
    // invites creating an empty directory that cannot be the thing they were asked to find.
    const result = await dialog.showOpenDialog(context.mainWindow, {
      properties: options ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
      title: options?.title,
      buttonLabel: options?.buttonLabel,
      message: options?.message,
      defaultPath: options
        ? (options.defaultPath ?? app.getPath('home'))
        : (lastPickedFolderParent ?? app.getPath('home')),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    lastPickedFolderParent = path.dirname(result.filePaths[0]);
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
  // The SENDER's own pixels, so a terminal dragged in the Command Terminal's
  // own window pictures that window and not the main one. The renderer measures
  // in CSS pixels; capturePage takes the page's DIPs, so the zoom factor scales it.
  ipcMain.handle(IPC.WINDOW_CAPTURE_REGION, async (event, rect: unknown): Promise<string | null> => {
    if (!isCaptureRect(rect)) return null;
    try {
      // Inside the try: a sender destroyed since it asked throws on any call.
      const zoom = event.sender.getZoomFactor();
      const image = await event.sender.capturePage({
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom),
      });
      if (image.isEmpty()) return null;
      return `data:image/jpeg;base64,${image.toJPEG(90).toString('base64')}`;
    } catch {
      return null;
    }
  });

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
  //
  // The image is capped at IMAGE_LONG_EDGE_CAP before it is written, so a raw 4K
  // or 5K grab does not land on disk and cross the bridge at full size. This
  // costs no fidelity and saves no tokens: the cap sits at the knee where the
  // chain normalizes anyway, so the dropped pixels are ones the model would
  // never have seen. See `src/shared/image-fidelity.ts` for what was measured.
  ipcMain.handle(IPC.CLIPBOARD_READ_IMAGE, async (): Promise<string | null> => {
    const image = await readClipboardImage(clipboard, (bytes) => nativeImage.createFromBuffer(bytes));
    if (!image) return null;
    // A write failure degrades to the same null an empty clipboard returns
    // rather than rejecting the renderer's invoke (see writePastedImage).
    return writePastedImage(image);
  });

  // Save PNG bytes the renderer decoded from a dropped image file into the same
  // temp directory, under the same cap and prune, and return the path. This is
  // the drop-path twin of CLIPBOARD_READ_IMAGE for a format the agent CLI cannot
  // take from a path (a bmp: outside Claude Code's native paste scan, and its
  // Read tool refuses the file as binary). The renderer decodes because it
  // already holds the dropped File and Chromium reads every format `<img>`
  // does; main's `nativeImage` decodes only PNG and JPEG, so the bytes arrive
  // here already PNG and the decode below is a validity check, not a
  // conversion. Null for anything that is not a decodable image, so the
  // renderer falls back to the path it had.
  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, (_event, pngBytes: unknown): string | null => {
    if (!(pngBytes instanceof Uint8Array) || pngBytes.byteLength === 0) return null;
    const image = nativeImage.createFromBuffer(
      Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength),
    );
    if (image.isEmpty()) return null;
    return writePastedImage(image);
  });

  // Write text to the clipboard natively in the main process rather than via the web
  // `navigator.clipboard.writeText()`. Electron's clipboard module is focus- and
  // permission-independent, whereas the web API rejects with NotAllowedError when the
  // document does not hold focus - exactly the state during a native context-menu click
  // (Menu.popup steals focus) and the case a TUI app's OSC 52 copy sequence hits. Since
  // Electron 44 the write is a promise; awaiting it lets a failed write reach the
  // renderer's own catch. Same rationale as CLIPBOARD_READ_IMAGE above.
  ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, async (_event, text: string): Promise<void> => {
    if (typeof text !== 'string' || text.length === 0) return;
    await clipboard.writeText(text);
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

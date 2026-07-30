import { type BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { ProjectOpenByPathOverrides } from '../../shared/types';
import { trackEvent, sanitizeErrorMessage } from '../analytics/analytics';
import { ProjectRepository } from '../db/repositories/project-repository';
import { ProjectGroupRepository } from '../db/repositories/project-group-repository';
import { SessionManager } from '../pty/session-manager';
import { ConfigManager } from '../config/config-manager';
import { BoardConfigManager } from '../config/board-config-manager';
import { DiffWatcher } from '../git/diff-watcher';
import { GitDetector } from '../git/git-detector';
import { ShellResolver } from '../pty/spawn/shell-resolver';
import { FontResolver } from '../font-resolver';
import { TerminalSubmitScheduler } from '../transition-engine/terminal-submit-scheduler';
import { createPasteEngine } from '../pty/paste-engine';
import { TerminalSubmit } from '../pty/terminal-submit';
import {
  registerProjectHandlers,
  cleanupProject as cleanupProjectImpl,
  deleteProjectFromIndex as deleteProjectFromIndexImpl,
  pruneStaleWorktreeProjects as pruneStaleWorktreeProjectsImpl,
  openProjectByPath as openProjectByPathImpl,
  activateAllProjects as activateAllProjectsImpl,
  getLastOpenedProject as getLastOpenedProjectImpl,
} from './handlers/projects';
import { registerTaskCrudHandlers } from './handlers/task-crud';
import { registerTaskArchiveHandlers } from './handlers/task-archive';
import { registerTaskMoveHandlers } from './handlers/task-move';
import { registerTaskBranchHandlers } from './handlers/task-branch';
import { registerTaskRuntimeOverrideHandlers } from './handlers/task-runtime-override';
import { registerSessionHandlers } from './handlers/sessions';
import { startMetricsSnapshotTimer } from './handlers/metrics-snapshot-timer';
import { registerTransientSessionHandlers } from './handlers/transient-sessions';
import { registerTranscriptionHandlers } from './handlers/transcription';
import { TranscriptionService } from '../transcription/transcription-service';
import { registerBoardHandlers } from './handlers/board';
import { registerSystemHandlers, showDesktopNotification } from './handlers/system';
import { registerBacklogHandlers } from './handlers/backlog';
import { registerGitDiffHandlers } from './handlers/git-diff';
import { registerBrowserHandlers } from './handlers/browser';
import { registerSearchHandlers } from './handlers/search';
import { registerTranscriptHandlers } from './handlers/transcripts';
import { registerMobileBridgeHandlers } from './handlers/mobile-bridge';
import { registerUsageStatsHandlers } from './handlers/usage-stats';
import { registerPopOutHandlers } from './handlers/pop-out';
import { registerMonitorHandlers } from './handlers/monitor';
import { registerTaskDetailOwnershipHandlers } from './handlers/task-detail-ownership';
import { retrievalService } from '../retrieval/retrieval-service';
import { MobileBridgeService } from '../mobile-bridge/mobile-bridge-service';
import { BoardEventBus } from '../mobile-bridge/board-event-bus';
import { DesktopNotifier } from '../notifications/desktop-notifier';
import { ActivityIntervalRecorder } from '../activity-engine/activity-interval-recorder';
import { ActivityIntervalStore } from '../activity-engine/activity-interval-store';
import { getProjectDb } from '../db/database';
import { getProjectRepos } from './helpers';
import { KANGENTIC_HOSTED_RELAY_URL, resolveRelayUrl } from '../../shared/relay';
import type { IpcContext } from './ipc-context';
import type { McpHttpServerHandle } from '../agent/mcp-http-server';

let context: IpcContext | null = null;

function requireContext(): IpcContext {
  if (!context) throw new Error('IPC not initialized -- call registerAllIpc first');
  return context;
}

/**
 * Returns the live IpcContext if it has been initialized, otherwise null.
 * Used by the in-process MCP HTTP server to look up the current project
 * context per request without throwing during the startup window.
 */
export function getOptionalIpcContext(): IpcContext | null {
  return context;
}

export function registerAllIpc(mainWindow: BrowserWindow, mcpServerHandle: McpHttpServerHandle | null = null): void {
  // Idempotent: on macOS, activate → createWindow() may call this again.
  // Just update the window reference and return. ipcMain.handle calls
  // must NOT run twice (throws "Attempted to register a second handler").
  if (context) {
    context.mainWindow = mainWindow;
    if (mcpServerHandle) context.mcpServerHandle = mcpServerHandle;
    return;
  }

  // Eagerly create SessionManager + PasteEngine + TerminalSubmit +
  // TerminalSubmitScheduler (lightweight, needed early). TerminalSubmit is
  // the unified byte-pushing engine (submitContent + submitKeystrokes);
  // TerminalSubmitScheduler layers task-keyed scheduling (cancel,
  // fresh-spawn wait, drag-burst coalesce) on top. pasteEngine remains for
  // now until Step 4 of the migration deletes it.
  const sessionManager = new SessionManager();
  const pasteEngine = createPasteEngine(sessionManager);
  const terminalSubmit = new TerminalSubmit(sessionManager, pasteEngine);
  const terminalSubmitScheduler = new TerminalSubmitScheduler(sessionManager, terminalSubmit);
  const transcriptionService = new TranscriptionService();
  const boardConfigManager = new BoardConfigManager({
    ephemeral: process.argv.includes('--ephemeral'),
  });
  const diffWatcher = new DiffWatcher();
  // Placeholder config -- reconciled to the real effective config right
  // after `context` (and its configManager getter) is constructed below,
  // since MobileBridgeService's constructor needs a config synchronously
  // but configManager itself is only available once `context` exists.
  const mobileBridgeService = new MobileBridgeService({ enabled: false, relayUrl: KANGENTIC_HOSTED_RELAY_URL });
  const boardEvents = new BoardEventBus();
  // Owns the desktop idle/crash notification decision (cooldown, focus gate,
  // active-project gate, title assembly). Every option closure goes through
  // requireContext() rather than capturing `context` directly: this notifier
  // is constructed before `context` is assigned below, and its callbacks only
  // ever run later (in response to a SessionManager event), by which point
  // `context` is set.
  const desktopNotifier = new DesktopNotifier({
    sessionManager,
    getNotificationConfig: () => requireContext().configManager.load().notifications,
    getActiveProjectId: () => requireContext().currentProjectId ?? undefined,
    isWindowFocused: () => {
      const mainWindow = requireContext().mainWindow;
      return !mainWindow.isDestroyed() && mainWindow.isFocused();
    },
    flashFrame: () => {
      const mainWindow = requireContext().mainWindow;
      if (!mainWindow.isDestroyed()) mainWindow.flashFrame(true);
    },
    resolveTaskTitle: (projectId, taskId) => {
      try {
        return getProjectRepos(requireContext(), projectId).tasks.getById(taskId)?.title;
      } catch {
        return undefined;
      }
    },
    resolveProjectName: (projectId) => requireContext().projectRepo.getById(projectId)?.name,
    showNotification: (input) => showDesktopNotification(requireContext(), input),
  });

  // Lazy-initialize heavy objects on first access
  let projectRepo: ProjectRepository | null = null;
  let projectGroupRepo: ProjectGroupRepository | null = null;
  let configManager: ConfigManager | null = null;
  let gitDetector: GitDetector | null = null;
  let shellResolver: ShellResolver | null = null;
  let fontResolver: FontResolver | null = null;

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
    diffWatcher,
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
    get fontResolver() {
      if (!fontResolver) fontResolver = new FontResolver();
      return fontResolver;
    },
    terminalSubmitScheduler,
    terminalSubmit,
    transcriptionService,
    currentProjectId: null,
    currentProjectPath: null,
    recoveredProjects: new Set<string>(),
    mcpServerHandle,
    mobileBridgeService,
    boardEvents,
    desktopNotifier,
  };

  // The bridge needs IpcContext (SessionManager, repos, DiffService,
  // commandHandlers) to register its capability-verb handlers - it cannot
  // receive it at construction time above since IpcContext does not exist
  // yet at that point. attachContext() must run before reconcile() so the
  // first reconcile's syncSessions() has handlers to route into.
  mobileBridgeService.attachContext(context);
  desktopNotifier.start();

  // Durable activity-disposition-interval ledger (see
  // activity-interval-recorder.ts and the session_activity_intervals
  // migration comment for why this exists: the engine's own state is
  // in-memory only, and events.jsonl is neither a faithful nor a
  // reliably-retained record of committed transitions). getProjectDb caches
  // connections per project, so resolving a fresh store on every event is
  // cheap - it never opens a new connection.
  const activityIntervalRecorder = new ActivityIntervalRecorder({
    sessionManager,
    getStore: (projectId) => new ActivityIntervalStore(getProjectDb(projectId)),
  });
  activityIntervalRecorder.start();

  const effectiveConfig = context.configManager.getEffectiveConfig(context.currentProjectPath ?? undefined);
  mobileBridgeService.reconcile({
    // Dev-only until the mobile app launches: a production build never
    // enables the bridge regardless of persisted config (paired gates:
    // system.ts's config:set reconcile and the renderer's settings tab).
    enabled: __KANGENTIC_DEV__ && (effectiveConfig.mobileBridge?.enabled ?? false),
    relayUrl: resolveRelayUrl(effectiveConfig.mobileBridge),
  });

  registerProjectHandlers(context);
  registerTaskCrudHandlers(context);
  registerTaskArchiveHandlers(context);
  registerTaskMoveHandlers(context);
  registerTaskBranchHandlers(context);
  registerTaskRuntimeOverrideHandlers(context);
  registerSessionHandlers(context);
  registerTransientSessionHandlers(context);
  registerTranscriptionHandlers(context);
  registerBoardHandlers(context);
  registerBacklogHandlers(context);
  registerGitDiffHandlers(context);
  registerBrowserHandlers(context);
  registerSearchHandlers(context);
  registerTranscriptHandlers(context);
  registerUsageStatsHandlers(context);
  registerSystemHandlers(context);
  registerMobileBridgeHandlers(context);
  registerMonitorHandlers(context);
  registerTaskDetailOwnershipHandlers();
  registerPopOutHandlers(context);

  // Start the central embedding engine's background drain loop at boot, not
  // lazily on the first project:open. attach() is idempotent, so the later
  // startForProject() call on project open just no-ops this part; what
  // matters is the drain loop is alive even before any project is open (it
  // parks on an empty dirty-set until markDirty wakes it).
  retrievalService.attach(context);

  // Periodically flush live-session metrics so an app/OS kill mid-run doesn't
  // lose that run's cost/duration/compactions (stopped on before-quit).
  startMetricsSnapshotTimer(sessionManager);

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

export function getTerminalSubmitScheduler(): TerminalSubmitScheduler {
  return requireContext().terminalSubmitScheduler;
}

export function getBoardConfigManager(): BoardConfigManager {
  return requireContext().boardConfigManager;
}

export function getConfigManager(): ConfigManager {
  return requireContext().configManager;
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

export async function openProjectByPath(projectPath: string, overrides?: ProjectOpenByPathOverrides) {
  return openProjectByPathImpl(requireContext(), projectPath, overrides);
}

export async function activateAllProjects(): Promise<void> {
  return activateAllProjectsImpl(requireContext());
}

export function getLastOpenedProject() {
  return getLastOpenedProjectImpl(requireContext());
}

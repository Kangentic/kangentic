import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { ElectronAPI, NotificationInput, Project, Session, SessionUsage, ActivityState, ActivityReason, SessionEvent, UpdateDownloadedInfo, UsageTimePeriod, UsageStatsScope, UsageDayDrill, UsageCustomWindow, TaskBulkDeleteProgress, ProjectMoveProgress, DictationModelProgress, MobilePairingSasPayload, MobilePairingEndedPayload } from '../shared/types';
import { POPOUT_ARG_PREFIX } from '../shared/pop-out';
import type { PopOutDescriptor, PopOutKind, PopOutParamsByKind } from '../shared/pop-out';
import { installConsoleCapture } from './diagnostics/console-capture';
import { installDevtoolsPreloadHooks } from '../devtools/preload/install-globals';

// Pop-out descriptor: `--kangentic-popout=<base64 JSON>` is appended to a pop-out window's
// additionalArguments by the main process (pop-out-window-manager.ts). Read once at preload
// time; null for the main window, which never carries this flag. Malformed input degrades to
// null rather than throwing, so a bad descriptor falls back to booting the full app.
function readPopOutDescriptor(): PopOutDescriptor | null {
  const arg = process.argv.find((value) => value.startsWith(POPOUT_ARG_PREFIX));
  if (!arg) return null;
  try {
    return JSON.parse(Buffer.from(arg.slice(POPOUT_ARG_PREFIX.length), 'base64').toString('utf-8')) as PopOutDescriptor;
  } catch {
    return null;
  }
}
const popOutDescriptor = readPopOutDescriptor();

// Forward renderer console.* + window error events to the main-process
// diagnostics subsystem. The main side decides whether to persist based on
// the `developer.persistConsoleLogs` toggle. Crashes are always captured.
// Runs at preload time so it survives even if `index.tsx` throws on boot.
installConsoleCapture();

// Dev-only: install window.__kangenticPreviewMutations and
// __kangenticPreviewReact globals so the localhost inspection bridge
// can read DOM mutations + React fiber state via Runtime.evaluate.
// Production builds drop the import + call via `__KANGENTIC_DEV__`.
if (__KANGENTIC_DEV__) {
  installDevtoolsPreloadHooks();
}

const api: ElectronAPI = {
  projects: {
    list: () => ipcRenderer.invoke(IPC.PROJECT_LIST),
    create: (input) => ipcRenderer.invoke(IPC.PROJECT_CREATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.PROJECT_DELETE, id),
    open: (id) => ipcRenderer.invoke(IPC.PROJECT_OPEN, id),
    getCurrent: () => ipcRenderer.invoke(IPC.PROJECT_GET_CURRENT),
    openByPath: (path: string) => ipcRenderer.invoke(IPC.PROJECT_OPEN_BY_PATH, path),
    searchEntries: (input) => ipcRenderer.invoke(IPC.PROJECT_SEARCH_ENTRIES, input),
    rename: (id: string, name: string) => ipcRenderer.invoke(IPC.PROJECT_RENAME, id, name),
    setDefaultAgent: (id: string, agentName: string) => ipcRenderer.invoke(IPC.PROJECT_SET_DEFAULT_AGENT, id, agentName),
    setDefaultModel: (id: string, model: string | null) => ipcRenderer.invoke(IPC.PROJECT_SET_DEFAULT_MODEL, id, model),
    setDefaultEffort: (id: string, effort: string | null) => ipcRenderer.invoke(IPC.PROJECT_SET_DEFAULT_EFFORT, id, effort),
    reorder: (ids: string[]) => ipcRenderer.invoke(IPC.PROJECT_REORDER, ids),
    setGroup: (projectId: string, groupId: string | null) => ipcRenderer.invoke(IPC.PROJECT_SET_GROUP, projectId, groupId),
    relocate: (id: string, newPath: string, options) => ipcRenderer.invoke(IPC.PROJECT_RELOCATE, id, newPath, options),
    onMoveProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ProjectMoveProgress) => callback(progress);
      ipcRenderer.on(IPC.PROJECT_MOVE_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.PROJECT_MOVE_PROGRESS, handler);
    },
    onAutoOpened: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, project: Project) => callback(project);
      ipcRenderer.on(IPC.PROJECT_AUTO_OPENED, handler);
      return () => ipcRenderer.removeListener(IPC.PROJECT_AUTO_OPENED, handler);
    },
    onPathMissing: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, project: Project) => callback(project);
      ipcRenderer.on(IPC.PROJECT_PATH_MISSING, handler);
      return () => ipcRenderer.removeListener(IPC.PROJECT_PATH_MISSING, handler);
    },
  },

  projectGroups: {
    list: () => ipcRenderer.invoke(IPC.PROJECT_GROUP_LIST),
    create: (input: { name: string }) => ipcRenderer.invoke(IPC.PROJECT_GROUP_CREATE, input),
    update: (id: string, name: string) => ipcRenderer.invoke(IPC.PROJECT_GROUP_UPDATE, id, name),
    delete: (id: string) => ipcRenderer.invoke(IPC.PROJECT_GROUP_DELETE, id),
    reorder: (ids: string[]) => ipcRenderer.invoke(IPC.PROJECT_GROUP_REORDER, ids),
    setCollapsed: (id: string, collapsed: boolean) => ipcRenderer.invoke(IPC.PROJECT_GROUP_SET_COLLAPSED, id, collapsed),
  },

  tasks: {
    list: (swimlaneId?) => ipcRenderer.invoke(IPC.TASK_LIST, swimlaneId),
    create: (input, projectId) => ipcRenderer.invoke(IPC.TASK_CREATE, input, projectId),
    update: (input, projectId) => ipcRenderer.invoke(IPC.TASK_UPDATE, input, projectId),
    delete: (id, projectId) => ipcRenderer.invoke(IPC.TASK_DELETE, id, projectId),
    move: (input, projectId) => ipcRenderer.invoke(IPC.TASK_MOVE, input, projectId),
    cancelSpawn: (taskId) => ipcRenderer.invoke(IPC.TASK_CANCEL_SPAWN, taskId),
    listArchived: () => ipcRenderer.invoke(IPC.TASK_LIST_ARCHIVED),
    listArchivedPreview: (limit) => ipcRenderer.invoke(IPC.TASK_LIST_ARCHIVED_PREVIEW, limit),
    unarchive: (input, projectId) => ipcRenderer.invoke(IPC.TASK_UNARCHIVE, input, projectId),
    bulkDelete: (ids, projectId) => ipcRenderer.invoke(IPC.TASK_BULK_DELETE, ids, projectId),
    bulkUnarchive: (ids, targetSwimlaneId, projectId) => ipcRenderer.invoke(IPC.TASK_BULK_UNARCHIVE, ids, targetSwimlaneId, projectId),
    switchBranch: (input, projectId) => ipcRenderer.invoke(IPC.TASK_SWITCH_BRANCH, input, projectId),
    setRuntimeOverride: (input, projectId) => ipcRenderer.invoke(IPC.TASK_SET_RUNTIME_OVERRIDE, input, projectId),
    resolvePr: (taskId, projectId) => ipcRenderer.invoke(IPC.TASK_RESOLVE_PR, taskId, projectId),
    setDetailViewState: (taskId, state, projectId) => ipcRenderer.invoke(IPC.TASK_SET_DETAIL_VIEW_STATE, taskId, state, projectId),
    onAutoMoved: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, taskId: string, targetSwimlaneId: string, taskTitle: string, projectId?: string) =>
        callback(taskId, targetSwimlaneId, taskTitle, projectId);
      ipcRenderer.on(IPC.TASK_AUTO_MOVED, handler);
      return () => ipcRenderer.removeListener(IPC.TASK_AUTO_MOVED, handler);
    },
    onCreatedByAgent: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, taskId: string, taskTitle: string, columnName: string, projectId?: string) =>
        callback(taskId, taskTitle, columnName, projectId);
      ipcRenderer.on(IPC.TASK_CREATED_BY_AGENT, handler);
      return () => ipcRenderer.removeListener(IPC.TASK_CREATED_BY_AGENT, handler);
    },
    onUpdatedByAgent: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, taskId: string, taskTitle: string, projectId?: string) =>
        callback(taskId, taskTitle, projectId);
      ipcRenderer.on(IPC.TASK_UPDATED_BY_AGENT, handler);
      return () => ipcRenderer.removeListener(IPC.TASK_UPDATED_BY_AGENT, handler);
    },
    onDeletedByAgent: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, taskId: string, taskTitle: string, projectId?: string) =>
        callback(taskId, taskTitle, projectId);
      ipcRenderer.on(IPC.TASK_DELETED_BY_AGENT, handler);
      return () => ipcRenderer.removeListener(IPC.TASK_DELETED_BY_AGENT, handler);
    },
    onSessionResync: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId?: string) =>
        callback(projectId);
      ipcRenderer.on(IPC.TASK_SESSION_RESYNC, handler);
      return () => ipcRenderer.removeListener(IPC.TASK_SESSION_RESYNC, handler);
    },
    onSpawnProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, taskId: string, label: string | null) =>
        callback(taskId, label);
      ipcRenderer.on(IPC.TASK_SPAWN_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.TASK_SPAWN_PROGRESS, handler);
    },
    getSpawnProgress: () => ipcRenderer.invoke(IPC.TASK_GET_SPAWN_PROGRESS),
    onBulkDeleteProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: TaskBulkDeleteProgress) =>
        callback(progress);
      ipcRenderer.on(IPC.TASK_BULK_DELETE_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.TASK_BULK_DELETE_PROGRESS, handler);
    },
  },

  attachments: {
    list: (taskId: string) => ipcRenderer.invoke(IPC.ATTACHMENT_LIST, taskId),
    add: (input: { task_id: string; filename: string; data: string; media_type: string }) => ipcRenderer.invoke(IPC.ATTACHMENT_ADD, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.ATTACHMENT_REMOVE, id),
    getDataUrl: (id: string) => ipcRenderer.invoke(IPC.ATTACHMENT_GET_DATA_URL, id),
    open: (id: string) => ipcRenderer.invoke(IPC.ATTACHMENT_OPEN, id),
  },

  swimlanes: {
    list: () => ipcRenderer.invoke(IPC.SWIMLANE_LIST),
    create: (input) => ipcRenderer.invoke(IPC.SWIMLANE_CREATE, input),
    update: (input) => ipcRenderer.invoke(IPC.SWIMLANE_UPDATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.SWIMLANE_DELETE, id),
    reorder: (ids) => ipcRenderer.invoke(IPC.SWIMLANE_REORDER, ids),
    onUpdatedByAgent: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, swimlaneId: string, swimlaneName: string, projectId?: string) =>
        callback(swimlaneId, swimlaneName, projectId);
      ipcRenderer.on(IPC.SWIMLANE_UPDATED_BY_AGENT, handler);
      return () => ipcRenderer.removeListener(IPC.SWIMLANE_UPDATED_BY_AGENT, handler);
    },
  },

  actions: {
    list: () => ipcRenderer.invoke(IPC.ACTION_LIST),
    create: (input) => ipcRenderer.invoke(IPC.ACTION_CREATE, input),
    update: (input) => ipcRenderer.invoke(IPC.ACTION_UPDATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.ACTION_DELETE, id),
  },

  transitions: {
    list: () => ipcRenderer.invoke(IPC.TRANSITION_LIST),
    set: (fromId, toId, actionIds) => ipcRenderer.invoke(IPC.TRANSITION_SET, fromId, toId, actionIds),
    getForTransition: (fromId, toId) => ipcRenderer.invoke(IPC.TRANSITION_GET_FOR, fromId, toId),
  },

  sessions: {
    spawn: (input, projectId) => ipcRenderer.invoke(IPC.SESSION_SPAWN, input, projectId),
    kill: (id) => ipcRenderer.invoke(IPC.SESSION_KILL, id),
    suspend: (taskId, projectId) => ipcRenderer.invoke(IPC.SESSION_SUSPEND, taskId, projectId),
    resume: (taskId, resumePrompt?, projectId?) => ipcRenderer.invoke(IPC.SESSION_RESUME, taskId, resumePrompt, projectId),
    reconcile: (taskId, projectId) => ipcRenderer.invoke(IPC.SESSION_RECONCILE, taskId, projectId),
    reset: (taskId, projectId) => ipcRenderer.invoke(IPC.SESSION_RESET, taskId, projectId),
    write: (id, data) => ipcRenderer.invoke(IPC.SESSION_WRITE, id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke(IPC.SESSION_RESIZE, id, cols, rows),
    list: () => ipcRenderer.invoke(IPC.SESSION_LIST),
    getScrollback: (id) => ipcRenderer.invoke(IPC.SESSION_GET_SCROLLBACK, id),
    getFirstOutput: () => ipcRenderer.invoke(IPC.SESSION_GET_FIRST_OUTPUT),
    getUsage: (projectId?) => ipcRenderer.invoke(IPC.SESSION_GET_USAGE, projectId),
    onData: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string, projectId?: string) => callback(sessionId, data, projectId);
      ipcRenderer.on(IPC.SESSION_DATA, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_DATA, handler);
    },
    ackData: (id, bytes) => ipcRenderer.send(IPC.SESSION_DRAIN_ACK, id, bytes),
    onFirstOutput: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, projectId?: string) => callback(sessionId, projectId);
      ipcRenderer.on(IPC.SESSION_FIRST_OUTPUT, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_FIRST_OUTPUT, handler);
    },
    onExit: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, exitCode: number, projectId?: string, intentional?: boolean) => callback(sessionId, exitCode, projectId, intentional);
      ipcRenderer.on(IPC.SESSION_EXIT, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_EXIT, handler);
    },
    onStatus: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, session: Session, projectId?: string) => callback(sessionId, session, projectId);
      ipcRenderer.on(IPC.SESSION_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_STATUS, handler);
    },
    onUsage: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: SessionUsage, projectId?: string) => callback(sessionId, data, projectId);
      ipcRenderer.on(IPC.SESSION_USAGE, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_USAGE, handler);
    },
    getActivity: (projectId?) => ipcRenderer.invoke(IPC.SESSION_GET_ACTIVITY, projectId),
    getActivityReason: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_GET_ACTIVITY_REASON, sessionId),
    getActivityReasons: (projectId?: string) => ipcRenderer.invoke(IPC.SESSION_GET_ACTIVITY_REASONS, projectId),
    getActivityStats: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_GET_ACTIVITY_STATS, sessionId),
    onActivity: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, state: ActivityState, reason: ActivityReason, projectId?: string, taskId?: string) => callback(sessionId, state, reason, projectId, taskId);
      ipcRenderer.on(IPC.SESSION_ACTIVITY, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_ACTIVITY, handler);
    },
    getEvents: (sessionId) => ipcRenderer.invoke(IPC.SESSION_GET_EVENTS, sessionId),
    getEventsCache: (projectId?) => ipcRenderer.invoke(IPC.SESSION_GET_EVENTS_CACHE, projectId),
    onEvent: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, event: SessionEvent, projectId?: string) => callback(sessionId, event, projectId);
      ipcRenderer.on(IPC.SESSION_EVENT, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_EVENT, handler);
    },
    onIdleTimeout: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, taskId: string, timeoutMinutes: number, projectId?: string) => callback(sessionId, taskId, timeoutMinutes, projectId);
      ipcRenderer.on(IPC.SESSION_IDLE_TIMEOUT, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_IDLE_TIMEOUT, handler);
    },
    getSummary: (taskId: string) => ipcRenderer.invoke(IPC.SESSION_GET_SUMMARY, taskId),
    listSummaries: () => ipcRenderer.invoke(IPC.SESSION_LIST_SUMMARIES),
    getToolBreakdown: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_GET_TOOL_BREAKDOWN, sessionId),
    spawnTransient: (input) => ipcRenderer.invoke(IPC.SESSION_SPAWN_TRANSIENT, input),
    killTransient: (id) => ipcRenderer.invoke(IPC.SESSION_KILL_TRANSIENT, id),
    setFocused: (sessionIds: string[]) => ipcRenderer.invoke(IPC.SESSION_SET_FOCUSED, sessionIds),
    notifyUserInterrupt: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_NOTIFY_USER_INTERRUPT, sessionId),
    injectSettings: (input) => ipcRenderer.invoke(IPC.SESSION_INJECT_SETTINGS, input),
  },

  usage: {
    getDashboardStats: (scope: UsageStatsScope, period: UsageTimePeriod, drill?: UsageDayDrill | null, customWindow?: UsageCustomWindow | null) =>
      ipcRenderer.invoke(IPC.USAGE_GET_DASHBOARD_STATS, scope, period, drill ?? null, customWindow ?? null),
  },

  dictation: {
    start: (options) => ipcRenderer.invoke(IPC.TRANSCRIBE_START, options),
    stop: (dictationSessionId, expectedFrames) => ipcRenderer.invoke(IPC.TRANSCRIBE_STOP, dictationSessionId, expectedFrames),
    cancel: (dictationSessionId) => ipcRenderer.invoke(IPC.TRANSCRIBE_CANCEL, dictationSessionId),
    commit: (sessionId, text) => ipcRenderer.invoke(IPC.TRANSCRIBE_COMMIT, sessionId, text),
    submit: (sessionId, text, eraseCount) => ipcRenderer.invoke(IPC.TRANSCRIBE_SUBMIT, sessionId, text, eraseCount),
    getInfo: (config) => ipcRenderer.invoke(IPC.TRANSCRIBE_GET_INFO, config),
    onPartial: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, dictationSessionId: string, text: string) => callback(dictationSessionId, text);
      ipcRenderer.on(IPC.TRANSCRIBE_PARTIAL, handler);
      return () => ipcRenderer.removeListener(IPC.TRANSCRIBE_PARTIAL, handler);
    },
    onFinal: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, dictationSessionId: string, text: string) => callback(dictationSessionId, text);
      ipcRenderer.on(IPC.TRANSCRIBE_FINAL, handler);
      return () => ipcRenderer.removeListener(IPC.TRANSCRIBE_FINAL, handler);
    },
    sendAudioChunk: (chunk) => ipcRenderer.send(IPC.TRANSCRIBE_AUDIO_CHUNK, chunk),
    requestMic: () => ipcRenderer.invoke(IPC.TRANSCRIBE_REQUEST_MIC),
    onModelProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DictationModelProgress) => callback(progress);
      ipcRenderer.on(IPC.TRANSCRIBE_MODEL_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.TRANSCRIBE_MODEL_PROGRESS, handler);
    },
    downloadModel: (config) => ipcRenderer.invoke(IPC.TRANSCRIBE_DOWNLOAD_MODEL, config),
    liveWrite: (sessionId, payload) => ipcRenderer.send(IPC.TRANSCRIBE_LIVE_WRITE, sessionId, payload),
    prewarm: (config) => ipcRenderer.send(IPC.TRANSCRIBE_PREWARM, config),
  },

  config: {
    get: () => ipcRenderer.invoke(IPC.CONFIG_GET),
    getGlobal: () => ipcRenderer.invoke(IPC.CONFIG_GET_GLOBAL),
    set: (config) => ipcRenderer.invoke(IPC.CONFIG_SET, config),
    setSync: (config) => { ipcRenderer.sendSync(IPC.CONFIG_SET_SYNC, config); },
    getProjectOverrides: () => ipcRenderer.invoke(IPC.CONFIG_GET_PROJECT),
    setProjectOverrides: (overrides) => ipcRenderer.invoke(IPC.CONFIG_SET_PROJECT, overrides),
    getProjectOverridesByPath: (projectPath) => ipcRenderer.invoke(IPC.CONFIG_GET_PROJECT_BY_PATH, projectPath),
    setProjectOverridesByPath: (projectPath, overrides) => ipcRenderer.invoke(IPC.CONFIG_SET_PROJECT_BY_PATH, projectPath, overrides),
    syncDefaultToProjects: (partial) => ipcRenderer.invoke(IPC.CONFIG_SYNC_DEFAULT_TO_PROJECTS, partial),
    onChanged: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.CONFIG_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.CONFIG_CHANGED, handler);
    },
  },

  keybindings: {
    probeGlobal: (combos: string[]) => ipcRenderer.invoke(IPC.KEYBINDINGS_PROBE_GLOBAL, combos),
  },

  agent: {
    detect: () => ipcRenderer.invoke(IPC.AGENT_DETECT),
    listCommands: (cwd?) => ipcRenderer.invoke(IPC.AGENT_LIST_COMMANDS, cwd),
    summarize: (input) => ipcRenderer.invoke(IPC.AGENT_SUMMARIZE, input),
  },

  agents: {
    list: (forceRefresh?: boolean) => ipcRenderer.invoke(IPC.AGENT_LIST, forceRefresh),
    probeExecutionServer: (agentName: string) => ipcRenderer.invoke(IPC.AGENT_PROBE_EXECUTION_SERVER, agentName),
  },

  handoffs: {
    list: (taskId: string) => ipcRenderer.invoke(IPC.HANDOFF_LIST, taskId),
  },

  shell: {
    getAvailable: () => ipcRenderer.invoke(IPC.SHELL_GET_AVAILABLE),
    getDefault: () => ipcRenderer.invoke(IPC.SHELL_GET_DEFAULT),
    openPath: (dirPath: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, dirPath),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, url),
    showItemInFolder: (fullPath: string) => ipcRenderer.invoke(IPC.SHELL_SHOW_ITEM_IN_FOLDER, fullPath),
    exec: (command: string, cwd: string) => ipcRenderer.invoke(IPC.SHELL_EXEC, command, cwd),
  },

  git: {
    detect: () => ipcRenderer.invoke(IPC.GIT_DETECT),
    listBranches: () => ipcRenderer.invoke(IPC.GIT_LIST_BRANCHES),
    diffFiles: (input) => ipcRenderer.invoke(IPC.GIT_DIFF_FILES, input),
    fileContent: (input) => ipcRenderer.invoke(IPC.GIT_FILE_CONTENT, input),
    subscribeDiff: (worktreePath) => ipcRenderer.send(IPC.GIT_DIFF_SUBSCRIBE, worktreePath),
    unsubscribeDiff: (worktreePath) => ipcRenderer.send(IPC.GIT_DIFF_UNSUBSCRIBE, worktreePath),
    checkPendingChanges: (input) => ipcRenderer.invoke(IPC.GIT_CHECK_PENDING_CHANGES, input),
    branchSummary: (input) => ipcRenderer.invoke(IPC.GIT_BRANCH_SUMMARY, input),
    commitGraph: (input) => ipcRenderer.invoke(IPC.GIT_COMMIT_GRAPH, input),
    fileHistory: (input) => ipcRenderer.invoke(IPC.GIT_FILE_HISTORY, input),
    blame: (input) => ipcRenderer.invoke(IPC.GIT_BLAME, input),
    onDiffChanged: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.GIT_DIFF_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.GIT_DIFF_CHANGED, handler);
    },
  },

  dialog: {
    selectFolder: () => ipcRenderer.invoke(IPC.DIALOG_SELECT_FOLDER),
  },

  notifications: {
    show: (input: NotificationInput) => ipcRenderer.send(IPC.NOTIFICATION_SHOW, input),
    onClicked: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string, taskId: string) => callback(projectId, taskId);
      ipcRenderer.on(IPC.NOTIFICATION_CLICKED, handler);
      return () => ipcRenderer.removeListener(IPC.NOTIFICATION_CLICKED, handler);
    },
  },

  window: {
    minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
    flashFrame: (flash: boolean) => ipcRenderer.send(IPC.WINDOW_FLASH_FRAME, flash),
    isFocused: () => ipcRenderer.invoke(IPC.WINDOW_IS_FOCUSED),
  },

  popOut: {
    open: <K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]) =>
      ipcRenderer.invoke(IPC.POPOUT_OPEN, kind, params),
    close: <K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]) =>
      ipcRenderer.invoke(IPC.POPOUT_CLOSE, kind, params),
    focus: <K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]) =>
      ipcRenderer.invoke(IPC.POPOUT_FOCUS, kind, params),
    isOpen: <K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]) =>
      ipcRenderer.invoke(IPC.POPOUT_IS_OPEN, kind, params),
    listOpen: () => ipcRenderer.invoke(IPC.POPOUT_LIST_OPEN),
    onChanged: (callback: (openInstanceKeys: string[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, keys: string[]) => callback(keys);
      ipcRenderer.on(IPC.POPOUT_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.POPOUT_CHANGED, handler);
    },
    descriptor: popOutDescriptor,
  },

  analytics: {
    trackRendererError: (message: string) => ipcRenderer.send(IPC.TRACK_RENDERER_ERROR, message),
  },

  app: {
    getVersion: () => ipcRenderer.invoke(IPC.APP_GET_VERSION),
  },

  updater: {
    checkForUpdate: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
    installUpdate: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
    onUpdateDownloaded: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, info: UpdateDownloadedInfo) => callback(info);
      ipcRenderer.on(IPC.UPDATE_DOWNLOADED, handler);
      return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOADED, handler);
    },
  },

  backlogAttachments: {
    list: (backlogTaskId: string) => ipcRenderer.invoke(IPC.BACKLOG_ATTACHMENT_LIST, backlogTaskId),
    add: (input: { backlog_task_id: string; filename: string; data: string; media_type: string }) => ipcRenderer.invoke(IPC.BACKLOG_ATTACHMENT_ADD, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.BACKLOG_ATTACHMENT_REMOVE, id),
    getDataUrl: (id: string) => ipcRenderer.invoke(IPC.BACKLOG_ATTACHMENT_GET_DATA_URL, id),
    open: (id: string) => ipcRenderer.invoke(IPC.BACKLOG_ATTACHMENT_OPEN, id),
  },

  backlog: {
    list: () => ipcRenderer.invoke(IPC.BACKLOG_LIST),
    create: (input) => ipcRenderer.invoke(IPC.BACKLOG_CREATE, input),
    update: (input) => ipcRenderer.invoke(IPC.BACKLOG_UPDATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.BACKLOG_DELETE, id),
    reorder: (ids) => ipcRenderer.invoke(IPC.BACKLOG_REORDER, ids),
    bulkDelete: (ids) => ipcRenderer.invoke(IPC.BACKLOG_BULK_DELETE, ids),
    promote: (input) => ipcRenderer.invoke(IPC.BACKLOG_PROMOTE, input),
    demote: (input) => ipcRenderer.invoke(IPC.BACKLOG_DEMOTE, input),
    renameLabel: (oldName, newName) => ipcRenderer.invoke(IPC.BACKLOG_RENAME_LABEL, oldName, newName),
    deleteLabel: (name) => ipcRenderer.invoke(IPC.BACKLOG_DELETE_LABEL, name),
    remapPriorities: (mapping) => ipcRenderer.invoke(IPC.BACKLOG_REMAP_PRIORITIES, mapping),
    onChangedByAgent: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId?: string) => callback(projectId);
      ipcRenderer.on(IPC.BACKLOG_CHANGED_BY_AGENT, handler);
      return () => ipcRenderer.removeListener(IPC.BACKLOG_CHANGED_BY_AGENT, handler);
    },
    onLabelColorsChanged: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.BACKLOG_LABEL_COLORS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.BACKLOG_LABEL_COLORS_CHANGED, handler);
    },
    importCheckCli: (source) => ipcRenderer.invoke(IPC.BACKLOG_IMPORT_CHECK_CLI, source),
    importFetch: (input) => ipcRenderer.invoke(IPC.BACKLOG_IMPORT_FETCH, input),
    importExecute: (input) => ipcRenderer.invoke(IPC.BACKLOG_IMPORT_EXECUTE, input),
    importSourcesList: () => ipcRenderer.invoke(IPC.BACKLOG_IMPORT_SOURCES_LIST),
    importSourcesAdd: (input) => ipcRenderer.invoke(IPC.BACKLOG_IMPORT_SOURCES_ADD, input),
    importSourcesRemove: (id) => ipcRenderer.invoke(IPC.BACKLOG_IMPORT_SOURCES_REMOVE, id),
    asana: {
      authStatus: () => ipcRenderer.invoke(IPC.BOARDS_ASANA_AUTH_STATUS),
      setPat: (input) => ipcRenderer.invoke(IPC.BOARDS_ASANA_SET_PAT, input),
      clearCredential: () => ipcRenderer.invoke(IPC.BOARDS_ASANA_CLEAR_CREDENTIAL),
    },
  },

  mobile: {
    getStatus: () => ipcRenderer.invoke(IPC.MOBILE_GET_STATUS),
    startPairing: () => ipcRenderer.invoke(IPC.MOBILE_START_PAIRING),
    confirmPairing: (displayName, capabilities) => ipcRenderer.invoke(IPC.MOBILE_CONFIRM_PAIRING, displayName, capabilities),
    cancelPairing: () => ipcRenderer.invoke(IPC.MOBILE_CANCEL_PAIRING),
    listDevices: () => ipcRenderer.invoke(IPC.MOBILE_LIST_DEVICES),
    revokeDevice: (deviceId) => ipcRenderer.invoke(IPC.MOBILE_REVOKE_DEVICE, deviceId),
    setDeviceCapabilities: (deviceId, capabilities) => ipcRenderer.invoke(IPC.MOBILE_SET_DEVICE_CAPABILITIES, deviceId, capabilities),
    onPairingSas: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: MobilePairingSasPayload) => callback(payload);
      ipcRenderer.on(IPC.MOBILE_PAIRING_SAS, handler);
      return () => ipcRenderer.removeListener(IPC.MOBILE_PAIRING_SAS, handler);
    },
    onPairingEnded: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: MobilePairingEndedPayload) => callback(payload);
      ipcRenderer.on(IPC.MOBILE_PAIRING_ENDED, handler);
      return () => ipcRenderer.removeListener(IPC.MOBILE_PAIRING_ENDED, handler);
    },
    onStateChanged: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.MOBILE_STATE_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.MOBILE_STATE_CHANGED, handler);
    },
  },

  boardConfig: {
    exists: () => ipcRenderer.invoke(IPC.BOARD_CONFIG_EXISTS),
    export: () => ipcRenderer.invoke(IPC.BOARD_CONFIG_EXPORT),
    apply: (projectId: string) => ipcRenderer.invoke(IPC.BOARD_CONFIG_APPLY, projectId),
    onChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId);
      ipcRenderer.on(IPC.BOARD_CONFIG_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.BOARD_CONFIG_CHANGED, handler);
    },
    onShortcutsChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId);
      ipcRenderer.on(IPC.BOARD_CONFIG_SHORTCUTS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.BOARD_CONFIG_SHORTCUTS_CHANGED, handler);
    },
    getShortcuts: () => ipcRenderer.invoke(IPC.BOARD_CONFIG_GET_SHORTCUTS),
    setShortcuts: (actions, target) => ipcRenderer.invoke(IPC.BOARD_CONFIG_SET_SHORTCUTS, actions, target),
    setDefaultBaseBranch: (branch: string) => ipcRenderer.invoke(IPC.BOARD_CONFIG_SET_DEFAULT_BASE_BRANCH, branch),
  },

  clipboard: {
    readImage: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ_IMAGE),
    writeText: (text) => ipcRenderer.invoke(IPC.CLIPBOARD_WRITE_TEXT, text),
  },

  browser: {
    captureAndSend: (input) => ipcRenderer.invoke(IPC.BROWSER_CAPTURE_SEND, input),
    getUrls: (taskId) => ipcRenderer.invoke(IPC.BROWSER_URL_GET, taskId),
    setTaskUrl: (taskId, url) => ipcRenderer.invoke(IPC.BROWSER_URL_SET_TASK, taskId, url),
    clearTaskUrl: (taskId) => ipcRenderer.invoke(IPC.BROWSER_URL_CLEAR_TASK, taskId),
    clearStorage: () => ipcRenderer.invoke(IPC.BROWSER_CLEAR_STORAGE),
    registerPane: (input) => ipcRenderer.invoke(IPC.BROWSER_PANE_REGISTER, input),
    unregisterPane: (sessionId, webContentsId) => ipcRenderer.invoke(IPC.BROWSER_PANE_UNREGISTER, sessionId, webContentsId),
    onZoomChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, factor: number) => callback(factor);
      ipcRenderer.on(IPC.BROWSER_ZOOM_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.BROWSER_ZOOM_CHANGED, handler);
    },
  },

  search: {
    everything: (input) => ipcRenderer.invoke(IPC.SEARCH_EVERYTHING, input),
  },

  transcripts: {
    get: (input) => ipcRenderer.invoke(IPC.TRANSCRIPT_GET, input),
    listSessions: (taskId, projectId) =>
      ipcRenderer.invoke(IPC.TRANSCRIPT_LIST_SESSIONS, taskId, projectId),
  },

  memory: {
    getStatus: () => ipcRenderer.invoke(IPC.MEMORY_STATUS),
    rebuildIndex: (projectId) => ipcRenderer.invoke(IPC.MEMORY_REBUILD_INDEX, projectId),
  },

  platform: process.platform,

  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
};

// Dev-only: expose the preview's ephemeral-project creator behind the same
// __KANGENTIC_DEV__ guard as the inspection hooks above, so production drops it.
if (__KANGENTIC_DEV__) {
  // `--kangentic-ephemeral` is appended to the renderer process argv (via the
  // BrowserWindow `additionalArguments`) ONLY in dev-preview mode, so this is
  // true for `/preview` and false for the regular `npm start` dogfood.
  const isEphemeralPreview = process.argv.includes('--kangentic-ephemeral');
  // The original task title (base64-encoded in the BrowserWindow additionalArguments by
  // main) so the title bar can identify which task the preview clones belong to. Null
  // when not in preview, or when main could not resolve it.
  const PREVIEW_TITLE_FLAG = '--kangentic-preview-task-title=';
  const previewTitleArg = process.argv.find((arg) => arg.startsWith(PREVIEW_TITLE_FLAG));
  const previewTaskTitle = previewTitleArg
    ? Buffer.from(previewTitleArg.slice(PREVIEW_TITLE_FLAG.length), 'base64').toString('utf-8')
    : null;
  api.dev = {
    createEphemeralProject: () => ipcRenderer.invoke(IPC.DEV_CREATE_EPHEMERAL_PROJECT),
    seedGitChanges: (targetPaths: string[]) => ipcRenderer.invoke(IPC.DEV_SEED_GIT_CHANGES, targetPaths),
    seedEmbeddingBacklog: (count: number) => ipcRenderer.invoke(IPC.DEV_SEED_EMBEDDING_BACKLOG, count),
    seedLargeConversation: (count: number) => ipcRenderer.invoke(IPC.DEV_SEED_LARGE_CONVERSATION, count),
    seedUsageData: (days: number) => ipcRenderer.invoke(IPC.DEV_SEED_USAGE_DATA, days),
    isEphemeralPreview,
    previewTaskTitle,
  };
}

contextBridge.exposeInMainWorld('electronAPI', api);

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { ElectronAPI, NotificationInput, Project, Session, SessionUsage, ActivityState, SessionEvent, UpdateDownloadedInfo, UsageTimePeriod } from '../shared/types';

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
    reorder: (ids: string[]) => ipcRenderer.invoke(IPC.PROJECT_REORDER, ids),
    setGroup: (projectId: string, groupId: string | null) => ipcRenderer.invoke(IPC.PROJECT_SET_GROUP, projectId, groupId),
    onAutoOpened: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, project: Project) => callback(project);
      ipcRenderer.on(IPC.PROJECT_AUTO_OPENED, handler);
      return () => ipcRenderer.removeListener(IPC.PROJECT_AUTO_OPENED, handler);
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
    create: (input) => ipcRenderer.invoke(IPC.TASK_CREATE, input),
    update: (input) => ipcRenderer.invoke(IPC.TASK_UPDATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.TASK_DELETE, id),
    move: (input) => ipcRenderer.invoke(IPC.TASK_MOVE, input),
    listArchived: () => ipcRenderer.invoke(IPC.TASK_LIST_ARCHIVED),
    unarchive: (input) => ipcRenderer.invoke(IPC.TASK_UNARCHIVE, input),
    bulkDelete: (ids) => ipcRenderer.invoke(IPC.TASK_BULK_DELETE, ids),
    bulkUnarchive: (ids, targetSwimlaneId) => ipcRenderer.invoke(IPC.TASK_BULK_UNARCHIVE, ids, targetSwimlaneId),
    switchBranch: (input) => ipcRenderer.invoke(IPC.TASK_SWITCH_BRANCH, input),
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
    spawn: (input) => ipcRenderer.invoke(IPC.SESSION_SPAWN, input),
    kill: (id) => ipcRenderer.invoke(IPC.SESSION_KILL, id),
    suspend: (taskId) => ipcRenderer.invoke(IPC.SESSION_SUSPEND, taskId),
    resume: (taskId, resumePrompt?) => ipcRenderer.invoke(IPC.SESSION_RESUME, taskId, resumePrompt),
    write: (id, data) => ipcRenderer.invoke(IPC.SESSION_WRITE, id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke(IPC.SESSION_RESIZE, id, cols, rows),
    list: () => ipcRenderer.invoke(IPC.SESSION_LIST),
    getScrollback: (id) => ipcRenderer.invoke(IPC.SESSION_GET_SCROLLBACK, id),
    getUsage: (projectId?) => ipcRenderer.invoke(IPC.SESSION_GET_USAGE, projectId),
    onData: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string, projectId?: string) => callback(sessionId, data, projectId);
      ipcRenderer.on(IPC.SESSION_DATA, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_DATA, handler);
    },
    onFirstOutput: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, projectId?: string) => callback(sessionId, projectId);
      ipcRenderer.on(IPC.SESSION_FIRST_OUTPUT, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_FIRST_OUTPUT, handler);
    },
    onExit: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, exitCode: number, projectId?: string) => callback(sessionId, exitCode, projectId);
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
    onActivity: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, state: ActivityState, projectId?: string, taskId?: string, taskTitle?: string, isPermission?: boolean) => callback(sessionId, state, projectId, taskId, taskTitle, isPermission);
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
    spawnTransient: (input) => ipcRenderer.invoke(IPC.SESSION_SPAWN_TRANSIENT, input),
    killTransient: (id) => ipcRenderer.invoke(IPC.SESSION_KILL_TRANSIENT, id),
    getPeriodStats: (period: UsageTimePeriod) => ipcRenderer.invoke(IPC.SESSION_GET_PERIOD_STATS, period),
  },

  config: {
    get: () => ipcRenderer.invoke(IPC.CONFIG_GET),
    getGlobal: () => ipcRenderer.invoke(IPC.CONFIG_GET_GLOBAL),
    set: (config) => ipcRenderer.invoke(IPC.CONFIG_SET, config),
    getProjectOverrides: () => ipcRenderer.invoke(IPC.CONFIG_GET_PROJECT),
    setProjectOverrides: (overrides) => ipcRenderer.invoke(IPC.CONFIG_SET_PROJECT, overrides),
    getProjectOverridesByPath: (projectPath) => ipcRenderer.invoke(IPC.CONFIG_GET_PROJECT_BY_PATH, projectPath),
    setProjectOverridesByPath: (projectPath, overrides) => ipcRenderer.invoke(IPC.CONFIG_SET_PROJECT_BY_PATH, projectPath, overrides),
    syncDefaultToProjects: (partial) => ipcRenderer.invoke(IPC.CONFIG_SYNC_DEFAULT_TO_PROJECTS, partial),
  },

  claude: {
    detect: () => ipcRenderer.invoke(IPC.CLAUDE_DETECT),
    listCommands: (cwd?) => ipcRenderer.invoke(IPC.CLAUDE_LIST_COMMANDS, cwd),
  },

  shell: {
    getAvailable: () => ipcRenderer.invoke(IPC.SHELL_GET_AVAILABLE),
    getDefault: () => ipcRenderer.invoke(IPC.SHELL_GET_DEFAULT),
    openPath: (dirPath: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, dirPath),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, url),
    exec: (command: string, cwd: string) => ipcRenderer.invoke(IPC.SHELL_EXEC, command, cwd),
  },

  git: {
    detect: () => ipcRenderer.invoke(IPC.GIT_DETECT),
    listBranches: () => ipcRenderer.invoke(IPC.GIT_LIST_BRANCHES),
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

  platform: process.platform,

  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

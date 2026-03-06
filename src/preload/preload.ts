import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { ElectronAPI, NotificationInput, Project, SessionStatus, SessionUsage, ActivityState, SessionEvent } from '../shared/types';

const api: ElectronAPI = {
  projects: {
    list: () => ipcRenderer.invoke(IPC.PROJECT_LIST),
    create: (input) => ipcRenderer.invoke(IPC.PROJECT_CREATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.PROJECT_DELETE, id),
    open: (id) => ipcRenderer.invoke(IPC.PROJECT_OPEN, id),
    getCurrent: () => ipcRenderer.invoke(IPC.PROJECT_GET_CURRENT),
    openByPath: (path: string) => ipcRenderer.invoke(IPC.PROJECT_OPEN_BY_PATH, path),
    reorder: (ids: string[]) => ipcRenderer.invoke(IPC.PROJECT_REORDER, ids),
    onAutoOpened: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, project: Project) => callback(project);
      ipcRenderer.on(IPC.PROJECT_AUTO_OPENED, handler);
      return () => ipcRenderer.removeListener(IPC.PROJECT_AUTO_OPENED, handler);
    },
  },

  tasks: {
    list: (swimlaneId?) => ipcRenderer.invoke(IPC.TASK_LIST, swimlaneId),
    create: (input) => ipcRenderer.invoke(IPC.TASK_CREATE, input),
    update: (input) => ipcRenderer.invoke(IPC.TASK_UPDATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.TASK_DELETE, id),
    move: (input) => ipcRenderer.invoke(IPC.TASK_MOVE, input),
    listArchived: () => ipcRenderer.invoke(IPC.TASK_LIST_ARCHIVED),
    unarchive: (input) => ipcRenderer.invoke(IPC.TASK_UNARCHIVE, input),
    onAutoMoved: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, taskId: string, targetSwimlaneId: string, taskTitle: string) =>
        callback(taskId, targetSwimlaneId, taskTitle);
      ipcRenderer.on(IPC.TASK_AUTO_MOVED, handler);
      return () => ipcRenderer.removeListener(IPC.TASK_AUTO_MOVED, handler);
    },
  },

  attachments: {
    list: (taskId: string) => ipcRenderer.invoke(IPC.ATTACHMENT_LIST, taskId),
    add: (input: { task_id: string; filename: string; data: string; media_type: string }) => ipcRenderer.invoke(IPC.ATTACHMENT_ADD, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.ATTACHMENT_REMOVE, id),
    getDataUrl: (id: string) => ipcRenderer.invoke(IPC.ATTACHMENT_GET_DATA_URL, id),
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
    resume: (taskId) => ipcRenderer.invoke(IPC.SESSION_RESUME, taskId),
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
    onExit: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, exitCode: number, projectId?: string) => callback(sessionId, exitCode, projectId);
      ipcRenderer.on(IPC.SESSION_EXIT, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_EXIT, handler);
    },
    onStatus: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, status: SessionStatus, projectId?: string) => callback(sessionId, status, projectId);
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
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, state: ActivityState, projectId?: string) => callback(sessionId, state, projectId);
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
  },

  config: {
    get: () => ipcRenderer.invoke(IPC.CONFIG_GET),
    getGlobal: () => ipcRenderer.invoke(IPC.CONFIG_GET_GLOBAL),
    set: (config) => ipcRenderer.invoke(IPC.CONFIG_SET, config),
    getProjectOverrides: () => ipcRenderer.invoke(IPC.CONFIG_GET_PROJECT),
    setProjectOverrides: (overrides) => ipcRenderer.invoke(IPC.CONFIG_SET_PROJECT, overrides),
    getProjectOverridesByPath: (projectPath) => ipcRenderer.invoke(IPC.CONFIG_GET_PROJECT_BY_PATH, projectPath),
    setProjectOverridesByPath: (projectPath, overrides) => ipcRenderer.invoke(IPC.CONFIG_SET_PROJECT_BY_PATH, projectPath, overrides),
  },

  claude: {
    detect: () => ipcRenderer.invoke(IPC.CLAUDE_DETECT),
  },

  shell: {
    getAvailable: () => ipcRenderer.invoke(IPC.SHELL_GET_AVAILABLE),
    getDefault: () => ipcRenderer.invoke(IPC.SHELL_GET_DEFAULT),
    openPath: (dirPath: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, dirPath),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, url),
  },

  git: {
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
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

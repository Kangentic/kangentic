import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { ElectronAPI, Project, SessionStatus, SessionUsage, ActivityState, SessionEvent } from '../shared/types';

const api: ElectronAPI = {
  projects: {
    list: () => ipcRenderer.invoke(IPC.PROJECT_LIST),
    create: (input) => ipcRenderer.invoke(IPC.PROJECT_CREATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.PROJECT_DELETE, id),
    open: (id) => ipcRenderer.invoke(IPC.PROJECT_OPEN, id),
    getCurrent: () => ipcRenderer.invoke(IPC.PROJECT_GET_CURRENT),
    openByPath: (path: string) => ipcRenderer.invoke(IPC.PROJECT_OPEN_BY_PATH, path),
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
    getUsage: () => ipcRenderer.invoke(IPC.SESSION_GET_USAGE),
    onData: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data);
      ipcRenderer.on(IPC.SESSION_DATA, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_DATA, handler);
    },
    onExit: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, exitCode: number) => callback(sessionId, exitCode);
      ipcRenderer.on(IPC.SESSION_EXIT, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_EXIT, handler);
    },
    onStatus: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, status: SessionStatus) => callback(sessionId, status);
      ipcRenderer.on(IPC.SESSION_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_STATUS, handler);
    },
    onUsage: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: SessionUsage) => callback(sessionId, data);
      ipcRenderer.on(IPC.SESSION_USAGE, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_USAGE, handler);
    },
    getActivity: () => ipcRenderer.invoke(IPC.SESSION_GET_ACTIVITY),
    onActivity: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, state: ActivityState) => callback(sessionId, state);
      ipcRenderer.on(IPC.SESSION_ACTIVITY, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_ACTIVITY, handler);
    },
    getEvents: (sessionId) => ipcRenderer.invoke(IPC.SESSION_GET_EVENTS, sessionId),
    getEventsCache: () => ipcRenderer.invoke(IPC.SESSION_GET_EVENTS_CACHE),
    onEvent: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, event: SessionEvent) => callback(sessionId, event);
      ipcRenderer.on(IPC.SESSION_EVENT, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_EVENT, handler);
    },
  },

  config: {
    get: () => ipcRenderer.invoke(IPC.CONFIG_GET),
    set: (config) => ipcRenderer.invoke(IPC.CONFIG_SET, config),
    getProjectOverrides: () => ipcRenderer.invoke(IPC.CONFIG_GET_PROJECT),
    setProjectOverrides: (overrides) => ipcRenderer.invoke(IPC.CONFIG_SET_PROJECT, overrides),
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

  window: {
    minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
    flashFrame: (flash: boolean) => ipcRenderer.send(IPC.WINDOW_FLASH_FRAME, flash),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

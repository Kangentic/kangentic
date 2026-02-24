import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { ElectronAPI } from '../shared/types';

const api: ElectronAPI = {
  projects: {
    list: () => ipcRenderer.invoke(IPC.PROJECT_LIST),
    create: (input) => ipcRenderer.invoke(IPC.PROJECT_CREATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.PROJECT_DELETE, id),
    open: (id) => ipcRenderer.invoke(IPC.PROJECT_OPEN, id),
    getCurrent: () => ipcRenderer.invoke(IPC.PROJECT_GET_CURRENT),
    openByPath: (path: string) => ipcRenderer.invoke(IPC.PROJECT_OPEN_BY_PATH, path),
    onAutoOpened: (callback: (project: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, project: any) => callback(project);
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
  },

  swimlanes: {
    list: () => ipcRenderer.invoke(IPC.SWIMLANE_LIST),
    create: (input) => ipcRenderer.invoke(IPC.SWIMLANE_CREATE, input),
    update: (input) => ipcRenderer.invoke(IPC.SWIMLANE_UPDATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.SWIMLANE_DELETE, id),
    reorder: (ids) => ipcRenderer.invoke(IPC.SWIMLANE_REORDER, ids),
  },

  skills: {
    list: () => ipcRenderer.invoke(IPC.SKILL_LIST),
    create: (input) => ipcRenderer.invoke(IPC.SKILL_CREATE, input),
    update: (input) => ipcRenderer.invoke(IPC.SKILL_UPDATE, input),
    delete: (id) => ipcRenderer.invoke(IPC.SKILL_DELETE, id),
  },

  transitions: {
    list: () => ipcRenderer.invoke(IPC.TRANSITION_LIST),
    set: (fromId, toId, skillIds) => ipcRenderer.invoke(IPC.TRANSITION_SET, fromId, toId, skillIds),
    getForTransition: (fromId, toId) => ipcRenderer.invoke(IPC.TRANSITION_GET_FOR, fromId, toId),
  },

  sessions: {
    spawn: (input) => ipcRenderer.invoke(IPC.SESSION_SPAWN, input),
    kill: (id) => ipcRenderer.invoke(IPC.SESSION_KILL, id),
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
    onUsage: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: any) => callback(sessionId, data);
      ipcRenderer.on(IPC.SESSION_USAGE, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_USAGE, handler);
    },
    getActivity: () => ipcRenderer.invoke(IPC.SESSION_GET_ACTIVITY),
    onActivity: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, state: string) => callback(sessionId, state as any);
      ipcRenderer.on(IPC.SESSION_ACTIVITY, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_ACTIVITY, handler);
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
  },

  window: {
    minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

import { app, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { IPC } from '../../../shared/ipc-channels';
import type { SshClientStatus, SshConfigHost, SshDirectoryListing, SshHostAddInput, SshHostKeyProbe, SshHostProgram, SshHostStatus, SshHostUpdateInput, SshRemoteFolderProbe } from '../../../shared/types';
import { PATHS } from '../../config/paths';
import { SshHostAdmin } from '../../remote/ssh-host-admin';
import { defaultSshSetupDeps } from '../../remote/ssh-setup';
import type { IpcContext } from '../ipc-context';
import { TaskRepository } from '../../db/repositories/task-repository';
import { getExistingProjectDb } from '../../db/database';
import { isLiveSessionStatus } from '../../../shared/session-liveness';
import { suspendProjectForHiding, takeHiddenProjectOutOfApp } from '../helpers/hide-project';
import { cleanupProject, revealHostProjects } from './projects';

/**
 * SSH hosts (#913): machine-global like the mobile bridge, so these channels take no trailing projectId
 * and sit outside the project-scoped mutation set (`.claude/rules/project-scoped-ipc.md`). A host serves
 * every project and must be addable with no project open.
 *
 * The logic is `SshHostAdmin`, which takes its dependencies; this file only wires it to the context.
 */

/** A project's open tasks. No database file is no tasks, and is not created for asking. */
function boardTasksOf(projectId: string): Array<{ id: string }> {
  const db = getExistingProjectDb(projectId);
  return db ? new TaskRepository(db).list() : [];
}

/** Tell the window the set of projects changed, so the sidebar shows the ones that are visible now. */
function notifyProjectsChanged(context: IpcContext): void {
  if (!context.mainWindow.isDestroyed()) context.mainWindow.webContents.send(IPC.PROJECT_LIST_CHANGED);
}

/** The folder remote projects' shell folders live in. */
export function remoteProjectsRoot(): string {
  return path.dirname(PATHS.remoteProjectShell('x'));
}

/** The admin for this context, built once and shared with the project handlers. */
export function createSshHostAdmin(context: IpcContext): SshHostAdmin | null {
  const hosting = context.remoteHosting;
  if (!hosting) return null;
  return new SshHostAdmin({
    hosting,
    projects: { listOnHost: (hostId) => context.projectRepo.listOnHost(hostId) },
    setup: defaultSshSetupDeps(PATHS.configDir),
    removeProject: async (project) => {
      await cleanupProject(context, project.id, project.path);
      context.projectRepo.delete(project.id);
    },
    suspendProjectSessions: (project) => suspendProjectForHiding(context, project, () => boardTasksOf(project.id)),
    hideProject: (project) => takeHiddenProjectOutOfApp(context, project),
    hasLiveSessions: (hostId) => {
      const projectIds = new Set(context.projectRepo.listOnHost(hostId).map((project) => project.id));
      return context.sessionManager.listSessions().some((session) => projectIds.has(session.projectId) && isLiveSessionStatus(session.status));
    },
    revealProjects: async (hostId) => {
      notifyProjectsChanged(context);
      await revealHostProjects(context, hostId);
    },
    projectsChanged: () => notifyProjectsChanged(context),
    remoteProjectsRoot: remoteProjectsRoot(),
    newShellFolder: () => PATHS.remoteProjectShell(randomUUID()),
    appVersion: () => app.getVersion(),
    removeHomeMirror: (hostId) => fs.rm(PATHS.remoteHomeMirror(hostId), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }),
    log: (line) => console.log(line),
  });
}

export function registerSshHostHandlers(context: IpcContext): SshHostAdmin | null {
  const admin = createSshHostAdmin(context);
  if (!admin || !context.remoteHosting) {
    // Said once here, or every SSH tab call fails as Electron's bare "No handler registered".
    console.warn('[remote] SSH hosts are unavailable: no remote hosting was set up, so no ssh handler is registered.');
    return null;
  }
  // The project handlers prepare a remote project through it.
  context.remoteHosting.admin = admin;

  ipcMain.handle(IPC.SSH_DETECT_CLIENT, (): Promise<SshClientStatus> => admin.detectClient());
  ipcMain.handle(IPC.SSH_LIST_HOSTS, (): SshHostStatus[] => admin.listHosts());
  ipcMain.handle(IPC.SSH_PROBE_HOST_KEY, (_event, destination: string): Promise<SshHostKeyProbe> => admin.probeHostKey(destination));
  ipcMain.handle(IPC.SSH_LIST_CONFIG_HOSTS, (): Promise<SshConfigHost[]> => admin.listConfigHosts());
  ipcMain.handle(IPC.SSH_ADD_HOST, (_event, input: SshHostAddInput): Promise<SshHostStatus> => admin.addHost(input));
  ipcMain.handle(IPC.SSH_REMOVE_HOST, (_event, hostId: string): Promise<void> => admin.removeHost(hostId));
  ipcMain.handle(IPC.SSH_CLEAR_HOST_DATA, (_event, hostId: string): Promise<void> => admin.clearHostData(hostId));
  ipcMain.handle(IPC.SSH_UPDATE_HOST, (_event, hostId: string, input: SshHostUpdateInput): Promise<SshHostStatus> => admin.updateHost(hostId, input));
  ipcMain.handle(IPC.SSH_RECONNECT_HOST, (_event, hostId: string): Promise<SshHostStatus> => admin.reconnectHost(hostId));
  ipcMain.handle(IPC.SSH_HOST_PROGRAM, (_event, hostId: string): Promise<SshHostProgram> => admin.hostProgram(hostId));
  ipcMain.handle(IPC.SSH_CHECK_KEY_FILE, (_event, keyFilePath: string): Promise<void> => admin.checkKeyFile(keyFilePath));
  ipcMain.handle(IPC.SSH_PROBE_CHANGED_KEY, (_event, hostId: string): Promise<SshHostKeyProbe> => admin.probeChangedHostKey(hostId));
  ipcMain.handle(IPC.SSH_TRUST_NEW_KEY, (_event, hostId: string, shownFingerprint: string): Promise<SshHostStatus> => admin.trustNewHostKey(hostId, shownFingerprint));
  ipcMain.handle(IPC.SSH_PROBE_REMOTE_FOLDER, (_event, hostId: string, folderPath: string): Promise<SshRemoteFolderProbe> => admin.probeRemoteFolder(hostId, folderPath));
  ipcMain.handle(IPC.SSH_LIST_DIRECTORIES, (_event, hostId: string, directoryPath: string): Promise<SshDirectoryListing> => admin.listDirectories(hostId, directoryPath));
  return admin;
}

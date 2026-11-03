/**
 * Everything the SSH feature needs at startup, built in one place so `register-all.ts` gains a few
 * lines (#913): the host table, the service that connects hosts, the relay that keeps a remote
 * session's folder in step with its host's, and the resolver both spawn chokepoints ask.
 *
 * Hosts connect after startup, not before it: a host that is down must never delay the window, and its
 * link keeps retrying by itself. Until a host is connected a spawn onto it fails with a sentence.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { PATHS } from '../config/paths';
import type { ProjectRepository } from '../db/repositories/project-repository';
import { SshHostRepository } from '../db/repositories/ssh-host-repository';
import type { SessionManager } from '../pty/session-manager';
import type { HostAsset } from './link/host-installer';
import { readInstallId } from './install-identity';
import { createRemoteLaunchResolver, setRemoteLaunchResolver } from './remote-launch';
import { RemoteHostService } from './remote-host-service';
import { RemoteSessionRelay } from './remote-session-relay';

export interface RemoteHosting {
  hosts: SshHostRepository;
  hostService: RemoteHostService;
  relay: RemoteSessionRelay;
  /** Connect every stored host, one after another, logging what could not be reached. */
  connectAll(): Promise<void>;
}

export interface RemoteHostingDeps {
  sessionManager: SessionManager;
  projects: () => Pick<ProjectRepository, 'list'>;
  /** The program installed on a host: this build's, with its checksum, or null when the build carries none. */
  hostAsset?: () => HostAsset | null;
  /** The `ssh` program; a name on the PATH by default, which is how every platform finds its own. */
  sshPath?: string;
  log?: (line: string) => void;
}

/** Whether two paths name the same folder: case-insensitive on Windows, where the project list may differ in case. */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

export function createRemoteHosting(deps: RemoteHostingDeps): RemoteHosting {
  const log = deps.log ?? ((line: string) => console.log(line));
  const hosts = new SshHostRepository();
  const hostService = new RemoteHostService({
    sshPath: deps.sshPath ?? 'ssh',
    hosts,
    send: (request) => deps.sessionManager.remoteHostRequest(request),
    asset: deps.hostAsset ?? (() => null),
    identity: { installId: readInstallId(PATHS.configDir), label: os.hostname() },
  });
  const relay = new RemoteSessionRelay({ files: hostService, log });
  deps.sessionManager.setRemoteSessionRelay(relay);

  setRemoteLaunchResolver(createRemoteLaunchResolver({
    remoteOfProjectPath: (projectPath) => deps.projects().list().find((project) => project.remote && samePath(project.path, projectPath))?.remote ?? null,
    hostInfo: (hostId) => hostService.hostInfo(hostId),
    readFile: (hostId, hostPath) => hostService.readFile(hostId, hostPath),
    jsonPatch: (hostId, request) => hostService.jsonPatch(hostId, request),
    homeMirror: (hostId) => PATHS.remoteHomeMirror(hostId),
  }));

  return {
    hosts,
    hostService,
    relay,
    async connectAll() {
      for (const result of await hostService.connectAll()) {
        if (result.error) log(`[remote] host ${result.hostId.slice(0, 8)} was not connected: ${result.error.message}`);
      }
    },
  };
}

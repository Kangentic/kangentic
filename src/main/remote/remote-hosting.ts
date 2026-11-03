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
import { HostStatusBook } from './host-status';
import { defaultSshClientPaths } from './ssh-client';
import type { SshHostAdmin } from './ssh-host-admin';
import { createRemoteLaunchResolver, setRemoteLaunchResolver } from './remote-launch';
import { RemoteHostService } from './remote-host-service';
import { RemoteSessionRelay } from './remote-session-relay';

export interface RemoteHosting {
  hosts: SshHostRepository;
  hostService: RemoteHostService;
  relay: RemoteSessionRelay;
  /** Where each host's connection stands; the settings row and the project chip read it. */
  status: HostStatusBook;
  /** What the SSH tab and the Add project dialog do; set when the IPC handlers register, null before. */
  admin: SshHostAdmin | null;
  /** Connect one host, recording the outcome. A setup failure becomes `unreachable` with its words and does not throw. */
  connectHost(hostId: string): Promise<void>;
  /** Connect every stored host, one after another, logging what could not be reached. */
  connectAll(): Promise<void>;
}

export interface RemoteHostingDeps {
  sessionManager: SessionManager;
  projects: () => Pick<ProjectRepository, 'list'>;
  /** The program installed on a host: this build's, with its checksum, or null when the build carries none. */
  hostAsset?: () => HostAsset | readonly HostAsset[] | null;
  /** The `ssh` program; a name on the PATH by default, which is how every platform finds its own. */
  sshPath?: string;
  /** Told after a host's connection state changes, so the window can redraw. */
  onHostsChanged?: (hostId: string) => void;
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
    sshPath: deps.sshPath ?? defaultSshClientPaths().ssh,
    hosts,
    send: (request) => deps.sessionManager.remoteHostRequest(request),
    asset: deps.hostAsset ?? (() => null),
    identity: { installId: readInstallId(PATHS.configDir), label: os.hostname() },
  });
  const relay = new RemoteSessionRelay({ files: hostService, log });
  deps.sessionManager.setRemoteSessionRelay(relay);
  const status = new HostStatusBook({ onChange: (hostId) => deps.onHostsChanged?.(hostId) });
  // A link reports its own state; a drop is a state here, never the end of a session.
  deps.sessionManager.on('remote-link', (event: { hostId: string; state: 'connecting' | 'connected' | 'reconnecting' | 'stopped'; detail: string | null }) => {
    status.set(event.hostId, event.state, event.detail);
  });

  setRemoteLaunchResolver(createRemoteLaunchResolver({
    remoteOfProjectPath: (projectPath) => deps.projects().list().find((project) => project.remote && samePath(project.path, projectPath))?.remote ?? null,
    hostInfo: (hostId) => hostService.hostInfo(hostId),
    readFile: (hostId, hostPath) => hostService.readFile(hostId, hostPath),
    jsonPatch: (hostId, request) => hostService.jsonPatch(hostId, request),
    homeMirror: (hostId) => PATHS.remoteHomeMirror(hostId),
  }));

  const connectHost = async (hostId: string): Promise<void> => {
    status.set(hostId, 'connecting');
    try {
      await hostService.connect(hostId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[remote] host ${hostId.slice(0, 8)} was not connected: ${message}`);
      status.set(hostId, 'unreachable', message);
    }
  };

  return {
    hosts,
    hostService,
    relay,
    status,
    admin: null,
    connectHost,
    async connectAll() {
      for (const host of hosts.list()) await connectHost(host.id);
    },
  };
}

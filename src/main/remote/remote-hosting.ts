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
import { devPortRepository } from '../db/repositories/dev-port-repository';
import { SshHostRepository } from '../db/repositories/ssh-host-repository';
import type { SessionManager } from '../pty/session-manager';
import type { HostAsset } from './link/host-installer';
import { readInstallId } from './install-identity';
import { HostStatusBook } from './host-status';
import { defaultSshClientPaths } from './ssh-client';
import type { SshHostAdmin } from './ssh-host-admin';
import { PortForwardPlan, setPortForwardPlan } from './port-forward-plan';
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
  /** Connect every stored host at once, recording what could not be reached. A host that is off delays no other. */
  connectAll(): Promise<void>;
}

export interface RemoteHostingDeps {
  sessionManager: SessionManager;
  projects: () => Pick<ProjectRepository, 'list'>;
  /** The program installed on a host: this build's, with its checksum, or null when the build carries none. */
  hostAsset?: () => HostAsset | readonly HostAsset[] | null;
  /** The `ssh` program; `defaultSshClientPaths().ssh` by default (Windows' own OpenSSH where it exists). */
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
    liveSessions: (hostId) => deps.sessionManager.liveRemotePtys(hostId),
  });
  const relay = new RemoteSessionRelay({ files: hostService, log });
  deps.sessionManager.setRemoteSessionRelay(relay);
  const status = new HostStatusBook({ onChange: (hostId) => deps.onHostsChanged?.(hostId) });
  // A link reports its own state; a drop is a state here, never the end of a session.
  deps.sessionManager.on('remote-link', (event: { hostId: string; state: 'connecting' | 'connected' | 'reconnecting' | 'stopped'; detail: string | null }) => {
    status.noteLink(event.hostId, event.state, event.detail);
  });

  setRemoteLaunchResolver(createRemoteLaunchResolver({
    remoteOfProjectPath: (projectPath) => deps.projects().list().find((project) => project.remote && samePath(project.path, projectPath))?.remote ?? null,
    hostInfo: (hostId) => hostService.hostInfo(hostId),
    readFile: (hostId, hostPath) => hostService.readFile(hostId, hostPath),
    jsonPatch: (hostId, request) => hostService.jsonPatch(hostId, request),
    writeFiles: (hostId, files) => hostService.writeFiles(hostId, files),
    removeFiles: (hostId, paths) => hostService.removeFiles(hostId, paths),
    pathPresence: (hostId, paths) => hostService.pathPresence(hostId, paths),
    runCommand: (hostId, request) => hostService.runCommand(hostId, request),
    homeMirror: (hostId) => PATHS.remoteHomeMirror(hostId),
  }));

  // The reserved dev-server ports of remote projects reach this computer once a server listens on them
  // (the pty host's forwarder starts the ssh). The ledger is the source: every change to it is a sync.
  const forwardPlan = new PortForwardPlan({
    leases: () => devPortRepository.listAll(),
    projects: () => deps.projects().list(),
    send: (request) => deps.sessionManager.remoteHostRequest(request),
    log,
  });
  setPortForwardPlan(forwardPlan);
  devPortRepository.onChange(() => forwardPlan.schedule());

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

  // The links live in the pty host process, so a restart of it took every one with it while the agents
  // kept running on their hosts. Each host is added again with the PTYs main still holds there, and the
  // new link's reconcile rebinds them to their sessions on the host.
  deps.sessionManager.on('pty-host-restarted', () => {
    for (const hostId of hostService.connectedHosts()) void connectHost(hostId);
    // The new process remembers no forward either.
    forwardPlan.resend();
  });

  return {
    hosts,
    hostService,
    relay,
    status,
    admin: null,
    connectHost,
    async connectAll() {
      // connectHost never throws, so one host that fails or hangs holds up no other.
      await Promise.all(hosts.list().map((host) => connectHost(host.id)));
      // Ports reserved in an earlier run are still leased: forward them once their servers are up.
      forwardPlan.resend();
    },
  };
}

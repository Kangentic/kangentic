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
import { connectRetryDelayMs, isTransientConnectFailure } from './connect-retry';
import { createSshRunner } from './link/ssh-run';
import { captureKeyPrompt } from './ssh-key-prompt';
import { defaultSshClientPaths } from './ssh-client';
import type { SshHostAdmin } from './ssh-host-admin';
import { PortForwardPlan, setPortForwardPlan } from './port-forward-plan';
import { createRemoteLaunchResolver, setRemoteLaunchResolver } from './remote-launch';
import { setRemoteWorktreeResolver } from '../git/remote-worktree';
import { createRemoteWorktreeResolver } from './remote-worktrees';
import { setRemoteGitResolver } from '../git/remote-git';
import { createRemoteGitResolver } from './host-git';
import { setRemoteProjectLookup } from './host-paths';
import { hostAccessOf, setHostAccessLookup } from './host-transfer';
import { RemoteHostService } from './remote-host-service';
import { createSpawnAgentProbe, probeAgentOnHost, type HostAgentProbe } from './host-agent-probe';
import { invalidateHostAgentList } from '../agent/agent-list';
import type { ProjectRemote } from '../../shared/types';
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
  /** Count this host's next connection as its first of the run: it left and came back, so its projects start with it. */
  expectFirstConnect(hostId: string): void;
  /** Refuse every start on a host while it is being removed. Call the answer once the host is marked removed or the removal failed. */
  holdStarts(hostId: string): () => void;
  /** Connect every stored host at once, recording what could not be reached. A host that is off delays no other. */
  connectAll(): Promise<void>;
  /** The host and folder a project's shell folder stands for, or null for a project on this computer. */
  remoteOfProjectPath(projectPath: string): ProjectRemote | null;
  /** Whether an agent's CLI is installed on a host, asked of the host itself. */
  probeAgent(hostId: string, cliName: string): Promise<HostAgentProbe>;
}

export interface RemoteHostingDeps {
  sessionManager: SessionManager;
  projects: () => Pick<ProjectRepository, 'list' | 'listIncludingHidden'>;
  /** The program installed on a host: this build's, with its checksum, or null when the build carries none. */
  hostAsset?: () => HostAsset | readonly HostAsset[] | null;
  /** The `ssh` program; `defaultSshClientPaths().ssh` by default (Windows' own OpenSSH where it exists). */
  sshPath?: string;
  /** Told after a host's connection state changes, so the window can redraw. */
  onHostsChanged?: (hostId: string) => void;
  /** A host's link came up for the first time this run: the projects opened before it can recover their paused tasks. */
  onHostFirstConnected?: (hostId: string) => void;
  log?: (line: string) => void;
}

/** A program version on a host that nothing has installed or touched for this long is removed. */
const PRUNE_AFTER_DAYS = 30;

/** Whether two paths name the same folder: case-insensitive on Windows, where the project list may differ in case. */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

/** The app's version of the host program. A packaged app has one asset per CPU, and they all carry it. */
function assetVersion(asset: HostAsset | readonly HostAsset[] | null | undefined): string | undefined {
  const first = (Array.isArray(asset) ? asset[0] : asset) as HostAsset | null | undefined;
  return first?.version;
}

export function createRemoteHosting(deps: RemoteHostingDeps): RemoteHosting {
  const log = deps.log ?? ((line: string) => console.log(line));
  const hosts = new SshHostRepository();
  /**
   * Remove program versions that sat unused for a month, keeping this app's and the one running. A month, so
   * two computers on one host account never delete each other's version between connects. Best effort.
   */
  const pruneOldProgramVersions = async (hostId: string): Promise<void> => {
    const appVersion = assetVersion(deps.hostAsset?.());
    if (!appVersion) return;
    try {
      await hostService.pruneVersions(hostId, [appVersion], PRUNE_AFTER_DAYS);
    } catch (error) {
      log(`[remote] could not tidy old program versions on ${hostId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const hostService = new RemoteHostService({
    sshPath: deps.sshPath ?? defaultSshClientPaths().ssh,
    hosts,
    send: (request) => deps.sessionManager.remoteHostRequest(request),
    asset: deps.hostAsset ?? (() => null),
    identity: { installId: readInstallId(PATHS.configDir), label: os.hostname() },
    liveSessions: (hostId) => deps.sessionManager.liveRemotePtys(hostId),
    // A sign-in through the user's ssh config that is refused is asked once more, so ssh can say it wants a passphrase.
    captureKeyPrompt: (args) => captureKeyPrompt(args, { sshPath: deps.sshPath ?? defaultSshClientPaths().ssh, createRunner: createSshRunner }),
  });
  const relay = new RemoteSessionRelay({ files: hostService, log });
  deps.sessionManager.setRemoteSessionRelay(relay);
  const status = new HostStatusBook({ onChange: (hostId) => deps.onHostsChanged?.(hostId) });
  const firstConnected = new Set<string>();
  const startsHeld = new Set<string>();
  const spawnAgentProbe = createSpawnAgentProbe((hostId, request) => hostService.runCommand(hostId, request));
  // A link reports its own state; a drop is a state here, never the end of a session.
  deps.sessionManager.on('remote-link', (event: { hostId: string; state: 'connecting' | 'connected' | 'reconnecting' | 'stopped'; detail: string | null }) => {
    status.noteLink(event.hostId, event.state, event.detail);
    // What is installed there may have changed while the link was away, and a list read with it down is unknown.
    if (event.state === 'connected') {
      invalidateHostAgentList(event.hostId);
      spawnAgentProbe.forgetHost(event.hostId);
    }
    // Once per host per run, when its link first comes up: tidy the versions of the program a host kept.
    if (event.state === 'connected' && !firstConnected.has(event.hostId)) {
      firstConnected.add(event.hostId);
      void pruneOldProgramVersions(event.hostId);
      deps.onHostFirstConnected?.(event.hostId);
    }
  });

  // Every row: a project hidden because its host was removed is still a remote one, and its folder here is only a
  // stand-in. Read as local, a start already on its way would run in that empty folder on this computer.
  const remoteOfProjectPath = (projectPath: string): { hostId: string; path: string } | null =>
    deps.projects().listIncludingHidden().find((project) => project.remote && samePath(project.path, projectPath))?.remote ?? null;
  // What an agent is told about a path, for a caller that holds only the project's path (a prompt's variables).
  setRemoteProjectLookup(remoteOfProjectPath);
  setHostAccessLookup((hostId) => hostAccessOf(hostService, hostId));
  // A remote project's worktrees are made and removed on its host, by the git there.
  setRemoteWorktreeResolver(createRemoteWorktreeResolver({
    remoteOfProjectPath,
    runCommand: (hostId, request) => hostService.runCommand(hostId, request),
    pathPresence: (hostId, paths) => hostService.pathPresence(hostId, paths),
    log,
  }));
  // Every read of git for a remote project's folder runs on its host (`git/remote-git.ts` lists who asks this first).
  setRemoteGitResolver(createRemoteGitResolver({
    remoteProjects: () => deps.projects().listIncludingHidden().flatMap((project) => (project.remote ? [{ path: project.path, remote: project.remote }] : [])),
    runCommand: (hostId, request) => hostService.runCommand(hostId, request),
  }));
  setRemoteLaunchResolver(createRemoteLaunchResolver({
    remoteOfProjectPath,
    hostInfo: (hostId) => hostService.hostInfo(hostId),
    readFile: (hostId, hostPath) => hostService.readFile(hostId, hostPath),
    jsonPatch: (hostId, request) => hostService.jsonPatch(hostId, request),
    writeFiles: (hostId, files) => hostService.writeFiles(hostId, files),
    removeFiles: (hostId, paths, expect) => hostService.removeFiles(hostId, paths, expect),
    pathPresence: (hostId, paths) => hostService.pathPresence(hostId, paths),
    runCommand: (hostId, request) => hostService.runCommand(hostId, request),
    homeMirror: (hostId) => PATHS.remoteHomeMirror(hostId),
    probeAgent: (hostId, cliName) => spawnAgentProbe.probe(hostId, cliName),
    hostName: (hostId) => hosts.getById(hostId)?.name ?? null,
    isHostRemoved: (hostId) => startsHeld.has(hostId) || Boolean(hosts.getById(hostId)?.removed_at),
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

  /** A host whose setup failed because of the network is tried again on a timer: the one that is waiting. */
  const retryTimers = new Map<string, NodeJS.Timeout>();
  const cancelRetry = (hostId: string): void => {
    const timer = retryTimers.get(hostId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(hostId);
  };
  /** A retry goes on only for a host that is still stored, not being removed, and not already up. */
  const retryIsDue = (hostId: string): boolean => {
    const row = hosts.getById(hostId);
    return Boolean(row) && !row?.removed_at && !startsHeld.has(hostId) && !hostService.isConnected(hostId);
  };

  /**
   * `retry` is for the starts nobody asked for (launch, a pty host restart). A person pressing Reconnect, or
   * adding a host, gets the answer of one attempt, and supersedes a retry that was waiting.
   */
  const attemptConnect = async (hostId: string, options: { retry: boolean; attempt: number }): Promise<void> => {
    // A retry keeps the row as it is: a first try says Connecting, and the tries after it must not flip the
    // chip back and forth while the reason stays the same.
    if (options.attempt === 0) status.set(hostId, 'connecting');
    try {
      await hostService.connect(hostId);
      cancelRetry(hostId);
      // Dropping a link forgets its wanted ports, and the plan would not send a set it thinks is unchanged.
      forwardPlan.resendHost(hostId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[remote] host ${hostId.slice(0, 8)} was not connected: ${message}`);
      status.set(hostId, 'unreachable', message);
      if (!options.retry || !isTransientConnectFailure(message)) {
        cancelRetry(hostId);
        return;
      }
      const delayMs = connectRetryDelayMs(options.attempt);
      const timer = setTimeout(() => {
        retryTimers.delete(hostId);
        if (!retryIsDue(hostId)) {
          cancelRetry(hostId);
          return;
        }
        void attemptConnect(hostId, { retry: true, attempt: options.attempt + 1 });
      }, delayMs);
      timer.unref();
      retryTimers.set(hostId, timer);
    }
  };

  const connectHost = async (hostId: string): Promise<void> => {
    cancelRetry(hostId);
    await attemptConnect(hostId, { retry: false, attempt: 0 });
  };

  // The links live in the pty host process, so a restart of it took every one with it while the agents
  // kept running on their hosts. Each host is added again with the PTYs main still holds there, and the
  // new link's reconcile rebinds them to their sessions on the host.
  deps.sessionManager.on('pty-host-restarted', () => {
    for (const hostId of hostService.connectedHosts()) {
      cancelRetry(hostId);
      void attemptConnect(hostId, { retry: true, attempt: 0 });
    }
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
    expectFirstConnect: (hostId) => { firstConnected.delete(hostId); },
    holdStarts: (hostId) => {
      startsHeld.add(hostId);
      return () => { startsHeld.delete(hostId); };
    },
    remoteOfProjectPath,
    probeAgent: (hostId, cliName) => probeAgentOnHost((id, request) => hostService.runCommand(id, request), hostId, cliName),
    async connectAll() {
      // attemptConnect never throws, so one host that fails or hangs holds up no other. A launch with the
      // network down retries by itself: nobody pressed anything to ask for these.
      await Promise.all(hosts.list().map((host) => {
        cancelRetry(host.id);
        return attemptConnect(host.id, { retry: true, attempt: 0 });
      }));
      // Ports reserved in an earlier run are still leased: forward them once their servers are up.
      forwardPlan.resend();
    },
  };
}

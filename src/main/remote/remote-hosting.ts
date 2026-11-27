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
import type { HostAsset, HostInstallError } from './link/host-installer';
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
import { isRuntimeDefect } from '../../shared/handled-error-copy';
import { remoteHostReporter, remoteProgramUpdateReporter } from './remote-report';
import { RemoteSessionRelay } from './remote-session-relay';
import { createProgramUpdater, programUpdateReportTags, type ProgramUpdater } from './program-update';
import type { ProgramUpdateSessionDeps } from '../ipc/helpers/program-update-sessions';

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
  /**
   * Look again at whether the host's program needs replacing by this app's version (`program-update.ts`),
   * after a project's cold open took back agents the first look found running and not yet held.
   */
  considerProgramUpdate(hostId: string): void;
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
  /**
   * A host's link came up for the first time this run: the projects opened before it can recover their paused
   * tasks. The program update waits for what it returns, so it counts the agents recovery took back.
   */
  onHostFirstConnected?: (hostId: string) => void | Promise<void>;
  /**
   * This app's sessions as an update of a host's program needs them (`ipc/helpers/program-update-sessions.ts`).
   * Without it no host's program is replaced.
   */
  programUpdateSessions?: ProgramUpdateSessionDeps;
  log?: (line: string) => void;
}

/** The session events after which a session may have reached, or left, the point a program update waits for. */
const SAFE_POINT_EVENTS = ['activity', 'turn-ended', 'event', 'session-changed', 'session-removed'] as const;

/** A program version on a host that nothing has installed or touched for this long is removed. */
const PRUNE_AFTER_DAYS = 30;

/** Whether two paths name the same folder: case-insensitive on Windows, where the project list may differ in case. */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

/**
 * `ssh` exits with this when the connection or the sign-in failed. Any other status is the remote
 * command's own.
 */
const SSH_OWN_FAILURE_EXIT_CODE = 255;

/**
 * Whether a connect failed on something of Kangentic's own, as opposed to the network, a refused
 * sign-in, an `ssh` that would not start or a host Kangentic does not support, which are the user's
 * to fix and are the ordinary failures here. Told by the error's class and fields, never its words:
 *
 * - this build carries no host program (`HostProgramMissingError`),
 * - the archive downloaded is not the one the manifest names (`HostProgramMismatchError`),
 * - the build's own asset is malformed, or the host found the archive it received did not match,
 * - the install script ran on the host and failed there: `ssh` reached the host and handed back the
 *   script's own exit status, where a host it could not reach or sign in to exits 255,
 * - a `TypeError`, `RangeError` or `ReferenceError`, which is this side's own logic.
 *
 * Matched by name, as `EXPECTED_FAILURE_NAMES` is, so nothing here depends on which module made
 * the error.
 */
function isConnectInstallDefect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isRuntimeDefect(error)) return true;
  if (error.name === 'HostProgramMissingError' || error.name === 'HostProgramMismatchError') return true;
  if (error.name !== 'HostInstallError') return false;
  const installError = error as HostInstallError;
  if (installError.code === 'checksum' || installError.step === 'asset') return true;
  return installError.step === 'install' && typeof installError.exitCode === 'number' && installError.exitCode !== SSH_OWN_FAILURE_EXIT_CODE;
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
      // report-ok: old program versions stay on the host, which costs disk there, and the next
      // run's first connect tidies again.
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
  /** Hosts whose program is being replaced: a start there would land on the program about to exit. */
  const startsHeldForUpdate = new Set<string>();
  const spawnAgentProbe = createSpawnAgentProbe((hostId, request) => hostService.runCommand(hostId, request));
  const programUpdateSessions = deps.programUpdateSessions;
  const programUpdater: ProgramUpdater | null = programUpdateSessions ? createProgramUpdater({
    ...programUpdateSessions,
    appVersion: () => assetVersion(deps.hostAsset?.()),
    programInfo: (hostId) => hostService.programInfo(hostId),
    snapshot: (hostId) => hostService.snapshot(hostId),
    runCommand: (hostId, request) => hostService.runCommand(hostId, request),
    supports: (hostId, method) => hostService.supports(hostId, method),
    retireIfIdle: (hostId, daemonPid) => hostService.retireIfIdle(hostId, daemonPid),
    liveRemotePtys: (hostId) => deps.sessionManager.liveRemotePtys(hostId),
    holdStarts: (hostId) => {
      startsHeldForUpdate.add(hostId);
      return () => { startsHeldForUpdate.delete(hostId); };
    },
    onSessionChange: (listener) => {
      // Off the event's stack: the engine and the open-work ledger take the event in after it. One
      // callback per burst: every session in the app emits these, local ones too.
      let queued = false;
      const handler = (): void => {
        if (queued) return;
        queued = true;
        setImmediate(() => {
          queued = false;
          listener();
        });
      };
      for (const eventName of SAFE_POINT_EVENTS) deps.sessionManager.on(eventName, handler);
      return () => {
        for (const eventName of SAFE_POINT_EVENTS) deps.sessionManager.off(eventName, handler);
      };
    },
    stageReporter: { report: (error, stage, ranForMs) => { remoteProgramUpdateReporter.report(error, programUpdateReportTags(stage, ranForMs)); } },
    log,
  }) : null;
  // A link reports its own state; a drop is a state here, never the end of a session.
  deps.sessionManager.on('remote-link', (event: { hostId: string; state: 'connecting' | 'connected' | 'reconnecting' | 'stopped'; detail: string | null }) => {
    status.noteLink(event.hostId, event.state, event.detail);
    // What is installed there may have changed while the link was away, and a list read with it down is unknown.
    if (event.state === 'connected') {
      invalidateHostAgentList(event.hostId);
      spawnAgentProbe.forgetHost(event.hostId);
      // Which program answers decides which helper methods may be sent (`HELPER_METHOD_SINCE`).
      hostService.programInfo(event.hostId).catch((error: unknown) => {
        // report-ok: until it answers the host counts as the oldest program the app talks to, which only
        // holds back methods newer than it; the next connection asks again.
        log(`[remote] could not read the program version of ${event.hostId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      // The link may come back to another program.
      hostService.forgetProgram(event.hostId);
    }
    programUpdater?.onLinkState(event.hostId, event.state);
    // Once per host per run, when its link first comes up: tidy the versions of the program a host kept, and
    // once its recovery has taken back the agents a quit left running, see whether the program needs replacing.
    if (event.state === 'connected' && !firstConnected.has(event.hostId)) {
      const hostId = event.hostId;
      firstConnected.add(hostId);
      void pruneOldProgramVersions(hostId);
      void Promise.resolve(deps.onHostFirstConnected?.(hostId))
        // report-ok: the recovery reports its own failure (`recoverRemoteProjectsOnHost`, `remote_projects`);
        // the look still runs, and finds any agent it did not take back as a terminal nobody holds.
        .catch(() => undefined)
        .then(() => programUpdater?.consider(hostId));
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
    isHostUpdating: (hostId) => startsHeldForUpdate.has(hostId),
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
      // A host program this build does not carry, an archive that fails its checksum, or an
      // install script that failed on the host reads as "unreachable" on the host's row, and the
      // user cannot fix any of them. The network, a refused sign-in and an unsupported host are
      // the ordinary failures here and are not reported.
      if (isConnectInstallDefect(error)) remoteHostReporter.report(error, { tags: { stage: 'connect_install' } });
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
      // A host being removed has no program to update: a watch on it ends, and an added-again host starts over.
      programUpdater?.forgetHost(hostId);
      return () => { startsHeld.delete(hostId); };
    },
    considerProgramUpdate: (hostId) => { void programUpdater?.consider(hostId); },
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

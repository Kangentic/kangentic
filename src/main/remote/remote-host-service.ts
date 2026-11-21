/**
 * Main's side of the SSH hosts (#913): bring a stored host's link up (installing Kangentic's small
 * program on the host first when it is not there), take it down, and ask or push through the helper
 * running on it. Everything that touches a host goes through the pty host's one `remote` request, so
 * main holds no connection of its own and a crash of main loses nothing on the host.
 *
 * Never asks for a password or a passphrase. `ssh` runs with BatchMode, so a host that needs input
 * fails with its own words, which the caller shows as they are.
 */

import type { SpawnRemote, SshHost } from '../../shared/types';
import { installHost, type HostAsset, type InstalledHost } from './link/host-installer';
import { createSshRunner, type SshRunner } from './link/ssh-run';
import type { HelperMethod, HelperRequestMap, HelperSessionRecord, HostFileSearch, HostFileWrite, HostInfo, RemoteHostConnection, RemoteHostRequest, RemoteSessionRoute } from './protocol/messages';
import { assertSafeDestination } from './ssh-client';
import { HOST_NOT_CONNECTED_SENTENCE, HOST_UNREACHABLE_ERROR_NAME, HostUnreachableError } from './link/host-unreachable-error';
import { RefusalError } from '../../shared/refusal';

export { assertSafeDestination, InvalidSshDestinationError } from './ssh-client';

/** Each argument is one pid. A pid that has gone already is not a failure of the ask. */
const HANG_UP_SCRIPT = 'kill -HUP "$@" 2>/dev/null; exit 0';
const HANG_UP_TIMEOUT_MS = 10_000;
/** Past Claude's SessionEnd budget, as the host's own agent-exit wait is. */
const LEFT_RUNNING_WAIT_MS = 10_000;
const LEFT_RUNNING_POLL_MS = 250;

/**
 * The `ssh` options every Kangentic connection starts with. BatchMode so nothing waits on a prompt
 * no one can answer, keepalives so a dead link is noticed, and no agent forwarding because the host
 * has no use for this computer's keys. Host key checking stays as the user set it.
 */
export function sshArgsFor(host: Pick<SshHost, 'destination' | 'key_path'>): string[] {
  assertSafeDestination(host.destination);
  // ConnectTimeout so a powered-off host fails in seconds, not after the TCP stack gives up.
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ForwardAgent=no'];
  if (host.key_path) args.push('-i', host.key_path, '-o', 'IdentitiesOnly=yes');
  args.push(host.destination);
  return args;
}

export interface RemoteHostServiceDeps {
  /** The `ssh` program. */
  sshPath: string;
  hosts: { getById(hostId: string): SshHost | undefined; list(): SshHost[] };
  /** The pty host's `remote` request (`PtyHostClient.remote`). */
  send: (request: RemoteHostRequest) => Promise<unknown>;
  /** The program to install on a host: this app's version of it, with its checksum. Null when this build carries none. */
  asset: () => HostAsset | readonly HostAsset[] | null;
  /** How this computer introduces itself to a host's helper. */
  identity: { installId: string; label: string };
  install?: (run: SshRunner, asset: HostAsset | readonly HostAsset[]) => Promise<InstalledHost>;
  /** The PTYs main already holds on a host, sent with its `addHost` so a restarted pty host routes them again. */
  liveSessions?: (hostId: string) => RemoteSessionRoute[];
  createRunner?: (config: { sshPath: string; args: string[] }) => SshRunner;
  /**
   * What `ssh` itself asks for when a sign-in with the user's own ssh config is refused (a key's
   * passphrase), by repeating the failed attempt once so it can ask. Null for nothing. Optional: without it
   * a refusal is ssh's plain words.
   */
  captureKeyPrompt?: (args: string[]) => Promise<string | null>;
}

/** How long past a run's own bound the link waits, so the host's answer to a timeout gets back here. */
const COMMAND_ANSWER_GRACE_MS = 10_000;

/**
 * The longest a request waits for its host's connect to finish. Above `ConnectTimeout=15`, since a
 * connect runs the install's ssh first (Sentry DESKTOP-4N: a task opened 5 s after launch asked the
 * host before its link existed).
 */
export const HOST_READY_WAIT_MS = 30_000;

type HelperRequest = Extract<RemoteHostRequest, { op: 'helper' }>;

/**
 * A failed connect's words on one line. Every non-empty line is kept: ssh's cause can follow a warning
 * line (a host key it just added), and a passphrase prompt follows the refusal (`withKeyPrompt`).
 */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).join(' ');
}

export class HostProgramMissingError extends Error {
  constructor() {
    super('This build of Kangentic does not include the program to install on a host. A development build makes it with npm run build:host.');
    this.name = 'HostProgramMissingError';
  }
}

export class RemoteHostService {
  private readonly infoByHost = new Map<string, HostInfo>();
  private readonly connected = new Set<string>();
  private readonly connecting = new Map<string, Promise<void>>();
  /** Hosts disconnected while a connect was on its way, which must not add the host afterwards. */
  private readonly droppedWhileConnecting = new Set<string>();
  /** A connect asked for after a disconnect, waiting for the dropped one to end. `whenReady` waits on it. */
  private readonly queuedReconnects = new Map<string, Promise<void>>();
  /** Why a host's last connect failed, in its own words, until a connect succeeds or it is disconnected. */
  private readonly lastConnectFailure = new Map<string, string>();

  constructor(private readonly deps: RemoteHostServiceDeps) {}

  isConnected(hostId: string): boolean {
    return this.connected.has(hostId);
  }

  /**
   * Install the program on the host if it is not there, then start dialing. Resolves once the link is
   * added, not once it is up: a link that cannot connect keeps retrying and says why as its state.
   * A refusal (an unsupported host, a failed checksum, `ssh`'s own error) rejects with the words as given.
   */
  connect(hostId: string): Promise<void> {
    // A Reconnect during a first connect joins it: two installs of one version on one host share their
    // upload paths on the host, and each would clear the other's. A connect asked for after a disconnect is newer
    // than it, so it waits for the dropped one and connects for itself. One asked for before it ends with it: left
    // to redial, it would bring back a host that is being removed.
    const running = this.connecting.get(hostId);
    if (running) {
      if (!this.droppedWhileConnecting.has(hostId)) return running;
      const queued = this.queuedReconnects.get(hostId);
      if (queued) return queued;
      const reconnect = running.catch(() => undefined).then(() => {
        this.queuedReconnects.delete(hostId);
        return this.connect(hostId);
      });
      this.queuedReconnects.set(hostId, reconnect);
      return reconnect;
    }
    const connecting = this.install(hostId).then(
      () => { this.lastConnectFailure.delete(hostId); },
      (error: unknown) => {
        if (!this.droppedWhileConnecting.has(hostId)) this.lastConnectFailure.set(hostId, messageOf(error));
        throw error;
      },
    ).finally(() => {
      this.connecting.delete(hostId);
      this.droppedWhileConnecting.delete(hostId);
    });
    this.connecting.set(hostId, connecting);
    return connecting;
  }

  private async install(hostId: string): Promise<void> {
    const host = this.deps.hosts.getById(hostId);
    if (!host || host.removed_at) throw new RefusalError('That host is not set up in Kangentic.');
    const args = sshArgsFor(host);
    const asset = this.deps.asset();
    if (!asset || (Array.isArray(asset) && asset.length === 0)) throw new HostProgramMissingError();
    const createRunner = this.deps.createRunner ?? createSshRunner;
    const install = this.deps.install ?? installHost;
    let installed: InstalledHost;
    try {
      installed = await install(createRunner({ sshPath: this.deps.sshPath, args }), asset);
    } catch (error) {
      throw await this.withKeyPrompt(host, args, error);
    }
    if (this.droppedWhileConnecting.has(hostId)) return;
    const connection: RemoteHostConnection = {
      sshPath: this.deps.sshPath,
      args,
      remoteCommand: installed.relayCommand,
      installId: this.deps.identity.installId,
      label: this.deps.identity.label,
    };
    const sessions = this.deps.liveSessions?.(hostId) ?? [];
    await this.deps.send({ op: 'addHost', hostId, connection, ...(sessions.length > 0 ? { sessions } : {}) });
    if (!this.droppedWhileConnecting.has(hostId)) this.connected.add(hostId);
  }

  /**
   * A refused sign-in through the user's own ssh config may be a key that needs a passphrase, which BatchMode
   * reports as the same `Permission denied` as a wrong key. `ssh`'s own prompt, when the repeated attempt gets
   * one, goes under its words. A key file Kangentic holds is never encrypted (it refuses one at the picker), so
   * only the config sign-in is asked. Whatever fails here leaves the original error as it was.
   */
  private async withKeyPrompt(host: SshHost, args: string[], error: unknown): Promise<unknown> {
    if (host.key_path || !this.deps.captureKeyPrompt) return error;
    if (!(error instanceof Error) || !/permission denied/i.test(error.message)) return error;
    const prompt = await this.deps.captureKeyPrompt(args).catch(() => null);
    if (prompt && !error.message.includes(prompt)) error.message = `${error.message}\n${prompt}`;
    return error;
  }

  /** Every host this service has added, for re-adding them all after the process holding the links restarts. */
  connectedHosts(): string[] {
    return [...this.connected];
  }

  /** Stop dialing a host. Its agents keep running there. */
  async disconnect(hostId: string): Promise<void> {
    if (this.connecting.has(hostId)) this.droppedWhileConnecting.add(hostId);
    this.connected.delete(hostId);
    this.infoByHost.delete(hostId);
    this.lastConnectFailure.delete(hostId);
    await this.deps.send({ op: 'removeHost', hostId });
  }

  /** The host's home and login shell, asked once and kept until it is disconnected. */
  async hostInfo(hostId: string): Promise<HostInfo> {
    const known = this.infoByHost.get(hostId);
    if (known) return known;
    const info = await this.helper(hostId, 'hostInfo', {});
    this.infoByHost.set(hostId, info);
    return info;
  }

  /** A spawn's remote descriptor for a folder on the host, with the shell the host answered for. */
  async resolveRemote(hostId: string, hostPath: string): Promise<SpawnRemote> {
    const info = await this.hostInfo(hostId);
    return { hostId, cwd: hostPath, shellName: info.shellName };
  }

  writeFiles(hostId: string, files: HostFileWrite[], directories?: string[]): Promise<HelperRequestMap['writeFiles']['result']> {
    return this.helper(hostId, 'writeFiles', { files, ...(directories ? { directories } : {}) });
  }

  /** One file whose bytes are too large for the JSON body of a request (an MCP answer), up to 1 MiB. */
  async writeFileRaw(hostId: string, filePath: string, content: string, mode?: number): Promise<HelperRequestMap['writeFileRaw']['result']> {
    return await this.sendHelper({
      op: 'helper',
      hostId,
      method: 'writeFileRaw',
      params: { path: filePath, ...(mode === undefined ? {} : { mode }) },
      raw: Buffer.from(content, 'utf8'),
    }) as HelperRequestMap['writeFileRaw']['result'];
  }

  /** Edit a JSON file the host's CLI shares with Kangentic, under the CLI's own lock. */
  jsonPatch(hostId: string, request: HelperRequestMap['jsonPatch']['params']): Promise<HelperRequestMap['jsonPatch']['result']> {
    return this.helper(hostId, 'jsonPatch', request);
  }

  /** Start sending a session's hook files across the link as `hookFile` events. */
  watchHooks(hostId: string, sessionId: string, directory: string, statusFile?: string): Promise<HelperRequestMap['watchHooks']['result']> {
    return this.helper(hostId, 'watchHooks', { sessionId, directory, ...(statusFile ? { statusFile } : {}) });
  }

  unwatchHooks(hostId: string, sessionId: string): Promise<HelperRequestMap['unwatchHooks']['result']> {
    return this.helper(hostId, 'unwatchHooks', { sessionId });
  }

  /** Start sending a session's growing files (its transcript) across the link as `fileChunk` events. */
  watchFiles(hostId: string, sessionId: string, files: Array<{ key: string; path: string }>, searches?: HostFileSearch[]): Promise<HelperRequestMap['watchFiles']['result']> {
    return this.helper(hostId, 'watchFiles', { sessionId, files, ...(searches && searches.length > 0 ? { searches } : {}) });
  }

  unwatchFiles(hostId: string, sessionId: string): Promise<HelperRequestMap['unwatchFiles']['result']> {
    return this.helper(hostId, 'unwatchFiles', { sessionId });
  }

  /** Remove files the app wrote on the host (an agent's hooks or MCP entry at the end of a session). */
  removeFiles(hostId: string, paths: string[], expect?: Record<string, string>): Promise<HelperRequestMap['removeFiles']['result']> {
    return this.helper(hostId, 'removeFiles', { paths, ...(expect ? { expect } : {}) });
  }

  /** Remove folders that hold nothing (a finished session's hook folders). A folder with anything in it is left. */
  removeEmptyDirectories(hostId: string, paths: string[]): Promise<HelperRequestMap['removeEmptyDirectories']['result']> {
    return this.helper(hostId, 'removeEmptyDirectories', { paths });
  }

  /**
   * Run a program on the host to completion, through the user's shell. The link waits past the run's own
   * bound, so a long run (a `run_script` automation) ends with the host's answer, not a timeout here.
   */
  async runCommand(hostId: string, request: HelperRequestMap['runCommand']['params']): Promise<HelperRequestMap['runCommand']['result']> {
    return await this.sendHelper({
      op: 'helper',
      hostId,
      method: 'runCommand',
      params: request,
      timeoutMs: request.timeoutMs + COMMAND_ANSWER_GRACE_MS,
    }) as HelperRequestMap['runCommand']['result'];
  }

  /** The ports a server on the host listens on. A failed read rejects: an empty list says nothing is listening. */
  async listeningPorts(hostId: string): Promise<number[]> {
    return (await this.helper(hostId, 'listeningPorts', {})).ports;
  }

  readFile(hostId: string, filePath: string, maxBytes?: number): Promise<HelperRequestMap['readFile']['result']> {
    return this.helper(hostId, 'readFile', { path: filePath, maxBytes });
  }

  /** Whether each path is there. Only this answer may say a path is absent; a failed ask is an error, never "absent". */
  pathPresence(hostId: string, paths: string[]): Promise<HelperRequestMap['pathPresence']['result']> {
    return this.helper(hostId, 'pathPresence', { paths });
  }

  /** The terminals the host's program runs, alive or exited, as its own ledger holds them. A failed ask rejects. */
  snapshot(hostId: string): Promise<HelperRequestMap['snapshot']['result']> {
    return this.helper(hostId, 'snapshot', {});
  }

  /** Which program version the host runs, for how long, with how many terminals, and which versions it holds. */
  programInfo(hostId: string): Promise<HelperRequestMap['programInfo']['result']> {
    return this.helper(hostId, 'programInfo', {});
  }

  /**
   * End the sessions the host's program still runs for these projects and this app holds no PTY for. A Remove with
   * the link down leaves them: its kill went with the link, and the task's record says suspended. A resume would
   * then run a second agent on the same conversation, and nothing adopts the first.
   *
   * Read from the snapshot the link itself reads, and hung up by pid, with each pid an argument of one fixed
   * script. Never `suspendAll`, which ends every session on the host, another computer's on this account included.
   * The hangup is how a PTY ends on Linux (`pty-teardown-grace.md`). Resolves with how many it ended, once they are
   * gone. Rejects when the host cannot be asked or one outlives the wait: a failed ask is never "nothing running".
   */
  async endSessionsLeftRunning(
    hostId: string,
    projectIds: ReadonlySet<string>,
    options: { timeoutMs?: number; pollMs?: number; keepSessionIds?: ReadonlySet<string> } = {},
  ): Promise<number> {
    const heldHere = new Set((this.deps.liveSessions?.(hostId) ?? []).map((route) => route.sessionId));
    // `keepSessionIds`: sessions a record still names as running, whose agent is not taken back yet (#913).
    const kept = options.keepSessionIds;
    const leftRunning = async (): Promise<HelperSessionRecord[]> => (await this.helper(hostId, 'snapshot', {})).sessions
      .filter((record) => record.alive && projectIds.has(record.projectId) && !heldHere.has(record.sessionId) && !kept?.has(record.sessionId));
    const sessions = await leftRunning();
    if (sessions.length === 0) return 0;
    // `kill` reads 0 as the script's own process group and -1 as everything the user owns on the host.
    const unsafe = sessions.find((record) => !Number.isSafeInteger(record.pid) || record.pid <= 1);
    if (unsafe) throw new Error(`The host reported pid ${unsafe.pid} for a running terminal, which cannot be ended.`);
    await this.runCommand(hostId, { file: 'sh', args: ['-c', HANG_UP_SCRIPT, 'kangentic-end', ...sessions.map((record) => String(record.pid))], timeoutMs: HANG_UP_TIMEOUT_MS });
    const deadline = Date.now() + (options.timeoutMs ?? LEFT_RUNNING_WAIT_MS);
    let remaining = await leftRunning();
    while (remaining.length > 0) {
      if (Date.now() >= deadline) throw new RefusalError(`${remaining.length} of this host's terminals are still running.`);
      await new Promise((resolve) => { setTimeout(resolve, options.pollMs ?? LEFT_RUNNING_POLL_MS); });
      remaining = await leftRunning();
    }
    return sessions.length;
  }

  /** Remove old program versions from the host. Never the running one, and never one in `keep`. */
  pruneVersions(hostId: string, keep: string[], olderThanDays: number): Promise<HelperRequestMap['pruneVersions']['result']> {
    return this.helper(hostId, 'pruneVersions', { keep, olderThanDays });
  }

  private async helper<M extends HelperMethod>(hostId: string, method: M, params: HelperRequestMap[M]['params']): Promise<HelperRequestMap[M]['result']> {
    return await this.sendHelper({ op: 'helper', hostId, method, params }) as HelperRequestMap[M]['result'];
  }

  /**
   * Every request to a host's helper passes here. It waits for a connect still under way, and turns the
   * router's "This host is not connected." into a sentence that names the host and why its last connect failed.
   */
  private async sendHelper(request: HelperRequest): Promise<unknown> {
    await this.whenReady(request.hostId);
    try {
      return await this.deps.send(request);
    } catch (error) {
      // By name: the router's refusal crosses the pty host's transport as a plain Error.
      if (error instanceof Error && error.name === HOST_UNREACHABLE_ERROR_NAME) throw this.notConnectedError(request.hostId, error);
      throw error;
    }
  }

  /**
   * Resolves once a connect under way for the host has added its link, so a start in the first seconds
   * after launch reaches the host rather than a link that does not exist yet. Bounded by
   * `HOST_READY_WAIT_MS`. A connect that fails, one that a disconnect overtook, and one still running at
   * the bound each reject with a `HostUnreachableError` that says so, unless the host was already added
   * before it: a Reconnect, or the retry after a pty host restart, runs while the host still counts as
   * connected, and the router then holds whatever link there is, so the request goes on and the router
   * answers. A Reconnect queued behind a dropped connect is waited for in its place, within the same
   * bound. With no connect under way it waits for nothing. A connect never asks the helper itself (the
   * install runs `ssh` directly), so no request here waits on a connect that waits on it.
   */
  private async whenReady(hostId: string): Promise<void> {
    let pending = this.pendingConnect(hostId);
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), HOST_READY_WAIT_MS);
      timer.unref?.();
    });
    try {
      while (pending) {
        const current = pending;
        let outcome: 'ready' | 'timeout';
        try {
          outcome = await Promise.race([current.then(() => 'ready' as const), timedOut]);
        } catch (error) {
          pending = this.newerConnect(hostId, current);
          if (pending) continue;
          if (this.connected.has(hostId)) return;
          throw this.notConnectedError(hostId, error);
        }
        if (this.connected.has(hostId)) return;
        if (outcome === 'timeout') throw new HostUnreachableError(hostId, `${this.hostName(hostId)} is still connecting.`);
        pending = this.newerConnect(hostId, current);
      }
    } finally {
      clearTimeout(timer);
    }
    // The connect it waited on ended without adding the host: a disconnect overtook it.
    throw this.notConnectedError(hostId);
  }

  private notConnectedError(hostId: string, cause?: unknown): HostUnreachableError {
    return new HostUnreachableError(hostId, this.notConnectedSentence(hostId), cause === undefined ? undefined : { cause });
  }

  /** A queued Reconnect first: the connect it waits behind was dropped and will not add the link. */
  private pendingConnect(hostId: string): Promise<void> | undefined {
    return this.queuedReconnects.get(hostId) ?? this.connecting.get(hostId);
  }

  /** A connect that started after `settled` ended, which a waiter on `settled` waits for next. */
  private newerConnect(hostId: string, settled: Promise<void>): Promise<void> | undefined {
    const next = this.pendingConnect(hostId);
    return next !== settled ? next : undefined;
  }

  private hostName(hostId: string): string {
    return this.deps.hosts.getById(hostId)?.name || 'This host';
  }

  private notConnectedSentence(hostId: string): string {
    const reason = this.lastConnectFailure.get(hostId);
    if (reason) return `${this.hostName(hostId)} is not connected: ${reason}`;
    const name = this.deps.hosts.getById(hostId)?.name;
    return name ? `${name} is not connected.` : HOST_NOT_CONNECTED_SENTENCE;
  }
}

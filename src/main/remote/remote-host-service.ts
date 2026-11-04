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
import type { HelperMethod, HelperRequestMap, HostFileWrite, HostInfo, RemoteHostConnection, RemoteHostRequest, RemoteSessionRoute } from './protocol/messages';
import { assertSafeDestination } from './ssh-client';

export { assertSafeDestination, InvalidSshDestinationError } from './ssh-client';

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
    // upload paths on the host, and each would clear the other's.
    const running = this.connecting.get(hostId);
    if (running) return running;
    const connecting = this.install(hostId).finally(() => this.connecting.delete(hostId));
    this.connecting.set(hostId, connecting);
    return connecting;
  }

  private async install(hostId: string): Promise<void> {
    const host = this.deps.hosts.getById(hostId);
    if (!host) throw new Error('That host is not set up in Kangentic.');
    const args = sshArgsFor(host);
    const asset = this.deps.asset();
    if (!asset || (Array.isArray(asset) && asset.length === 0)) throw new HostProgramMissingError();
    const createRunner = this.deps.createRunner ?? createSshRunner;
    const install = this.deps.install ?? installHost;
    const installed = await install(createRunner({ sshPath: this.deps.sshPath, args }), asset);
    const connection: RemoteHostConnection = {
      sshPath: this.deps.sshPath,
      args,
      remoteCommand: installed.relayCommand,
      installId: this.deps.identity.installId,
      label: this.deps.identity.label,
    };
    const sessions = this.deps.liveSessions?.(hostId) ?? [];
    await this.deps.send({ op: 'addHost', hostId, connection, ...(sessions.length > 0 ? { sessions } : {}) });
    this.connected.add(hostId);
  }

  /** Every host this service has added, for re-adding them all after the process holding the links restarts. */
  connectedHosts(): string[] {
    return [...this.connected];
  }

  /** Stop dialing a host. Its agents keep running there. */
  async disconnect(hostId: string): Promise<void> {
    this.connected.delete(hostId);
    this.infoByHost.delete(hostId);
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
    return await this.deps.send({
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

  /** Remove files the app wrote on the host (an agent's hooks or MCP entry at the end of a session). */
  removeFiles(hostId: string, paths: string[]): Promise<HelperRequestMap['removeFiles']['result']> {
    return this.helper(hostId, 'removeFiles', { paths });
  }

  /** Remove folders that hold nothing (a finished session's hook folders). A folder with anything in it is left. */
  removeEmptyDirectories(hostId: string, paths: string[]): Promise<HelperRequestMap['removeEmptyDirectories']['result']> {
    return this.helper(hostId, 'removeEmptyDirectories', { paths });
  }

  /** Run a program on the host to completion, through the user's shell, for a CLI's own probe. */
  runCommand(hostId: string, request: HelperRequestMap['runCommand']['params']): Promise<HelperRequestMap['runCommand']['result']> {
    return this.helper(hostId, 'runCommand', request);
  }

  readFile(hostId: string, filePath: string, maxBytes?: number): Promise<HelperRequestMap['readFile']['result']> {
    return this.helper(hostId, 'readFile', { path: filePath, maxBytes });
  }

  /** Whether each path is there. Only this answer may say a path is absent; a failed ask is an error, never "absent". */
  pathPresence(hostId: string, paths: string[]): Promise<HelperRequestMap['pathPresence']['result']> {
    return this.helper(hostId, 'pathPresence', { paths });
  }

  private async helper<M extends HelperMethod>(hostId: string, method: M, params: HelperRequestMap[M]['params']): Promise<HelperRequestMap[M]['result']> {
    return await this.deps.send({ op: 'helper', hostId, method, params }) as HelperRequestMap[M]['result'];
  }
}

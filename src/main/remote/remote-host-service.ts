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
import type { HelperMethod, HelperRequestMap, HostFileWrite, HostInfo, RemoteHostConnection, RemoteHostRequest } from './protocol/messages';

/** A destination that `ssh` would read as an option, or that carries whitespace or control characters. */
export class InvalidSshDestinationError extends Error {
  constructor(readonly destination: string) {
    super('The host address is not valid. Use a name from your SSH config, user@host, or an ssh:// address.');
    this.name = 'InvalidSshDestinationError';
  }
}

export function assertSafeDestination(destination: string): void {
  // A leading dash is an `ssh` option (-oProxyCommand=...), not a destination.
  if (destination.length === 0 || destination.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(destination)) {
    throw new InvalidSshDestinationError(destination);
  }
}

/**
 * The `ssh` options every Kangentic connection starts with. BatchMode so nothing waits on a prompt
 * no one can answer, keepalives so a dead link is noticed, and no agent forwarding because the host
 * has no use for this computer's keys. Host key checking stays as the user set it.
 */
export function sshArgsFor(host: Pick<SshHost, 'destination' | 'key_path'>): string[] {
  assertSafeDestination(host.destination);
  const args = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ForwardAgent=no'];
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
  asset: () => HostAsset | null;
  /** How this computer introduces itself to a host's helper. */
  identity: { installId: string; label: string };
  install?: (run: SshRunner, asset: HostAsset) => Promise<InstalledHost>;
  createRunner?: (config: { sshPath: string; args: string[] }) => SshRunner;
}

export class HostProgramMissingError extends Error {
  constructor() {
    super('This build of Kangentic does not include the program to install on a host.');
    this.name = 'HostProgramMissingError';
  }
}

export class RemoteHostService {
  private readonly infoByHost = new Map<string, HostInfo>();
  private readonly connected = new Set<string>();

  constructor(private readonly deps: RemoteHostServiceDeps) {}

  isConnected(hostId: string): boolean {
    return this.connected.has(hostId);
  }

  /**
   * Install the program on the host if it is not there, then start dialing. Resolves once the link is
   * added, not once it is up: a link that cannot connect keeps retrying and says why as its state.
   * A refusal (an unsupported host, a failed checksum, `ssh`'s own error) rejects with the words as given.
   */
  async connect(hostId: string): Promise<void> {
    const host = this.deps.hosts.getById(hostId);
    if (!host) throw new Error('That host is not set up in Kangentic.');
    const args = sshArgsFor(host);
    const asset = this.deps.asset();
    if (!asset) throw new HostProgramMissingError();
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
    await this.deps.send({ op: 'addHost', hostId, connection });
    this.connected.add(hostId);
  }

  /** Stop dialing a host. Its agents keep running there. */
  async disconnect(hostId: string): Promise<void> {
    this.connected.delete(hostId);
    this.infoByHost.delete(hostId);
    await this.deps.send({ op: 'removeHost', hostId });
  }

  /** Connect every stored host at startup. One that fails does not stop the rest; its error is returned. */
  async connectAll(): Promise<Array<{ hostId: string; error: Error | null }>> {
    const results: Array<{ hostId: string; error: Error | null }> = [];
    for (const host of this.deps.hosts.list()) {
      try {
        await this.connect(host.id);
        results.push({ hostId: host.id, error: null });
      } catch (error) {
        results.push({ hostId: host.id, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
    return results;
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

  writeFiles(hostId: string, files: HostFileWrite[]): Promise<HelperRequestMap['writeFiles']['result']> {
    return this.helper(hostId, 'writeFiles', { files });
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

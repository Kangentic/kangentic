/**
 * What the SSH settings tab and the Add project dialog do (#913), behind the IPC handlers: add a host
 * (trust its key, set up how Kangentic signs in, install its program, connect), remove one with its
 * projects, reconnect, forget an old key, check a folder on a host, and prepare a remote project.
 *
 * Each step that changes something can be undone by the step after it failing: a host whose key step
 * fails is not left in the table, and a key made for it is deleted. A host whose only problem is that it
 * cannot be connected stays in the table with the reason, so the user can fix the host and retry.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Project,
  ProjectCreateInput,
  SshClientStatus,
  SshHost,
  SshHostAddInput,
  SshHostKeyProbe,
  SshHostStatus,
  SshRemoteFolderProbe,
} from '../../shared/types';
import { childProcessEnv } from '../shared/child-env';
import { sshArgsFor } from './remote-host-service';
import { assertSafeDestination } from './ssh-client';
import type { RemoteHosting } from './remote-hosting';
import {
  createHostKey,
  deleteHostKeys,
  detectSshClient,
  forgetHostKey,
  importHostKey,
  installPublicKeyWithPassword,
  probeHostKey,
  removeKeyCommand,
  trustHostKey,
  type SshSetupDeps,
} from './ssh-setup';

const MAX_HOST_NAME_LENGTH = 60;

export interface SshHostAdminDeps {
  hosting: Pick<RemoteHosting, 'hosts' | 'hostService' | 'status' | 'connectHost'>;
  projects: {
    listOnHost(hostId: string): Project[];
  };
  setup: SshSetupDeps;
  /** Take a project out of Kangentic completely: its sessions, its database, its row. */
  removeProject(project: Project): Promise<void>;
  /** Where remote projects' shell folders live, so removal never deletes a folder outside it. */
  remoteProjectsRoot: string;
  /** A new folder id and path for a remote project's shell. */
  newShellFolder(): string;
  log?: (line: string) => void;
}

export class SshHostAdmin {
  /** Addresses being added right now, so a second add of one cannot start before the first has made its row. */
  private readonly adding = new Set<string>();

  constructor(private readonly deps: SshHostAdminDeps) {}

  detectClient(): Promise<SshClientStatus> {
    return detectSshClient(this.deps.setup);
  }

  listHosts(): SshHostStatus[] {
    return this.deps.hosting.hosts.list().map((host) => this.statusOf(host));
  }

  async probeHostKey(destination: string): Promise<SshHostKeyProbe> {
    const probe = await probeHostKey(destination, this.deps.setup);
    return { hostname: probe.hostname, port: probe.port, keyType: probe.keyType, fingerprint: probe.fingerprint };
  }

  async addHost(input: SshHostAddInput): Promise<SshHostStatus> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_HOST_NAME_LENGTH) throw new Error(`Give the host a name of 1 to ${MAX_HOST_NAME_LENGTH} characters.`);
    assertSafeDestination(input.destination);

    // One host per address. Two rows for one machine would run two links that take the host over from each
    // other (one install, one owner at a time), each seeing "the peer ended the connection" again and again.
    // The in-flight check covers a second add that starts before the first has made its row.
    const existing = this.deps.hosting.hosts.list().find((candidate) => candidate.destination === input.destination);
    if (existing) throw new Error(`${input.destination} is already added as "${existing.name}".`);
    if (this.adding.has(input.destination)) throw new Error(`${input.destination} is already being added.`);
    this.adding.add(input.destination);
    try {
      return await this.addNewHost(input, name);
    } finally {
      this.adding.delete(input.destination);
    }
  }

  private async addNewHost(input: SshHostAddInput, name: string): Promise<SshHostStatus> {
    // The key the user was shown, or nothing: a host that changed its key meanwhile is refused here.
    await trustHostKey(input.destination, input.expectedFingerprint, this.deps.setup);

    const host = this.deps.hosting.hosts.create({ name, destination: input.destination });
    let createdKeyPath: string | null = null;
    try {
      if (input.signIn.method === 'key-file') {
        const copy = await importHostKey(host.id, input.signIn.keyFilePath, this.deps.setup);
        this.deps.hosting.hosts.setKey(host.id, copy, false);
      } else if (input.signIn.method === 'create-key') {
        const pair = await createHostKey(host.id, this.deps.setup);
        createdKeyPath = pair.privateKeyPath;
        await installPublicKeyWithPassword(input.destination, pair.publicKey, input.signIn.password, this.deps.setup);
        this.deps.hosting.hosts.setKey(host.id, pair.privateKeyPath, true);
      }
    } catch (error) {
      // Nothing of this host is kept: no row, and no key made for it. A step that failed after the key
      // reached the host (a timeout while ssh was still running, say) would leave its line in
      // authorized_keys with no copy here to ever remove it, so take it off while the key still exists.
      if (createdKeyPath) await this.takeKeyOffHost(input.destination, createdKeyPath, input.name.trim());
      this.deps.hosting.hosts.delete(host.id);
      await deleteHostKeys(host.id, this.deps.setup).catch(() => undefined);
      throw error;
    }

    await this.deps.hosting.connectHost(host.id);
    return this.statusOf(this.deps.hosting.hosts.getById(host.id) ?? host);
  }

  async reconnectHost(hostId: string): Promise<SshHostStatus> {
    const host = this.requireHost(hostId);
    await this.deps.hosting.connectHost(hostId);
    return this.statusOf(host);
  }

  renameHost(hostId: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_HOST_NAME_LENGTH) throw new Error(`Give the host a name of 1 to ${MAX_HOST_NAME_LENGTH} characters.`);
    this.requireHost(hostId);
    this.deps.hosting.hosts.rename(hostId, trimmed);
  }

  async forgetHostKey(hostId: string): Promise<void> {
    await forgetHostKey(this.requireHost(hostId).destination, this.deps.setup);
  }

  /**
   * Remove a host: its projects leave Kangentic (and stay on the host), their running agents end the way
   * a project's removal ends them, the key Kangentic made is taken off the host when it can be reached
   * and deleted here, and the link stops.
   */
  async removeHost(hostId: string): Promise<void> {
    const host = this.requireHost(hostId);
    for (const project of this.deps.projects.listOnHost(hostId)) {
      await this.deps.removeProject(project);
      await this.removeShellFolder(project.path);
    }
    if (host.key_created && host.key_path) await this.takeKeyOffHost(host.destination, host.key_path, host.name);
    await this.deps.hosting.hostService.disconnect(hostId).catch((error: unknown) => {
      this.deps.log?.(`[remote] could not stop the link for ${hostId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.deps.hosting.status.remove(hostId);
    await deleteHostKeys(hostId, this.deps.setup).catch(() => undefined);
    this.deps.hosting.hosts.delete(hostId);
  }

  /** Whether a folder exists on a host, as the host's helper says: only it can. A link that is down is an error, not "missing". */
  async probeRemoteFolder(hostId: string, folderPath: string): Promise<SshRemoteFolderProbe> {
    this.requireHost(hostId);
    const info = await this.deps.hosting.hostService.hostInfo(hostId);
    const resolved = resolveHostFolder(folderPath, info.home);
    const [folder, git] = await this.deps.hosting.hostService.pathPresence(hostId, [resolved, `${resolved}/.git`]);
    return { exists: folder === 'present', path: resolved, isGitRepo: git === 'present' };
  }

  /**
   * Get a remote project ready to be created: check its folder is there, make its shell folder on this
   * computer, and keep `.kangentic/` out of the host repository's git status. Returns the input with
   * the shell folder as its path.
   */
  async prepareRemoteProject(input: ProjectCreateInput): Promise<ProjectCreateInput> {
    const remote = input.remote;
    if (!remote) throw new Error('This is not a remote project.');
    this.requireHost(remote.hostId);
    const probe = await this.probeRemoteFolder(remote.hostId, remote.path);
    if (!probe.exists) throw new Error(`${probe.path} does not exist on that host.`);

    const shellFolder = this.deps.newShellFolder();
    await fs.mkdir(shellFolder, { recursive: true });
    try {
      if (probe.isGitRepo) await this.excludeKangenticFolder(remote.hostId, probe.path);
    } catch (error) {
      await fs.rm(shellFolder, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { ...input, path: shellFolder, remote: { hostId: remote.hostId, path: probe.path } };
  }

  /** Keep Kangentic's runtime folder out of `git status` on the host, the way project open does on this computer. */
  private async excludeKangenticFolder(hostId: string, projectFolder: string): Promise<void> {
    const service = this.deps.hosting.hostService;
    const excludeFile = `${projectFolder}/.git/info/exclude`;
    const [infoFolder] = await service.pathPresence(hostId, [`${projectFolder}/.git/info`]);
    // A `.git` that is a file (a worktree or a submodule) has no info folder here: leave it alone.
    if (infoFolder !== 'present') return;
    const current = await service.readFile(hostId, excludeFile);
    const existing = current.content ?? '';
    if (existing.split(/\r?\n/).some((line) => line.trim() === '.kangentic/' || line.trim() === '.kangentic')) return;
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await service.writeFiles(hostId, [{ path: excludeFile, content: `${existing}${separator}.kangentic/\n`, mode: 0o644 }]);
  }

  /**
   * Take a key Kangentic made off a host, signing in with that key. Best effort, and never throws: the
   * host may be off, or the key may never have got there.
   */
  private async takeKeyOffHost(destination: string, keyPath: string, label: string): Promise<void> {
    try {
      const publicKey = (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim();
      // The same options as every connection (`sshArgsFor`), and the same scrubbed environment as every setup step.
      await this.deps.setup.run(this.deps.setup.sshPath, [
        ...(this.deps.setup.sshOptions ?? []),
        ...sshArgsFor({ destination, key_path: keyPath }),
        removeKeyCommand(publicKey),
      ], { env: childProcessEnv(), timeout: 30_000 });
    } catch (error) {
      // The key stays in the host's authorized_keys, which its owner can edit by hand.
      this.deps.log?.(`[remote] could not take the key off ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a remote project's shell folder, only ever inside the folder remote projects live in. The folder
   * is Kangentic's own, unlike a local project's, so a project delete and a failed create remove it too.
   */
  async removeShellFolder(shellFolder: string): Promise<void> {
    const root = path.resolve(this.deps.remoteProjectsRoot);
    const target = path.resolve(shellFolder);
    if (target === root || !target.startsWith(root + path.sep)) return;
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
  }

  private requireHost(hostId: string): SshHost {
    const host = this.deps.hosting.hosts.getById(hostId);
    if (!host) throw new Error('That host is not set up in Kangentic.');
    return host;
  }

  private statusOf(host: SshHost): SshHostStatus {
    const status = this.deps.hosting.status.get(host.id);
    return {
      host,
      state: status?.state ?? 'connecting',
      detail: status?.detail ?? null,
      since: status?.since ?? null,
      projectCount: this.deps.projects.listOnHost(host.id).length,
    };
  }
}

/** A folder the user typed, as an absolute path on the host: `~` is the host's home, anything else must already be absolute. */
export function resolveHostFolder(folderPath: string, home: string): string {
  const trimmed = folderPath.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f]/.test(trimmed)) throw new Error('Enter the folder\'s path on the host.');
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? `${home}${trimmed.slice(1)}` : trimmed;
  if (!expanded.startsWith('/')) throw new Error('Enter an absolute path on the host, starting with / or ~/.');
  const normalized = expanded.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  if (normalized.split('/').includes('..')) throw new Error('Leave out .. from the path.');
  return normalized;
}

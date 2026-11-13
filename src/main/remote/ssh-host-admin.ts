/**
 * What the SSH settings tab and the Add project dialog do (#913), behind the IPC handlers: add a host
 * (trust its key, set up how Kangentic signs in, install its program, connect), edit one in place, remove
 * one (which hides its projects and deletes nothing), clear its projects' data, reconnect, forget an old
 * key, list and check folders on a host, and prepare a remote project.
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
  SshConfigHost,
  SshDirectoryEntry,
  SshDirectoryListing,
  SshHost,
  SshHostAddInput,
  SshHostKeyProbe,
  SshHostProgram,
  SshHostStatus,
  SshHostUpdateInput,
  SshRemoteFolderProbe,
  SshSignIn,
} from '../../shared/types';
import { renameWithRetry } from '../fs/directory-move';
import { childProcessEnv } from '../shared/child-env';
import { sshArgsFor } from './remote-host-service';
import { assertSafeDestination } from './ssh-client';
import { readSshConfigHosts } from './ssh-config-hosts';
import type { RemoteHosting } from './remote-hosting';
import {
  checkKeyFile,
  createHostKey,
  deleteHostKeys,
  KEYS_ASIDE_SUFFIX,
  detectSshClient,
  hostKeyDirectory,
  importHostKey,
  installPublicKeyWithPassword,
  probeHostKey,
  readRecordedFingerprint,
  removeKeyCommand,
  replaceHostKey,
  trustHostKey,
  type SshSetupDeps,
} from './ssh-setup';
import { RefusalError } from '../../shared/refusal';

const MAX_HOST_NAME_LENGTH = 60;
const SIGN_IN_PROOF_TIMEOUT_MS = 30_000;
const TAKE_KEY_OFF_TIMEOUT_MS = 30_000;

function assertHostName(name: string): void {
  if (name.length === 0 || name.length > MAX_HOST_NAME_LENGTH) throw new RefusalError(`Give the host a name of 1 to ${MAX_HOST_NAME_LENGTH} characters.`);
}

/** Whether a resolved path on a host is its home or beneath it. */
function isInsideHome(resolved: string, home: string): boolean {
  return resolved === home || resolved.startsWith(`${home.replace(/\/+$/, '')}/`);
}

/** A new sign-in set up with the old keys aside, not yet proved. */
interface SignInChange {
  /** The new sign-in works: take the old key off the host and delete it here. */
  commit(): Promise<void>;
  /** It does not: put back the keys and the row the host had. */
  rollback(): Promise<void>;
}

/** Roll back after `error`, and say so if that failed too, with where the old key still is. */
async function withRollback(error: unknown, change: SignInChange | null, aside?: string): Promise<unknown> {
  try {
    await change?.rollback();
    return error;
  } catch (rollbackError) {
    const reason = error instanceof Error ? error.message : String(error);
    const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    const where = aside ? `, so it is still at ${aside}` : ` (it is still in the folder beside the host's keys, named ${KEYS_ASIDE_SUFFIX})`;
    return new Error(`${reason} The old key could not be put back${where}: ${rollbackReason}`, { cause: error });
  }
}

/**
 * A run that ended between moving the keys aside and finishing leaves the aside folder behind. When the row's key
 * is not where the row says, the aside folder holds the only copy, so it goes back. Otherwise it is the old key of
 * a change that finished, and must not stay as a stray private key.
 */
async function settleInterruptedChange(host: SshHost, keyDirectory: string, aside: string): Promise<void> {
  const present = (target: string): Promise<boolean> => fs.access(target).then(() => true, () => false);
  if (!await present(aside)) return;
  if (!host.key_path || await present(host.key_path)) {
    await fs.rm(aside, { recursive: true, force: true });
    return;
  }
  await fs.rm(keyDirectory, { recursive: true, force: true });
  await renameWithRetry(aside, keyDirectory);
}

/** One address as a comparison key. A host name does not differ by case; the user name before it does. */
function addressKeyOf(destination: string): string {
  const trimmed = destination.trim();
  const hostStart = trimmed.lastIndexOf('@') + 1;
  return trimmed.slice(0, hostStart) + trimmed.slice(hostStart).toLowerCase();
}

export interface SshHostAdminDeps {
  hosting: Pick<RemoteHosting, 'hosts' | 'hostService' | 'status' | 'connectHost' | 'expectFirstConnect' | 'holdStarts'>;
  projects: {
    listOnHost(hostId: string): Project[];
  };
  setup: SshSetupDeps;
  /** Take a project out of Kangentic completely: its sessions, its database, its row. Only Clear data does this to a host's projects. */
  removeProject(project: Project): Promise<void>;
  /** Stop a project's live agents and record them as suspended, so they start again with the host. Deletes nothing. */
  suspendProjectSessions(project: Project): Promise<void>;
  /** Take a project the removal just hid out of the running app: its background work, its windows, and the current project. */
  hideProject?(project: Project): void;
  /** Whether an agent or terminal is running for a project on the host, which a change of its address or sign-in would cut. */
  hasLiveSessions?(hostId: string): boolean;
  /** A host's projects are shown again after it was added back: start what they had running and tell the window. */
  revealProjects?(hostId: string): Promise<void>;
  /** Tell the window the set of projects changed (a host's projects were hidden or deleted). */
  projectsChanged?(): void;
  /** Where remote projects' shell folders live, so removal never deletes a folder outside it. */
  remoteProjectsRoot: string;
  /** A new folder id and path for a remote project's shell. */
  newShellFolder(): string;
  /** Delete this computer's mirror of a host's home folder, where its transcripts are copied to. */
  removeHomeMirror?: (hostId: string) => Promise<void>;
  /** This app's version, to compare with the program's on a host. */
  appVersion?: () => string | null;
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

  /** Whether a key file the user chose can be used, so a passphrase key is refused when it is chosen. Rejects with the reason. */
  async checkKeyFile(keyFilePath: string): Promise<void> {
    await checkKeyFile(keyFilePath);
  }

  /** The named hosts in this computer's `~/.ssh/config`, for the address field. A missing file is no hosts. */
  listConfigHosts(): Promise<SshConfigHost[]> {
    return readSshConfigHosts(this.deps.setup.homeDirectory);
  }

  async probeHostKey(destination: string): Promise<SshHostKeyProbe> {
    const probe = await probeHostKey(destination, this.deps.setup);
    return { hostname: probe.hostname, port: probe.port, keyType: probe.keyType, fingerprint: probe.fingerprint };
  }

  async addHost(input: SshHostAddInput): Promise<SshHostStatus> {
    const name = input.name.trim();
    assertHostName(name);
    assertSafeDestination(input.destination);

    // One host per address. Two rows for one machine would run two links that take the host over from each
    // other (one install, one owner at a time), each seeing "the peer ended the connection" again and again.
    // The in-flight check covers a second add that starts before the first has made its row.
    const addressKey = addressKeyOf(input.destination);
    const existing = this.deps.hosting.hosts.list().find((candidate) => addressKeyOf(candidate.destination) === addressKey);
    if (existing) throw new RefusalError(`${input.destination} is already added as "${existing.name}".`);
    if (this.adding.has(addressKey)) throw new RefusalError(`${input.destination} is already being added.`);
    this.adding.add(addressKey);
    try {
      // The same address as a host that was removed: that row comes back, so its projects do too.
      const removed = this.deps.hosting.hosts.listRemoved().find((candidate) => addressKeyOf(candidate.destination) === addressKey);
      return await this.addNewHost(input, name, removed);
    } finally {
      this.adding.delete(addressKey);
    }
  }

  private async addNewHost(input: SshHostAddInput, name: string, removed?: SshHost): Promise<SshHostStatus> {
    // The key the user was shown, or nothing: a host that changed its key meanwhile is refused here.
    await trustHostKey(input.destination, input.expectedFingerprint, this.deps.setup);

    // A removed host's row is restored under the name given now, and its projects are still its own.
    const restored = removed ? this.deps.hosting.hosts.restore(removed.id, name) : undefined;
    const host = restored ?? this.deps.hosting.hosts.create({ name, destination: input.destination });
    let createdKeyPath: string | null = null;
    try {
      await this.applySignIn(host.id, input.destination, input.signIn, (keyPath) => { createdKeyPath = keyPath; });
    } catch (error) {
      // Nothing of this host is kept: no row, and no key made for it. A step that failed after the key
      // reached the host (a timeout while ssh was still running, say) would leave its line in
      // authorized_keys with no copy here to ever remove it, so take it off while the key still exists.
      if (createdKeyPath) await this.takeKeyOffHost(input.destination, createdKeyPath, input.name.trim());
      // A restored host goes back to being removed, so its projects stay hidden and nothing is lost.
      if (restored) this.deps.hosting.hosts.markRemoved(host.id);
      else this.deps.hosting.hosts.delete(host.id);
      await deleteHostKeys(host.id, this.deps.setup).catch(() => undefined);
      throw error;
    }

    // A host seen connected earlier this run would otherwise not start its projects when the link comes up.
    if (restored) this.deps.hosting.expectFirstConnect(host.id);
    await this.deps.hosting.connectHost(host.id);
    if (restored) {
      await this.deps.revealProjects?.(host.id).catch((error: unknown) => {
        this.deps.log?.(`[remote] could not start ${host.name}'s projects again: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return this.statusOf(this.deps.hosting.hosts.getById(host.id) ?? host);
  }

  /**
   * Set up how Kangentic signs in to a host and record it on the host's row: the user's own config, a copy of a
   * key file, or a key Kangentic makes and adds with the host's password. `onKeyCreated` is told the path of a key
   * made, as soon as it exists, so a caller whose later step fails can take it back off the host.
   */
  private async applySignIn(hostId: string, destination: string, signIn: SshSignIn, onKeyCreated: (keyPath: string) => void): Promise<void> {
    if (signIn.method === 'key-file') {
      const copy = await importHostKey(hostId, signIn.keyFilePath, this.deps.setup);
      this.deps.hosting.hosts.setKey(hostId, copy, false);
    } else if (signIn.method === 'create-key') {
      const pair = await createHostKey(hostId, this.deps.setup);
      onKeyCreated(pair.privateKeyPath);
      await installPublicKeyWithPassword(destination, pair.publicKey, signIn.password, this.deps.setup);
      this.deps.hosting.hosts.setKey(hostId, pair.privateKeyPath, true);
    } else {
      this.deps.hosting.hosts.setKey(hostId, null, false);
    }
  }

  /**
   * Change a host's name, address or sign-in in place. Its projects keep their host, so they keep their
   * directories. The name saves at once. A new address needs the key the user was shown for it, and is refused when
   * another host (or a removed one, whose projects it would shadow) already has it. Refused while terminals run on
   * the host, since the link restarts.
   *
   * The new address and sign-in are proved with a real `ssh` in BatchMode before anything is taken away, because a
   * key file is only copied and My SSH config runs nothing, and `connectHost` never throws. So a sign-in that cannot
   * get in rejects with ssh's own words and leaves the address, the keys and the row as they were. The old key comes
   * off the host only after the proof: on a host with passwords off it is the only way back in.
   */
  async updateHost(hostId: string, input: SshHostUpdateInput): Promise<SshHostStatus> {
    const host = this.requireHost(hostId);
    const name = input.name.trim();
    assertHostName(name);
    const destination = input.destination.trim();
    const addressChanged = addressKeyOf(destination) !== addressKeyOf(host.destination);
    if (!addressChanged && !input.signIn) {
      this.deps.hosting.hosts.rename(hostId, name);
      return this.statusOf(this.deps.hosting.hosts.getById(hostId) ?? host);
    }

    assertSafeDestination(destination);
    const newKey = addressKeyOf(destination);
    if (addressChanged) {
      const other = this.deps.hosting.hosts.list().find((candidate) => candidate.id !== hostId && addressKeyOf(candidate.destination) === newKey);
      if (other) throw new RefusalError(`${destination} is already added as "${other.name}".`);
      const hidden = this.deps.hosting.hosts.listRemoved().find((candidate) => addressKeyOf(candidate.destination) === newKey);
      if (hidden) throw new RefusalError(`${destination} belongs to a host you removed, with its projects. Add it again from Add host to bring them back.`);
      if (this.adding.has(newKey)) throw new RefusalError(`${destination} is already being added.`);
      if (!input.expectedFingerprint) throw new RefusalError('Show the new address\'s key and trust it before saving the address.');
      // A key Kangentic made was added to the old machine only: it has to be made again for the new one.
      if (host.key_created && !input.signIn) throw new RefusalError('Sign in again for the new address: the key Kangentic made was added to the old one.');
    }
    if (this.deps.hasLiveSessions?.(hostId)) {
      throw new RefusalError('Stop the terminals running on this host first. Changing its address or sign-in restarts the connection.');
    }

    this.adding.add(newKey);
    try {
      if (addressChanged) await trustHostKey(destination, input.expectedFingerprint ?? '', this.deps.setup);
      const change = input.signIn ? await this.beginSignInChange(host, destination, input.signIn) : null;
      try {
        await this.proveSignIn(destination, this.deps.hosting.hosts.getById(hostId)?.key_path ?? null);
      } catch (error) {
        throw await withRollback(error, change);
      }
      this.deps.hosting.hosts.setDestination(hostId, destination);
      this.deps.hosting.hosts.rename(hostId, name);
      await change?.commit();
    } finally {
      this.adding.delete(newKey);
    }

    // The link was made for the old address or key: end it and make it again.
    await this.deps.hosting.hostService.disconnect(hostId).catch((error: unknown) => {
      this.deps.log?.(`[remote] could not stop the link for ${hostId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.deps.hosting.connectHost(hostId);
    return this.statusOf(this.deps.hosting.hosts.getById(hostId) ?? host);
  }

  /**
   * Set up a new sign-in, with the old key files moved aside. Moved, never copied: a rename cannot leave two half
   * copies, keeps the ACL Windows' ssh requires of a key, and a folder that is not there is the only failure that
   * means there are no keys. Anything else stops here, before a key is touched.
   *
   * Nothing is taken off the host yet. The caller proves the sign-in, then commits, which takes a key Kangentic
   * made off the old address, or rolls back. A key file the user chose is never touched on the host.
   */
  private async beginSignInChange(current: SshHost, destination: string, signIn: SshSignIn): Promise<SignInChange> {
    // What the host had, kept apart from the row, which the new sign-in rewrites.
    const host: SshHost = { ...current };
    const keyDirectory = hostKeyDirectory(this.deps.setup.configDirectory, host.id);
    const aside = `${keyDirectory}${KEYS_ASIDE_SUFFIX}`;
    await settleInterruptedChange(host, keyDirectory, aside);
    let hadKeys = true;
    try {
      await renameWithRetry(keyDirectory, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hadKeys = false;
    }

    let createdKeyPath: string | null = null;
    const change: SignInChange = {
      commit: async () => {
        if (hadKeys && host.key_created && host.key_path) {
          await this.takeKeyOffHost(host.destination, path.join(aside, path.basename(host.key_path)), host.name);
        }
        await fs.rm(aside, { recursive: true, force: true }).catch((error: unknown) => {
          this.deps.log?.(`[remote] could not delete the old keys of ${host.name}: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
      rollback: async () => {
        if (createdKeyPath) await this.takeKeyOffHost(destination, createdKeyPath, host.name);
        this.deps.hosting.hosts.setKey(host.id, host.key_path, host.key_created);
        await fs.rm(keyDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        if (hadKeys) await renameWithRetry(aside, keyDirectory);
      },
    };
    try {
      await this.applySignIn(host.id, destination, signIn, (keyPath) => { createdKeyPath = keyPath; });
    } catch (error) {
      throw await withRollback(error, change, aside);
    }
    return change;
  }

  /** Sign in the way the link will, and run nothing. Rejects with ssh's own words. */
  private async proveSignIn(destination: string, keyPath: string | null): Promise<void> {
    const result = await this.deps.setup.run(this.deps.setup.sshPath, [
      ...(this.deps.setup.sshOptions ?? []),
      ...sshArgsFor({ destination, key_path: keyPath }),
      'true',
    ], { env: childProcessEnv(), timeout: SIGN_IN_PROOF_TIMEOUT_MS });
    if (result.code !== 0) throw new RefusalError((result.stderr || result.stdout).trim() || `ssh to ${destination} exited with ${result.code}.`);
  }

  async reconnectHost(hostId: string): Promise<SshHostStatus> {
    const host = this.requireHost(hostId);
    await this.deps.hosting.connectHost(hostId);
    return this.statusOf(host);
  }

  /**
   * What the program on a host reports about itself. Asks the host, so it rejects with the link's own words
   * while the host is not connected; the settings row asks only for a connected host.
   */
  async hostProgram(hostId: string): Promise<SshHostProgram> {
    this.requireHost(hostId);
    const info = await this.deps.hosting.hostService.programInfo(hostId);
    return {
      version: info.version,
      appVersion: this.deps.appVersion?.() ?? null,
      startedAt: info.startedAt,
      liveSessions: info.liveSessions,
      installedVersions: info.installedVersions,
    };
  }

  /**
   * The key a host whose key changed presents now, with the fingerprint the user trusted before when it can
   * be read. Trusts nothing: the dialog shows it and the user decides.
   */
  async probeChangedHostKey(hostId: string): Promise<SshHostKeyProbe> {
    const host = this.requireHost(hostId);
    const probe = await probeHostKey(host.destination, this.deps.setup);
    const previousFingerprint = await readRecordedFingerprint(host.destination, this.deps.setup);
    return { hostname: probe.hostname, port: probe.port, keyType: probe.keyType, fingerprint: probe.fingerprint, previousFingerprint };
  }

  /** Trust the key the user was shown for a host whose key changed, then connect. */
  async trustNewHostKey(hostId: string, shownFingerprint: string): Promise<SshHostStatus> {
    const host = this.requireHost(hostId);
    await replaceHostKey(host.destination, shownFingerprint, this.deps.setup);
    await this.deps.hosting.connectHost(hostId);
    return this.statusOf(host);
  }

  /**
   * Remove a host: forget the connection and hide its projects. Nothing of theirs is deleted. Their live agents
   * are suspended and start again when the same address is added back, the key Kangentic made is taken off the
   * host when it can be reached and deleted here, and the link stops. The row is kept, marked removed, so adding
   * the address again restores it and its projects with it.
   */
  async removeHost(hostId: string): Promise<void> {
    const host = this.requireHost(hostId);
    const projects = this.deps.projects.listOnHost(hostId);
    // The board stays usable until the row is marked, up to 30 s below. A start in that time would outlive the
    // suspend, on a link about to stop, so no start reaches this host from here on.
    const releaseStarts = this.deps.hosting.holdStarts(hostId);
    try {
      for (const project of projects) await this.deps.suspendProjectSessions(project);
      if (host.key_created && host.key_path) await this.takeKeyOffHost(host.destination, host.key_path, host.name);
      await this.deps.hosting.hostService.disconnect(hostId).catch((error: unknown) => {
        this.deps.log?.(`[remote] could not stop the link for ${hostId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      });
      this.deps.hosting.status.remove(hostId);
      await deleteHostKeys(hostId, this.deps.setup).catch(() => undefined);
      this.deps.hosting.hosts.markRemoved(hostId);
    } finally {
      releaseStarts();
    }
    // Last, once it is true: the taking off above can take 30 s, with the board still on screen.
    for (const project of projects) this.deps.hideProject?.(project);
    this.deps.projectsChanged?.();
  }

  /**
   * Delete Kangentic's own data for a host's projects: boards, tasks, history, the shell folders and the copy of
   * the host's transcripts. Local only, so it works with the host down, and the host stays in the list with no
   * projects. Nothing on the host is touched.
   *
   * One project that cannot be deleted stops none of the others. It is named in the rejection, and the copy of the
   * transcripts stays while it is left to read them.
   */
  async clearHostData(hostId: string): Promise<void> {
    const host = this.requireHost(hostId);
    const failed: string[] = [];
    for (const project of this.deps.projects.listOnHost(hostId)) {
      try {
        await this.deps.removeProject(project);
        await this.removeShellFolder(project.path);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.log?.(`[remote] could not clear ${project.name}: ${reason}`);
        failed.push(`${project.name}: ${reason}`);
      }
    }
    if (failed.length === 0) {
      // The copies of the host's transcripts are this computer's, and no project is left to read them.
      await this.deps.removeHomeMirror?.(hostId).catch((error: unknown) => {
        this.deps.log?.(`[remote] could not remove the copy of ${host.name}'s files: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.deps.projectsChanged?.();
    if (failed.length > 0) throw new RefusalError(`Could not clear ${failed.join('; ')}`);
  }

  /** Whether a folder exists on a host, as the host's helper says: only it can. A link that is down is an error, not "missing". */
  async probeRemoteFolder(hostId: string, folderPath: string): Promise<SshRemoteFolderProbe> {
    this.requireHost(hostId);
    const info = await this.deps.hosting.hostService.hostInfo(hostId);
    const resolved = resolveHostFolder(folderPath, info.home);
    // The helper reads and writes only beneath the user's home, so a project anywhere else could be added
    // here and then fail on its first file. Said now, with the home it must be in.
    if (!isInsideHome(resolved, info.home)) {
      throw new RefusalError(`${resolved} is outside the home folder on the host (${info.home}). Kangentic works only in folders inside it.`);
    }
    const [folder, git] = await this.deps.hosting.hostService.pathPresence(hostId, [resolved, `${resolved}/.git`]);
    return { exists: folder === 'present', path: resolved, isGitRepo: git === 'present' };
  }

  /**
   * The folders directly inside a directory on a host, for the Directory field's suggestions and its Browse list.
   * One fixed `sh` script through the helper's command runner, with the path as an argument and never in the
   * script's text. A directory that is not there, or outside the home Kangentic works in, is an answer; a host that
   * cannot be asked is an error, never an empty list (`ssh-remote.md`).
   */
  async listDirectories(hostId: string, directoryPath: string): Promise<SshDirectoryListing> {
    this.requireHost(hostId);
    const info = await this.deps.hosting.hostService.hostInfo(hostId);
    const resolved = resolveHostFolder(directoryPath, info.home);
    if (!isInsideHome(resolved, info.home)) {
      return { path: resolved, insideHome: false, exists: false, entries: [], truncated: false };
    }
    let result: Awaited<ReturnType<RemoteHosting['hostService']['runCommand']>>;
    try {
      result = await this.deps.hosting.hostService.runCommand(hostId, {
        file: 'sh',
        args: ['-c', LIST_DIRECTORIES_SCRIPT, 'kangentic-ls', resolved],
        timeoutMs: LIST_DIRECTORIES_TIMEOUT_MS,
      });
    } catch (error) {
      throw new RefusalError(`Could not list ${resolved} on the host: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (result.error) throw new RefusalError(`Could not list ${resolved} on the host: ${result.error}`);
    if (result.timedOut) throw new RefusalError(`The host did not list ${resolved} in time.`);
    if (result.code !== 0) throw new RefusalError(`Could not list ${resolved} on the host: ${(result.stderr || result.stdout).trim().split('\n')[0] || `exit ${result.code}`}`);
    return parseDirectoryListing(resolved, result.stdout);
  }

  /**
   * Get a remote project ready to be created: check its folder is there, make its shell folder on this
   * computer, and keep `.kangentic/` out of the host repository's git status. Returns the input with
   * the shell folder as its path.
   */
  async prepareRemoteProject(input: ProjectCreateInput): Promise<ProjectCreateInput> {
    const remote = input.remote;
    if (!remote) throw new RefusalError('This is not a remote project.');
    this.requireHost(remote.hostId);
    const probe = await this.probeRemoteFolder(remote.hostId, remote.path);
    if (!probe.exists) throw new RefusalError(`${probe.path} does not exist on that host.`);

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
    // `expect` holds the write off a file edited since the read, and one too long for a whole read. That file is
    // the user's, and all it costs is `.kangentic/` in the host's `git status`.
    await service.writeFiles(hostId, [{
      path: excludeFile,
      content: `${existing}${separator}.kangentic/\n`,
      mode: 0o644,
      keepExistingMode: true,
      expect: current.exists ? existing : null,
    }]);
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
      ], { env: childProcessEnv(), timeout: TAKE_KEY_OFF_TIMEOUT_MS });
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
    // A removed host is no host to act on: only adding its address again brings it back.
    if (!host || host.removed_at) throw new RefusalError('That host is not set up in Kangentic.');
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

const LIST_DIRECTORIES_TIMEOUT_MS = 10_000;
/** More folders than this in one directory are cut, and the answer says so. */
const MAX_LISTED_DIRECTORIES = 300;

/**
 * Lists the visible folders directly inside `$1`, one per line: `d` or `g` (a git repository), a tab, the name.
 * A glob never matches a dot folder, so hidden folders are left out by the shell itself. A name that holds a
 * newline cannot be told from two lines, so the parser keeps only lines of the shape above, and reads a marker only
 * as the first line, where the script is the one that wrote it.
 */
const LIST_DIRECTORIES_SCRIPT = [
  'directory="$1"',
  '[ -d "$directory" ] || { echo kangentic-missing; exit 0; }',
  'cd "$directory" 2>/dev/null || { echo kangentic-denied; exit 0; }',
  'for entry in ./*/; do',
  '  [ -d "$entry" ] || continue',
  '  name=${entry#./}; name=${name%/}',
  '  if [ -e "$entry.git" ]; then printf \'g\\t%s\\n\' "$name"; else printf \'d\\t%s\\n\' "$name"; fi',
  'done',
].join('\n');

/** The listing script's output as a listing: sorted, capped, and with the two markers read as answers. */
export function parseDirectoryListing(resolvedPath: string, output: string): SshDirectoryListing {
  const lines = output.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0] === 'kangentic-missing') return { path: resolvedPath, insideHome: true, exists: false, entries: [], truncated: false };
  if (lines[0] === 'kangentic-denied') throw new RefusalError(`Kangentic cannot read ${resolvedPath} on the host.`);
  const entries: SshDirectoryEntry[] = [];
  for (const line of lines) {
    const match = /^([dg])\t(.+)$/.exec(line);
    if (match) entries.push({ name: match[2], isGitRepo: match[1] === 'g' });
  }
  entries.sort((first, second) => first.name.toLowerCase().localeCompare(second.name.toLowerCase()) || first.name.localeCompare(second.name));
  return { path: resolvedPath, insideHome: true, exists: true, entries: entries.slice(0, MAX_LISTED_DIRECTORIES), truncated: entries.length > MAX_LISTED_DIRECTORIES };
}

/** A folder the user typed, as an absolute path on the host: `~` is the host's home, anything else must already be absolute. */
export function resolveHostFolder(folderPath: string, home: string): string {
  const trimmed = folderPath.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f]/.test(trimmed)) throw new RefusalError('Enter the folder\'s path on the host.');
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? `${home}${trimmed.slice(1)}` : trimmed;
  if (!expanded.startsWith('/')) throw new RefusalError('Enter an absolute path on the host, starting with / or ~/.');
  const normalized = expanded.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  if (normalized.split('/').includes('..')) throw new RefusalError('Leave out .. from the path.');
  return normalized;
}

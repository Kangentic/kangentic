/**
 * What the SSH settings tab and the Add project dialog do (#913), with the host table, the host's
 * helper and the ssh program replaced by in-memory fakes: adding a host in each of its three sign-in
 * ways and undoing it when a step fails, removing a host with its projects, checking a folder on a
 * host, and preparing a remote project.
 *
 * What a user loses if it breaks: a half-added host left in the list, a key made for a host that was
 * never added, a project left behind when its host is removed, a folder outside Kangentic's own deleted,
 * or a "folder not found" shown when the real reason is that the host cannot be reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const fileFaults = vi.hoisted(() => ({
  /** Return an error to refuse a rename, as a locked folder on Windows does. */
  rename: null as null | ((from: string, to: string) => Error | null),
}));
// The code under test renames through `renameWithRetry`, which uses original-fs, so the fault is injected there.
// Without a fault it renames for real.
vi.mock('../../src/main/fs/directory-move', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/fs/directory-move')>();
  const nodeFs = await import('node:fs');
  const renameWithRetry = async (from: string, to: string): Promise<void> => {
    const fault = fileFaults.rename?.(String(from), String(to));
    if (fault) throw fault;
    await nodeFs.promises.rename(from, to);
  };
  return { ...actual, renameWithRetry };
});

import { SshHostAdmin, parseDirectoryListing, resolveHostFolder, type SshHostAdminDeps } from '../../src/main/remote/ssh-host-admin';
import { HostStatusBook } from '../../src/main/remote/host-status';
import type { Project, SshHost } from '../../src/shared/types';
import { RefusalError } from '../../src/shared/refusal';
import { isExpectedFailure } from '../../src/main/analytics/handled-report';
import { HostUnreachableError } from '../../src/main/remote/link/link-hub';
import type { RunProgram, SshSetupDeps } from '../../src/main/remote/ssh-setup';

const KEY_BLOB = Buffer.from('a real looking public key blob, long enough to hash').toString('base64');
const FINGERPRINT = `SHA256:${createHash('sha256').update(Buffer.from(KEY_BLOB, 'base64')).digest('base64').replace(/=+$/, '')}`;
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOgIJuDZuvCDEVMrBvKoQm4R5vVmmcYCuZ1F8rK2mSyP kangentic';

let scratch: string;
let home: string;
let shellRoot: string;

interface Rig {
  admin: SshHostAdmin;
  /** Whether an agent or terminal runs for a project on any host, as the app's session list would say. */
  liveSessions: { running: boolean };
  /** Projects whose hide step ran, in order. */
  hiddenProjects: string[];
  /** Make `removeProject` fail for this project, as a locked database does. Null lets every project through again. */
  failRemoveProject: (projectId: string | null, failure?: Error) => void;
  expectFirstConnect: ReturnType<typeof vi.fn>;
  removeHomeMirror: ReturnType<typeof vi.fn>;
  hosts: SshHost[];
  projects: Project[];
  removedProjects: string[];
  suspendedProjects: string[];
  revealedHosts: string[];
  projectsChanged: ReturnType<typeof vi.fn>;
  run: RunProgram & { calls: Array<{ file: string; args: string[] }> };
  hostService: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    hostInfo: ReturnType<typeof vi.fn>;
    programInfo: ReturnType<typeof vi.fn>;
    pathPresence: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    writeFiles: ReturnType<typeof vi.fn>;
    runCommand: ReturnType<typeof vi.fn>;
  };
  status: HostStatusBook;
  connectHost: ReturnType<typeof vi.fn>;
  setup: SshSetupDeps;
  /** What happened to starts and the host row, in order: hold, suspend, marked, release. */
  events: string[];
  /** Make `hosts.restore` return nothing, as a row that vanished between the list and the restore. */
  restoreFindsNothing: { value: boolean };
  /** Make the suspend step of this project fail. Null lets every project through again. */
  failSuspend: (projectId: string | null) => void;
}

function makeRun(options: { keyBlob?: string; installFails?: boolean } = {}): Rig['run'] {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run = (async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (args.includes('-G')) {
      return { code: 0, stdout: `hostname lab.example.test\nport 22\nuser dev\nuserknownhostsfile ${path.join(home, '.ssh', 'known_hosts')}\n`, stderr: '' };
    }
    const knownIndex = args.findIndex((arg) => arg.startsWith('UserKnownHostsFile='));
    if (knownIndex >= 0) {
      fs.writeFileSync(args[knownIndex].slice('UserKnownHostsFile='.length), `lab.example.test ssh-ed25519 ${options.keyBlob ?? KEY_BLOB}\n`);
      return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
    }
    if (file === 'ssh-keygen' && args.includes('-t')) {
      const target = args[args.indexOf('-f') + 1];
      fs.writeFileSync(target, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
      fs.writeFileSync(`${target}.pub`, `${PUBLIC_KEY}\n`);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('PubkeyAuthentication=no')) {
      return options.installFails ? { code: 255, stdout: '', stderr: 'Permission denied (password).' } : { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }) as Rig['run'];
  run.calls = calls;
  return run;
}

function makeRig(runOptions: { keyBlob?: string; installFails?: boolean } = {}): Rig {
  const hosts: SshHost[] = [];
  const projects: Project[] = [];
  const removedProjects: string[] = [];
  const suspendedProjects: string[] = [];
  const revealedHosts: string[] = [];
  const projectsChanged = vi.fn();
  const liveSessions = { running: false };
  const hiddenProjects: string[] = [];
  const failingProjects = new Map<string, Error>();
  const failingSuspends = new Set<string>();
  const events: string[] = [];
  const restoreFindsNothing = { value: false };
  const expectFirstConnect = vi.fn();
  const run = makeRun(runOptions);
  const setup: SshSetupDeps = {
    sshPath: 'ssh',
    sshKeygenPath: 'ssh-keygen',
    run,
    configDirectory: path.join(scratch, 'config'),
    temporaryDirectory: path.join(scratch, 'tmp'),
    platform: process.platform,
    homeDirectory: home,
  };
  const status = new HostStatusBook();
  const connectHost = vi.fn(async (hostId: string) => { status.set(hostId, 'connecting'); });
  const hostService = {
    connect: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    hostInfo: vi.fn(async () => ({ home: '/home/dev', shellPath: '/bin/bash', shellName: 'bash' })),
    pathPresence: vi.fn(async (_hostId: string, paths: string[]) => paths.map(() => 'present' as const)),
    readFile: vi.fn(async () => ({ exists: false, content: null })),
    writeFiles: vi.fn(async () => ({ written: 1 })),
    runCommand: vi.fn(async (_hostId: string, _request: { file: string; args: string[]; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }> => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
    programInfo: vi.fn(async () => ({ version: '0.53.0', startedAt: '2026-11-04T08:00:00.000Z', liveSessions: 3, installedVersions: ['0.52.0', '0.53.0'] })),
  };
  let counter = 0;
  const removeHomeMirror = vi.fn(async (_hostId: string) => undefined);
  const deps: SshHostAdminDeps = {
    hosting: {
      hosts: {
        // A removed host keeps its row but is not a host in use, as the repository's `list` has it.
        list: () => hosts.filter((host) => host.removed_at === null),
        listRemoved: () => hosts.filter((host) => host.removed_at !== null),
        getById: (id: string) => hosts.find((host) => host.id === id),
        create: (input: { name: string; destination: string }) => {
          const host: SshHost = { id: `0000000${++counter}-0000-4000-8000-000000000000`, name: input.name, destination: input.destination, key_path: null, key_created: false, created_at: '2026-11-03T00:00:00.000Z', removed_at: null };
          hosts.push(host);
          return host;
        },
        markRemoved: (id: string) => {
          const host = hosts.find((candidate) => candidate.id === id);
          if (host) { host.removed_at = '2026-11-06T00:00:00.000Z'; host.key_path = null; host.key_created = false; }
          events.push('marked');
          return host;
        },
        restore: (id: string, name: string) => {
          if (restoreFindsNothing.value) return undefined;
          const host = hosts.find((candidate) => candidate.id === id);
          if (host) { host.removed_at = null; host.name = name; }
          return host;
        },
        setKey: (id: string, keyPath: string | null, keyCreated: boolean) => {
          const host = hosts.find((candidate) => candidate.id === id);
          if (host) { host.key_path = keyPath; host.key_created = keyCreated; }
          return host;
        },
        rename: (id: string, name: string) => {
          const host = hosts.find((candidate) => candidate.id === id);
          if (host) host.name = name;
          return host;
        },
        setDestination: (id: string, destination: string) => {
          const host = hosts.find((candidate) => candidate.id === id);
          if (host) host.destination = destination;
          return host;
        },
        delete: (id: string) => { hosts.splice(hosts.findIndex((host) => host.id === id), 1); },
      },
      hostService,
      status,
      connectHost,
      expectFirstConnect,
      holdStarts: (hostId: string) => {
        events.push('hold');
        return () => { events.push('release'); void hostId; };
      },
    } as unknown as SshHostAdminDeps['hosting'],
    projects: { listOnHost: (hostId: string) => projects.filter((project) => project.remote?.hostId === hostId) },
    setup,
    removeProject: async (project) => {
      const failure = failingProjects.get(project.id);
      if (failure) throw failure;
      removedProjects.push(project.id);
    },
    hideProject: (project) => { hiddenProjects.push(project.id); },
    suspendProjectSessions: async (project) => {
      events.push('suspend');
      if (failingSuspends.has(project.id)) throw new Error('the pty host did not answer');
      suspendedProjects.push(project.id);
    },
    revealProjects: async (hostId) => { revealedHosts.push(hostId); },
    projectsChanged,
    hasLiveSessions: () => liveSessions.running,
    remoteProjectsRoot: shellRoot,
    newShellFolder: () => path.join(shellRoot, `shell-${++counter}`),
    appVersion: () => '0.54.0',
    removeHomeMirror,
  };
  return { admin: new SshHostAdmin(deps), liveSessions, hiddenProjects, failRemoveProject: (projectId, failure = new Error('database is locked')) => { if (projectId) failingProjects.set(projectId, failure); else failingProjects.clear(); }, expectFirstConnect, removeHomeMirror, hosts, projects, removedProjects, suspendedProjects, revealedHosts, projectsChanged, run, hostService, status, connectHost, setup, events, restoreFindsNothing, failSuspend: (projectId) => { if (projectId) failingSuspends.add(projectId); else failingSuspends.clear(); } };
}

function project(id: string, hostId: string, shellFolder: string): Project {
  return { id, name: id, path: shellFolder, github_url: null, default_agent: 'claude', default_model: null, default_effort: null, group_id: null, position: 0, remote: { hostId, path: '/home/dev/api' }, last_opened: '', created_at: '' } as Project;
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-admin-'));
  home = path.join(scratch, 'home');
  shellRoot = path.join(scratch, 'remote-projects');
  fs.mkdirSync(path.join(scratch, 'tmp'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(shellRoot, { recursive: true });
});

afterEach(() => {
  fileFaults.rename = null;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('adding a host', () => {
  it('with the user\'s own ssh setup: trusts the key shown, adds the row, and connects', async () => {
    const rig = makeRig();

    const status = await rig.admin.addHost({ name: 'Lab box', destination: 'dev@lab.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    expect(status.host).toMatchObject({ name: 'Lab box', destination: 'dev@lab.example.test', key_path: null, key_created: false });
    expect(rig.connectHost).toHaveBeenCalledWith(status.host.id);
    expect(fs.readFileSync(path.join(home, '.ssh', 'known_hosts'), 'utf8')).toContain('lab.example.test ssh-ed25519');
  });

  it('with a key file: keeps a copy in Kangentic\'s folder and signs in with it', async () => {
    const rig = makeRig();
    const keyFile = path.join(scratch, 'downloaded-key');
    fs.writeFileSync(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');

    const status = await rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'key-file', keyFilePath: keyFile }, expectedFingerprint: FINGERPRINT });

    expect(status.host.key_created).toBe(false);
    expect(status.host.key_path).not.toBe(keyFile);
    expect(fs.existsSync(status.host.key_path!)).toBe(true);
  });

  it('with a created key: makes the key, adds it with the password, and records that Kangentic made it', async () => {
    const rig = makeRig();

    const status = await rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'create-key', password: 'pw' }, expectedFingerprint: FINGERPRINT });

    expect(status.host.key_created).toBe(true);
    expect(fs.existsSync(status.host.key_path!)).toBe(true);
    expect(rig.run.calls.some((call) => call.args.includes('PubkeyAuthentication=no'))).toBe(true);
  });

  it('is refused, and writes nothing, when the host now presents another key than the one shown', async () => {
    const rig = makeRig({ keyBlob: Buffer.from('another key blob that is not the one the user was shown').toString('base64') });

    await expect(rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT }))
      .rejects.toThrow('different key than the one you were shown');

    expect(rig.hosts).toEqual([]);
    expect(fs.existsSync(path.join(home, '.ssh', 'known_hosts'))).toBe(false);
  });

  it('leaves no host and no key behind when the password is refused, and shows ssh\'s words', async () => {
    const rig = makeRig({ installFails: true });

    await expect(rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'create-key', password: 'wrong' }, expectedFingerprint: FINGERPRINT }))
      .rejects.toThrow('Permission denied (password).');

    expect(rig.hosts).toEqual([]);
    expect(fs.existsSync(path.join(rig.setup.configDirectory, 'ssh'))).toBe(true);
    expect(fs.readdirSync(path.join(rig.setup.configDirectory, 'ssh'))).toEqual([]);
    expect(rig.connectHost).not.toHaveBeenCalled();
  });

  it('tries to take the key it made off the host when the add fails, signing in with that key, before deleting its own copy', async () => {
    const rig = makeRig({ installFails: true });

    await expect(rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'create-key', password: 'wrong' }, expectedFingerprint: FINGERPRINT }))
      .rejects.toThrow('Permission denied');

    // The install may have reached the host before it failed (a timeout leaves it unknown), and
    // nothing here could remove the line once the local key is gone.
    const removal = rig.run.calls.find((call) => call.args.some((arg) => arg.includes('grep -vxF')));
    expect(removal?.args).toEqual(expect.arrayContaining(['IdentitiesOnly=yes', 'BatchMode=yes']));
    expect(removal?.args[removal.args.indexOf('-i') + 1]).toMatch(/ssh/);
  });

  it('does not try to take a key off the host when the add used no key of its own', async () => {
    const rig = makeRig();
    const notAKey = path.join(scratch, 'notes.txt');
    fs.writeFileSync(notAKey, 'hello');

    await expect(rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'key-file', keyFilePath: notAKey }, expectedFingerprint: FINGERPRINT }))
      .rejects.toThrow();

    expect(rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')))).toBe(false);
  });

  it('leaves no host behind when a chosen key file is not a key', async () => {
    const rig = makeRig();
    const notAKey = path.join(scratch, 'notes.txt');
    fs.writeFileSync(notAKey, 'hello');

    await expect(rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'key-file', keyFilePath: notAKey }, expectedFingerprint: FINGERPRINT }))
      .rejects.toThrow('not a private key');

    expect(rig.hosts).toEqual([]);
  });

  it('keeps the host, with the reason, when it cannot be connected: the user can fix it and try again', async () => {
    const rig = makeRig();
    rig.connectHost.mockImplementation(async (hostId: string) => { rig.status.set(hostId, 'unreachable', 'Kangentic does not include the program to install on a host.'); });

    const status = await rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    expect(rig.hosts).toHaveLength(1);
    expect(status).toMatchObject({ state: 'unreachable', detail: 'Kangentic does not include the program to install on a host.' });
  });

  it('refuses an address that is already a host, so one machine never has two links taking it over from each other', async () => {
    const rig = makeRig();
    await rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });
    const callsAfterFirst = rig.run.calls.length;

    await expect(rig.admin.addHost({ name: 'Lab again', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT }))
      .rejects.toThrow('already added as "Lab"');

    expect(rig.hosts).toHaveLength(1);
    expect(rig.run.calls).toHaveLength(callsAfterFirst);
  });

  it('reads the same host name in another letter case as the same host', async () => {
    const rig = makeRig();
    await rig.admin.addHost({ name: 'Lab', destination: 'dev@Lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    await expect(rig.admin.addHost({ name: 'Lab 2', destination: 'dev@lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT }))
      .rejects.toThrow('already added as "Lab"');
  });

  it('keeps two accounts whose user names differ only by case apart', async () => {
    const rig = makeRig();
    await rig.admin.addHost({ name: 'Lab', destination: 'Deploy@lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    await expect(rig.admin.addHost({ name: 'Lab 2', destination: 'deploy@lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT }))
      .resolves.toMatchObject({ host: { destination: 'deploy@lab' } });
  });

  it('refuses a second add of one address that starts before the first has made its row', async () => {
    const rig = makeRig();
    const first = rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });
    const second = rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    await expect(second).rejects.toThrow('already being added');
    await first;
    expect(rig.hosts).toHaveLength(1);
  });

  it.each([
    ['an empty name', '', 'lab'],
    ['a name that is too long', 'x'.repeat(61), 'lab'],
    ['an address that ssh would read as an option', 'Lab', '-oProxyCommand=calc'],
  ])('is refused for %s before anything is learned or written', async (_label, name, destination) => {
    const rig = makeRig();

    await expect(rig.admin.addHost({ name, destination, signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT })).rejects.toThrow();

    expect(rig.run.calls).toEqual([]);
    expect(rig.hosts).toEqual([]);
  });
});

describe('listing hosts', () => {
  it('shows each host with its state and how many projects are on it', async () => {
    const rig = makeRig();
    const added = await rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });
    rig.status.set(added.host.id, 'connected');
    rig.projects.push(project('p1', added.host.id, path.join(shellRoot, 'a')), project('p2', added.host.id, path.join(shellRoot, 'b')));

    expect(rig.admin.listHosts()).toEqual([expect.objectContaining({ state: 'connected', projectCount: 2, host: expect.objectContaining({ name: 'Lab' }) })]);
  });

  it('reads a host nobody has heard from yet as connecting', async () => {
    const rig = makeRig();
    rig.hosts.push({ id: 'h-new', name: 'New', destination: 'new', key_path: null, key_created: false, created_at: '', removed_at: null });
    expect(rig.admin.listHosts()[0].state).toBe('connecting');
  });
});

describe('removing a host', () => {
  async function rigWithHost(options: { createdKey?: boolean } = {}) {
    const rig = makeRig();
    const added = await rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: options.createdKey ? { method: 'create-key', password: 'pw' } : { method: 'config' }, expectedFingerprint: FINGERPRINT });
    const folderA = path.join(shellRoot, 'shell-a');
    const folderB = path.join(shellRoot, 'shell-b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });
    rig.projects.push(project('p1', added.host.id, folderA), project('p2', added.host.id, folderB), project('other', 'another-host', path.join(shellRoot, 'keep')));
    return { rig, hostId: added.host.id, folderA, folderB };
  }

  it('hides the host and its projects and deletes none of their data', async () => {
    const { rig, hostId, folderA, folderB } = await rigWithHost();

    await rig.admin.removeHost(hostId);

    // Nothing was deleted: no project, no shell folder, no copy of the host's files.
    expect(rig.removedProjects).toEqual([]);
    expect(fs.existsSync(folderA)).toBe(true);
    expect(fs.existsSync(folderB)).toBe(true);
    expect(rig.removeHomeMirror).not.toHaveBeenCalled();
    // The host leaves the list, but its row is kept, marked removed, so its projects can come back.
    expect(rig.admin.listHosts()).toEqual([]);
    expect(rig.hosts).toEqual([expect.objectContaining({ id: hostId, removed_at: expect.any(String) })]);
    expect(rig.status.get(hostId)).toBeUndefined();
    expect(rig.hostService.disconnect).toHaveBeenCalledWith(hostId);
    expect(rig.projectsChanged).toHaveBeenCalled();
  });

  it('takes the project out of the app only after the host is marked removed, so nothing reads it gone while the key comes off', async () => {
    const { rig, hostId } = await rigWithHost({ createdKey: true });
    const original = rig.setup.run;
    let hiddenDuringKeyRemoval: string[] | null = null;
    rig.setup.run = (async (file: string, args: string[], options?: unknown) => {
      if (args.some((arg) => arg.includes('grep -vxF'))) hiddenDuringKeyRemoval = [...rig.hiddenProjects];
      return original(file, args, options as never);
    }) as RunProgram;

    await rig.admin.removeHost(hostId);

    expect(hiddenDuringKeyRemoval).toEqual([]);
    expect(rig.hiddenProjects).toEqual(['p1', 'p2']);
  });

  it('suspends the agents of its projects, and only its own', async () => {
    const { rig, hostId } = await rigWithHost();

    await rig.admin.removeHost(hostId);

    expect(rig.suspendedProjects).toEqual(['p1', 'p2']);
  });

  it('takes the key it made off the host, and deletes it here', async () => {
    const { rig, hostId } = await rigWithHost({ createdKey: true });
    const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
    expect(fs.existsSync(keyDirectory)).toBe(true);

    await rig.admin.removeHost(hostId);

    const removal = rig.run.calls.find((call) => call.args.some((arg) => arg.includes('grep -vxF')));
    expect(removal?.args).toEqual(expect.arrayContaining(['IdentitiesOnly=yes', 'BatchMode=yes']));
    expect(fs.existsSync(keyDirectory)).toBe(false);
    expect(rig.hosts[0]).toMatchObject({ key_path: null, key_created: false });
  });

  it('still removes the host when it cannot be reached to take the key off', async () => {
    const { rig, hostId } = await rigWithHost({ createdKey: true });
    const original = rig.setup.run;
    rig.setup.run = (async (file: string, args: string[], options?: unknown) => {
      if (args.some((arg) => arg.includes('grep -vxF'))) throw new Error('spawn ssh ETIMEDOUT');
      return original(file, args, options as never);
    }) as RunProgram;

    await rig.admin.removeHost(hostId);

    expect(rig.admin.listHosts()).toEqual([]);
  });

  it('does not touch the host\'s key for a host that signs in the user\'s own way', async () => {
    const { rig, hostId } = await rigWithHost();

    await rig.admin.removeHost(hostId);

    expect(rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')))).toBe(false);
  });

  it('is no host to act on once removed: it cannot be reconnected or cleared', async () => {
    const { rig, hostId } = await rigWithHost();
    await rig.admin.removeHost(hostId);

    await expect(rig.admin.reconnectHost(hostId)).rejects.toThrow('not set up');
    await expect(rig.admin.clearHostData(hostId)).rejects.toThrow('not set up');
  });

  it('refuses every start on the host before the first agent is suspended, and lets them go only after the host is marked removed', async () => {
    const { rig, hostId } = await rigWithHost();
    rig.events.length = 0;

    await rig.admin.removeHost(hostId);

    expect(rig.events).toEqual(['hold', 'suspend', 'suspend', 'marked', 'release']);
  });

  it('lets starts go again, and leaves the host unmarked and its projects visible, when a suspend fails', async () => {
    const { rig, hostId } = await rigWithHost();
    rig.failSuspend('p2');
    rig.events.length = 0;

    await expect(rig.admin.removeHost(hostId)).rejects.toThrow('the pty host did not answer');

    expect(rig.events).toEqual(['hold', 'suspend', 'suspend', 'release']);
    expect(rig.hosts[0].removed_at).toBeNull();
    expect(rig.hiddenProjects).toEqual([]);
  });
});

describe('clearing a host\'s data', () => {
  async function rigWithHost() {
    const rig = makeRig();
    const added = await rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });
    const folderA = path.join(shellRoot, 'shell-a');
    const folderB = path.join(shellRoot, 'shell-b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });
    rig.projects.push(project('p1', added.host.id, folderA), project('p2', added.host.id, folderB), project('other', 'another-host', path.join(shellRoot, 'keep')));
    return { rig, hostId: added.host.id, folderA, folderB };
  }

  it('deletes the host\'s projects and their shell folders, leaving other hosts\' alone, and keeps the host', async () => {
    const { rig, hostId, folderA, folderB } = await rigWithHost();

    await rig.admin.clearHostData(hostId);

    expect(rig.removedProjects).toEqual(['p1', 'p2']);
    expect(fs.existsSync(folderA)).toBe(false);
    expect(fs.existsSync(folderB)).toBe(false);
    expect(rig.admin.listHosts()).toEqual([expect.objectContaining({ host: expect.objectContaining({ id: hostId, removed_at: null }) })]);
    expect(rig.projectsChanged).toHaveBeenCalled();
  });

  it('is local only: it asks the host nothing and never suspends an agent or takes a key off', async () => {
    const { rig, hostId } = await rigWithHost();

    await rig.admin.clearHostData(hostId);

    expect(rig.hostService.disconnect).not.toHaveBeenCalled();
    expect(rig.hostService.pathPresence).not.toHaveBeenCalled();
    expect(rig.suspendedProjects).toEqual([]);
    expect(rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')))).toBe(false);
  });

  it('deletes this computer\'s copy of the host\'s files, and still finishes when that fails', async () => {
    const { rig, hostId } = await rigWithHost();
    rig.removeHomeMirror.mockRejectedValueOnce(new Error('EBUSY'));

    await rig.admin.clearHostData(hostId);

    expect(rig.removeHomeMirror).toHaveBeenCalledWith(hostId);
    expect(rig.removedProjects).toEqual(['p1', 'p2']);
  });

  it('finishes what it can when one project fails, then says which one failed', async () => {
    const { rig, hostId, folderB } = await rigWithHost();
    rig.failRemoveProject('p1');

    await expect(rig.admin.clearHostData(hostId)).rejects.toThrow('p1');

    expect(rig.removedProjects).toEqual(['p2']);
    expect(fs.existsSync(folderB)).toBe(false);
    expect(rig.projectsChanged).toHaveBeenCalled();
  });

  it('wraps a local failure in a plain Error with its cause, so a defect still reports and is not read as a refusal', async () => {
    const { rig, hostId } = await rigWithHost();
    const defect = new TypeError('cannot read properties of undefined');
    rig.failRemoveProject('p1', defect);

    const rejection = await rig.admin.clearHostData(hostId).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(RefusalError);
    expect((rejection as Error).cause).toBe(defect);
    expect(isExpectedFailure(rejection)).toBe(false);
  });

  it('keeps the copy of the transcripts while a project that reads it is left, and a second try removes it', async () => {
    const { rig, hostId } = await rigWithHost();
    rig.failRemoveProject('p1');
    await expect(rig.admin.clearHostData(hostId)).rejects.toThrow();
    expect(rig.removeHomeMirror).not.toHaveBeenCalled();

    rig.failRemoveProject(null);
    rig.projects.splice(0, rig.projects.length, ...rig.projects.filter((candidate) => !rig.removedProjects.includes(candidate.id)));
    await rig.admin.clearHostData(hostId);

    expect(rig.removeHomeMirror).toHaveBeenCalledWith(hostId);
  });

  it('never deletes a folder outside the one remote projects live in, whatever a project row says', async () => {
    const { rig, hostId } = await rigWithHost();
    const outside = path.join(scratch, 'precious');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'file.txt'), 'keep me');
    rig.projects.push(project('bad', hostId, outside), project('root', hostId, shellRoot));

    await rig.admin.clearHostData(hostId);

    expect(fs.readFileSync(path.join(outside, 'file.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(shellRoot)).toBe(true);
  });
});

describe('adding a removed host\'s address again', () => {
  async function removedHost(options: { name?: string; installFails?: boolean } = {}) {
    const rig = makeRig({ installFails: options.installFails });
    const added = await rig.admin.addHost({ name: options.name ?? 'Lab', destination: 'lab.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });
    rig.projects.push(project('p1', added.host.id, path.join(shellRoot, 'shell-a')));
    await rig.admin.removeHost(added.host.id);
    return { rig, hostId: added.host.id };
  }

  it('restores the same host, so its projects come back as they were, under the name given now', async () => {
    const { rig, hostId } = await removedHost();

    const back = await rig.admin.addHost({ name: 'Build server', destination: 'lab.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    expect(back.host.id).toBe(hostId);
    expect(rig.hosts).toHaveLength(1);
    expect(rig.hosts[0]).toMatchObject({ name: 'Build server', removed_at: null });
    expect(rig.projects.map((candidate) => candidate.remote?.hostId)).toEqual([hostId]);
    expect(rig.removedProjects).toEqual([]);
  });

  it('matches by address and not by case of the host name, as a second add of one address does', async () => {
    const { rig, hostId } = await removedHost();

    const back = await rig.admin.addHost({ name: 'Lab', destination: 'LAB.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    expect(back.host.id).toBe(hostId);
  });

  it('starts what the projects had running once the host is connected, never before', async () => {
    const { rig, hostId } = await removedHost();
    rig.connectHost.mockImplementationOnce(async () => {
      expect(rig.revealedHosts).toEqual([]);
    });

    await rig.admin.addHost({ name: 'Lab', destination: 'lab.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    expect(rig.revealedHosts).toEqual([hostId]);
  });

  it('counts its next connection as its first, so its projects start whenever that comes, however late', async () => {
    const { rig, hostId } = await removedHost();

    await rig.admin.addHost({ name: 'Lab', destination: 'lab.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    expect(rig.expectFirstConnect).toHaveBeenCalledWith(hostId);
    const firstConnectCall = rig.expectFirstConnect.mock.invocationCallOrder[0];
    expect(firstConnectCall).toBeLessThan(rig.connectHost.mock.invocationCallOrder.at(-1)!);
  });

  it('is a new host at a new address: the old projects stay hidden', async () => {
    const { rig, hostId } = await removedHost();

    const other = await rig.admin.addHost({ name: 'Lab', destination: 'lab2.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    expect(other.host.id).not.toBe(hostId);
    expect(rig.revealedHosts).toEqual([]);
    expect(rig.hosts.find((candidate) => candidate.id === hostId)?.removed_at).not.toBeNull();
  });

  it('removes the row again, not deletes it, when the sign-in step fails, so the projects stay hidden and nothing is lost', async () => {
    const { rig, hostId } = await removedHost();
    // The password step fails to install the key it made.
    const original = rig.setup.run;
    rig.setup.run = (async (file: string, args: string[], options?: unknown) => {
      if (args.includes('PubkeyAuthentication=no')) return { code: 255, stdout: '', stderr: 'Permission denied (password).' };
      return original(file, args, options as never);
    }) as RunProgram;

    await expect(rig.admin.addHost({ name: 'Lab', destination: 'lab.example.test', signIn: { method: 'create-key', password: 'wrong' }, expectedFingerprint: FINGERPRINT })).rejects.toThrow();

    const row = rig.hosts.find((candidate) => candidate.id === hostId);
    expect(row?.removed_at).not.toBeNull();
    expect(rig.revealedHosts).toEqual([]);
    expect(rig.projects).toHaveLength(1);
  });

  it('makes a new row when the removed one cannot be restored, and a later failure deletes that row, marks nothing removed and reveals nothing', async () => {
    const { rig, hostId } = await removedHost();
    rig.restoreFindsNothing.value = true;
    rig.setup.run = (async (file: string, args: string[], options?: unknown) => {
      if (args.includes('PubkeyAuthentication=no')) return { code: 255, stdout: '', stderr: 'Permission denied (password).' };
      return makeRun()(file, args, options as never);
    }) as RunProgram;
    rig.events.length = 0;

    await expect(rig.admin.addHost({ name: 'Lab', destination: 'lab.example.test', signIn: { method: 'create-key', password: 'wrong' }, expectedFingerprint: FINGERPRINT })).rejects.toThrow('Permission denied');

    // Only the old removed row is left: the new one was deleted, not marked removed.
    expect(rig.hosts.map((candidate) => candidate.id)).toEqual([hostId]);
    expect(rig.events).not.toContain('marked');
    expect(rig.revealedHosts).toEqual([]);
    expect(rig.expectFirstConnect).not.toHaveBeenCalled();
  });

  it('reveals nothing and expects no first connection when the removed row could not be restored and the add succeeds as a new host', async () => {
    const { rig, hostId } = await removedHost();
    rig.restoreFindsNothing.value = true;

    const added = await rig.admin.addHost({ name: 'Lab', destination: 'lab.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    expect(added.host.id).not.toBe(hostId);
    expect(rig.revealedHosts).toEqual([]);
    expect(rig.expectFirstConnect).not.toHaveBeenCalled();
  });

  it('refuses an address that is already a host in use, as before', async () => {
    const rig = makeRig();
    await rig.admin.addHost({ name: 'Lab', destination: 'lab.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });

    await expect(rig.admin.addHost({ name: 'Again', destination: 'lab.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT })).rejects.toThrow('already added');
  });
});

describe('listing the folders in a directory on a host', () => {
  async function rigWithHost() {
    const rig = makeRig();
    const added = await rig.admin.addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });
    return { rig, hostId: added.host.id };
  }

  it('reads the script\'s lines as folders, sorted, with git repositories flagged', async () => {
    const { rig, hostId } = await rigWithHost();
    rig.hostService.runCommand.mockResolvedValueOnce({ code: 0, stdout: 'd\tnotes\ng\tapi\nd\tCode\nnoise without a tab\n', stderr: '', timedOut: false });

    const listing = await rig.admin.listDirectories(hostId, '~/');

    expect(listing).toEqual({
      path: '/home/dev',
      insideHome: true,
      exists: true,
      entries: [{ name: 'api', isGitRepo: true }, { name: 'Code', isGitRepo: false }, { name: 'notes', isGitRepo: false }],
      truncated: false,
    });
  });

  it('passes the path as an argument and never in the script, so a hostile name is not code', async () => {
    const { rig, hostId } = await rigWithHost();

    await rig.admin.listDirectories(hostId, '~/a"; rm -rf ~; "');

    const request = rig.hostService.runCommand.mock.calls[0][1] as { file: string; args: string[] };
    expect(request.file).toBe('sh');
    expect(request.args.at(-1)).toBe('/home/dev/a"; rm -rf ~; "');
    expect(request.args[1]).not.toContain('rm -rf');
  });

  it('answers a directory that is not there as not existing, and one outside the home without asking the host', async () => {
    const { rig, hostId } = await rigWithHost();
    rig.hostService.runCommand.mockResolvedValueOnce({ code: 0, stdout: 'kangentic-missing\n', stderr: '', timedOut: false });

    expect(await rig.admin.listDirectories(hostId, '~/nope/')).toMatchObject({ exists: false, insideHome: true, entries: [] });

    rig.hostService.runCommand.mockClear();
    expect(await rig.admin.listDirectories(hostId, '/etc')).toMatchObject({ insideHome: false, entries: [] });
    expect(rig.hostService.runCommand).not.toHaveBeenCalled();
  });

  it('is an error, never an empty list, when the host cannot be asked or the directory cannot be read', async () => {
    const { rig, hostId } = await rigWithHost();

    rig.hostService.runCommand.mockRejectedValueOnce(new Error('The link to the host is down.'));
    await expect(rig.admin.listDirectories(hostId, '~/')).rejects.toThrow('link to the host is down');

    rig.hostService.runCommand.mockResolvedValueOnce({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(rig.admin.listDirectories(hostId, '~/')).rejects.toThrow('in time');

    rig.hostService.runCommand.mockResolvedValueOnce({ code: 0, stdout: 'kangentic-denied\n', stderr: '', timedOut: false });
    await expect(rig.admin.listDirectories(hostId, '~/private')).rejects.toThrow('cannot read');

    rig.hostService.runCommand.mockResolvedValueOnce({ code: 2, stdout: '', stderr: 'sh: oops\n', timedOut: false });
    await expect(rig.admin.listDirectories(hostId, '~/')).rejects.toThrow('sh: oops');
  });

  it('wraps a failed ask in a plain Error with its cause: a defect still reports, a down link is skipped by its cause', async () => {
    const { rig, hostId } = await rigWithHost();

    const defect = new TypeError('cannot read properties of undefined');
    rig.hostService.runCommand.mockRejectedValueOnce(defect);
    const defectRejection = await rig.admin.listDirectories(hostId, '~/').then(() => null, (error: unknown) => error);
    expect(defectRejection).toBeInstanceOf(Error);
    expect(defectRejection).not.toBeInstanceOf(RefusalError);
    expect((defectRejection as Error).cause).toBe(defect);
    expect(isExpectedFailure(defectRejection)).toBe(false);

    const downLink = new HostUnreachableError(hostId, 'The link to the host is down.');
    rig.hostService.runCommand.mockRejectedValueOnce(downLink);
    const downRejection = await rig.admin.listDirectories(hostId, '~/').then(() => null, (error: unknown) => error);
    expect((downRejection as Error).cause).toBe(downLink);
    expect(isExpectedFailure(downRejection)).toBe(true);
  });

  it('reads a marker only as the first line: the same text later is a folder name holding a newline, not an answer', () => {
    const later = 'd\talpha\nkangentic-missing\nd\tbeta\n';
    expect(parseDirectoryListing('/home/dev', later)).toMatchObject({ exists: true, entries: [{ name: 'alpha', isGitRepo: false }, { name: 'beta', isGitRepo: false }] });
    expect(() => parseDirectoryListing('/home/dev', 'd\talpha\nkangentic-denied\ng\tbeta\n')).not.toThrow();
    expect(parseDirectoryListing('/home/dev', 'd\talpha\nkangentic-denied\ng\tbeta\n').entries).toHaveLength(2);

    expect(parseDirectoryListing('/home/dev', 'kangentic-missing\nd\talpha\n')).toMatchObject({ exists: false, entries: [] });
    expect(() => parseDirectoryListing('/home/dev', 'kangentic-denied\n')).toThrow('cannot read');
  });

  it('cuts a very large directory and says so', () => {
    const output = Array.from({ length: 305 }, (_, index) => `d\tfolder-${String(index).padStart(3, '0')}`).join('\n');

    const listing = parseDirectoryListing('/home/dev', output);

    expect(listing.entries).toHaveLength(300);
    expect(listing.truncated).toBe(true);
  });

  it('is refused for a removed host, and a path with .. is refused with its reason', async () => {
    const { rig, hostId } = await rigWithHost();
    await expect(rig.admin.listDirectories(hostId, '~/../etc')).rejects.toThrow('Leave out ..');
    await rig.admin.removeHost(hostId);
    await expect(rig.admin.listDirectories(hostId, '~/')).rejects.toThrow('not set up');
  });

  // The real script on a real shell: what the helper would run on the host. POSIX only, like the other script tests.
  it.skipIf(process.platform === 'win32')('lists real folders: hidden ones left out, a repository flagged, a file ignored, and a name with a space intact', async () => {
    const { execFile } = await import('node:child_process');
    const root = path.join(scratch, 'listing');
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'with space'), { recursive: true });
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    const { rig, hostId } = await rigWithHost();
    rig.hostService.runCommand.mockImplementationOnce(async (_id: string, request: { file: string; args: string[] }) => {
      return await new Promise((resolve) => {
        execFile(request.file, request.args.map((arg, index, all) => (index === all.length - 1 ? root : arg)), (error, stdout, stderr) => {
          resolve({ code: error ? 1 : 0, stdout, stderr, timedOut: false });
        });
      });
    });
    rig.hostService.hostInfo.mockResolvedValueOnce({ home: path.dirname(root), shellPath: '/bin/sh', shellName: 'sh' });

    const listing = await rig.admin.listDirectories(hostId, root);

    expect(listing.entries).toEqual([
      { name: 'plain', isGitRepo: false },
      { name: 'repo', isGitRepo: true },
      { name: 'with space', isGitRepo: false },
    ]);
  });
});

describe('editing a host in place', () => {
  async function rigWithHost(options: { createdKey?: boolean; destination?: string } = {}) {
    const rig = makeRig();
    const added = await rig.admin.addHost({
      name: 'Lab',
      destination: options.destination ?? 'dev@lab.example.test',
      signIn: options.createdKey ? { method: 'create-key', password: 'pw' } : { method: 'config' },
      expectedFingerprint: FINGERPRINT,
    });
    rig.projects.push(project('p1', added.host.id, path.join(shellRoot, 'shell-a')));
    rig.connectHost.mockClear();
    rig.hostService.disconnect.mockClear();
    rig.run.calls.length = 0;
    return { rig, hostId: added.host.id };
  }

  it('saves a new name at once, without touching the connection', async () => {
    const { rig, hostId } = await rigWithHost();

    const status = await rig.admin.updateHost(hostId, { name: 'Build server', destination: 'dev@lab.example.test' });

    expect(status.host.name).toBe('Build server');
    expect(rig.hostService.disconnect).not.toHaveBeenCalled();
    expect(rig.connectHost).not.toHaveBeenCalled();
  });

  it('moves a host to a new address, keeping its row and projects, and connects there', async () => {
    const { rig, hostId } = await rigWithHost();

    const status = await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab2.example.test', expectedFingerprint: FINGERPRINT });

    expect(status.host.id).toBe(hostId);
    expect(rig.hosts[0].destination).toBe('dev@lab2.example.test');
    expect(rig.projects[0].remote?.hostId).toBe(hostId);
    expect(rig.removedProjects).toEqual([]);
    expect(rig.hostService.disconnect).toHaveBeenCalledWith(hostId);
    expect(rig.connectHost).toHaveBeenCalledWith(hostId);
  });

  it('refuses a new address without the key the user was shown, and trusts the key only if it still matches', async () => {
    const { rig, hostId } = await rigWithHost();

    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab2.example.test' })).rejects.toThrow('trust it');
    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab2.example.test', expectedFingerprint: 'SHA256:other' })).rejects.toThrow();

    expect(rig.hosts[0].destination).toBe('dev@lab.example.test');
    expect(rig.connectHost).not.toHaveBeenCalled();
  });

  it('refuses an address another host has, and one a removed host has, which would shadow its projects', async () => {
    const { rig, hostId } = await rigWithHost();
    const other = await rig.admin.addHost({ name: 'Other', destination: 'dev@other.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });
    const gone = await rig.admin.addHost({ name: 'Gone', destination: 'dev@gone.example.test', signIn: { method: 'config' }, expectedFingerprint: FINGERPRINT });
    await rig.admin.removeHost(gone.host.id);

    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@OTHER.example.test', expectedFingerprint: FINGERPRINT })).rejects.toThrow('already added as "Other"');
    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@gone.example.test', expectedFingerprint: FINGERPRINT })).rejects.toThrow('you removed');

    expect(rig.hosts.find((candidate) => candidate.id === hostId)?.destination).toBe('dev@lab.example.test');
    expect(other.host.destination).toBe('dev@other.example.test');
  });

  it('is refused while terminals run on the host, since the connection restarts', async () => {
    const { rig, hostId } = await rigWithHost();
    rig.liveSessions.running = true;

    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab2.example.test', expectedFingerprint: FINGERPRINT })).rejects.toThrow('Stop the terminals');
    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } })).rejects.toThrow('Stop the terminals');
    // A rename restarts nothing, so it is allowed.
    await expect(rig.admin.updateHost(hostId, { name: 'Renamed', destination: 'dev@lab.example.test' })).resolves.toBeDefined();
  });

  it('needs a new sign-in with a new address when the key Kangentic made was added to the old machine', async () => {
    const { rig, hostId } = await rigWithHost({ createdKey: true });

    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab2.example.test', expectedFingerprint: FINGERPRINT })).rejects.toThrow('Sign in again');

    expect(rig.hosts[0].destination).toBe('dev@lab.example.test');
  });

  it('switches from a key Kangentic made to the user\'s own setup: takes the old key off the host and deletes it', async () => {
    const { rig, hostId } = await rigWithHost({ createdKey: true });
    const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
    expect(fs.existsSync(keyDirectory)).toBe(true);

    const status = await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } });

    expect(status.host).toMatchObject({ key_path: null, key_created: false });
    expect(rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')))).toBe(true);
    expect(fs.existsSync(keyDirectory)).toBe(false);
    expect(fs.existsSync(`${keyDirectory}.previous`)).toBe(false);
  });

  it('switches from the user\'s setup to a password: makes a key and adds it with the password', async () => {
    const { rig, hostId } = await rigWithHost();

    const status = await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'create-key', password: 'pw' } });

    expect(status.host.key_created).toBe(true);
    expect(fs.existsSync(status.host.key_path!)).toBe(true);
    expect(rig.run.calls.some((call) => call.args.includes('PubkeyAuthentication=no'))).toBe(true);
    // Nothing was made by Kangentic before, so there is no old key to take off.
    expect(rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')))).toBe(false);
  });

  it('never takes a key file the user chose off the host when it is replaced', async () => {
    const { rig, hostId } = await rigWithHost();
    const keyFile = path.join(scratch, 'downloaded-key');
    fs.writeFileSync(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
    await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'key-file', keyFilePath: keyFile } });
    rig.run.calls.length = 0;

    await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } });

    expect(rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')))).toBe(false);
    expect(rig.hosts[0]).toMatchObject({ key_path: null, key_created: false });
  });

  it('leaves the host as it was, with its old key files back, when the new sign-in fails', async () => {
    const { rig, hostId } = await rigWithHost({ createdKey: true });
    const before = { ...rig.hosts[0] };
    const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
    const oldKey = fs.readFileSync(path.join(keyDirectory, 'id_ed25519'), 'utf8');
    const original = rig.setup.run;
    rig.setup.run = (async (file: string, args: string[], options?: unknown) => {
      if (args.includes('PubkeyAuthentication=no')) return { code: 255, stdout: '', stderr: 'Permission denied (password).' };
      return original(file, args, options as never);
    }) as RunProgram;
    fs.writeFileSync(path.join(keyDirectory, 'id_ed25519'), `${oldKey}old`);

    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'create-key', password: 'wrong' } })).rejects.toThrow();

    expect(rig.hosts[0]).toMatchObject({ destination: before.destination, key_path: before.key_path, key_created: true });
    expect(fs.readFileSync(path.join(keyDirectory, 'id_ed25519'), 'utf8')).toBe(`${oldKey}old`);
    expect(fs.existsSync(`${keyDirectory}.previous`)).toBe(false);
    expect(rig.connectHost).not.toHaveBeenCalled();
  });

  describe('proving the new sign-in before anything is taken away', () => {
    const provedWith = (rig: Rig) => rig.run.calls.filter((call) => call.args.at(-1) === 'true');
    const tookKeyOff = (rig: Rig) => rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')));

    /** A host that refuses the proof, as one with password sign-in off refuses a key it does not hold. */
    function refuseTheProof(rig: Rig, stderr = 'dev@lab: Permission denied (publickey).'): void {
      const original = rig.setup.run;
      rig.setup.run = (async (file: string, args: string[], options?: unknown) => {
        if (args.at(-1) === 'true') {
          rig.run.calls.push({ file, args });
          return { code: 255, stdout: '', stderr };
        }
        return original(file, args, options as never);
      }) as RunProgram;
    }

    it('connects with the new sign-in in BatchMode, and only then takes the old key off', async () => {
      const { rig, hostId } = await rigWithHost({ createdKey: true });

      await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } });

      const proof = provedWith(rig);
      expect(proof).toHaveLength(1);
      expect(proof[0].args).toContain('BatchMode=yes');
      const proofAt = rig.run.calls.indexOf(proof[0]);
      const keyOffAt = rig.run.calls.findIndex((call) => call.args.some((arg) => arg.includes('grep -vxF')));
      expect(keyOffAt).toBeGreaterThan(proofAt);
    });

    it('refuses with ssh\'s own words when My SSH config cannot sign in, and takes nothing away', async () => {
      const { rig, hostId } = await rigWithHost({ createdKey: true });
      const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
      const before = { ...rig.hosts[0] };
      refuseTheProof(rig);

      await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } }))
        .rejects.toThrow('Permission denied (publickey)');

      expect(tookKeyOff(rig)).toBe(false);
      expect(fs.existsSync(path.join(keyDirectory, 'id_ed25519'))).toBe(true);
      expect(fs.existsSync(`${keyDirectory}.previous`)).toBe(false);
      expect(rig.hosts[0]).toMatchObject({ key_path: before.key_path, key_created: true });
      expect(rig.connectHost).not.toHaveBeenCalled();
    });

    it('refuses a key file the host does not accept, and puts the key it had back', async () => {
      const { rig, hostId } = await rigWithHost({ createdKey: true });
      const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
      const keyFile = path.join(scratch, 'wrong-key');
      fs.writeFileSync(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
      refuseTheProof(rig);

      await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'key-file', keyFilePath: keyFile } }))
        .rejects.toThrow('Permission denied');

      expect(fs.existsSync(path.join(keyDirectory, 'id_imported'))).toBe(false);
      expect(fs.existsSync(path.join(keyDirectory, 'id_ed25519'))).toBe(true);
      expect(tookKeyOff(rig)).toBe(false);
    });

    it('keeps the old address when the new one cannot be signed in to', async () => {
      const { rig, hostId } = await rigWithHost();
      refuseTheProof(rig, 'ssh: connect to host lab2 port 22: Connection timed out');

      await expect(rig.admin.updateHost(hostId, { name: 'Renamed', destination: 'dev@lab2.example.test', expectedFingerprint: FINGERPRINT }))
        .rejects.toThrow('Connection timed out');

      expect(rig.hosts[0]).toMatchObject({ destination: 'dev@lab.example.test', name: 'Lab' });
      expect(rig.hostService.disconnect).not.toHaveBeenCalled();
    });

    it('proves a new address with the key the host already has', async () => {
      const { rig, hostId } = await rigWithHost();
      const keyFile = path.join(scratch, 'downloaded-key');
      fs.writeFileSync(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
      await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'key-file', keyFilePath: keyFile } });
      rig.run.calls.length = 0;

      await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab2.example.test', expectedFingerprint: FINGERPRINT });

      const proof = provedWith(rig);
      expect(proof).toHaveLength(1);
      expect(proof[0].args).toEqual(expect.arrayContaining(['-i', rig.hosts[0].key_path!, 'dev@lab2.example.test']));
    });
  });

  describe('moving the old key files aside', () => {
    const locked = (): Error => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });

    it('stops before anything is deleted when the old keys cannot be moved aside', async () => {
      const { rig, hostId } = await rigWithHost({ createdKey: true });
      const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
      const before = { ...rig.hosts[0] };
      fileFaults.rename = (from, to) => (to.endsWith('.previous') ? locked() : null);

      await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } }))
        .rejects.toThrow('EBUSY');

      expect(fs.existsSync(path.join(keyDirectory, 'id_ed25519'))).toBe(true);
      expect(rig.hosts[0]).toMatchObject({ key_path: before.key_path, key_created: true });
    });

    it('goes on when there is no key folder at all, since that only means no keys', async () => {
      const { rig, hostId } = await rigWithHost();

      await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } })).resolves.toBeDefined();
    });

    it('says where the old key is when it cannot be put back, and keeps it there', async () => {
      const { rig, hostId } = await rigWithHost({ createdKey: true });
      const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
      const original = rig.setup.run;
      rig.setup.run = (async (file: string, args: string[], options?: unknown) => {
        if (args.at(-1) === 'true') return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
        return original(file, args, options as never);
      }) as RunProgram;
      fileFaults.rename = (from) => (from.endsWith('.previous') ? locked() : null);

      await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } }))
        .rejects.toThrow(/Permission denied[\s\S]*\.previous/);

      expect(fs.existsSync(path.join(`${keyDirectory}.previous`, 'id_ed25519'))).toBe(true);
    });

    it('recovers the old key left aside by a crash mid-swap, instead of deleting the only copy', async () => {
      const { rig, hostId } = await rigWithHost({ createdKey: true });
      const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
      fs.renameSync(keyDirectory, `${keyDirectory}.previous`);

      await rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test', signIn: { method: 'config' } });

      // Restored first, so the sign-in that followed could take the key off the host with it.
      expect(rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')))).toBe(true);
      expect(fs.existsSync(`${keyDirectory}.previous`)).toBe(false);
    });

    it('takes the aside folder with the rest when the host is removed, so no private key is left behind', async () => {
      const { rig, hostId } = await rigWithHost({ createdKey: true });
      const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
      fs.cpSync(keyDirectory, `${keyDirectory}.previous`, { recursive: true });

      await rig.admin.removeHost(hostId);

      expect(fs.existsSync(`${keyDirectory}.previous`)).toBe(false);
    });
  });

  it('is no host to edit once removed', async () => {
    const { rig, hostId } = await rigWithHost();
    await rig.admin.removeHost(hostId);

    await expect(rig.admin.updateHost(hostId, { name: 'Lab', destination: 'dev@lab.example.test' })).rejects.toThrow('not set up');
  });
});

describe('checking a key file the user chose', () => {
  it('passes a usable key, and rejects one with a passphrase, with the reason', async () => {
    const rig = makeRig();
    const usable = path.join(scratch, 'id_plain');
    fs.writeFileSync(usable, '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n');
    const protectedKey = path.join(scratch, 'id_protected');
    fs.writeFileSync(protectedKey, '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,AB\n\nabc\n-----END RSA PRIVATE KEY-----\n');

    await expect(rig.admin.checkKeyFile(usable)).resolves.toBeUndefined();
    await expect(rig.admin.checkKeyFile(protectedKey)).rejects.toThrow('passphrase');
  });
});

describe('a host whose key changed', () => {
  it('reads the key it presents now, with no fingerprint before when none is recorded, and trusts nothing', async () => {
    const rig = makeRig();
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'dev@lab.example.test', key_path: null, key_created: false, created_at: '' });

    const probe = await rig.admin.probeChangedHostKey('h1');

    expect(probe).toEqual({ hostname: 'lab.example.test', port: 22, keyType: 'ssh-ed25519', fingerprint: FINGERPRINT, previousFingerprint: null });
    expect(rig.connectHost).not.toHaveBeenCalled();
  });

  it('trusts the key the user was shown and connects the host', async () => {
    const rig = makeRig();
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'dev@lab.example.test', key_path: null, key_created: false, created_at: '' });

    const status = await rig.admin.trustNewHostKey('h1', FINGERPRINT);

    expect(rig.connectHost).toHaveBeenCalledWith('h1');
    expect(status.host.id).toBe('h1');
  });

  it('connects nothing when the host now presents a different key than the one shown', async () => {
    const rig = makeRig({ keyBlob: Buffer.from('another key blob that is not the one the user was shown').toString('base64') });
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'dev@lab.example.test', key_path: null, key_created: false, created_at: '' });

    await expect(rig.admin.trustNewHostKey('h1', FINGERPRINT)).rejects.toThrow('different key than the one you were shown');

    expect(rig.connectHost).not.toHaveBeenCalled();
  });

  it('refuses a host that is not set up', async () => {
    const rig = makeRig();
    await expect(rig.admin.probeChangedHostKey('missing')).rejects.toThrow('not set up');
    await expect(rig.admin.trustNewHostKey('missing', FINGERPRINT)).rejects.toThrow('not set up');
  });
});

describe('the program on a host', () => {
  it('reports the host\'s program with this app\'s version beside it', async () => {
    const rig = makeRig();
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '' });

    expect(await rig.admin.hostProgram('h1')).toEqual({
      version: '0.53.0',
      appVersion: '0.54.0',
      startedAt: '2026-11-04T08:00:00.000Z',
      liveSessions: 3,
      installedVersions: ['0.52.0', '0.53.0'],
    });
  });

  it('passes a host that cannot be asked up as an error, and refuses a host that is not set up', async () => {
    const rig = makeRig();
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '' });
    rig.hostService.programInfo.mockRejectedValueOnce(new Error('Kangentic has no connection set up for host h1'));
    await expect(rig.admin.hostProgram('h1')).rejects.toThrow('no connection set up');
    await expect(rig.admin.hostProgram('missing')).rejects.toThrow('not set up');
  });
});

describe('checking a folder on a host', () => {
  it('expands ~, asks the helper, and says whether it is a git repository', async () => {
    const rig = makeRig();
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '' });
    rig.hostService.pathPresence.mockResolvedValue(['present', 'absent']);

    const probe = await rig.admin.probeRemoteFolder('h1', '~/projects/api/');

    expect(probe).toEqual({ exists: true, path: '/home/dev/projects/api', isGitRepo: false });
    expect(rig.hostService.pathPresence).toHaveBeenCalledWith('h1', ['/home/dev/projects/api', '/home/dev/projects/api/.git']);
  });

  it('reports a missing folder as missing, and passes a link that is down up as an error, never as "missing"', async () => {
    const rig = makeRig();
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '' });
    rig.hostService.pathPresence.mockResolvedValueOnce(['absent', 'absent']);
    expect((await rig.admin.probeRemoteFolder('h1', '/home/dev/none')).exists).toBe(false);

    rig.hostService.pathPresence.mockRejectedValueOnce(new Error('Kangentic has no connection set up for host h1'));
    await expect(rig.admin.probeRemoteFolder('h1', '/home/dev/none')).rejects.toThrow('no connection set up');
  });

  it('refuses a folder outside the host\'s home with the home it must be in, before asking the host about it', async () => {
    const rig = makeRig();
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '' });

    await expect(rig.admin.probeRemoteFolder('h1', '/srv/app')).rejects.toThrow('/srv/app is outside the home folder on the host (/home/dev)');
    await expect(rig.admin.probeRemoteFolder('h1', '/home/developer/app')).rejects.toThrow('outside the home folder');
    expect(rig.hostService.pathPresence).not.toHaveBeenCalled();
    // The home itself and anything under it is fine.
    rig.hostService.pathPresence.mockResolvedValue(['present', 'absent']);
    await expect(rig.admin.probeRemoteFolder('h1', '~')).resolves.toMatchObject({ path: '/home/dev' });
  });

  it.each([
    ['', 'Enter the folder'],
    ['relative/path', 'absolute path'],
    ['/home/dev/../root', 'Leave out ..'],
    ['/home/dev/\nrm', 'Enter the folder'],
  ])('refuses %j', (folder, message) => {
    expect(() => resolveHostFolder(folder, '/home/dev')).toThrow(message);
  });

  it('tidies repeated slashes and a trailing one, and keeps the root', () => {
    expect(resolveHostFolder('/home//dev///api/', '/home/dev')).toBe('/home/dev/api');
    expect(resolveHostFolder('/', '/home/dev')).toBe('/');
    expect(resolveHostFolder('~', '/home/dev')).toBe('/home/dev');
  });
});

describe('preparing a remote project', () => {
  const input = { name: 'api', path: '', remote: { hostId: 'h1', path: '/home/dev/api' } };

  function rigWithHostAndGit() {
    const rig = makeRig();
    rig.hosts.push({ id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '' });
    return rig;
  }

  it('makes the shell folder, keeps .kangentic/ out of the host repository\'s status, and returns the input pointed at the shell', async () => {
    const rig = rigWithHostAndGit();
    rig.hostService.readFile.mockResolvedValue({ exists: true, content: '# exclude\n*.log' });

    const prepared = await rig.admin.prepareRemoteProject(input);

    expect(fs.statSync(prepared.path).isDirectory()).toBe(true);
    expect(path.dirname(prepared.path)).toBe(shellRoot);
    expect(prepared.remote).toEqual({ hostId: 'h1', path: '/home/dev/api' });
    expect(rig.hostService.writeFiles).toHaveBeenCalledWith('h1', [{ path: '/home/dev/api/.git/info/exclude', content: '# exclude\n*.log\n.kangentic/\n', mode: 0o644, keepExistingMode: true, expect: '# exclude\n*.log' }]);
  });

  it('writes a repository with no exclude file as one that must still not exist', async () => {
    const rig = rigWithHostAndGit();
    rig.hostService.readFile.mockResolvedValue({ exists: false, content: null });

    await rig.admin.prepareRemoteProject(input);

    expect(rig.hostService.writeFiles).toHaveBeenCalledWith('h1', [{ path: '/home/dev/api/.git/info/exclude', content: '.kangentic/\n', mode: 0o644, keepExistingMode: true, expect: null }]);
  });

  it('writes nothing when .kangentic/ is already excluded, or the folder is not a git repository', async () => {
    const rig = rigWithHostAndGit();
    rig.hostService.readFile.mockResolvedValue({ exists: true, content: '.kangentic/\n' });
    await rig.admin.prepareRemoteProject(input);
    expect(rig.hostService.writeFiles).not.toHaveBeenCalled();

    rig.hostService.pathPresence.mockResolvedValue(['present', 'absent']);
    await rig.admin.prepareRemoteProject(input);
    expect(rig.hostService.writeFiles).not.toHaveBeenCalled();
  });

  it('refuses a folder that is not there, and makes no shell folder', async () => {
    const rig = rigWithHostAndGit();
    rig.hostService.pathPresence.mockResolvedValue(['absent', 'absent']);

    await expect(rig.admin.prepareRemoteProject(input)).rejects.toThrow('/home/dev/api does not exist on that host');

    expect(fs.readdirSync(shellRoot)).toEqual([]);
  });

  it('removes the shell folder it made when excluding fails', async () => {
    const rig = rigWithHostAndGit();
    rig.hostService.writeFiles.mockRejectedValue(new Error('the link dropped'));

    await expect(rig.admin.prepareRemoteProject(input)).rejects.toThrow('the link dropped');

    expect(fs.readdirSync(shellRoot)).toEqual([]);
  });

  it('refuses a host that is not set up, and an input that is not remote', async () => {
    const rig = makeRig();
    await expect(rig.admin.prepareRemoteProject({ name: 'api', path: '', remote: { hostId: 'nobody', path: '/x' } })).rejects.toThrow('not set up');
    await expect(rig.admin.prepareRemoteProject({ name: 'api', path: '/local' })).rejects.toThrow('not a remote project');
  });
});

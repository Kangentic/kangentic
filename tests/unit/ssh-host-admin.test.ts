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
import { SshHostAdmin, resolveHostFolder, type SshHostAdminDeps } from '../../src/main/remote/ssh-host-admin';
import { HostStatusBook } from '../../src/main/remote/host-status';
import type { Project, SshHost } from '../../src/shared/types';
import type { RunProgram, SshSetupDeps } from '../../src/main/remote/ssh-setup';

const KEY_BLOB = Buffer.from('a real looking public key blob, long enough to hash').toString('base64');
const FINGERPRINT = `SHA256:${createHash('sha256').update(Buffer.from(KEY_BLOB, 'base64')).digest('base64').replace(/=+$/, '')}`;
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOgIJuDZuvCDEVMrBvKoQm4R5vVmmcYCuZ1F8rK2mSyP kangentic';

let scratch: string;
let home: string;
let shellRoot: string;

interface Rig {
  admin: SshHostAdmin;
  hosts: SshHost[];
  projects: Project[];
  removedProjects: string[];
  run: RunProgram & { calls: Array<{ file: string; args: string[] }> };
  hostService: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    hostInfo: ReturnType<typeof vi.fn>;
    pathPresence: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    writeFiles: ReturnType<typeof vi.fn>;
  };
  status: HostStatusBook;
  connectHost: ReturnType<typeof vi.fn>;
  setup: SshSetupDeps;
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
  };
  let counter = 0;
  const deps: SshHostAdminDeps = {
    hosting: {
      hosts: {
        list: () => [...hosts],
        getById: (id: string) => hosts.find((host) => host.id === id),
        create: (input: { name: string; destination: string }) => {
          const host: SshHost = { id: `0000000${++counter}-0000-4000-8000-000000000000`, name: input.name, destination: input.destination, key_path: null, key_created: false, created_at: '2026-11-03T00:00:00.000Z' };
          hosts.push(host);
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
        delete: (id: string) => { hosts.splice(hosts.findIndex((host) => host.id === id), 1); },
      },
      hostService,
      status,
      connectHost,
    } as unknown as SshHostAdminDeps['hosting'],
    projects: { listOnHost: (hostId: string) => projects.filter((project) => project.remote?.hostId === hostId) },
    setup,
    removeProject: async (project) => { removedProjects.push(project.id); },
    remoteProjectsRoot: shellRoot,
    newShellFolder: () => path.join(shellRoot, `shell-${++counter}`),
  };
  return { admin: new SshHostAdmin(deps), hosts, projects, removedProjects, run, hostService, status, connectHost, setup };
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
    rig.hosts.push({ id: 'h-new', name: 'New', destination: 'new', key_path: null, key_created: false, created_at: '' });
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

  it('takes its projects out of Kangentic and deletes their shell folders, leaving other hosts\' alone', async () => {
    const { rig, hostId, folderA, folderB } = await rigWithHost();

    await rig.admin.removeHost(hostId);

    expect(rig.removedProjects).toEqual(['p1', 'p2']);
    expect(fs.existsSync(folderA)).toBe(false);
    expect(fs.existsSync(folderB)).toBe(false);
    expect(rig.hosts).toEqual([]);
    expect(rig.status.get(hostId)).toBeUndefined();
    expect(rig.hostService.disconnect).toHaveBeenCalledWith(hostId);
  });

  it('never deletes a folder outside the one remote projects live in, whatever a project row says', async () => {
    const { rig, hostId } = await rigWithHost();
    const outside = path.join(scratch, 'precious');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'file.txt'), 'keep me');
    rig.projects.push(project('bad', hostId, outside), project('root', hostId, shellRoot));

    await rig.admin.removeHost(hostId);

    expect(fs.readFileSync(path.join(outside, 'file.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(shellRoot)).toBe(true);
  });

  it('takes the key it made off the host, and deletes it here', async () => {
    const { rig, hostId } = await rigWithHost({ createdKey: true });
    const keyDirectory = path.join(rig.setup.configDirectory, 'ssh', hostId);
    expect(fs.existsSync(keyDirectory)).toBe(true);

    await rig.admin.removeHost(hostId);

    const removal = rig.run.calls.find((call) => call.args.some((arg) => arg.includes('grep -vxF')));
    expect(removal?.args).toEqual(expect.arrayContaining(['IdentitiesOnly=yes', 'BatchMode=yes']));
    expect(fs.existsSync(keyDirectory)).toBe(false);
  });

  it('still removes the host when it cannot be reached to take the key off', async () => {
    const { rig, hostId } = await rigWithHost({ createdKey: true });
    const original = rig.setup.run;
    rig.setup.run = (async (file: string, args: string[], options?: unknown) => {
      if (args.some((arg) => arg.includes('grep -vxF'))) throw new Error('spawn ssh ETIMEDOUT');
      return original(file, args, options as never);
    }) as RunProgram;

    await rig.admin.removeHost(hostId);

    expect(rig.hosts).toEqual([]);
  });

  it('does not touch the host\'s key for a host that signs in the user\'s own way', async () => {
    const { rig, hostId } = await rigWithHost();

    await rig.admin.removeHost(hostId);

    expect(rig.run.calls.some((call) => call.args.some((arg) => arg.includes('grep -vxF')))).toBe(false);
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
    expect((await rig.admin.probeRemoteFolder('h1', '/srv/none')).exists).toBe(false);

    rig.hostService.pathPresence.mockRejectedValueOnce(new Error('Kangentic has no connection set up for host h1'));
    await expect(rig.admin.probeRemoteFolder('h1', '/srv/none')).rejects.toThrow('no connection set up');
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
    expect(rig.hostService.writeFiles).toHaveBeenCalledWith('h1', [{ path: '/home/dev/api/.git/info/exclude', content: '# exclude\n*.log\n.kangentic/\n', mode: 0o644 }]);
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

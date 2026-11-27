/**
 * Main's side of an SSH host (#913): the ssh options every connection starts with, the check on a
 * destination that could smuggle an ssh option, and the order connect runs in (install, then dial).
 *
 * What a user loses if it breaks: a prompt the app cannot show hanging a connection, a typed address
 * turning into an ssh option, or a host whose program was never installed being dialed anyway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_READY_WAIT_MS,
  HostProgramMissingError,
  InvalidSshDestinationError,
  RemoteHostService,
  assertSafeDestination,
  sshArgsFor,
  type RemoteHostServiceDeps,
} from '../../src/main/remote/remote-host-service';
import { hostRequestWaitOf } from '../../src/main/remote/link/host-request-unanswered-error';
import { HOST_NOT_CONNECTED_SENTENCE, HostUnreachableError } from '../../src/main/remote/link/host-unreachable-error';
import type { SshHost } from '../../src/shared/types';
import type { RemoteHostRequest } from '../../src/main/remote/protocol/messages';
import type { InstalledHost } from '../../src/main/remote/link/host-installer';

const host = (overrides: Partial<SshHost> = {}): SshHost => ({
  id: 'host-a',
  name: 'Lab box',
  destination: 'dev@lab.example.test',
  key_path: null,
  key_created: false,
  created_at: '2026-11-03T00:00:00.000Z',
  ...overrides,
});

describe('sshArgsFor', () => {
  it('never lets ssh wait on a prompt, notices a dead link, and forwards no agent', () => {
    const args = sshArgsFor(host());
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ServerAliveInterval=15');
    expect(args).toContain('ForwardAgent=no');
    expect(args.at(-1)).toBe('dev@lab.example.test');
  });

  it('leaves host key checking as the user set it', () => {
    expect(sshArgsFor(host()).join(' ')).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile/);
  });

  it('signs in with the chosen key alone when the host has one, and uses the user\'s own setup when it has none', () => {
    const withKey = sshArgsFor(host({ key_path: '/home/dev/.config/kangentic/ssh/host-a/id' }));
    expect(withKey).toEqual(expect.arrayContaining(['-i', '/home/dev/.config/kangentic/ssh/host-a/id', 'IdentitiesOnly=yes']));
    expect(sshArgsFor(host())).not.toContain('-i');
  });
});

describe('a destination', () => {
  it.each(['-oProxyCommand=calc', '-J evil', '', 'a b', 'host\nname', 'host\u0000'])('is refused when it could be read as an option or carries whitespace: %j', (destination) => {
    expect(() => assertSafeDestination(destination)).toThrow(InvalidSshDestinationError);
    expect(() => sshArgsFor(host({ destination }))).toThrow(InvalidSshDestinationError);
  });

  it.each(['lab', 'dev@lab.example.test', 'ssh://dev@lab.example.test:2222', '10.0.0.7', 'dev@[fe80::1]'])('is accepted: %s', (destination) => {
    expect(() => assertSafeDestination(destination)).not.toThrow();
  });
});

function makeService(overrides: Partial<RemoteHostServiceDeps> = {}) {
  const sent: RemoteHostRequest[] = [];
  const order: string[] = [];
  const hosts = [host(), host({ id: 'host-b', destination: 'dev@other.example.test' })];
  const service = new RemoteHostService({
    sshPath: 'ssh',
    hosts: { getById: (id) => hosts.find((candidate) => candidate.id === id), list: () => hosts },
    send: async (request) => {
      order.push(`send:${request.op}`);
      sent.push(request);
      if (request.op === 'helper' && request.method === 'hostInfo') return { home: '/home/dev', shellPath: '/usr/bin/fish', shellName: 'fish' };
      return { ok: true };
    },
    asset: () => ({ version: '1.2.3', sha256: 'a'.repeat(64), arch: 'x64', filePath: '/asset.tar.gz' }),
    identity: { installId: 'install-a', label: 'a test computer' },
    install: async () => {
      order.push('install');
      return { directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true };
    },
    createRunner: () => (async () => ({ code: 0, stdout: '', stderr: '' })),
    ...overrides,
  });
  return { service, sent, order };
}

describe('connect', () => {
  it('installs the program first, then adds the link with the command the install named', async () => {
    const { service, sent, order } = makeService();

    await service.connect('host-a');

    expect(order).toEqual(['install', 'send:addHost']);
    expect(sent[0]).toMatchObject({
      op: 'addHost',
      hostId: 'host-a',
      connection: { sshPath: 'ssh', remoteCommand: 'node relay.js', installId: 'install-a', label: 'a test computer' },
    });
    expect(service.isConnected('host-a')).toBe(true);
  });

  it('dials nothing when the install fails, and passes the host\'s own words up', async () => {
    const { service, sent } = makeService({ install: async () => { throw new Error('Permission denied (publickey).'); } });

    await expect(service.connect('host-a')).rejects.toThrow('Permission denied (publickey).');
    expect(sent).toEqual([]);
    expect(service.isConnected('host-a')).toBe(false);
  });

  describe('a refused sign-in through the user\'s own ssh config', () => {
    const refusal = 'dev@lab.example.test: Permission denied (publickey).';
    const prompt = 'Enter passphrase for key \'/home/dev/.ssh/id_ed25519\':';

    it('shows ssh\'s own passphrase prompt under its refusal, which BatchMode reports as it does a wrong key', async () => {
      const captureKeyPrompt = vi.fn(async (_args: string[]) => prompt);
      const { service } = makeService({ install: async () => { throw new Error(refusal); }, captureKeyPrompt });

      await expect(service.connect('host-a')).rejects.toThrow(`${refusal}\n${prompt}`);
      // Asked with the arguments of the attempt that failed.
      expect(captureKeyPrompt.mock.calls[0][0]).toEqual(sshArgsFor(host()));
    });

    it('leaves the refusal as ssh said it when ssh asked for no passphrase', async () => {
      const { service } = makeService({ install: async () => { throw new Error(refusal); }, captureKeyPrompt: async () => null });

      await expect(service.connect('host-a')).rejects.toThrow(new RegExp(`^${refusal.replace(/[().]/g, '\\$&')}$`));
    });

    it('leaves the refusal as it was when the repeated attempt itself fails', async () => {
      const { service } = makeService({
        install: async () => { throw new Error(refusal); },
        captureKeyPrompt: async () => { throw new Error('spawn ssh ENOENT'); },
      });

      await expect(service.connect('host-a')).rejects.toThrow(refusal);
    });

    it('asks nothing of a host that signs in with a key file Kangentic holds, which is never encrypted', async () => {
      const captureKeyPrompt = vi.fn(async () => prompt);
      const { service } = makeService({
        hosts: { getById: () => host({ key_path: '/home/dev/.config/kangentic/ssh/host-a/id' }), list: () => [] },
        install: async () => { throw new Error(refusal); },
        captureKeyPrompt,
      });

      await expect(service.connect('host-a')).rejects.toThrow(refusal);
      expect(captureKeyPrompt).not.toHaveBeenCalled();
    });

    it('asks nothing when the failure was not a refusal', async () => {
      const captureKeyPrompt = vi.fn(async () => prompt);
      const { service } = makeService({
        install: async () => { throw new Error('ssh: connect to host lab port 22: Connection timed out'); },
        captureKeyPrompt,
      });

      await expect(service.connect('host-a')).rejects.toThrow('Connection timed out');
      expect(captureKeyPrompt).not.toHaveBeenCalled();
    });
  });

  it('says so when this build has no program to install, and sends nothing', async () => {
    const { service, sent } = makeService({ asset: () => null });

    await expect(service.connect('host-a')).rejects.toBeInstanceOf(HostProgramMissingError);
    expect(sent).toEqual([]);
  });

  it('refuses a host it does not know, and one whose address is an ssh option', async () => {
    const { service } = makeService();
    await expect(service.connect('nobody')).rejects.toThrow('not set up');

    const unsafe = makeService({ hosts: { getById: () => host({ destination: '-oProxyCommand=x' }), list: () => [] } });
    await expect(unsafe.service.connect('host-a')).rejects.toBeInstanceOf(InvalidSshDestinationError);
  });

  it('runs one install and one addHost for two connects of one host at once', async () => {
    let release = (): void => undefined;
    const open = new Promise<void>((resolve) => { release = resolve; });
    let installs = 0;
    const { service, sent } = makeService({
      install: async () => {
        installs += 1;
        await open;
        return { directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true };
      },
    });

    const first = service.connect('host-a');
    const second = service.connect('host-a');
    release();
    await Promise.all([first, second]);

    expect(installs).toBe(1);
    expect(sent.filter((request) => request.op === 'addHost')).toHaveLength(1);
    expect(service.isConnected('host-a')).toBe(true);
  });

  it('does not remember a rejected connect, so the next one installs again', async () => {
    let installs = 0;
    const { service, sent } = makeService({
      install: async () => {
        installs += 1;
        if (installs === 1) throw new Error('Connection refused');
        return { directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true };
      },
    });

    await expect(service.connect('host-a')).rejects.toThrow('Connection refused');
    await service.connect('host-a');

    expect(installs).toBe(2);
    expect(sent.filter((request) => request.op === 'addHost')).toHaveLength(1);
    expect(service.isConnected('host-a')).toBe(true);
  });

  it('sends the PTYs main already holds on the host with its addHost, and leaves the key out when there are none', async () => {
    const live = [{ sessionId: 's1', ptyId: 7 }];
    const withSessions = makeService({ liveSessions: (hostId) => (hostId === 'host-a' ? live : []) });
    await withSessions.service.connect('host-a');
    expect(withSessions.sent[0]).toMatchObject({ op: 'addHost', hostId: 'host-a', sessions: live });

    await withSessions.service.connect('host-b');
    const withoutSessions = withSessions.sent.find((request) => request.op === 'addHost' && request.hostId === 'host-b');
    expect(withoutSessions).toBeDefined();
    expect(withoutSessions).not.toHaveProperty('sessions');
  });

  it('refuses a host that was removed, and installs nothing there', async () => {
    const removedHost = host({ removed_at: '2026-11-06T00:00:00.000Z' });
    const { service, order } = makeService({ hosts: { getById: () => removedHost, list: () => [] } });

    await expect(service.connect('host-a')).rejects.toThrow('not set up');
    expect(order).toEqual([]);
  });

  describe('a disconnect while the install is still running', () => {
    /** An install that waits for `release`, the first time only. */
    function gatedInstall() {
      let release = (): void => undefined;
      const open = new Promise<void>((resolve) => { release = resolve; });
      let installs = 0;
      const harness = makeService({
        install: async () => {
          installs += 1;
          if (installs === 1) await open;
          return { directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true };
        },
      });
      return { ...harness, release, installCount: () => installs };
    }

    it('adds no link and leaves the host disconnected', async () => {
      const { service, sent, release } = gatedInstall();

      const connecting = service.connect('host-a');
      await service.disconnect('host-a');
      release();
      await connecting;

      expect(sent.filter((request) => request.op === 'addHost')).toEqual([]);
      expect(service.isConnected('host-a')).toBe(false);
      expect(service.connectedHosts()).toEqual([]);
    });

    it('ends a connect that joined before the disconnect with it, so a Reconnect cannot bring back a removed host', async () => {
      const { service, sent, release, installCount } = gatedInstall();

      const first = service.connect('host-a');
      const joined = service.connect('host-a');
      await service.disconnect('host-a');
      release();
      await Promise.all([first, joined]);

      expect(installCount()).toBe(1);
      expect(sent.filter((request) => request.op === 'addHost')).toEqual([]);
      expect(service.isConnected('host-a')).toBe(false);
    });

    it('connects for a connect asked for after the disconnect, with a second install', async () => {
      const { service, sent, release, installCount } = gatedInstall();

      const first = service.connect('host-a');
      await service.disconnect('host-a');
      const afterwards = service.connect('host-a');
      release();
      await Promise.all([first, afterwards]);

      expect(installCount()).toBe(2);
      expect(sent.filter((request) => request.op === 'addHost')).toHaveLength(1);
      expect(service.isConnected('host-a')).toBe(true);
    });

    it('still connects a later connect when the dropped install fails', async () => {
      let installs = 0;
      let failFirst = (): void => undefined;
      const firstFails = new Promise<void>((_resolve, reject) => { failFirst = () => reject(new Error('the host went away')); });
      const { service } = makeService({
        install: async () => {
          installs += 1;
          if (installs === 1) await firstFails;
          return { directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true };
        },
      });

      const first = service.connect('host-a');
      await service.disconnect('host-a');
      const afterwards = service.connect('host-a');
      failFirst();

      await expect(first).rejects.toThrow('the host went away');
      await afterwards;
      expect(service.isConnected('host-a')).toBe(true);
    });

    it('does not count the host connected when the disconnect lands while addHost is on its way', async () => {
      let answerAddHost = (): void => undefined;
      const addHostAnswered = new Promise<void>((resolve) => { answerAddHost = resolve; });
      let addHostSent = (): void => undefined;
      const addHostReached = new Promise<void>((resolve) => { addHostSent = resolve; });
      const { service } = makeService({
        send: async (request) => {
          if (request.op !== 'addHost') return { ok: true };
          addHostSent();
          await addHostAnswered;
          return { ok: true };
        },
      });

      const connecting = service.connect('host-a');
      await addHostReached;
      await service.disconnect('host-a');
      answerAddHost();
      await connecting;

      // Read after a restart of the process holding the links: it would add the host back.
      expect(service.connectedHosts()).toEqual([]);
    });
  });

  it('gives every connection a connect timeout, so a host that is off fails in seconds', () => {
    const args = sshArgsFor(host());
    expect(args).toContain('ConnectTimeout=15');
    expect(args.at(-1)).toBe(host().destination);
  });
});

describe('ending what a host still runs from before it was removed', () => {
  const session = (sessionId: string, projectId: string, pid: number, alive = true) => ({ sessionId, taskId: 'task', projectId, pid, alive, exitCode: alive ? null : 0, wirePtyId: null, inAltScreen: false });

  /** A helper whose snapshots answer in turn, the last one for good. */
  function serviceWithSnapshots(snapshots: Array<ReturnType<typeof session>[]>, overrides: Partial<RemoteHostServiceDeps> = {}) {
    const commands: Array<{ file: string; args: string[] }> = [];
    let asked = 0;
    const { service } = makeService({
      send: async (request) => {
        if (request.op === 'helper' && request.method === 'snapshot') {
          const answer = snapshots[Math.min(asked, snapshots.length - 1)];
          asked += 1;
          return { ownerEpoch: 3, daemonPid: 1, daemonStartedAt: '', sessions: answer };
        }
        if (request.op === 'helper' && request.method === 'runCommand') {
          commands.push(request.params as { file: string; args: string[] });
          return { code: 0, stdout: '', stderr: '', timedOut: false };
        }
        return { ok: true };
      },
      ...overrides,
    });
    return { service, commands };
  }

  it('hangs up only the live sessions of these projects, passing each pid as an argument, and waits until they are gone', async () => {
    const { service, commands } = serviceWithSnapshots([
      [session('left', 'project-a', 4100), session('elsewhere', 'project-other', 4200), session('finished', 'project-a', 4300, false)],
      [session('left', 'project-a', 4100, false), session('elsewhere', 'project-other', 4200)],
    ]);

    await expect(service.endSessionsLeftRunning('host-a', new Set(['project-a']))).resolves.toBe(1);

    expect(commands).toHaveLength(1);
    expect(commands[0].file).toBe('sh');
    expect(commands[0].args.slice(-1)).toEqual(['4100']);
    expect(commands[0].args[1]).not.toContain('4100');
  });

  it('asks nothing further of a host holding none of them', async () => {
    const { service, commands } = serviceWithSnapshots([[session('elsewhere', 'project-other', 4200)]]);

    await expect(service.endSessionsLeftRunning('host-a', new Set(['project-a']))).resolves.toBe(0);

    expect(commands).toEqual([]);
  });

  it('leaves a session this app holds a PTY for', async () => {
    const { service, commands } = serviceWithSnapshots(
      [[session('ours', 'project-a', 4100)]],
      { liveSessions: () => [{ sessionId: 'ours', ptyId: 7 }] },
    );

    await expect(service.endSessionsLeftRunning('host-a', new Set(['project-a']))).resolves.toBe(0);

    expect(commands).toEqual([]);
  });

  it('leaves a session a record still names as running, whose agent is not taken back yet', async () => {
    const { service, commands } = serviceWithSnapshots([
      [session('waiting', 'project-a', 4100), session('unowned', 'project-a', 4200)],
      [session('waiting', 'project-a', 4100), session('unowned', 'project-a', 4200, false)],
    ]);

    await expect(service.endSessionsLeftRunning('host-a', new Set(['project-a']), { keepSessionIds: new Set(['waiting']) })).resolves.toBe(1);

    expect(commands).toHaveLength(1);
    expect(commands[0].args.slice(-1)).toEqual(['4200']);
  });

  it('rejects when a session outlives the wait, so nothing starts a second agent on its conversation', async () => {
    const { service } = serviceWithSnapshots([[session('stuck', 'project-a', 4100)]]);

    await expect(service.endSessionsLeftRunning('host-a', new Set(['project-a']), { timeoutMs: 20, pollMs: 5 })).rejects.toThrow('still running');
  });

  it.each([0, -1, 1])('rejects a record with pid %i and runs no command, since kill reads 0 and -1 as whole groups', async (pid) => {
    const { service, commands } = serviceWithSnapshots([[session('odd', 'project-a', pid)]]);

    await expect(service.endSessionsLeftRunning('host-a', new Set(['project-a']))).rejects.toThrow(`pid ${pid}`);

    expect(commands).toEqual([]);
  });

  it('rejects a pid that is not a whole number, and ends none of the others', async () => {
    const { service, commands } = serviceWithSnapshots([[session('fine', 'project-a', 4100), session('odd', 'project-a', Number.NaN)]]);

    await expect(service.endSessionsLeftRunning('host-a', new Set(['project-a']))).rejects.toThrow('cannot be ended');

    expect(commands).toEqual([]);
  });

  it('rejects when the host cannot be asked, and never reads that as nothing running', async () => {
    const { service } = serviceWithSnapshots([], {
      send: async () => { throw new Error('the link is down'); },
    });

    await expect(service.endSessionsLeftRunning('host-a', new Set(['project-a']))).rejects.toThrow('the link is down');
  });
});

describe('asking a host', () => {
  it('asks its helper once for its shell and describes a spawn by it', async () => {
    const { service, sent } = makeService();

    expect(await service.resolveRemote('host-a', '/home/dev/api')).toEqual({ hostId: 'host-a', cwd: '/home/dev/api', shellName: 'fish' });
    await service.resolveRemote('host-a', '/home/dev/other');

    expect(sent.filter((request) => request.op === 'helper')).toHaveLength(1);
  });

  it('asks again after the host is disconnected, because its shell may have changed', async () => {
    const { service, sent } = makeService();
    await service.hostInfo('host-a');
    await service.disconnect('host-a');
    await service.hostInfo('host-a');

    expect(sent.filter((request) => request.op === 'helper')).toHaveLength(2);
    expect(sent.some((request) => request.op === 'removeHost')).toBe(true);
  });

  it('never turns a failed ask into "absent"', async () => {
    const { service } = makeService({ send: vi.fn(async () => { throw new Error('the link is down'); }) });

    await expect(service.pathPresence('host-a', ['/home/dev/api'])).rejects.toThrow('the link is down');
  });

  it('names the helper call and the wait on a request the host never answered, for the launch report (Sentry DESKTOP-4N)', async () => {
    const unanswered = Object.assign(new Error('the host did not answer runCommand within 250 s'), { name: 'HostRequestUnansweredError', code: 'HOST_NO_ANSWER' });
    const { service } = makeService({ send: vi.fn(async () => { throw unanswered; }) });

    const rejected = await service.runCommand('host-a', { file: 'sh', args: [], timeoutMs: 240_000 }).then(() => null, (error: unknown) => error);

    expect(rejected).toBe(unanswered);
    expect(hostRequestWaitOf(rejected)).toMatchObject({ method: 'runCommand' });
    // Any other failure is passed on as it was.
    const other = new Error('the link is down');
    const { service: plain } = makeService({ send: vi.fn(async () => { throw other; }) });
    await expect(plain.pathPresence('host-a', ['/home/dev/api'])).rejects.toBe(other);
    expect(hostRequestWaitOf(other)).toBeNull();
  });

  it('never turns a failed read of the host\'s ports into "nothing is listening"', async () => {
    const { service } = makeService({ send: vi.fn(async () => { throw new Error('the link is down'); }) });

    await expect(service.listeningPorts('host-a')).rejects.toThrow('the link is down');
  });

  it('asks the link to wait past a command\'s own bound, so the host\'s answer gets back', async () => {
    const { service, sent } = makeService();

    await service.runCommand('host-a', { file: 'sh', args: [], timeoutMs: 600_000 });

    const request = sent.find((candidate) => candidate.op === 'helper');
    expect(request).toMatchObject({ method: 'runCommand' });
    expect(request?.op === 'helper' && request.timeoutMs).toBeGreaterThan(600_000);
  });
});

// Sentry DESKTOP-4N: a paused task opened 5 s after launch asked its host before the connect
// started at launch had added the link, and failed with a sentence that named the host's id.
describe('a request while the host is still connecting', () => {
  function connectingService(overrides: Partial<RemoteHostServiceDeps> = {}) {
    let finishInstall: (() => void) | null = null;
    let failInstall: ((error: Error) => void) | null = null;
    const made = makeService({
      install: () => new Promise((resolve, reject) => {
        finishInstall = () => resolve({ directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true });
        failInstall = reject;
      }),
      ...overrides,
    });
    return {
      ...made,
      finishInstall: () => finishInstall?.(),
      failInstall: (error: Error) => failInstall?.(error),
    };
  }

  // The router's refusal reaches main as a plain Error with this name, once its link is gone.
  function routerRefusal(): Error {
    const refusal = new Error(HOST_NOT_CONNECTED_SENTENCE);
    refusal.name = 'HostUnreachableError';
    return refusal;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the link to be added, then asks the host', async () => {
    const { service, sent, finishInstall } = connectingService();
    const connecting = service.connect('host-a');

    const asked = service.runCommand('host-a', { file: 'git', args: ['status'], timeoutMs: 5_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.some((request) => request.op === 'helper')).toBe(false);

    finishInstall();
    await connecting;
    await asked;

    expect(sent.map((request) => request.op)).toEqual(['addHost', 'helper']);
  });

  it('refuses with the host\'s name and its connect\'s own words when the connect fails, and asks nothing', async () => {
    const { service, sent, failInstall } = connectingService();
    const connecting = service.connect('host-a').catch(() => undefined);

    const asked = service.hostInfo('host-a');
    failInstall(new Error('ssh: connect to host lab.example.test port 22: Connection timed out'));
    await connecting;

    const refusal = await asked.then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(HostUnreachableError);
    expect((refusal as Error).message).toBe('Lab box is not connected: ssh: connect to host lab.example.test port 22: Connection timed out');
    expect((refusal as Error).message).not.toContain('host-a');
    expect(sent.some((request) => request.op === 'helper')).toBe(false);
  });

  it('waits no longer than its bound for a connect that never ends', async () => {
    vi.useFakeTimers();
    const { service, sent } = connectingService();
    void service.connect('host-a');

    const asked = service.pathPresence('host-a', ['/home/dev/api']).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(HOST_READY_WAIT_MS);

    const refusal = await asked;
    expect(refusal).toBeInstanceOf(HostUnreachableError);
    expect((refusal as Error).message).toBe('Lab box is still connecting.');
    expect(sent.some((request) => request.op === 'helper')).toBe(false);
  });

  it('refuses a request whose connect a disconnect overtook', async () => {
    const { service, sent, finishInstall } = connectingService();
    const connecting = service.connect('host-a');
    const asked = service.hostInfo('host-a').then(() => null, (error: unknown) => error);

    await service.disconnect('host-a');
    finishInstall();
    await connecting;

    const refusal = await asked;
    expect(refusal).toBeInstanceOf(HostUnreachableError);
    expect((refusal as Error).message).toBe('Lab box is not connected.');
    expect(sent.some((request) => request.op === 'helper')).toBe(false);
  });

  it('says a host with no link is not connected, by name, where the router knows no name', async () => {
    const refusalFromRouter = routerRefusal();
    const { service } = makeService({ send: vi.fn(async () => { throw refusalFromRouter; }) });

    const refusal = await service.runCommand('host-a', { file: 'git', args: [], timeoutMs: 5_000 }).then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(HostUnreachableError);
    expect((refusal as Error).message).toBe('Lab box is not connected.');
    expect((refusal as Error).cause).toBe(refusalFromRouter);
  });

  it('names why the last connect failed when the router finds no link', async () => {
    const { service } = makeService({
      install: async () => { throw new Error('Permission denied (publickey).'); },
      send: vi.fn(async () => { throw routerRefusal(); }),
    });
    await service.connect('host-a').catch(() => undefined);

    await expect(service.hostInfo('host-a')).rejects.toThrow('Lab box is not connected: Permission denied (publickey).');
  });

  /** A `send` that answers until `state.refuse` is set, then refuses as the router does for a host with no link. */
  function refusingSend() {
    const state = { refuse: false };
    const send = vi.fn(async (_request: RemoteHostRequest): Promise<unknown> => {
      if (state.refuse) throw routerRefusal();
      return { ok: true };
    });
    return { state, send };
  }

  const messageOfRefusal = (asked: Promise<unknown>): Promise<string | null> =>
    asked.then(() => null, (error: unknown) => (error as Error).message);

  describe('the reason a connect failed', () => {
    it('is not stored by a connect that failed after a disconnect overtook it', async () => {
      const { state, send } = refusingSend();
      const { service, failInstall } = connectingService({ send });
      const connecting = service.connect('host-a').catch(() => undefined);
      const asked = messageOfRefusal(service.hostInfo('host-a'));

      await service.disconnect('host-a');
      failInstall(new Error('ssh failed'));
      await connecting;
      await asked;

      state.refuse = true;
      expect(await messageOfRefusal(service.hostInfo('host-a'))).toBe('Lab box is not connected.');
    });

    it('is cleared by a later connect that succeeds', async () => {
      const { state, send } = refusingSend();
      const install = vi.fn()
        .mockRejectedValueOnce(new Error('Permission denied (publickey).'))
        .mockResolvedValue({ directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true });
      const { service } = makeService({ send, install });
      await service.connect('host-a').catch(() => undefined);
      state.refuse = true;
      expect(await messageOfRefusal(service.hostInfo('host-a'))).toBe('Lab box is not connected: Permission denied (publickey).');

      state.refuse = false;
      await service.connect('host-a');
      state.refuse = true;

      expect(await messageOfRefusal(service.hostInfo('host-a'))).toBe('Lab box is not connected.');
    });

    it('is cleared by a disconnect', async () => {
      const { state, send } = refusingSend();
      const { service } = makeService({ send, install: async () => { throw new Error('Permission denied (publickey).'); } });
      await service.connect('host-a').catch(() => undefined);

      await service.disconnect('host-a');
      state.refuse = true;

      expect(await messageOfRefusal(service.hostInfo('host-a'))).toBe('Lab box is not connected.');
    });

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ])('names every non-empty line of a failure with several (%s), so the cause after a warning and the passphrase prompt stay', async (_label, lineBreak) => {
      const failure = [
        'Could not read the host\'s details: Warning: Permanently added \'lab.example.test\' (ED25519) to the list of known hosts.',
        '  user@lab.example.test: Permission denied (publickey).',
        '',
        'Enter passphrase for key \'/home/dev/.ssh/id_ed25519\':',
      ].join(lineBreak);
      const { state, send } = refusingSend();
      const { service } = makeService({ send, install: async () => { throw new Error(failure); } });
      await service.connect('host-a').catch(() => undefined);
      state.refuse = true;

      expect(await messageOfRefusal(service.hostInfo('host-a'))).toBe(
        'Lab box is not connected: Could not read the host\'s details: Warning: Permanently added \'lab.example.test\' (ED25519) to the list of known hosts. '
        + 'user@lab.example.test: Permission denied (publickey). Enter passphrase for key \'/home/dev/.ssh/id_ed25519\':',
      );
    });
  });

  describe('a refusal for a host with no name', () => {
    const unnamedHosts: Array<[string, RemoteHostServiceDeps['hosts']]> = [
      ['a row with an empty name', { getById: () => host({ name: '' }), list: () => [] }],
      ['no row', { getById: () => undefined, list: () => [] }],
    ];

    it.each(unnamedHosts)('says only that the host is not connected for %s', async (_label, hosts) => {
      const { service } = makeService({ hosts, send: vi.fn(async () => { throw routerRefusal(); }) });

      expect(await messageOfRefusal(service.hostInfo('host-a'))).toBe('This host is not connected.');
      expect(HOST_NOT_CONNECTED_SENTENCE).toBe('This host is not connected.');
    });

    it.each(unnamedHosts)('puts the connect\'s reason after it for %s', async (_label, hosts) => {
      const { service } = makeService({
        hosts,
        send: vi.fn(async () => { throw routerRefusal(); }),
        install: async () => { throw new Error('Permission denied (publickey).'); },
      });
      await service.connect('host-a').catch(() => undefined);

      const message = await messageOfRefusal(service.hostInfo('host-a'));

      // With no row at all the connect itself is refused first, and that sentence is the reason.
      expect(message).toMatch(/^This host is not connected: (Permission denied \(publickey\)\.|That host is not set up in Kangentic\.)$/);
    });
  });

  function perCallInstalls() {
    const installs: Array<{ finish: () => void }> = [];
    const install = vi.fn((): Promise<InstalledHost> => new Promise((resolve) => {
      installs.push({ finish: () => resolve({ directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true }) });
    }));
    return { install, installs };
  }

  const installedHost: InstalledHost = { directory: '/home/dev/.kangentic/host/1.2.3', relayCommand: 'node relay.js', installed: true };

  /** Lets promise continuations run under fake timers without moving the clock. */
  async function flushPromises(): Promise<void> {
    for (let turn = 0; turn < 10; turn++) await vi.advanceTimersByTimeAsync(0);
  }

  describe('a Reconnect of a host that is already connected', () => {
    /** The first install succeeds, the second stays pending until `endSecond` is called. */
    function reconnectingService() {
      let rejectSecond: ((error: Error) => void) | null = null;
      const install = vi.fn()
        .mockResolvedValueOnce(installedHost)
        .mockImplementationOnce(() => new Promise<InstalledHost>((_resolve, reject) => { rejectSecond = reject; }));
      const made = makeService({ install });
      return { ...made, install, failSecond: (error: Error) => rejectSecond?.(error) };
    }

    it('sends a request on to the router when the Reconnect fails, and the router answers', async () => {
      const { service, sent, install, failSecond } = reconnectingService();
      await service.connect('host-a');
      const reconnect = service.connect('host-a').catch(() => undefined);
      await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2));

      const asked = service.hostInfo('host-a');
      failSecond(new Error('Permission denied (publickey).'));
      await reconnect;

      await expect(asked).resolves.toMatchObject({ shellName: 'fish' });
      expect(sent.some((request) => request.op === 'helper' && request.method === 'hostInfo')).toBe(true);
    });

    it('sends a request on to the router at the bound when the Reconnect never ends, rather than saying it is still connecting', async () => {
      vi.useFakeTimers();
      const { service, sent, install } = reconnectingService();
      await service.connect('host-a');
      void service.connect('host-a').catch(() => undefined);
      await flushPromises();
      expect(install).toHaveBeenCalledTimes(2);

      const asked = service.hostInfo('host-a').then((answer) => ({ answer }), (error: unknown) => ({ error }));
      await flushPromises();
      expect(sent.some((request) => request.op === 'helper')).toBe(false);
      await vi.advanceTimersByTimeAsync(HOST_READY_WAIT_MS);

      const outcome = await asked;
      expect(outcome).not.toHaveProperty('error');
      expect(outcome).toMatchObject({ answer: { shellName: 'fish' } });
      expect(sent.some((request) => request.op === 'helper' && request.method === 'hostInfo')).toBe(true);
    });
  });

  describe('writeFileRaw while the host is still connecting', () => {
    it('sends nothing until the link is added, then sends the write', async () => {
      const { service, sent, finishInstall } = connectingService();
      const connecting = service.connect('host-a');

      const asked = service.writeFileRaw('host-a', '/home/dev/x', 'body');
      await Promise.resolve();
      await Promise.resolve();
      expect(sent.some((request) => request.op === 'helper')).toBe(false);

      finishInstall();
      await connecting;
      await asked;

      const helperRequests = sent.filter((request) => request.op === 'helper');
      expect(helperRequests).toHaveLength(1);
      expect(helperRequests[0]).toMatchObject({ method: 'writeFileRaw', hostId: 'host-a', params: { path: '/home/dev/x' } });
    });

    it('names the host when the router finds no link', async () => {
      const { service } = makeService({ send: vi.fn(async () => { throw routerRefusal(); }) });

      const refusal = await service.writeFileRaw('host-a', '/home/dev/x', 'body').then(() => null, (error: unknown) => error);

      expect(refusal).toBeInstanceOf(HostUnreachableError);
      expect((refusal as Error).message).toBe('Lab box is not connected.');
    });
  });

  describe('the wait\'s bound', () => {
    it('counts from the request, so a Reconnect that starts later does not restart it', async () => {
      vi.useFakeTimers();
      const { install, installs } = perCallInstalls();
      const { service, sent } = makeService({ install });
      const dropped = service.connect('host-a');
      await service.disconnect('host-a');
      void service.connect('host-a').catch(() => undefined);
      const asked = service.hostInfo('host-a').then(() => null, (error: unknown) => (error as Error).message);

      await vi.advanceTimersByTimeAsync(10_000);
      installs[0].finish();
      await dropped;
      await flushPromises();
      expect(installs).toHaveLength(2);

      // Not yet at the bound since the request: 10 s were spent before the Reconnect began its install.
      await vi.advanceTimersByTimeAsync(HOST_READY_WAIT_MS - 10_000 - 1);
      let settled = false;
      void asked.then(() => { settled = true; });
      await flushPromises();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await asked).toBe('Lab box is still connecting.');
      expect(sent.some((request) => request.op === 'helper')).toBe(false);
    });

    it('is cleared once the request has waited for its connect', async () => {
      vi.useFakeTimers();
      const { service, finishInstall } = connectingService();
      const connecting = service.connect('host-a');
      const asked = service.hostInfo('host-a');
      await flushPromises();

      finishInstall();
      await connecting;
      await asked;

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('a Reconnect queued behind a dropped connect', () => {
    it('delivers a request made before it, one made after it and one made as the dropped connect ends, each only once the link is added', async () => {
      const { install, installs } = perCallInstalls();
      const { service, sent } = makeService({ install });
      const dropped = service.connect('host-a');
      const askedBefore = service.hostInfo('host-a');

      await service.disconnect('host-a');
      const reconnect = service.connect('host-a');
      const askedAfter = service.runCommand('host-a', { file: 'git', args: ['status'], timeoutMs: 5_000 });

      installs[0].finish();
      await dropped;
      // The dropped connect has ended and the Reconnect has not started its install yet.
      const askedBetween = service.pathPresence('host-a', ['/home/dev/api']);
      await vi.waitFor(() => expect(installs).toHaveLength(2));
      installs[1].finish();
      await reconnect;

      await expect(askedBefore).resolves.toMatchObject({ shellName: 'fish' });
      await expect(askedAfter).resolves.toEqual({ ok: true });
      await expect(askedBetween).resolves.toEqual({ ok: true });
      const operations = sent.map((request) => (request.op === 'helper' ? request.method : request.op));
      expect(operations.filter((operation) => operation !== 'removeHost' && operation !== 'addHost').sort()).toEqual(['hostInfo', 'pathPresence', 'runCommand']);
      // Every helper request went after the link was added, none ahead of it.
      expect(operations.indexOf('addHost')).toBe(1);
      expect(service.isConnected('host-a')).toBe(true);
    });

    it('is one reconnect however many connects ask for it', async () => {
      const { install, installs } = perCallInstalls();
      const { service } = makeService({ install });
      const dropped = service.connect('host-a');

      await service.disconnect('host-a');
      const firstAsk = service.connect('host-a');
      const secondAsk = service.connect('host-a');
      expect(secondAsk).toBe(firstAsk);

      installs[0].finish();
      await dropped;
      await vi.waitFor(() => expect(installs).toHaveLength(2));
      installs[1].finish();
      await Promise.all([firstAsk, secondAsk]);

      expect(install).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * A link joins whatever program already runs on the host, which an update of the app leaves older than the
 * app (task #1227). A method newer than that program is refused here with a sentence, never sent: the old
 * program would answer "unknown method".
 */
describe('a helper method the host program is too old for', () => {
  const withVersion = (version: string | null) => {
    const sent: RemoteHostRequest[] = [];
    const made = makeService({
      send: async (request) => {
        sent.push(request);
        if (request.op === 'helper' && request.method === 'programInfo') return { version, startedAt: '2026-11-27T00:00:00.000Z', liveSessions: 0, installedVersions: [] };
        if (request.op === 'helper' && request.method === 'retireIfIdle') return { retired: true, liveSessions: 0 };
        return { ok: true };
      },
    });
    return { service: made.service, sent };
  };

  it('is refused for a program older than the method, and sent once the program is new enough', async () => {
    const { service, sent } = withVersion('0.62.0');
    await service.programInfo('host-a');
    expect(service.supports('host-a', 'retireIfIdle')).toBe(false);
    expect(service.supports('host-a', 'runCommand')).toBe(true);
    await expect(service.retireIfIdle('host-a', 4000)).rejects.toThrow(/Lab box runs Kangentic's host program 0\.62\.0.*retireIfIdle needs 0\.65\.0/);
    expect(sent.filter((request) => request.op === 'helper' && request.method === 'retireIfIdle')).toEqual([]);

    const newer = withVersion('0.65.0');
    await newer.service.programInfo('host-a');
    await expect(newer.service.retireIfIdle('host-a', 4000)).resolves.toEqual({ retired: true, liveSessions: 0 });
    expect(newer.sent.find((request) => request.op === 'helper' && request.method === 'retireIfIdle')).toMatchObject({ params: { daemonPid: 4000 } });
  });

  it('says the host has not reported its version when nothing has asked yet, and sends nothing', async () => {
    const { service, sent } = withVersion('0.65.0');
    const refusal = await service.retireIfIdle('host-a', 4000).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    const message = (refusal as Error).message;
    expect(message).toMatch(/has not said which version.*retireIfIdle needs 0\.65\.0/);
    expect(message).not.toMatch(/runs Kangentic's host program/);
    expect(sent).toEqual([]);
  });

  it('counts a program not asked yet as the oldest the app talks to, and a development run as having every method', async () => {
    const { service } = withVersion(null);
    expect(service.supports('host-a', 'retireIfIdle')).toBe(false);
    expect(service.supports('host-a', 'programInfo')).toBe(true);
    await service.programInfo('host-a');
    expect(service.supports('host-a', 'retireIfIdle')).toBe(true);
  });

  it('forgets the version when the link drops or the host is disconnected', async () => {
    const { service } = withVersion('0.65.0');
    await service.programInfo('host-a');
    expect(service.programVersion('host-a')).toBe('0.65.0');
    service.forgetProgram('host-a');
    expect(service.programVersion('host-a')).toBeUndefined();
    await service.programInfo('host-a');
    await service.disconnect('host-a');
    expect(service.supports('host-a', 'retireIfIdle')).toBe(false);
  });
});

/**
 * Main's side of an SSH host (#913): the ssh options every connection starts with, the check on a
 * destination that could smuggle an ssh option, and the order connect runs in (install, then dial).
 *
 * What a user loses if it breaks: a prompt the app cannot show hanging a connection, a typed address
 * turning into an ssh option, or a host whose program was never installed being dialed anyway.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HostProgramMissingError,
  InvalidSshDestinationError,
  RemoteHostService,
  assertSafeDestination,
  sshArgsFor,
  type RemoteHostServiceDeps,
} from '../../src/main/remote/remote-host-service';
import type { SshHost } from '../../src/shared/types';
import type { RemoteHostRequest } from '../../src/main/remote/protocol/messages';

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

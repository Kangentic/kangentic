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

  it('gives every connection a connect timeout, so a host that is off fails in seconds', () => {
    const args = sshArgsFor(host());
    expect(args).toContain('ConnectTimeout=15');
    expect(args.at(-1)).toBe(host().destination);
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
});

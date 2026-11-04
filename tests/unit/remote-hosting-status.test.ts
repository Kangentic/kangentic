/**
 * The wiring from a link's own events to the state a host row and a project chip show (#913), through
 * the real `createRemoteHosting`: SessionManager emits `remote-link`, the book records it, and the
 * window is told. `host-status.test.ts` drives the book directly, which would pass whatever the event
 * is called, so this is the test that fails if the two ends stop agreeing.
 *
 * What a user loses if it breaks: every connected host reading "Connecting", then "Unreachable" 20
 * seconds later, with nothing wrong on the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const devPorts = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    leases: [] as Array<{ port: number; projectId: string }>,
    listeners,
    onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    notifyChanged: () => { for (const listener of listeners) listener(); },
  };
});
vi.mock('../../src/main/db/repositories/dev-port-repository', () => ({
  devPortRepository: { listAll: () => devPorts.leases, onChange: devPorts.onChange },
}));
vi.mock('../../src/main/remote/link/host-installer', () => ({
  installHost: async () => ({ directory: '/home/dev/.kangentic/host/1.0.0', relayCommand: 'node relay.js', installed: true }),
}));
vi.mock('../../src/main/remote/install-identity', () => ({ readInstallId: () => 'install-id-for-tests' }));
vi.mock('../../src/main/db/repositories/ssh-host-repository', () => ({
  SshHostRepository: class {
    list() { return [{ id: 'host-1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '' }]; }
    getById(id: string) { return this.list().find((host) => host.id === id); }
  },
}));

import { createRemoteHosting } from '../../src/main/remote/remote-hosting';
import { RemoteAgentUnsupportedError, resolveRemoteLaunch, setRemoteLaunchResolver } from '../../src/main/remote/remote-launch';
import * as path from 'node:path';

function makeSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    setRemoteSessionRelay: vi.fn(),
    remoteHostRequest: vi.fn(async (_request: unknown) => undefined),
    liveRemotePtys: vi.fn(() => []),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  devPorts.leases.length = 0;
  devPorts.listeners.clear();
});
afterEach(() => {
  vi.useRealTimers();
  setRemoteLaunchResolver(null);
});

describe('a link reporting its state', () => {
  it('moves the host to connected, and tells the window once per change', () => {
    const sessionManager = makeSessionManager();
    const changed: string[] = [];
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => ({ list: () => [] }),
      onHostsChanged: (hostId) => changed.push(hostId),
      log: () => undefined,
    });

    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connecting', detail: null });
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });

    expect(hosting.status.get('host-1')?.state).toBe('connected');
    expect(changed).toEqual(['host-1', 'host-1']);
    // A connected host is never promoted to unreachable by the clock.
    vi.advanceTimersByTime(60_000);
    expect(hosting.status.get('host-1')?.state).toBe('connected');
  });

  it('keeps the link\'s words when it drops and goes on retrying, and promotes it to unreachable after a while', () => {
    const sessionManager = makeSessionManager();
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => ({ list: () => [] }),
      log: () => undefined,
    });

    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'reconnecting', detail: 'ssh: connect to host lab port 22: Connection timed out' });
    expect(hosting.status.get('host-1')).toMatchObject({ state: 'reconnecting', detail: 'ssh: connect to host lab port 22: Connection timed out' });

    vi.advanceTimersByTime(21_000);
    expect(hosting.status.get('host-1')?.state).toBe('unreachable');

    // The link was retrying underneath the whole time, and its success clears the verdict.
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    expect(hosting.status.get('host-1')?.state).toBe('connected');
  });
});

describe('resolving a project path to its remote', () => {
  // An adapter with no remoteCliName makes the resolver throw once it has found a remote, so the throw
  // proves the project list lookup found the remote without needing a live host.
  const adapterWithoutRemoteCli = { name: 'claude', displayName: 'Claude Code', remoteCliName: undefined };
  const remoteProjectPath = path.resolve(path.join('mock', 'shells', 'Remote-Project'));
  const localProjectPath = path.resolve(path.join('mock', 'projects', 'local-project'));

  function hostingWithProjects() {
    return createRemoteHosting({
      sessionManager: makeSessionManager() as never,
      projects: () => ({
        list: () => [
          { id: 'project-remote', path: remoteProjectPath, remote: { hostId: 'host-1', path: '/home/dev/app' } },
          { id: 'project-local', path: localProjectPath, remote: null },
        ] as never,
      }),
      log: () => undefined,
    });
  }

  it('finds the remote of the project whose shell folder is the path, and none for a local project', async () => {
    hostingWithProjects();

    await expect(resolveRemoteLaunch({ projectPath: remoteProjectPath, cwd: remoteProjectPath, adapter: adapterWithoutRemoteCli }))
      .rejects.toBeInstanceOf(RemoteAgentUnsupportedError);
    await expect(resolveRemoteLaunch({ projectPath: localProjectPath, cwd: localProjectPath, adapter: adapterWithoutRemoteCli }))
      .resolves.toBeNull();
    await expect(resolveRemoteLaunch({ projectPath: path.resolve(path.join('mock', 'elsewhere')), cwd: localProjectPath, adapter: adapterWithoutRemoteCli }))
      .resolves.toBeNull();
  });

  it.runIf(process.platform === 'win32')('matches a remote project path regardless of letter case on Windows', async () => {
    hostingWithProjects();

    await expect(resolveRemoteLaunch({ projectPath: remoteProjectPath.toUpperCase(), cwd: remoteProjectPath, adapter: adapterWithoutRemoteCli }))
      .rejects.toBeInstanceOf(RemoteAgentUnsupportedError);
  });

  it.runIf(process.platform !== 'win32')('treats a path differing only in case as another folder off Windows', async () => {
    hostingWithProjects();

    await expect(resolveRemoteLaunch({ projectPath: remoteProjectPath.toUpperCase(), cwd: remoteProjectPath, adapter: adapterWithoutRemoteCli }))
      .resolves.toBeNull();
  });
});

describe('connecting a host', () => {
  it('records the failing step\'s own words as unreachable and does not throw', async () => {
    const sessionManager = makeSessionManager();
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => ({ list: () => [] }),
      // No host program in this build: the connect fails before any ssh.
      hostAsset: () => null,
      log: () => undefined,
    });

    await expect(hosting.connectHost('host-1')).resolves.toBeUndefined();

    expect(hosting.status.get('host-1')?.state).toBe('unreachable');
    expect(hosting.status.get('host-1')?.detail).toMatch(/program/i);
  });
});

describe('the links living in the pty host', () => {
  const asset = { version: '1.0.0', sha256: 'a'.repeat(64), arch: 'x64' as const, filePath: '/asset.tar.gz' };
  const remoteProject = { id: 'project-remote', path: 'mock-shell', remote: { hostId: 'host-1', path: '/home/dev/app' } };

  function hostingWithRemoteProject() {
    const sessionManager = makeSessionManager();
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => ({ list: () => [remoteProject] as never }),
      hostAsset: () => asset,
      log: () => undefined,
    });
    const requests = (): Array<{ op: string; hostId?: string; ports?: number[] }> =>
      sessionManager.remoteHostRequest.mock.calls.map((call) => call[0] as { op: string; hostId?: string; ports?: number[] });
    return { sessionManager, hosting, requests };
  }

  it('sends a connected host its link again, and every forward, when the pty host restarts', async () => {
    const { sessionManager, hosting, requests } = hostingWithRemoteProject();
    devPorts.leases.push({ port: 7300, projectId: 'project-remote' });
    await hosting.connectHost('host-1');
    devPorts.notifyChanged();
    await vi.advanceTimersByTimeAsync(150);
    expect(requests().filter((request) => request.op === 'addHost')).toHaveLength(1);
    expect(requests().filter((request) => request.op === 'setForwards')).toHaveLength(1);

    sessionManager.emit('pty-host-restarted');
    await vi.advanceTimersByTimeAsync(150);

    expect(requests().filter((request) => request.op === 'addHost' && request.hostId === 'host-1')).toHaveLength(2);
    expect(requests().filter((request) => request.op === 'setForwards')).toEqual([
      { op: 'setForwards', hostId: 'host-1', ports: [7300] },
      { op: 'setForwards', hostId: 'host-1', ports: [7300] },
    ]);
  });

  it('adds no link for a host that was never connected when the pty host restarts', async () => {
    const { sessionManager, requests } = hostingWithRemoteProject();

    sessionManager.emit('pty-host-restarted');
    await vi.advanceTimersByTimeAsync(150);

    expect(requests().filter((request) => request.op === 'addHost')).toEqual([]);
  });

  it('sends the host its wanted ports when a dev-port lease changes', async () => {
    const { requests } = hostingWithRemoteProject();
    expect(requests()).toEqual([]);

    devPorts.leases.push({ port: 7301, projectId: 'project-remote' }, { port: 7302, projectId: 'a-local-project' });
    devPorts.notifyChanged();
    await vi.advanceTimersByTimeAsync(150);

    expect(requests()).toEqual([{ op: 'setForwards', hostId: 'host-1', ports: [7301] }]);
  });
});

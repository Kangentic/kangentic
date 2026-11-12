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
const removedHosts = vi.hoisted(() => new Set<string>());
vi.mock('../../src/main/db/repositories/ssh-host-repository', () => ({
  SshHostRepository: class {
    list() { return [{ id: 'host-1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '' }].filter((host) => !removedHosts.has(host.id)); }
    getById(id: string) {
      return [{ id: 'host-1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '', removed_at: removedHosts.has(id) ? '2026-11-06T00:00:00.000Z' : null }].find((host) => host.id === id);
    }
  },
}));

import { createRemoteHosting } from '../../src/main/remote/remote-hosting';
import { RemoteHostService } from '../../src/main/remote/remote-host-service';
import { RemoteAgentUnsupportedError, RemoteHostRemovedError, resolveRemoteLaunch, setRemoteLaunchResolver } from '../../src/main/remote/remote-launch';
import { remoteGitRunnerFor, setRemoteGitResolver } from '../../src/main/git/remote-git';
import { listAgentsOnHost, resetAgentListForTests } from '../../src/main/agent/agent-list';
import * as path from 'node:path';

/** The project table: what a person picks from, and the rows that also include a removed host's. */
function projectsOf(visible: unknown[], hidden: unknown[] = []) {
  return { list: () => visible as never, listIncludingHidden: () => [...visible, ...hidden] as never };
}

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
  removedHosts.clear();
});
afterEach(() => {
  vi.useRealTimers();
  setRemoteLaunchResolver(null);
  setRemoteGitResolver(null);
});

describe('a link reporting its state', () => {
  it('moves the host to connected, and tells the window once per change', () => {
    const sessionManager = makeSessionManager();
    const changed: string[] = [];
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => projectsOf([]),
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
      projects: () => projectsOf([]),
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
      projects: () => projectsOf([
        { id: 'project-remote', path: remoteProjectPath, remote: { hostId: 'host-1', path: '/home/dev/app' } },
        { id: 'project-local', path: localProjectPath, remote: null },
      ]),
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

  it('hands a host file removal its expected text, or the host removes a file the user just changed', async () => {
    const removeFiles = vi.spyOn(RemoteHostService.prototype, 'removeFiles').mockResolvedValue({ removed: 1 });
    vi.spyOn(RemoteHostService.prototype, 'hostInfo').mockResolvedValue({ home: '/home/dev', shellName: 'bash' } as never);
    // A spawn asks the host whether the CLI is installed before it builds anything.
    vi.spyOn(RemoteHostService.prototype, 'runCommand').mockResolvedValue({ code: 0, stdout: 'claude 2.1.0', stderr: '', timedOut: false });
    hostingWithProjects();

    const launch = await resolveRemoteLaunch({
      projectPath: remoteProjectPath,
      cwd: remoteProjectPath,
      adapter: { name: 'claude', displayName: 'Claude Code', remoteCliName: 'claude' },
    });
    await launch?.place.files?.removeFiles(['/home/dev/app/.mcp.json'], { '/home/dev/app/.mcp.json': '{}' });

    expect(removeFiles).toHaveBeenCalledWith('host-1', ['/home/dev/app/.mcp.json'], { '/home/dev/app/.mcp.json': '{}' });
    vi.restoreAllMocks();
  });

  it('routes git for a remote project\'s worktree stand-in to its host, and leaves a local project to this computer', async () => {
    const runCommand = vi.spyOn(RemoteHostService.prototype, 'runCommand').mockResolvedValue({
      code: 0, stdout: 'KG:code:0\nKG:size:0\nKG:id:git-1-1\nKG:err:\nKG:out:', stderr: '', timedOut: false,
    });
    hostingWithProjects();

    const runner = remoteGitRunnerFor(path.join(remoteProjectPath, '.kangentic', 'worktrees', '7'));
    expect(runner).not.toBeNull();
    expect(remoteGitRunnerFor(localProjectPath)).toBeNull();

    await runner?.run(['status']);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toBe('host-1');
    expect(runCommand.mock.calls[0][1]).toMatchObject({ file: 'sh', cwd: '/home/dev/app/.kangentic/worktrees/7' });
    vi.restoreAllMocks();
  });

  describe('a project hidden because its host was removed', () => {
    const adapterWithRemoteCli = { name: 'claude', displayName: 'Claude Code', remoteCliName: 'claude' };

    function hostingWithHiddenProject() {
      removedHosts.add('host-1');
      return createRemoteHosting({
        sessionManager: makeSessionManager() as never,
        projects: () => projectsOf([], [{ id: 'project-remote', path: remoteProjectPath, remote: { hostId: 'host-1', path: '/home/dev/app' } }]),
        log: () => undefined,
      });
    }

    it('still reads as remote, and refuses a start in a sentence, so nothing runs in its empty folder on this computer', async () => {
      hostingWithHiddenProject();

      const start = resolveRemoteLaunch({ projectPath: remoteProjectPath, cwd: remoteProjectPath, adapter: adapterWithRemoteCli });

      await expect(start).rejects.toBeInstanceOf(RemoteHostRemovedError);
      await expect(start).rejects.toThrow('Lab');
    });

    it('asks its host for git, and never this computer, whose folder is only a stand-in', () => {
      hostingWithHiddenProject();

      expect(remoteGitRunnerFor(path.join(remoteProjectPath, '.kangentic', 'worktrees', '7'))).not.toBeNull();
    });
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
      projects: () => projectsOf([]),
      // No host program in this build: the connect fails before any ssh.
      hostAsset: () => null,
      log: () => undefined,
    });

    await expect(hosting.connectHost('host-1')).resolves.toBeUndefined();

    expect(hosting.status.get('host-1')?.state).toBe('unreachable');
    expect(hosting.status.get('host-1')?.detail).toMatch(/program/i);
  });
});

describe('a host whose setup fails because the network is down', () => {
  const NETWORK_DOWN = 'ssh exited with code 255: ssh: connect to host lab port 22: Connection timed out';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function hostingRecordingStates() {
    const states: string[] = [];
    let hosting: ReturnType<typeof createRemoteHosting> | null = null;
    hosting = createRemoteHosting({
      sessionManager: makeSessionManager() as never,
      projects: () => projectsOf([]),
      onHostsChanged: () => { states.push(hosting?.status.get('host-1')?.state ?? 'none'); },
      log: () => undefined,
    });
    return { hosting, states };
  }

  it('is tried again on its own at launch, and stays unreachable between the tries instead of flipping back to connecting', async () => {
    const { hosting, states } = hostingRecordingStates();
    const connect = vi.spyOn(RemoteHostService.prototype, 'connect')
      .mockRejectedValueOnce(new Error(NETWORK_DOWN))
      .mockRejectedValueOnce(new Error(NETWORK_DOWN))
      .mockResolvedValue(undefined);

    await hosting.connectAll();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(hosting.status.get('host-1')).toMatchObject({ state: 'unreachable', detail: NETWORK_DOWN });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connect).toHaveBeenCalledTimes(3);

    // One Connecting, for the first try. The retries kept the row as it was.
    expect(states.filter((state) => state === 'connecting')).toHaveLength(1);

    // Connected: nothing is scheduled any more.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('waits longer each time, up to a minute', async () => {
    const { hosting } = hostingRecordingStates();
    const connect = vi.spyOn(RemoteHostService.prototype, 'connect').mockRejectedValue(new Error(NETWORK_DOWN));

    await hosting.connectAll();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(connect).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(connect).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(6);
  });

  it('is not tried again when the sign-in was refused', async () => {
    const { hosting } = hostingRecordingStates();
    const connect = vi.spyOn(RemoteHostService.prototype, 'connect').mockRejectedValue(new Error('dev@lab: Permission denied (publickey).'));

    await hosting.connectAll();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(hosting.status.get('host-1')?.state).toBe('unreachable');
  });

  it('is not tried again once the host was removed meanwhile, or while its removal holds starts', async () => {
    const { hosting } = hostingRecordingStates();
    const connect = vi.spyOn(RemoteHostService.prototype, 'connect').mockRejectedValue(new Error(NETWORK_DOWN));

    await hosting.connectAll();
    removedHosts.add('host-1');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(connect).toHaveBeenCalledTimes(1);

    removedHosts.clear();
    await hosting.connectAll();
    hosting.holdStarts('host-1');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('is not retried behind the back of a person who pressed Reconnect, whose answer is that one attempt', async () => {
    const { hosting } = hostingRecordingStates();
    const connect = vi.spyOn(RemoteHostService.prototype, 'connect').mockRejectedValue(new Error(NETWORK_DOWN));

    await hosting.connectAll();
    await hosting.connectHost('host-1');
    expect(connect).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe('refusing starts while a host is being removed', () => {
  const projectPath = path.resolve(path.join('mock', 'shells', 'Held-Project'));
  // No remote CLI name: a start that gets past the removal check stops at this next refusal instead.
  const adapterWithoutRemoteCli = { name: 'claude', displayName: 'Claude Code', remoteCliName: undefined };

  function hostingWithProject() {
    return createRemoteHosting({
      sessionManager: makeSessionManager() as never,
      projects: () => projectsOf([{ id: 'project-remote', path: projectPath, remote: { hostId: 'host-1', path: '/home/dev/app' } }]),
      log: () => undefined,
    });
  }

  it('rejects a start for the host\'s project with the removal sentence while the hold is on, and goes on after the release', async () => {
    const hosting = hostingWithProject();
    const release = hosting.holdStarts('host-1');

    const held = resolveRemoteLaunch({ projectPath, cwd: projectPath, adapter: adapterWithoutRemoteCli });
    await expect(held).rejects.toBeInstanceOf(RemoteHostRemovedError);
    await expect(held).rejects.toThrow('Lab');

    release();
    await expect(resolveRemoteLaunch({ projectPath, cwd: projectPath, adapter: adapterWithoutRemoteCli }))
      .rejects.toBeInstanceOf(RemoteAgentUnsupportedError);
  });

  it('holds only the host named', async () => {
    const hosting = hostingWithProject();
    hosting.holdStarts('another-host');

    await expect(resolveRemoteLaunch({ projectPath, cwd: projectPath, adapter: adapterWithoutRemoteCli }))
      .rejects.toBeInstanceOf(RemoteAgentUnsupportedError);
  });
});

describe('a host\'s link coming back', () => {
  const projectPath = path.resolve(path.join('mock', 'shells', 'Probe-Project'));

  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentListForTests();
  });

  function hostingWithProject() {
    const sessionManager = makeSessionManager();
    createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => projectsOf([{ id: 'project-remote', path: projectPath, remote: { hostId: 'host-1', path: '/home/dev/app' } }]),
      log: () => undefined,
    });
    return sessionManager;
  }

  it('drops the host\'s agent list, so the next listing asks the host again', async () => {
    const sessionManager = hostingWithProject();
    const probe = vi.fn(async () => ({ status: 'missing' as const, version: null, detail: null }));
    await listAgentsOnHost('host-1', probe);
    const asked = probe.mock.calls.length;
    await listAgentsOnHost('host-1', probe);
    expect(probe).toHaveBeenCalledTimes(asked);

    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    await listAgentsOnHost('host-1', probe);

    expect(probe).toHaveBeenCalledTimes(asked * 2);
  });

  it('drops a found spawn probe, so the next start asks the host whether the CLI is still there', async () => {
    const sessionManager = hostingWithProject();
    vi.spyOn(RemoteHostService.prototype, 'hostInfo').mockResolvedValue({ home: '/home/dev', shellName: 'bash' } as never);
    const runCommand = vi.spyOn(RemoteHostService.prototype, 'runCommand').mockResolvedValue({ code: 0, stdout: 'claude 2.1.0', stderr: '', timedOut: false });
    const versionAsks = (): number => runCommand.mock.calls.filter((call) => call[1].args.includes('--version')).length;
    const adapter = { name: 'claude', displayName: 'Claude Code', remoteCliName: 'claude' };

    await resolveRemoteLaunch({ projectPath, cwd: projectPath, adapter });
    await resolveRemoteLaunch({ projectPath, cwd: projectPath, adapter });
    expect(versionAsks()).toBe(1);

    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    await resolveRemoteLaunch({ projectPath, cwd: projectPath, adapter });

    expect(versionAsks()).toBe(2);
  });
});

describe('the links living in the pty host', () => {
  const asset = { version: '1.0.0', sha256: 'a'.repeat(64), arch: 'x64' as const, filePath: '/asset.tar.gz' };
  const remoteProject = { id: 'project-remote', path: 'mock-shell', remote: { hostId: 'host-1', path: '/home/dev/app' } };

  function hostingWithRemoteProject() {
    const sessionManager = makeSessionManager();
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => projectsOf([remoteProject]),
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

  it('sends the wanted ports again when a host\'s link is made again, since dropping the link forgot them', async () => {
    const { hosting, requests } = hostingWithRemoteProject();
    devPorts.leases.push({ port: 7300, projectId: 'project-remote' });
    await hosting.connectHost('host-1');
    devPorts.notifyChanged();
    await vi.advanceTimersByTimeAsync(150);

    await hosting.hostService.disconnect('host-1');
    await hosting.connectHost('host-1');
    await vi.advanceTimersByTimeAsync(150);

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

describe('telling the app a host connected for the first time', () => {
  function hostingTellingUs() {
    const sessionManager = makeSessionManager();
    const connected: string[] = [];
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => projectsOf([]),
      onHostFirstConnected: (hostId) => connected.push(hostId),
      log: () => undefined,
    });
    return { sessionManager, connected, hosting };
  }

  it('says so again for a host that left and came back, whichever connection that turns out to be', () => {
    const { sessionManager, connected, hosting } = hostingTellingUs();
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    expect(connected).toEqual(['host-1']);

    hosting.expectFirstConnect('host-1');
    // The first dial after the re-add failed: a later Reconnect is what brings it up.
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connecting', detail: null });
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'reconnecting', detail: 'Connection refused' });
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });

    expect(connected).toEqual(['host-1', 'host-1']);
  });

  it('says so once per host per run, so a paused remote task resumes without a manual Resume', () => {
    const { sessionManager, connected } = hostingTellingUs();

    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connecting', detail: null });
    expect(connected).toEqual([]);
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    expect(connected).toEqual(['host-1']);

    // A drop and a return is the same run, and what was running never paused.
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'reconnecting', detail: null });
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    expect(connected).toEqual(['host-1']);

    sessionManager.emit('remote-link', { hostId: 'host-2', state: 'connected', detail: null });
    expect(connected).toEqual(['host-1', 'host-2']);
  });
});

describe('tidying old program versions on a host', () => {
  const asset = { version: '1.0.0', sha256: 'a'.repeat(64), arch: 'x64' as const, filePath: '/asset.tar.gz' };

  function hostingWith(hostAsset: (() => typeof asset) | undefined) {
    const sessionManager = makeSessionManager();
    createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => projectsOf([]),
      ...(hostAsset ? { hostAsset } : {}),
      log: () => undefined,
    });
    const prunes = (): unknown[] =>
      sessionManager.remoteHostRequest.mock.calls
        .map((call) => call[0] as { op: string; method?: string; params?: unknown })
        .filter((request) => request.op === 'helper' && request.method === 'pruneVersions')
        .map((request) => request.params);
    return { sessionManager, prunes };
  }

  it('asks a host to remove versions unused for a month, keeping this app\'s, once per run when its link first connects', async () => {
    const { sessionManager, prunes } = hostingWith(() => asset);

    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connecting', detail: null });
    expect(prunes()).toEqual([]);
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(prunes()).toEqual([{ keep: ['1.0.0'], olderThanDays: 30 }]);

    // A drop and a return is the same run: the host is not asked again.
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'reconnecting', detail: null });
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(prunes()).toHaveLength(1);
  });

  it('asks nothing of a host when this build carries no program version to keep', async () => {
    const { sessionManager, prunes } = hostingWith(undefined);
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(prunes()).toEqual([]);
  });

  it('records the failure and goes on when the host cannot be asked', async () => {
    const sessionManager = makeSessionManager();
    sessionManager.remoteHostRequest.mockRejectedValue(new Error('the link dropped'));
    const lines: string[] = [];
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => projectsOf([]),
      hostAsset: () => asset,
      log: (line) => lines.push(line),
    });
    sessionManager.emit('remote-link', { hostId: 'host-1', state: 'connected', detail: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(lines.some((line) => line.includes('could not tidy old program versions') && line.includes('the link dropped'))).toBe(true);
    expect(hosting.status.get('host-1')?.state).toBe('connected');
  });
});

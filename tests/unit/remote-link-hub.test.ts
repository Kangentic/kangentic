/**
 * The link hub (#913): several SSH hosts behind one `PtyHostTransport`, driven by the real
 * `PtyHostClient`. Two real helpers around the real `PtyHostCore` stand in for two hosts, over
 * in-memory pairs. A spawn names its host and everything after it follows the PTY or session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkHub } from '../../src/main/remote/link/link-hub';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostEvent } from '../../src/main/pty/host/protocol';
import { createFakeRendererPort, receivedOutput } from './helpers/fake-renderer-port';
import { dialHelper, makeHelperRig, settle, spawnParams, type HelperRig } from './helpers/remote-link-rig';

const FAST = { initialDelayMs: 100, maxDelayMs: 400 };
const teardown: Array<() => void> = [];

interface HubRig {
  hub: LinkHub;
  client: PtyHostClient;
  hosts: Record<string, HelperRig>;
  events: PtyHostEvent[];
}

function addHost(rig: HubRig, hostId: string, helper: HelperRig, installId = 'install-a'): void {
  rig.hosts[hostId] = helper;
  rig.hub.addHost(hostId, {
    identity: { installId, bootId: 'boot-1', label: 'a test computer' },
    connect: async () => dialHelper(helper),
    reconnect: FAST,
  });
  teardown.push(() => helper.helper.dispose());
}

function makeHubRig(hostIds: string[] = ['host-a', 'host-b']): HubRig {
  const hub = new LinkHub();
  const client = new PtyHostClient(hub);
  const rig: HubRig = { hub, client, hosts: {}, events: [] };
  client.setEventHandler((event) => rig.events.push(event));
  hostIds.forEach((hostId, index) => addHost(rig, hostId, makeHelperRig(1, { firstPid: 4242 + index * 100 })));
  teardown.push(() => { for (const hostId of hostIds) hub.removeHost(hostId); });
  return rig;
}

async function spawnOn(rig: HubRig, hostId: string, sessionId: string, taskId: string) {
  const spawning = rig.client.spawn(spawnParams(sessionId, taskId, hostId));
  await settle();
  const outcome = await spawning;
  if (!outcome.ok) throw outcome.error;
  return outcome.pty;
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  vi.useRealTimers();
});

describe('routing by host', () => {
  it('sends a spawn to the host it names and every later command to the same one', async () => {
    const rig = makeHubRig();
    await settle();
    const first = await spawnOn(rig, 'host-a', 's1', 'task-1');
    const second = await spawnOn(rig, 'host-b', 's2', 'task-2');
    // The host's pids (4242, 4342) name processes on another machine, so the handles carry none.
    expect(first.pid).toBeNull();
    expect(second.pid).toBeNull();
    expect(rig.hosts['host-a'].spawnPty).toHaveBeenCalledTimes(1);
    expect(rig.hosts['host-b'].spawnPty).toHaveBeenCalledTimes(1);

    first.write('to a');
    second.kill();
    await settle();
    expect(rig.hosts['host-a'].fakes[0].write).toHaveBeenCalledWith('to a');
    expect(rig.hosts['host-b'].fakes[0].write).not.toHaveBeenCalled();
    expect(rig.hosts['host-b'].fakes[0].kill).toHaveBeenCalledTimes(1);
    expect(rig.hosts['host-a'].fakes[0].kill).not.toHaveBeenCalled();
    expect(rig.hub.hostOfSession('s1')).toBe('host-a');
    expect(rig.hub.hostOfSession('s2')).toBe('host-b');
  });

  it('shows each session\'s output on a renderer port that has it in focus, whichever host it ran on', async () => {
    const rig = makeHubRig();
    const renderer = createFakeRendererPort();
    rig.hub.attachRendererPort(1, renderer.port);
    await settle();
    await spawnOn(rig, 'host-a', 's1', 'task-1');
    await spawnOn(rig, 'host-b', 's2', 'task-2');
    rig.client.post({ type: 'setRendererFocus', rendererId: 1, sessionIds: ['s1', 's2'] });
    await settle();

    rig.hosts['host-a'].fakes[0].feed('from a');
    rig.hosts['host-b'].fakes[0].feed('from b');
    await settle();
    expect(receivedOutput(renderer).filter((entry) => entry.sessionId === 's1').map((entry) => entry.data).join('')).toBe('from a');
    expect(receivedOutput(renderer).filter((entry) => entry.sessionId === 's2').map((entry) => entry.data).join('')).toBe('from b');
  });

  it('routes a session request, such as scrollback, to the session\'s host', async () => {
    const rig = makeHubRig();
    await settle();
    await spawnOn(rig, 'host-a', 's1', 'task-1');
    await spawnOn(rig, 'host-b', 's2', 'task-2');
    rig.hosts['host-b'].fakes[0].feed('only on b');
    await settle();

    const scrollback = rig.client.getScrollback('s2', false);
    await settle();
    expect(await scrollback).toContain('only on b');
  });

  it('fails a spawn that names no known host, with a sentence, and a request with no host to follow', async () => {
    const rig = makeHubRig(['host-a']);
    await settle();
    const unknown = await rig.client.spawn(spawnParams('s9', 'task-9', 'host-z'));
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.error.message).toContain('no connection set up for host host-z');
    const local = await rig.client.spawn(spawnParams('s8', 'task-8'));
    expect(local.ok).toBe(false);

    await expect(rig.hub.request('getDiagnostics', {})).rejects.toThrow('not available on a remote host');
    await expect(rig.hub.request('ping', {})).resolves.toBe('pong');
  });
});

describe('connection state', () => {
  it('reports a drop as a remoteLink event for that host only, never as an exit', async () => {
    const rig = makeHubRig();
    await settle();
    await spawnOn(rig, 'host-a', 's1', 'task-1');
    await spawnOn(rig, 'host-b', 's2', 'task-2');
    rig.events.length = 0;

    rig.hosts['host-a'].linkStreams.at(-1)?.destroy();
    await settle(10);
    const dropped = rig.events.filter((event) => event.type === 'remoteLink');
    expect(dropped).toEqual([expect.objectContaining({ type: 'remoteLink', hostId: 'host-a', state: 'reconnecting' })]);
    expect(rig.events.some((event) => event.type === 'exit')).toBe(false);
    expect(rig.hub.linkOf('host-b')?.state).toBe('connected');

    await settle(400);
    expect(rig.events.filter((event) => event.type === 'remoteLink').at(-1)).toMatchObject({ hostId: 'host-a', state: 'connected' });
    expect(rig.hosts['host-a'].helper.liveSessionCount).toBe(1);
  });

  it('forgets a removed host\'s routes and drops later commands for it without throwing', async () => {
    const rig = makeHubRig(['host-a']);
    await settle();
    const pty = await spawnOn(rig, 'host-a', 's1', 'task-1');
    rig.hub.removeHost('host-a');
    expect(rig.hub.hostOfSession('s1')).toBeNull();
    expect(() => pty.write('late')).not.toThrow();
    expect(rig.hosts['host-a'].fakes[0].write).not.toHaveBeenCalled();
    expect(rig.hosts['host-a'].helper.liveSessionCount).toBe(1);
  });

  it('hands a port attached before a host was added to that host too', async () => {
    const rig = makeHubRig([]);
    const renderer = createFakeRendererPort();
    rig.hub.attachRendererPort(1, renderer.port);
    addHost(rig, 'host-late', makeHelperRig(1));
    teardown.push(() => rig.hub.removeHost('host-late'));
    await settle();
    await spawnOn(rig, 'host-late', 's1', 'task-1');
    rig.client.post({ type: 'setRendererFocus', rendererId: 1, sessionIds: ['s1'] });
    await settle();
    rig.hosts['host-late'].fakes[0].feed('hello');
    await settle();
    expect(receivedOutput(renderer).map((entry) => entry.data).join('')).toBe('hello');
  });
});

describe('sessions and renderers the hub lets go of', () => {
  it('loses the PTY route of a session the host reports lost, so a later command no longer reaches that link', async () => {
    const hub = new LinkHub();
    const client = new PtyHostClient(hub);
    const firstHelper = makeHelperRig(1);
    // The host's helper restarts: the next dial reaches a new one that remembers no session.
    let current = firstHelper;
    hub.addHost('host-a', {
      identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
      connect: async () => dialHelper(current),
      reconnect: FAST,
    });
    teardown.push(() => hub.removeHost('host-a'), () => firstHelper.helper.dispose());
    await settle();
    const spawning = client.spawn(spawnParams('s1', 'task-1', 'host-a'));
    await settle();
    const outcome = await spawning;
    if (!outcome.ok) throw outcome.error;
    const write = { type: 'write', ptyId: outcome.pty.ptyId, data: 'before the loss' } as const;
    expect(hub.ownsCommand(write)).toBe(true);
    expect(hub.hostOfSession('s1')).toBe('host-a');

    const restartedHelper = makeHelperRig(1);
    teardown.push(() => restartedHelper.helper.dispose());
    current = restartedHelper;
    firstHelper.linkStreams.at(-1)?.destroy();
    await settle(600);

    expect(hub.hostOfSession('s1')).toBeNull();
    expect(hub.ownsCommand(write)).toBe(false);
    hub.post({ ...write, data: 'after the loss' });
    await settle();
    expect(restartedHelper.fakes[0].write).not.toHaveBeenCalled();
    expect(firstHelper.fakes[0].write).not.toHaveBeenCalledWith('after the loss');
  });

  it('gives a host added after a renderer was forgotten no focus for it, and a host added before it the last focus', async () => {
    const post = vi.spyOn(RemoteLink.prototype, 'post');
    const hub = new LinkHub();
    const addLink = (hostId: string): void => {
      const helper = makeHelperRig(1);
      teardown.push(() => helper.helper.dispose(), () => hub.removeHost(hostId));
      hub.addHost(hostId, { identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' }, connect: async () => dialHelper(helper), reconnect: FAST });
    };
    const focusPosts = (): unknown[] => post.mock.calls.map((call) => call[0]).filter((command) => command.type === 'setRendererFocus' && command.rendererId === 7);

    hub.post({ type: 'setRendererFocus', rendererId: 7, sessionIds: ['s1'] });
    addLink('host-a');
    expect(focusPosts()).toHaveLength(1);

    post.mockClear();
    hub.post({ type: 'forgetRenderer', rendererId: 7 });
    post.mockClear();
    addLink('host-b');

    expect(focusPosts()).toEqual([]);
    post.mockRestore();
    await settle();
  });
});

describe('quit', () => {
  it('lets go of every host and ends nothing: each agent keeps running for the next launch to take back', async () => {
    const rig = makeHubRig();
    await settle();
    await spawnOn(rig, 'host-a', 's1', 'task-1');
    await spawnOn(rig, 'host-b', 's2', 'task-2');

    rig.hub.shutdown();
    await settle(2_000);

    for (const hostId of ['host-a', 'host-b']) {
      expect(rig.hosts[hostId].fakes[0].kill).not.toHaveBeenCalled();
      expect(rig.hosts[hostId].fakes[0].write).not.toHaveBeenCalled();
      expect(rig.hosts[hostId].helper.snapshot().sessions.every((entry) => entry.alive)).toBe(true);
      expect(rig.hub.linkOf(hostId)?.state).toBe('stopped');
    }
  });
});

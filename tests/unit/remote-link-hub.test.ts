/**
 * The link hub (#913): several SSH hosts behind one `PtyHostTransport`, driven by the real
 * `PtyHostClient`. Two real helpers around the real `PtyHostCore` stand in for two hosts, over
 * in-memory pairs. A spawn names its host and everything after it follows the PTY or session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkHub } from '../../src/main/remote/link/link-hub';
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
  hostIds.forEach((hostId, index) => addHost(rig, hostId, makeHelperRig(1, 4242 + index * 100)));
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
    expect(first.pid).toBe(4242);
    expect(second.pid).toBe(4342);

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

describe('quit', () => {
  it('asks every host to suspend its own sessions, each with the plan the app gave', async () => {
    const rig = makeHubRig();
    await settle();
    await spawnOn(rig, 'host-a', 's1', 'task-1');
    await spawnOn(rig, 'host-b', 's2', 'task-2');
    rig.hub.linkOf('host-a')?.setQuitPlan(() => [{ sessionId: 's1', consoleCloseIsGraceful: true }]);
    rig.hub.linkOf('host-b')?.setQuitPlan(() => [{ sessionId: 's2', consoleCloseIsGraceful: true }]);

    rig.hub.shutdown();
    await settle();
    expect(rig.hosts['host-a'].fakes[0].kill).toHaveBeenCalledTimes(1);
    expect(rig.hosts['host-b'].fakes[0].kill).toHaveBeenCalledTimes(1);
  });
});

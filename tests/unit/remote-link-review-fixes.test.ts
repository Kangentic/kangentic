/**
 * Fixes a review pass made to the #913 SSH link, each pinned through the real hub, link and helper
 * over in-memory pairs: a repeat addHost keeps the live routes, a restarted hub rebinds the sessions
 * it is handed, a spawn that gets no answer is killed on its host, the helper refuses and ends spawns
 * that are still starting, and redialNow cuts a backoff short.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkHub } from '../../src/main/remote/link/link-hub';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import type { HelperServer } from '../../src/main/remote/helper/helper-server';
import type { HelperSessionRecord } from '../../src/main/remote/protocol/messages';
import { dialHelper, makeHelperRig, settle, spawnParams, type HelperRig } from './helpers/remote-link-rig';

const FAST = { initialDelayMs: 100, maxDelayMs: 400 };
const teardown: Array<() => void> = [];

function identity(bootId: string) {
  return { installId: 'install-a', bootId, label: 'a test computer' };
}

function addHostTo(hub: LinkHub, hostId: string, helper: HelperRig, bootId: string, sessions?: Array<{ sessionId: string; ptyId: number }>, requestTimeoutMs?: number): RemoteLink {
  const link = hub.addHost(hostId, {
    identity: identity(bootId),
    connect: async () => dialHelper(helper),
    reconnect: FAST,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  }, sessions);
  teardown.push(() => hub.removeHost(hostId));
  return link;
}

/** Holds every spawn the helper's core is asked for until `release` is called. */
function holdCoreSpawns(helper: HelperServer): { release(): void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = helper.core.handleRequest.bind(helper.core) as (method: string, params: unknown) => unknown;
  vi.spyOn(helper.core, 'handleRequest').mockImplementation((async (method: string, params: unknown) => {
    if (method === 'spawn') await gate;
    return original(method, params);
  }) as unknown as typeof helper.core.handleRequest);
  return { release };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LinkHub.addHost on a host it already has', () => {
  it('keeps the link and its routes, so later commands and session requests still reach the host', async () => {
    const hub = new LinkHub();
    const client = new PtyHostClient(hub);
    const helper = makeHelperRig(1);
    teardown.push(() => helper.helper.dispose());
    const first = addHostTo(hub, 'host-a', helper, 'boot-1');
    await settle();
    const spawning = client.spawn(spawnParams('s1', 'task-1', 'host-a'));
    await settle();
    const outcome = await spawning;
    if (!outcome.ok) throw outcome.error;

    const second = addHostTo(hub, 'host-a', helper, 'boot-1');
    await settle();
    expect(second).toBe(first);
    expect(hub.hostOfSession('s1')).toBe('host-a');

    outcome.pty.write('after the repeat add');
    helper.fakes[0].feed('still on the host');
    await settle();
    expect(helper.fakes[0].write).toHaveBeenCalledWith('after the repeat add');
    const scrollback = client.getScrollback('s1', false);
    await settle();
    expect(await scrollback).toContain('still on the host');
  });
});

describe('LinkHub.addHost for a new host with sessions it already holds', () => {
  it('rebinds them on connect, so a write to the old PTY id reaches the PTY on the host', async () => {
    const helper = makeHelperRig(1);
    teardown.push(() => helper.helper.dispose());

    const firstHub = new LinkHub();
    const firstClient = new PtyHostClient(firstHub);
    addHostTo(firstHub, 'host-a', helper, 'boot-1');
    await settle();
    const spawning = firstClient.spawn(spawnParams('s1', 'task-1', 'host-a'));
    await settle();
    const outcome = await spawning;
    if (!outcome.ok) throw outcome.error;
    const ptyId = outcome.pty.ptyId;
    firstHub.removeHost('host-a');
    await settle();

    // The process holding the links restarted: a new hub, a new boot id, the sessions main still holds.
    const secondHub = new LinkHub();
    const adoptable: HelperSessionRecord[][] = [];
    secondHub.setHandlers({ onAdoptable: (records) => adoptable.push(records) });
    addHostTo(secondHub, 'host-a', helper, 'boot-2', [{ sessionId: 's1', ptyId }]);
    await settle();

    expect(adoptable).toEqual([]);
    secondHub.post({ type: 'write', ptyId, data: 'typed after restart' });
    await settle();
    expect(helper.fakes[0].write).toHaveBeenCalledWith('typed after restart');
  });
});

describe('LinkHub.spawn when the host gives no answer', () => {
  it('sends that link a kill for the PTY, so the agent does not run on unowned', async () => {
    const hub = new LinkHub();
    const helper = makeHelperRig(1);
    teardown.push(() => helper.helper.dispose());
    const held = holdCoreSpawns(helper.helper);
    addHostTo(hub, 'host-a', helper, 'boot-1', undefined, 200);
    await settle();

    const wireParams = { ...spawnParams('s1', 'task-1', 'host-a'), ptyId: 41, sentAtMs: Date.now() };
    const spawning = hub.request('spawn', wireParams);
    const rejection = expect(spawning).rejects.toThrow('did not answer spawn');
    await settle(300);
    await rejection;
    expect(hub.hostOfSession('s1')).toBeNull();

    // The core now answers: the helper must already know the spawn was killed, and end the PTY.
    held.release();
    await settle();
    expect(helper.fakes[0].kill).toHaveBeenCalledTimes(1);
    expect(helper.helper.liveSessionCount).toBe(0);
  });
});

describe('HelperServer spawns that are still starting', () => {
  async function connectedLink(helper: HelperRig): Promise<RemoteLink> {
    const link = new RemoteLink({ identity: identity('boot-1'), connect: async () => dialHelper(helper), reconnect: FAST });
    teardown.push(() => link.stop());
    link.start();
    await settle();
    return link;
  }

  function spawnOver(link: RemoteLink, sessionId: string, taskId: string, ptyId: number) {
    return link.request('spawn', { ...spawnParams(sessionId, taskId), ptyId, sentAtMs: Date.now() });
  }

  it('refuses a second spawn for the same task before the first has answered', async () => {
    const helper = makeHelperRig(2);
    teardown.push(() => helper.helper.dispose());
    const held = holdCoreSpawns(helper.helper);
    const link = await connectedLink(helper);

    const first = spawnOver(link, 's1', 'task-1', 1);
    const second = spawnOver(link, 's2', 'task-1', 2);
    await settle();
    const refused = await second;
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error.code).toBe('SPAWN_REFUSED_LIVE');

    held.release();
    await settle();
    expect((await first).ok).toBe(true);
    expect(helper.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('ends a spawn that was killed while it started, and never ledgers it alive', async () => {
    const helper = makeHelperRig(1);
    teardown.push(() => helper.helper.dispose());
    const held = holdCoreSpawns(helper.helper);
    const link = await connectedLink(helper);

    const spawning = spawnOver(link, 's1', 'task-1', 1);
    await settle();
    link.post({ type: 'kill', ptyId: 1 });
    await settle();
    held.release();
    await settle();
    expect((await spawning).ok).toBe(true);

    expect(helper.fakes[0].kill).toHaveBeenCalledTimes(1);
    expect(helper.helper.liveSessionCount).toBe(0);
    expect(helper.helper.snapshot().sessions.filter((record) => record.alive)).toEqual([]);
  });

  it('ends a spawn that was still starting when a suspendAll for the current epoch arrived', async () => {
    const helper = makeHelperRig(1);
    teardown.push(() => helper.helper.dispose());
    const held = holdCoreSpawns(helper.helper);
    const link = await connectedLink(helper);

    const spawning = spawnOver(link, 's1', 'task-1', 1);
    await settle();
    const suspended = await link.requestHelper('suspendAll', { ownerEpoch: helper.helper.snapshot().ownerEpoch, sessions: [] });
    expect(suspended).toMatchObject({ ignored: false, suspended: 1 });
    held.release();
    await settle();
    await spawning;

    expect(helper.fakes[0].kill).toHaveBeenCalledTimes(1);
    expect(helper.helper.liveSessionCount).toBe(0);
  });
});

describe('RemoteLink.redialNow', () => {
  it('dials again at once instead of waiting out the backoff', async () => {
    const connect = vi.fn(async () => { throw new Error('host unreachable'); });
    const link = new RemoteLink({ identity: identity('boot-1'), connect, reconnect: { initialDelayMs: 60_000, maxDelayMs: 600_000 } });
    teardown.push(() => link.stop());
    link.start();
    await settle(10);
    expect(connect).toHaveBeenCalledTimes(1);

    await settle(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
    link.redialNow();
    await settle(10);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

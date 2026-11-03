/**
 * A PTY on a remote host has no pid on this machine (#913). The helper answers a spawn with a pid on
 * ITS host; keeping it would let the quit drain, a kill, a wait or the lost-host cleanup signal an
 * unrelated process here (0 names Kangentic's own process group, -1 every process the user owns).
 *
 * Red-green: pass `result.pid` for a hostId spawn in `PtyHostClient.spawn`, or let `takeLiveHandles`
 * take a remote handle, and the matching test below fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { PTY_HOST_LOST_EXIT_CODE, PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostLifecycleListener, PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import { spawnParams } from './helpers/remote-link-rig';

function fakeTransport(spawnedPid: number) {
  let lifecycle: PtyHostLifecycleListener | undefined;
  const stopLostPtyTree = vi.fn();
  const transport: PtyHostTransport = {
    post: () => undefined,
    attachRendererPort: () => undefined,
    request: (async () => ({ ok: true, pid: spawnedPid })) as unknown as PtyHostTransport['request'],
    setEventListener: () => undefined,
    setLifecycleListener: (listener) => { lifecycle = listener; },
    stopLostPtyTree,
    hostPid: 1234,
    shutdown: () => undefined,
  };
  return { client: new PtyHostClient(transport), stopLostPtyTree, loseHost: () => lifecycle?.onHostDown() };
}

describe('the pid of a PTY handle', () => {
  it('is the real pid for a PTY on this machine', async () => {
    const { client } = fakeTransport(4321);
    const outcome = await client.spawn(spawnParams('local-1', 'task-1'));
    expect(outcome.ok && outcome.pty.pid).toBe(4321);
  });

  it('is null for a PTY on a remote host, whatever pid the host answered', async () => {
    const { client } = fakeTransport(4321);
    const outcome = await client.spawn(spawnParams('remote-1', 'task-1', 'host-a'));
    expect(outcome.ok && outcome.pty.pid).toBeNull();
  });
});

describe('a local pty host that dies', () => {
  it('ends its own PTYs and stops their trees, and leaves a remote PTY running', async () => {
    const { client, stopLostPtyTree, loseHost } = fakeTransport(4321);
    const lostSessions: string[][] = [];
    client.setLifecycleHandler({ onHostLost: (ids) => lostSessions.push(ids), onHostRestarted: () => undefined });

    const local = await client.spawn(spawnParams('local-1', 'task-1'));
    const remote = await client.spawn(spawnParams('remote-1', 'task-2', 'host-a'));
    if (!local.ok || !remote.ok) throw new Error('spawn failed');
    const localExit = vi.fn();
    const remoteExit = vi.fn();
    client.onPtyExit(local.pty.ptyId, localExit);
    client.onPtyExit(remote.pty.ptyId, remoteExit);

    loseHost();

    expect(localExit).toHaveBeenCalledWith(PTY_HOST_LOST_EXIT_CODE);
    expect(stopLostPtyTree).toHaveBeenCalledTimes(1);
    expect(stopLostPtyTree).toHaveBeenCalledWith(4321);
    expect(remoteExit).not.toHaveBeenCalled();
    expect(remote.pty.hasExited).toBe(false);
    expect(lostSessions).toEqual([['local-1']]);
  });
});

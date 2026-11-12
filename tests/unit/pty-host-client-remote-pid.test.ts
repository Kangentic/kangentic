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
import type { PtyHostEvent } from '../../src/main/pty/host/protocol';
import { spawnParams } from './helpers/remote-link-rig';

function fakeTransport(spawnedPid: number, request?: PtyHostTransport['request']) {
  let lifecycle: PtyHostLifecycleListener | undefined;
  let eventListener: ((event: PtyHostEvent) => void) | undefined;
  const stopLostPtyTree = vi.fn();
  const transport: PtyHostTransport = {
    post: () => undefined,
    attachRendererPort: () => undefined,
    request: request ?? (async () => ({ ok: true, pid: spawnedPid })) as unknown as PtyHostTransport['request'],
    setEventListener: (listener) => { eventListener = listener; },
    setLifecycleListener: (listener) => { lifecycle = listener; },
    stopLostPtyTree,
    hostPid: 1234,
    shutdown: () => undefined,
  };
  return { client: new PtyHostClient(transport), stopLostPtyTree, loseHost: () => lifecycle?.onHostDown(), emit: (event: PtyHostEvent) => eventListener?.(event) };
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

describe('a remote request', () => {
  /** A `run_script` on a host runs for minutes, and the transport's own 15 s default would fail it while it still ran. */
  it('waits as long as the link does when the request names a wait, and past it, so the link answers first', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const { client } = fakeTransport(4321, request as unknown as PtyHostTransport['request']);

    await client.remote({ op: 'helper', hostId: 'host-a', method: 'runCommand', params: {}, timeoutMs: 600_000 });

    const options = (request.mock.calls[0] as unknown[])[2] as { timeoutMs: number };
    expect(options.timeoutMs).toBeGreaterThan(600_000);
  });

  it('keeps the transport default for a request that names none', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const { client } = fakeTransport(4321, request as unknown as PtyHostTransport['request']);

    await client.remote({ op: 'helper', hostId: 'host-a', method: 'hostInfo', params: {} });

    expect((request.mock.calls[0] as unknown[])[2]).toBeUndefined();
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

describe('liveRemotePtys', () => {
  it('lists exactly the live routes of the host asked, not another host, a local PTY or an exited one', async () => {
    const { client, emit } = fakeTransport(4321);
    const firstOnA = await client.spawn(spawnParams('a-1', 'task-1', 'host-a'));
    const exitedOnA = await client.spawn(spawnParams('a-2', 'task-2', 'host-a'));
    const secondOnA = await client.spawn(spawnParams('a-3', 'task-3', 'host-a'));
    const onB = await client.spawn(spawnParams('b-1', 'task-4', 'host-b'));
    const local = await client.spawn(spawnParams('local-1', 'task-5'));
    if (!firstOnA.ok || !exitedOnA.ok || !secondOnA.ok || !onB.ok || !local.ok) throw new Error('spawn failed');

    emit({ type: 'exit', ptyId: exitedOnA.pty.ptyId, exitCode: 0 } as PtyHostEvent);

    expect(client.liveRemotePtys('host-a')).toEqual([
      { sessionId: 'a-1', ptyId: firstOnA.pty.ptyId },
      { sessionId: 'a-3', ptyId: secondOnA.pty.ptyId },
    ]);
    expect(client.liveRemotePtys('host-b')).toEqual([{ sessionId: 'b-1', ptyId: onB.pty.ptyId }]);
    expect(client.liveRemotePtys('host-c')).toEqual([]);
  });
});

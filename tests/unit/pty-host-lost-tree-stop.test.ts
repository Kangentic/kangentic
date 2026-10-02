/**
 * When the pty host dies, main stops the process tree each of its PTYs left
 * behind, by pid, before it reports the PTY exited and before recovery resumes
 * the session on the new host. A closed pseudo console (Windows) or a hangup
 * (POSIX) usually ends the agent a PTY ran, but nothing guarantees it, and one
 * left running would go on editing its worktree beside the resumed session.
 *
 * Only a transport whose PTYs can outlive their host implements the stop
 * (`stopLostPtyTree`: the utility process). The in-process host the other unit
 * tests run has none, so the made-up pids their fakes answer with are never
 * signalled on the machine running them.
 *
 * Red-green: drop the `stopTree` calls in `PtyHostClient.reportHostLost` and the
 * first and last tests fail.
 */

import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostLifecycleListener, PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostEvent } from '../../src/main/pty/host/protocol';
import { killChildTreeByPid } from '../../src/main/shared/child-tree-stop';

type SpawnParams = Parameters<PtyHostClient['spawn']>[0];
type RawSpawnOptions = Parameters<PtyHostClient['spawnRaw']>[2];

/** A host that answers each spawn with the next pid, and can be killed. */
function fakeHost(pids: number[], stopLostPtyTree?: (pid: number) => void) {
  let deliver: (event: PtyHostEvent) => void = () => undefined;
  let lifecycle: PtyHostLifecycleListener | null = null;
  const request = ((method: string) => (method === 'spawn' || method === 'spawnRaw'
    ? Promise.resolve({ ok: true, pid: pids.shift() })
    : Promise.reject(new Error('no requests here')))) as PtyHostTransport['request'];
  const transport: PtyHostTransport = {
    post: () => undefined,
    request,
    setEventListener: (listener) => { deliver = listener; },
    setLifecycleListener: (listener) => { lifecycle = listener; },
    hostPid: 1234,
    shutdown: () => undefined,
    ...(stopLostPtyTree ? { stopLostPtyTree } : {}),
  };
  const client = new PtyHostClient(transport);
  return {
    client,
    emit: (event: PtyHostEvent) => deliver(event),
    hostDown: () => lifecycle?.onHostDown(),
  };
}

const sessionParams = (sessionId: string): SpawnParams => ({ sessionId, cols: 80, rows: 24 }) as unknown as SpawnParams;
const rawOptions = { cwd: '/work', cols: 80, rows: 24, env: {} } as unknown as RawSpawnOptions;

async function spawnSession(client: PtyHostClient, sessionId: string): Promise<number> {
  const outcome = await client.spawn(sessionParams(sessionId));
  if (!outcome.ok) throw outcome.error;
  return outcome.pty.ptyId;
}

describe('a pty host that dies with PTYs running', () => {
  it('stops each live PTY\'s tree by pid, a probe\'s included, before reporting it exited, and leaves one that had exited', async () => {
    const stopped: number[] = [];
    const host = fakeHost([501, 502, 503], (pid) => stopped.push(pid));
    const liveId = await spawnSession(host.client, 'session-live');
    const exitedId = await spawnSession(host.client, 'session-exited');
    await host.client.spawnRaw('claude', [], rawOptions);
    host.emit({ type: 'exit', ptyId: exitedId, exitCode: 0 } as PtyHostEvent);

    let stoppedWhenReported: number[] | null = null;
    host.client.onPtyExit(liveId, () => { stoppedWhenReported = [...stopped]; });
    host.hostDown();

    expect(stopped.sort()).toEqual([501, 503]);
    // The tree was stopped before the session heard of its PTY's exit.
    expect(stoppedWhenReported).toContain(501);
  });

  it('reports the loss and signals nothing when the transport has no stop, as the in-process host has none', async () => {
    const host = fakeHost([601]);
    await spawnSession(host.client, 'session-a');
    const lost = vi.fn();
    host.client.setLifecycleHandler({ onHostLost: lost, onHostRestarted: () => undefined });

    expect(() => host.hostDown()).not.toThrow();
    expect(lost).toHaveBeenCalledWith(['session-a']);
  });

  it('stops an agent the dead host left running', async () => {
    // Stand-in for the orphaned agent: a real process this test owns.
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    const orphanExited = new Promise<void>((resolve) => orphan.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve) => orphan.once('spawn', () => resolve()));
      const host = fakeHost([orphan.pid ?? 0], (pid) => killChildTreeByPid(pid));
      await spawnSession(host.client, 'session-orphan');

      host.hostDown();

      await orphanExited;
      expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
    } finally {
      // A stop path that regressed must not leave this process running past
      // the test: it never exits on its own. A no-op once it has exited.
      orphan.kill('SIGKILL');
    }
  }, 20_000);
});

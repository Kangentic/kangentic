/**
 * A task reap waits for a PTY of its task that kill() parked and that has not
 * exited yet (src/main/pty/session-manager.ts, reapTaskProcesses). Until that
 * PTY exits, the pty host holds it and protects it and everything under it, so
 * a Done move made right after a young session was stopped would otherwise
 * leave the agent's children running. The wait is bounded.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (message: string) => message }));

import { SessionManager } from '../../src/main/pty/session-manager';
import { KILL_GRACE_MS, type DeferredKillRegistry } from '../../src/main/pty/lifecycle/deferred-kill';
import type { PtyHandle } from '../../src/main/pty/host/pty-host-client';
import type { TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const EMPTY: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, entries: [] };

function setup() {
  const manager = new SessionManager();
  const order: string[] = [];
  const reapTaggedProcesses = vi.fn(async () => {
    order.push('host-reap');
    return EMPTY;
  });
  Object.assign((manager as unknown as { host: { reapTaggedProcesses: unknown } }).host, { reapTaggedProcesses });
  const deferredKills = (manager as unknown as { deferredKills: DeferredKillRegistry }).deferredKills;
  const park = (sessionId: string) => deferredKills.schedule({
    sessionId,
    taskId: TASK,
    ptyRef: { pid: 4242, kill: vi.fn(), write: vi.fn() } as unknown as PtyHandle,
    pid: 4242,
  });
  return { manager, order, reapTaggedProcesses, park };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Wall-clock wait that works under fake timers: `setImmediate` and `Date` stay real. */
async function realDelay(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
}

describe('reapTaskProcesses waits for a parked PTY of its task', () => {
  it('scans only after the parked PTY has exited', async () => {
    const { manager, order, park } = setup();
    park('sess-parked');
    const reaping = manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    order.push('exit');
    manager.emit('exit', 'sess-parked', 0, true);
    await reaping;
    expect(order).toEqual(['exit', 'host-reap']);
  });

  it('does not wait when nothing of the task is parked', async () => {
    const { manager, reapTaggedProcesses } = setup();
    const startedAt = Date.now();
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(KILL_GRACE_MS);
  });

  it('gives up at its bound when the exit never arrives, and reaps anyway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager, reapTaggedProcesses, park } = setup();
    park('sess-stuck');
    const reaping = manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    // Real time for the directory lookup's real I/O, so a reap that did not
    // wait would have reached the host by now.
    await realDelay(150);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 1500 - 1);
    await realDelay(50);
    expect(reapTaggedProcesses).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await reaping;
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
  });
});

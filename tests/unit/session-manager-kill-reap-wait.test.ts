/**
 * kill() followed by a task reap, through a real manager and the mock PTY
 * (src/main/pty/session-manager.ts). kill() parks a young session's PTY on the
 * deferred-kill grace and tags the parked entry with the session's task;
 * reapTaskProcesses waits for that task's parked PTYs to exit before it calls
 * the pty host. Until a PTY exits the host protects it and everything under it,
 * so a reap that did not wait would leave the agent's children running.
 *
 * session-reap-parked-exit.test.ts parks the PTY by hand on the registry. This
 * file is the other half: the task id reaches the registry through the real
 * kill(). Same mock prelude as session-manager-deferred-kill.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';
import { KILL_GRACE_MS } from '../../src/main/pty/lifecycle/deferred-kill';

const EXIT_SEQUENCE = ['\x03', '/exit\r'];
/** A task id the reap accepts: a task tag value must be a UUID. */
const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const EMPTY_REAP: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] };

let tmpDir: string;
const managers: SessionManager[] = [];

/**
 * The same controllable mock PTY the deferred-kill suite uses. With
 * `exitOnKill: false` a kill leaves the process running until the test calls
 * `triggerExit`, the ConPTY that takes a while to report its exit.
 */
function createMockPty(pid = 12345, options: { exitOnKill?: boolean } = {}) {
  const exitOnKill = options.exitOnKill ?? true;
  let exitHandler: ((exitEvent: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid,
    cols: 120,
    rows: 30,
    onData: vi.fn(),
    onExit: vi.fn((callback: (exitEvent: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitOnKill && exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };

  return {
    mockPty,
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

/** A manager whose pty host reports every reap it is asked for, in `order`. */
function createManager(order: string[]) {
  const manager = new SessionManager();
  managers.push(manager);
  const reapTaggedProcesses = vi.fn(async () => {
    order.push('host-reap');
    return EMPTY_REAP;
  });
  Object.assign((manager as unknown as { host: { reapTaggedProcesses: unknown } }).host, { reapTaggedProcesses });
  return { manager, reapTaggedProcesses };
}

async function spawnTaskSession(manager: SessionManager, ptyOptions: { exitOnKill?: boolean } = {}) {
  const mock = createMockPty(12345, ptyOptions);
  vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
  const session = await manager.spawn({ taskId: TASK, command: '', cwd: tmpDir, exitSequence: EXIT_SEQUENCE });
  return { session, ...mock };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kill-reap-wait-'));
});

afterEach(() => {
  // A test that installed fake timers and failed before restoring them.
  vi.useRealTimers();
  // Flushes a PTY still parked by a test that failed before its exit, so no
  // grace timer outlives the test.
  for (const manager of managers.splice(0)) manager.killAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kill() then reapTaskProcesses', () => {
  it('reaches the host only after the PTY kill() parked has exited', async () => {
    const order: string[] = [];
    const { manager, reapTaggedProcesses } = createManager(order);
    const { session, mockPty, triggerExit } = await spawnTaskSession(manager);
    manager.on('exit', (exitedSessionId: string) => {
      if (exitedSessionId === session.id) order.push('exit');
    });

    manager.kill(session.id);
    // A young session: its PTY is parked on the grace, not killed.
    expect(mockPty.kill).not.toHaveBeenCalled();

    const reaping = manager.reapTaskProcesses(tmpDir, [{ id: TASK, worktreePath: null }], { stop: true });
    // A fixed wait, on purpose: the absence of a host call cannot be polled. A
    // reap that did not wait reaches the host after one directory lookup, a few
    // milliseconds. A slow machine can only make broken wiring pass this check,
    // never make working wiring fail it.
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(reapTaggedProcesses).not.toHaveBeenCalled();

    triggerExit(0);
    await reaping;
    expect(order).toEqual(['exit', 'host-reap']);
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
  });

  it('has nothing to wait for after a kill that parks nothing, so the same reap reaches the host', async () => {
    // The counterpart that keeps the test above from passing vacuously: in this
    // fixture the reap does reach the host quickly when no PTY is parked.
    const order: string[] = [];
    const { manager, reapTaggedProcesses } = createManager(order);
    const { session } = await spawnTaskSession(manager);

    manager.kill(session.id, { immediate: true });
    await manager.reapTaskProcesses(tmpDir, [{ id: TASK, worktreePath: null }], { stop: true });

    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
  });

  it('still waits for the exit when the deferred force-kill already fired, until the PTY reports it', async () => {
    // The parked listing outlives the force-kill timer: the process can take a
    // while longer to go after the kill, and until it does the host protects it
    // and everything under it. So a reap that arrives AFTER the timer fired must
    // still wait, and only the exit releases it.
    const order: string[] = [];
    const { manager, reapTaggedProcesses } = createManager(order);
    // A kill that does not end the process by itself.
    const { session, mockPty, triggerExit } = await spawnTaskSession(manager, { exitOnKill: false });
    manager.on('exit', (exitedSessionId: string) => {
      if (exitedSessionId === session.id) order.push('exit');
    });

    // Timers are faked only for the grace: after the spawn, before kill() arms
    // its force-kill, and restored before anything that does real I/O.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      manager.kill(session.id);
      expect(mockPty.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 1);
    } finally {
      vi.useRealTimers();
    }
    // The force-kill fired first, and the PTY has not exited.
    await vi.waitFor(() => { expect(mockPty.kill).toHaveBeenCalled(); });
    expect(order).toEqual([]);

    const reaping = manager.reapTaskProcesses(tmpDir, [{ id: TASK, worktreePath: null }], { stop: true });
    // A fixed wait, on purpose: the absence of a host call cannot be polled. A
    // reap that did not wait reaches the host after one directory lookup, a few
    // milliseconds. A slow machine can only make broken wiring pass this check,
    // never make working wiring fail it.
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(reapTaggedProcesses).not.toHaveBeenCalled();

    triggerExit(0);
    await reaping;
    expect(order).toEqual(['exit', 'host-reap']);
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting through its own force-kill when the reap began inside the grace', async () => {
    // The other order: the reap starts while the PTY is still parked and the
    // timer fires under it. The wait is bounded by the grace plus 1500 ms, so it
    // must still be open just after the force-kill, and the exit that follows
    // releases it.
    const order: string[] = [];
    const { manager, reapTaggedProcesses } = createManager(order);
    const { session, mockPty, triggerExit } = await spawnTaskSession(manager, { exitOnKill: false });
    manager.on('exit', (exitedSessionId: string) => {
      if (exitedSessionId === session.id) order.push('exit');
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    manager.kill(session.id);
    const reaping = manager.reapTaskProcesses(tmpDir, [{ id: TASK, worktreePath: null }], { stop: true });
    try {
      // Past the force-kill, well inside the reap's own wait. The reap's bound
      // is a fake timer too, so a bound shorter than the grace fires here.
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 1);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => { expect(mockPty.kill).toHaveBeenCalled(); });
    // Real wait, as above: a reap that went on after the timer would be at the host by now.
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(reapTaggedProcesses).not.toHaveBeenCalled();

    triggerExit(0);
    await reaping;
    expect(order).toEqual(['exit', 'host-reap']);
  });
});

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

const EXIT_SEQUENCE = ['\x03', '/exit\r'];
/** A task id the reap accepts: a task tag value must be a UUID. */
const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const EMPTY_REAP: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, entries: [] };

let tmpDir: string;
const managers: SessionManager[] = [];

/** The same controllable mock PTY the deferred-kill suite uses. */
function createMockPty(pid = 12345) {
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
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
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

async function spawnTaskSession(manager: SessionManager) {
  const mock = createMockPty();
  vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
  const session = await manager.spawn({ taskId: TASK, command: '', cwd: tmpDir, exitSequence: EXIT_SEQUENCE });
  return { session, ...mock };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kill-reap-wait-'));
});

afterEach(() => {
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
});

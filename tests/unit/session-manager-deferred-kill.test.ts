/**
 * SessionManager.kill()'s grace for young sessions, end to end through a real
 * manager and the mock PTY: the exit sequence lands, `session.pty` is nulled at
 * once, the force-kill waits KILL_GRACE_MS, a natural exit inside the grace
 * cancels it, the two maturity bounds and the `immediate` option restore the
 * instant kill, and killAll() reports what it parked or flushed.
 *
 * session-manager.test.ts pins isYoungSession to false so the rest of the
 * suite keeps today's instant-kill fixtures; this file is where the grace is
 * exercised for real. Same mock prelude as that file.
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
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type { AgentParser } from '../../src/shared/types';
import { SharedFolderHolds } from '../../src/main/agent/shared/shared-folder-holds';
import {
  KILL_GRACE_MS,
  YOUNG_AFTER_ALT_SCREEN_MS,
  YOUNG_SINCE_SPAWN_MS,
} from '../../src/main/pty/lifecycle/deferred-kill';
import { AGENT_EXIT_REQUEST_TIMEOUT_MS, type AgentExitWaitResult } from '../../src/main/pty/host/exited-root-wait';
import { createFakeRendererPort } from './helpers/fake-renderer-port';

const EXIT_SEQUENCE = ['\x03', '/exit\r'];

let tmpDir: string;

/** The same controllable mock PTY session-manager.test.ts uses. */
function createMockPty(pid = 12345) {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((exitEvent: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid,
    cols: 120,
    rows: 30,
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback;
    }),
    onExit: vi.fn((callback: (exitEvent: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      mockPty.cols = cols;
      mockPty.rows = rows;
    }),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };

  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

function registryRow(manager: SessionManager, sessionId: string): ManagedSession | undefined {
  return (manager as unknown as { registry: { get(id: string): ManagedSession | undefined } }).registry.get(sessionId);
}

/**
 * Returns a spy on the PTY handle that kill() parks on the deferred-kill
 * registry. The force-kill timer calls this handle, so a test whose PTY has
 * already exited asserts on the spy, not on the raw PTY mock. The raw mock
 * miscounts there in two ways. On Windows the host releases a PTY that exited
 * on its own with a kill of its own (releaseExitedPty), so the raw mock counts
 * a kill no timer made. And a timer that fires after the exit never reaches
 * the raw mock on any platform, because the handle throws ESRCH and
 * safeKillPty swallows it.
 *
 * Call it before kill(), which nulls the row's pty.
 */
function spyOnParkedHandleKill(manager: SessionManager, sessionId: string) {
  const handle = registryRow(manager, sessionId)?.pty;
  if (!handle) throw new Error('expected the spawned session to hold a PTY handle');
  return vi.spyOn(handle, 'kill');
}

async function spawnSession(manager: SessionManager, taskId: string, pid?: number) {
  const mock = createMockPty(pid);
  vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
  const session = await manager.spawn({ taskId, command: '', cwd: tmpDir, exitSequence: EXIT_SEQUENCE });
  return { session, ...mock };
}

/** Everything the PTY was asked to write after a given call count. */
function writesAfter(mockPty: { write: ReturnType<typeof vi.fn> }, callCount: number): string[] {
  return mockPty.write.mock.calls.slice(callCount).map((call) => call[0] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-deferred-kill-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kill() on a young session', () => {
  it('writes the exit sequence, nulls the pty at once, and force-kills only after the grace', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-young');
    const writesBefore = mockPty.write.mock.calls.length;

    manager.kill(session.id);

    expect(writesAfter(mockPty, writesBefore)).toEqual(EXIT_SEQUENCE);
    expect(registryRow(manager, session.id)?.pty).toBeNull();
    expect(mockPty.kill).not.toHaveBeenCalled();
    // The row stays running until the process actually exits, which is what
    // lets kill -> awaitExit -> remove wait for it.
    expect(manager.getSession(session.id)?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    expect(mockPty.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockPty.kill).toHaveBeenCalledTimes(1);

    manager.killAll();
  });

  it('closes a young session at once, typing nothing, when its agent exits gracefully on a console close', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-close-graceful');
    const row = registryRow(manager, session.id);
    if (!row) throw new Error('expected the spawned row');
    row.consoleCloseIsGraceful = true;
    const parkedKill = spyOnParkedHandleKill(manager, session.id);
    const writesBefore = mockPty.write.mock.calls.length;

    manager.kill(session.id);

    expect(writesAfter(mockPty, writesBefore)).toEqual([]);
    expect(parkedKill).toHaveBeenCalledTimes(1);
    expect(registryRow(manager, session.id)?.pty).toBeNull();
    // Nothing parked: a quit right after reports no deferred kill.
    expect(manager.killAll().deferredCount).toBe(0);
  });

  it('reads the agent\'s console-close answer at spawn, for this platform', async () => {
    const manager = new SessionManager();
    const consoleCloseIsGraceful = vi.fn((platform: NodeJS.Platform) => platform === process.platform);
    vi.mocked(pty.spawn).mockReturnValue(createMockPty().mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-close-flag',
      command: '',
      cwd: tmpDir,
      exitSequence: EXIT_SEQUENCE,
      agentParser: { detectFirstOutput: () => false, removeHooks: () => {}, runtime: {}, consoleCloseIsGraceful } as unknown as AgentParser,
    });
    expect(consoleCloseIsGraceful).toHaveBeenCalledWith(process.platform);
    expect(registryRow(manager, session.id)?.consoleCloseIsGraceful).toBe(true);
    manager.killAll();
  });

  it('no-ops write() and resize() while the parked PTY is still exiting', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-noop');
    manager.kill(session.id);
    const writesAfterKill = mockPty.write.mock.calls.length;

    manager.write(session.id, 'stray keystrokes');
    manager.resize(session.id, 80, 24);

    expect(mockPty.write.mock.calls.length).toBe(writesAfterKill);
    expect(mockPty.resize).not.toHaveBeenCalledWith(80, 24);
    manager.killAll();
  });

  it('tags the eventual exit intentional, so the renderer shows no crash toast', async () => {
    const manager = new SessionManager();
    const { session } = await spawnSession(manager, 'task-intent');
    const exits: unknown[][] = [];
    manager.on('exit', (...args: unknown[]) => exits.push(args));

    manager.kill(session.id);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 1);

    const exit = exits.find((call) => call[0] === session.id);
    expect(exit).toBeDefined();
    expect(exit![2]).toBe(true);
  });

  it('cancels the force-kill when the PTY exits on its own inside the grace', async () => {
    const manager = new SessionManager();
    const { session, triggerExit } = await spawnSession(manager, 'task-natural');
    // Counted on the parked handle, for the reason spyOnParkedHandleKill gives.
    const handleKill = spyOnParkedHandleKill(manager, session.id);

    manager.kill(session.id);
    triggerExit(0);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);

    expect(handleKill).not.toHaveBeenCalled();
    expect(manager.getSession(session.id)?.status).toBe('exited');
  });

  it('keeps the grace through remove(): the row goes at once, the PTY exits later', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-remove');

    manager.remove(session.id);

    expect(manager.getSession(session.id)).toBeUndefined();
    expect(mockPty.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(mockPty.kill).toHaveBeenCalledTimes(1);
  });

  it('lets kill -> awaitExit -> remove resolve only once the process has exited', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-await');

    manager.kill(session.id);
    let settled = false;
    const exited = manager.awaitExit(session.id).then(() => { settled = true; });
    manager.remove(session.id);

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    expect(settled).toBe(false);
    // The mock's kill fires onExit on a 0 ms timer; the 'exit' it emits is
    // what awaitExit was waiting on, even though the row is already gone.
    await vi.advanceTimersByTimeAsync(2);
    await exited;
    expect(settled).toBe(true);
    expect(mockPty.kill).toHaveBeenCalledTimes(1);
  });

  it('resolves awaitExit and cancels the deferred kill when the PTY exits naturally after remove()', async () => {
    // The previous test covers the TIMER path: the deferred kill's own
    // schedule() fires and the mock's kill() call raises onExit. This one
    // covers the PTY exiting on its own inside the grace, AFTER remove() has
    // already deleted the row - the case kill()'s `session.ptyDisposables =
    // undefined` line is meant to protect.
    //
    // Walking remove() (detachAndDelete, registry.delete, clearSessionCaches)
    // shows none of them read session.ptyDisposables today, so with THIS
    // mock (whose onExit returns no functional disposable - dispose() would
    // throw on undefined and be swallowed) that line's effect is not
    // independently observable through remove(). Its real target is a
    // different caller: killAllSessions' synchronous quit-path loop
    // (session-shutdown.ts) also reads session.ptyDisposables per row and
    // would dispose it a second time - early, ahead of the grace - were it
    // still set after this session's row got parked. That path is exercised
    // by the killAll() tests below, not this one.
    //
    // What IS the observable contract the design promises, and what this
    // test pins: the spawn flow's onExit listener stays attached through
    // remove(), so a natural exit still reaches the manager's 'exit' event,
    // which is what resolves awaitExit and cancels the force-kill timer.
    const manager = new SessionManager();
    const { session, triggerExit } = await spawnSession(manager, 'task-natural-after-remove');
    // Counted on the parked handle, for the reason spyOnParkedHandleKill gives.
    const handleKill = spyOnParkedHandleKill(manager, session.id);

    manager.kill(session.id);
    let settled = false;
    const exited = manager.awaitExit(session.id).then(() => { settled = true; });
    manager.remove(session.id);

    triggerExit(0);
    await exited;
    expect(settled).toBe(true);

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
    expect(handleKill).not.toHaveBeenCalled();
  });
});

describe('suspend() and awaitExit() on a session whose console close is the agent\'s graceful exit', () => {
  // A close ends the shell at once and the agent a moment later, still inside
  // its SessionEnd hooks and transcript writes. The PTY's exit is the shell's,
  // so a suspend or awaitExit that stopped there would let a resume, a handoff's
  // transcript read or a folder move overlap the agent. The host's ledger of
  // task roots knows when the agent is gone (`awaitAgentExit`), so both ask it.
  //
  // The host's answer is held shut by hand, so a caller that did not wait for it
  // is visible: it would have resolved long before the gate opens.
  //
  // Red-green, per assertion:
  //  - dropping the `consoleCloseIsGraceful` field from gracefulPtyShutdown's
  //    input in suspend() makes the suspend type the keys and wait out its 1500 ms
  //    grace (the sync kill and no-writes assertions fail);
  //  - dropping the `awaitAgentExitOf` line after it resolves the suspend before
  //    the gate opens (the pending assertion fails);
  //  - reading the row inside the `.then` in awaitExit, instead of up front,
  //    loses the task id once the caller's remove() has deleted the row (the
  //    awaitAgentExit call never happens);
  //  - dropping the `consoleCloseIsGraceful !== true` early return in awaitExit
  //    makes the no-flag cases ask the host.

  function markCloseGraceful(manager: SessionManager, sessionId: string): void {
    const row = registryRow(manager, sessionId);
    if (!row) throw new Error('expected the spawned row');
    row.consoleCloseIsGraceful = true;
  }

  /** A host `awaitAgentExit` the test answers by hand. */
  function gatedAgentExit(manager: SessionManager) {
    const pendingAnswers: Array<(result: AgentExitWaitResult) => void> = [];
    const awaitAgentExit = vi.fn((_taskIds: string[], _timeoutMs: number) => new Promise<AgentExitWaitResult>((resolve) => { pendingAnswers.push(resolve); }));
    Object.assign((manager as unknown as { host: { awaitAgentExit: unknown } }).host, { awaitAgentExit });
    return {
      awaitAgentExit,
      /** The agent is gone: answers every ask made so far. */
      answer: () => {
        for (const resolve of pendingAnswers) resolve({ found: [], stillRunning: [], waitedMs: 0 });
      },
    };
  }

  describe('suspend()', () => {
    it('closes at once, types nothing, and resolves only once the host reports the agent has exited', async () => {
      const manager = new SessionManager();
      const { session, mockPty } = await spawnSession(manager, 'task-suspend-graceful');
      markCloseGraceful(manager, session.id);
      const gate = gatedAgentExit(manager);
      const handleKill = spyOnParkedHandleKill(manager, session.id);
      const writesBefore = mockPty.write.mock.calls.length;

      let settled = false;
      const suspending = manager.suspend(session.id).then(() => { settled = true; });

      // The close lands in the same tick: no keys, no wait for a natural exit.
      expect(handleKill).toHaveBeenCalledTimes(1);
      expect(writesAfter(mockPty, writesBefore)).toEqual([]);

      // The mock raises the PTY's exit on a 0 ms timer; the shell is gone, so the
      // suspend now asks the host about the agent.
      await vi.advanceTimersByTimeAsync(1);
      expect(gate.awaitAgentExit).toHaveBeenCalledTimes(1);
      expect(gate.awaitAgentExit).toHaveBeenCalledWith([session.taskId], AGENT_EXIT_REQUEST_TIMEOUT_MS);

      // Well past every timer the suspend owns of its own (the 1500 ms kill
      // propagation, the scrollback scan's bound): only the host's answer holds it.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);

      gate.answer();
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 3);
      await suspending;
      expect(settled).toBe(true);
      expect(manager.getSession(session.id)?.status).toBe('suspended');
    });

    it('types the exit keys and never asks the host for the agent when the close is not graceful', async () => {
      const manager = new SessionManager();
      const { session, mockPty, triggerExit } = await spawnSession(manager, 'task-suspend-typed');
      const gate = gatedAgentExit(manager);
      const writesBefore = mockPty.write.mock.calls.length;

      const suspending = manager.suspend(session.id);

      // Typed into, and given its grace to exit by itself before any kill.
      expect(writesAfter(mockPty, writesBefore)).toEqual(EXIT_SEQUENCE);
      expect(mockPty.kill).not.toHaveBeenCalled();

      triggerExit(0);
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 3);
      await suspending;

      expect(gate.awaitAgentExit).not.toHaveBeenCalled();
      expect(manager.getSession(session.id)?.status).toBe('suspended');
    });
  });

  describe('awaitExit()', () => {
    it('waits for the PTY, then for the agent under the task id it read when called, though the caller removed the row', async () => {
      const manager = new SessionManager();
      const { session } = await spawnSession(manager, 'task-await-graceful');
      markCloseGraceful(manager, session.id);
      const gate = gatedAgentExit(manager);

      // The documented caller order: kill, capture the wait, THEN remove.
      manager.kill(session.id);
      let settled = false;
      const exited = manager.awaitExit(session.id).then(() => { settled = true; });
      manager.remove(session.id);
      expect(manager.getSession(session.id)).toBeUndefined();

      // The shell has not exited yet, so the agent is not asked about.
      expect(gate.awaitAgentExit).not.toHaveBeenCalled();

      // The mock raises the PTY's exit on a 0 ms timer, and that exit, not the
      // 10 s safety timeout, is what moves awaitExit on to the agent.
      await vi.advanceTimersByTimeAsync(1);
      expect(gate.awaitAgentExit).toHaveBeenCalledTimes(1);
      expect(gate.awaitAgentExit).toHaveBeenCalledWith(['task-await-graceful'], AGENT_EXIT_REQUEST_TIMEOUT_MS);

      // Past awaitExit's own 10 s safety timeout: only the host's answer holds it.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(settled).toBe(false);

      gate.answer();
      await exited;
      expect(settled).toBe(true);
    });

    it('resolves on the PTY\'s exit alone and never asks the host for the agent when the close is not graceful', async () => {
      const manager = new SessionManager();
      const { session } = await spawnSession(manager, 'task-await-typed');
      const gate = gatedAgentExit(manager);

      // immediate: a young session's kill would otherwise park its PTY for the grace.
      manager.kill(session.id, { immediate: true });
      const exited = manager.awaitExit(session.id);
      manager.remove(session.id);

      await vi.advanceTimersByTimeAsync(1);
      await exited;

      expect(gate.awaitAgentExit).not.toHaveBeenCalled();
    });
  });
});

describe('the maturity bounds', () => {
  it('kills at once 12 s after the first alt-screen frame', async () => {
    const manager = new SessionManager();
    const { session, mockPty, feedData } = await spawnSession(manager, 'task-alt');

    feedData('\x1b[?1049h');
    expect(registryRow(manager, session.id)?.altScreenEnteredAt).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(YOUNG_AFTER_ALT_SCREEN_MS);
    const writesBefore = mockPty.write.mock.calls.length;

    manager.kill(session.id);

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
    expect(writesAfter(mockPty, writesBefore)).toEqual([]);
    manager.killAll();
  });

  it('still defers 11 s after the first alt-screen frame', async () => {
    const manager = new SessionManager();
    const { session, mockPty, feedData } = await spawnSession(manager, 'task-alt-young');

    feedData('\x1b[?1049h');
    await vi.advanceTimersByTimeAsync(YOUNG_AFTER_ALT_SCREEN_MS - 1_000);

    manager.kill(session.id);

    expect(mockPty.kill).not.toHaveBeenCalled();
    manager.killAll();
  });

  it('stamps only the FIRST alt-screen entry, so a re-entry cannot re-open the window', async () => {
    const manager = new SessionManager();
    const { session, feedData } = await spawnSession(manager, 'task-alt-once');

    feedData('\x1b[?1049h');
    const first = registryRow(manager, session.id)?.altScreenEnteredAt;
    await vi.advanceTimersByTimeAsync(5_000);
    feedData('\x1b[?1049l');
    feedData('\x1b[?1049h');

    expect(registryRow(manager, session.id)?.altScreenEnteredAt).toBe(first);
    manager.killAll();
  });

  it('kills at once 60 s after spawn when no alt-screen frame was ever seen', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-old');

    await vi.advanceTimersByTimeAsync(YOUNG_SINCE_SPAWN_MS);
    manager.kill(session.id);

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
    manager.killAll();
  });

  it('kills at once with { immediate: true } whatever the age', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-immediate');
    const writesBefore = mockPty.write.mock.calls.length;

    manager.kill(session.id, { immediate: true });

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
    expect(writesAfter(mockPty, writesBefore)).toEqual([]);
    manager.killAll();
  });
});

describe('killAll() and the parked PTYs', () => {
  it('without grace, flushes a parked PTY now and reports it as a plain kill', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-flush', 4242);
    const handleKill = spyOnParkedHandleKill(manager, session.id);
    manager.kill(session.id);
    expect(mockPty.kill).not.toHaveBeenCalled();

    const report = manager.killAll();

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ pids: [4242], killedCount: 1, deferredCount: 0 });
    // Counted on the handle. A timer the flush left armed would fire after the
    // exit, and only the handle sees a kill made then.
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
    expect(handleKill).toHaveBeenCalledTimes(1);
  });

  it('with grace, leaves a parked PTY on its timer and counts it as deferred', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-parked', 4242);
    manager.kill(session.id);

    const report = manager.killAll({ allowGrace: true });

    expect(report).toEqual({ pids: [4242], killedCount: 1, deferredCount: 1 });
    expect(mockPty.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(mockPty.kill).toHaveBeenCalledTimes(1);
  });

  it('with grace, parks a running young session instead of killing it, and kills a mature one at once', async () => {
    const manager = new SessionManager();
    const mature = await spawnSession(manager, 'task-mature', 1111);
    await vi.advanceTimersByTimeAsync(YOUNG_SINCE_SPAWN_MS);
    const young = await spawnSession(manager, 'task-young', 2222);
    const youngWritesBefore = young.mockPty.write.mock.calls.length;

    const report = manager.killAll({ allowGrace: true });

    expect(report).toEqual({ pids: [1111, 2222], killedCount: 2, deferredCount: 1 });
    expect(mature.mockPty.kill).toHaveBeenCalledTimes(1);
    expect(young.mockPty.kill).not.toHaveBeenCalled();
    expect(writesAfter(young.mockPty, youngWritesBefore)).toEqual(EXIT_SEQUENCE);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(young.mockPty.kill).toHaveBeenCalledTimes(1);
  });

  it('dispose() leaves a parked PTY alone: it runs right after killAll() on the quit path', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-dispose', 4242);
    manager.killAll({ allowGrace: true });

    manager.dispose();

    expect(mockPty.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(mockPty.kill).toHaveBeenCalledTimes(1);
    expect(session.id).toBeTruthy();
  });
});

describe('killAll() and dispose() with a utility pty host', () => {
  /** The manager's transport, made to look like a utility host with a pid. */
  function asUtilityHost(manager: SessionManager, hostPid: number) {
    const transport = (manager as unknown as { host: { transport: { hostPid: number | null; shutdown: (exitWaitMs?: number) => void } } }).host.transport;
    Object.defineProperty(transport, 'hostPid', { value: hostPid });
    return vi.spyOn(transport, 'shutdown');
  }

  it('adds the host to the drain as one more kill, and bounds its wait inside the extended deadline', async () => {
    const manager = new SessionManager();
    await spawnSession(manager, 'task-young', 2222);
    const shutdown = asUtilityHost(manager, 9999);

    const report = manager.killAll({ allowGrace: true });
    manager.dispose();

    expect(report).toEqual({ pids: [2222, 9999], killedCount: 2, deferredCount: 1 });
    // Drain deadline 1500 + the 1500 grace, less the 200 margin.
    expect(shutdown).toHaveBeenCalledWith(2800);
  });

  it('bounds the host\'s wait inside the base deadline when nothing was deferred', async () => {
    const manager = new SessionManager();
    await spawnSession(manager, 'task-mature', 1111);
    await vi.advanceTimersByTimeAsync(YOUNG_SINCE_SPAWN_MS);
    const shutdown = asUtilityHost(manager, 9999);

    const report = manager.killAll({ allowGrace: true });
    manager.dispose();

    expect(report).toEqual({ pids: [1111, 9999], killedCount: 2, deferredCount: 0 });
    expect(shutdown).toHaveBeenCalledWith(1300);
  });

  it('leaves the report alone when nothing was killed, so a quit with no terminals is not held', () => {
    const manager = new SessionManager();
    asUtilityHost(manager, 9999);
    expect(manager.killAll({ allowGrace: true })).toEqual({ pids: [], killedCount: 0, deferredCount: 0 });
  });
});

describe('the spawn flow onData guard once remove() has cleared the row', () => {
  /** An adapter that reports an agent session id it finds in the output. */
  function idCapturingParser(): AgentParser {
    return {
      detectFirstOutput: () => false,
      removeHooks: () => {},
      runtime: {
        sessionId: { fromOutput: (text: string) => text.match(/session=(\S+)/)?.[1] ?? null },
      },
    } as unknown as AgentParser;
  }

  it('captures an agent session id from the output of a registered session', async () => {
    // The counterpart that keeps the next test from passing vacuously: the
    // same adapter and chunk shape DO reach the capture while the row exists.
    const manager = new SessionManager();
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-id-capture',
      command: '',
      cwd: tmpDir,
      exitSequence: EXIT_SEQUENCE,
      agentParser: idCapturingParser(),
    });
    const telemetry = (manager as unknown as {
      telemetry: { notifyAgentSessionId: (sessionId: string, capturedId: string) => void };
    }).telemetry;
    const notifySpy = vi.spyOn(telemetry, 'notifyAgentSessionId');

    mock.feedData('session=captured-id\r\n');

    expect(notifySpy).toHaveBeenCalledWith(session.id, 'captured-id');
    manager.killAll();
  });

  it('ignores a session id the parked PTY prints after remove() cleared the row', async () => {
    // kill() parks a young session's PTY on the deferred-kill grace: the row
    // is deleted by remove(), but the PTY is still alive and can still emit a
    // chunk before the force-kill timer fires. The pty host drops its own
    // state for the session at remove() (removeSession), and main drops every
    // event that would re-create per-session state for an id the registry no
    // longer holds, so nothing captures an id under it.
    const manager = new SessionManager();
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-post-remove-data',
      command: '',
      cwd: tmpDir,
      exitSequence: EXIT_SEQUENCE,
      agentParser: idCapturingParser(),
    });
    const telemetry = (manager as unknown as {
      telemetry: { notifyAgentSessionId: (sessionId: string, capturedId: string) => void };
    }).telemetry;
    const notifySpy = vi.spyOn(telemetry, 'notifyAgentSessionId');

    manager.kill(session.id);
    manager.remove(session.id);
    mock.feedData('session=after-remove-id\r\n');

    expect(notifySpy).not.toHaveBeenCalled();
    manager.killAll();
  });

  it('feeds stream telemetry and PTY activity detection before remove(), and stops once the row is gone', async () => {
    // The previous test spies on the session-id scanner only. The four
    // consumers session-spawn-flow.ts gates behind rowStillRegistered are
    // four SEPARATE if statements, not one shared branch, so dropping
    // `&& rowStillRegistered` from just the stream-telemetry branch or just
    // the activity-detection branch would still leave that test green. This
    // test spies on the other two consumers directly: telemetry.setSessionUsage
    // (fed by the stream-telemetry block) and telemetry.notifyPtyData (fed by
    // the PTY activity-detection block), which needs an agentParser whose
    // runtime declares a non-hooks activity strategy and a streamOutput
    // factory.
    const manager = new SessionManager();
    const activityAgentParser = {
      detectFirstOutput: () => false,
      removeHooks: () => {},
      runtime: {
        activity: { kind: 'pty', detectIdle: () => false },
        streamOutput: {
          createParser: () => ({
            parseTelemetry: () => ({ usage: { toolCallCount: 1 } }),
          }),
        },
      },
    } as unknown as AgentParser;

    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-post-remove-telemetry',
      command: '',
      cwd: tmpDir,
      exitSequence: EXIT_SEQUENCE,
      agentParser: activityAgentParser,
    });

    const telemetry = (manager as unknown as {
      telemetry: {
        notifyPtyData: (sessionId: string) => void;
        setSessionUsage: (sessionId: string, partial: unknown) => void;
      };
    }).telemetry;
    const notifyPtyDataSpy = vi.spyOn(telemetry, 'notifyPtyData');
    const setSessionUsageSpy = vi.spyOn(telemetry, 'setSessionUsage');

    mock.feedData('before-remove-telemetry-chunk');
    expect(notifyPtyDataSpy).toHaveBeenCalledWith(session.id);
    expect(setSessionUsageSpy).toHaveBeenCalledWith(session.id, { toolCallCount: 1 });

    notifyPtyDataSpy.mockClear();
    setSessionUsageSpy.mockClear();
    manager.kill(session.id);
    manager.remove(session.id);
    mock.feedData('after-remove-telemetry-chunk');

    expect(notifyPtyDataSpy).not.toHaveBeenCalled();
    expect(setSessionUsageSpy).not.toHaveBeenCalled();
    manager.killAll();
  });
});

describe('a folder-shared adapter file across a same-task respawn', () => {
  // Gemini, Cursor and the other folder-shared adapters hold the file they
  // write in buildCommand until the session releases it (SharedFolderHolds).
  // The release used to be keyed by task: a young session's kill parks its PTY
  // with its exit listener still attached, the task respawns inside the grace,
  // the new build re-adds the same task id (a no-op), and then the old PTY's
  // exit removed the task id and stripped the RUNNING session's hooks and MCP
  // entry. Keyed by session id, the late exit ends only its own hold.
  //
  // Red-green: releasing with `session.taskId` in removeAdapterHooks never
  // ends a session's own hold, so the new session's exit fails to strip and
  // the suspend's release fails to strip; the task-keyed holds this replaced
  // failed the first case at the old exit instead.

  /** An adapter whose removeHooks goes through real holds, with the strip spied. */
  function holdingAdapter() {
    const holds = new SharedFolderHolds();
    const strip = vi.fn();
    const parser = {
      detectFirstOutput: () => false,
      removeHooks: (directory: string, sessionId?: string) => {
        const folder = holds.release(sessionId, directory);
        if (folder) strip(folder);
      },
      runtime: { sessionId: { fromOutput: () => null } },
    } as unknown as AgentParser;
    return { parser, holds, strip };
  }

  /** What a build does before spawn: take the session's hold, then spawn under the same id. */
  async function buildAndSpawn(manager: SessionManager, adapter: ReturnType<typeof holdingAdapter>, sessionId: string, taskId: string) {
    adapter.holds.retain(sessionId, tmpDir);
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      id: sessionId,
      taskId,
      command: '',
      cwd: tmpDir,
      exitSequence: EXIT_SEQUENCE,
      agentParser: adapter.parser,
    });
    return { session, ...mock };
  }

  it('the old PTY\'s late exit after a kill keeps the new session\'s file', async () => {
    const manager = new SessionManager();
    const adapter = holdingAdapter();
    const old = await buildAndSpawn(manager, adapter, 'old-session', 'task-respawn');

    // Young, so the kill parks the PTY for the grace with its exit listener.
    manager.kill(old.session.id);
    expect(old.mockPty.kill).not.toHaveBeenCalled();

    const fresh = await buildAndSpawn(manager, adapter, 'new-session', 'task-respawn');
    expect(fresh.session.status).toBe('running');

    old.triggerExit(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(adapter.strip).not.toHaveBeenCalled();
    expect(adapter.holds.isHeld(tmpDir)).toBe(true);

    // The running session's own end strips it.
    fresh.triggerExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.strip).toHaveBeenCalledTimes(1);
    expect(adapter.strip).toHaveBeenCalledWith(tmpDir);
    manager.killAll();
  });

  it('a suspend, a respawn, then the old PTY\'s exit keeps the new session\'s file', async () => {
    // suspend() releases at its start and the exit releases again. The
    // second release lands after the respawn took its own hold.
    const manager = new SessionManager();
    const adapter = holdingAdapter();
    const old = await buildAndSpawn(manager, adapter, 'old-session', 'task-suspend');

    const suspended = manager.suspend(old.session.id);
    // suspend() released at once: nobody else held the folder.
    expect(adapter.strip).toHaveBeenCalledTimes(1);

    const fresh = await buildAndSpawn(manager, adapter, 'new-session', 'task-suspend');
    expect(fresh.session.status).toBe('running');

    old.triggerExit(0);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 3);
    await suspended;

    expect(adapter.strip).toHaveBeenCalledTimes(1);
    expect(adapter.holds.isHeld(tmpDir)).toBe(true);
    manager.killAll();
  });
});

describe('retireAgentlessSession on a young session', () => {
  it('kills a young leftover shell at once: no exit sequence, synchronous pty.kill(), exited stamped', async () => {
    // retireAgentlessSession always calls kill(sessionId, { immediate: true }):
    // the agent CLI is already gone (that is the whole premise of the sweep),
    // so the exit-sequence grace would only type `/exit` into a bare leftover
    // shell and the caller's own `exited` stamp would let a later awaitExit
    // resolve while that shell still held the cwd. This suite is where
    // isYoungSession is real (session-manager-agent-absence.test.ts mocks
    // SessionTelemetry entirely and drives the callback directly, so the
    // fixture there never exercises a genuinely young session), so it is
    // where the { immediate: true } wiring against a real young session can
    // be pinned without being vacuous.
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-agentless');
    const row = registryRow(manager, session.id);
    if (!row) throw new Error('expected the spawned session to be registered');
    // isAgentAbsenceCandidate requires a non-transient session with an
    // adapter - presence is what matters, not the contents (mirrors
    // session-manager-agent-absence.test.ts's seedSession).
    row.agentParser = {} as unknown as ManagedSession['agentParser'];

    // Clear the 30 s agent-spawn grace (AGENT_SPAWN_GRACE_MS in
    // session-manager.ts, module-private - mirrored here as in
    // session-manager-agent-absence.test.ts) while staying well inside the
    // deferred-kill grace's own 60 s young window, so the session is still
    // young when retireAgentlessSession runs.
    const agentSpawnGraceMs = 30_000;
    await vi.advanceTimersByTimeAsync(agentSpawnGraceMs + 1_000);
    const writesBefore = mockPty.write.mock.calls.length;

    (manager as unknown as { retireAgentlessSession(id: string): void }).retireAgentlessSession(session.id);

    expect(writesAfter(mockPty, writesBefore)).toEqual([]);
    expect(mockPty.kill).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('exited');
    expect(row.exitCode).toBe(0);
  });
});

describe('a renderer\'s keystrokes once main has dropped the PTY handle', () => {
  // A renderer types on its own port to the pty host, not through main, so main
  // nulling `session.pty` no longer stops its keys. kill() and the suspend's
  // clearPty seal the PTY first (sealUserInput). Red-green: dropping the
  // sealUserInput() call in either site lets the typed text reach the PTY.
  const RENDERER_ID = 7;

  it('kill() of a young session: the exit sequence lands, later keys do not', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-seal-kill');
    const port = createFakeRendererPort();
    manager.attachRendererPort(RENDERER_ID, port.port);

    // Control: the port reaches this PTY while main holds the handle.
    port.send({ type: 'write', sessionId: session.id, data: 'typed before' });
    expect(mockPty.write.mock.calls.map((call) => call[0])).toContain('typed before');
    const writesBeforeKill = mockPty.write.mock.calls.length;

    manager.kill(session.id);
    port.send({ type: 'write', sessionId: session.id, data: 'typed after the kill' });

    expect(writesAfter(mockPty, writesBeforeKill)).toEqual(EXIT_SEQUENCE);
  });

  it('suspend(): keys typed after the grace ends and the handle drops do not reach the PTY', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-seal-suspend');
    // The kill lands with no exit of its own, so only the seal can stop the keys.
    mockPty.kill.mockImplementation(() => undefined);
    const port = createFakeRendererPort();
    manager.attachRendererPort(RENDERER_ID, port.port);

    void manager.suspend(session.id);
    // Past the natural-exit wait: clearPty seals and nulls, then the force-kill.
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 1);
    expect(registryRow(manager, session.id)?.pty).toBeNull();
    expect(mockPty.kill).toHaveBeenCalled();
    const writesAfterClear = mockPty.write.mock.calls.length;

    port.send({ type: 'write', sessionId: session.id, data: 'typed after the suspend' });

    expect(writesAfter(mockPty, writesAfterClear)).toEqual([]);
  });
});

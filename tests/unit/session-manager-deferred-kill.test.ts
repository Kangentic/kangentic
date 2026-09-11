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
import {
  KILL_GRACE_MS,
  YOUNG_AFTER_ALT_SCREEN_MS,
  YOUNG_SINCE_SPAWN_MS,
} from '../../src/main/pty/lifecycle/deferred-kill';

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
    const { session, mockPty, triggerExit } = await spawnSession(manager, 'task-natural');

    manager.kill(session.id);
    triggerExit(0);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);

    expect(mockPty.kill).not.toHaveBeenCalled();
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
    const { session, mockPty, triggerExit } = await spawnSession(manager, 'task-natural-after-remove');

    manager.kill(session.id);
    let settled = false;
    const exited = manager.awaitExit(session.id).then(() => { settled = true; });
    manager.remove(session.id);

    triggerExit(0);
    await exited;
    expect(settled).toBe(true);

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
    expect(mockPty.kill).not.toHaveBeenCalled();
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
    manager.kill(session.id);
    expect(mockPty.kill).not.toHaveBeenCalled();

    const report = manager.killAll();

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ pids: [4242], killedCount: 1, deferredCount: 0 });
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
    expect(mockPty.kill).toHaveBeenCalledTimes(1);
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

describe('the spawn flow onData guard once remove() has cleared the row', () => {
  it('feeds the session-id scanner before remove(), and stops once the row is gone', async () => {
    // kill() parks a young session's PTY on the deferred-kill grace: the row
    // is deleted by remove(), but the PTY the spawn flow attached onData to
    // is still alive and can still emit a chunk before the force-kill timer
    // fires. session-spawn-flow.ts computes rowStillRegistered once per chunk
    // (context.registry.has(id)) and gates four consumers behind it - the
    // transcript writer, this session-id scanner, the stream-telemetry block,
    // and the PTY activity-detection block - so none of them re-create
    // per-session state under an id clearSessionCaches already cleared. The
    // scanner is the cleanest of the four to spy on: it needs no
    // agentParser fixture and no transcript repository, and it is gated by
    // the exact same rowStillRegistered read as the other three. The next
    // test in this describe covers the remaining two (stream telemetry and
    // PTY activity detection), which this one does not touch.
    const manager = new SessionManager();
    const { session, feedData } = await spawnSession(manager, 'task-post-remove-data');
    const sessionIdManager = (manager as unknown as {
      sessionIdManager: { onData: (sessionId: string, data: string, agentParser: unknown) => void };
    }).sessionIdManager;
    const onDataSpy = vi.spyOn(sessionIdManager, 'onData');

    feedData('before-remove-chunk');
    expect(onDataSpy).toHaveBeenCalledWith(session.id, 'before-remove-chunk', undefined);

    onDataSpy.mockClear();
    manager.kill(session.id);
    manager.remove(session.id);
    feedData('after-remove-chunk');

    expect(onDataSpy).not.toHaveBeenCalled();
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

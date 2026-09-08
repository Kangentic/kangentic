import { describe, it, expect, vi } from 'vitest';
import type * as pty from 'node-pty';
import { writeExitSequence, killAllSessions } from '../../src/main/pty/shutdown/session-shutdown';
import type { ShutdownSession, ShutdownContext } from '../../src/main/pty/shutdown/session-shutdown';

describe('writeExitSequence', () => {
  it('writes every command in order', () => {
    const writes: string[] = [];
    const ptyRef = { write: (d: string) => { writes.push(d); } } as unknown as pty.IPty;
    writeExitSequence(ptyRef, ['\x03', '/exit\r']);
    expect(writes).toEqual(['\x03', '/exit\r']);
  });

  it('swallows individual write errors and keeps trying subsequent commands', () => {
    let callCount = 0;
    const writes: string[] = [];
    const ptyRef = {
      write: (d: string) => {
        callCount++;
        if (callCount === 1) throw new Error('EIO: PTY dead');
        writes.push(d);
      },
    } as unknown as pty.IPty;
    expect(() => writeExitSequence(ptyRef, ['\x03', '/exit\r'])).not.toThrow();
    // First write threw; second write still attempted
    expect(writes).toEqual(['/exit\r']);
  });

  it('is a no-op for an empty exit sequence', () => {
    const ptyRef = { write: vi.fn() } as unknown as pty.IPty;
    writeExitSequence(ptyRef, []);
    expect((ptyRef.write as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// Note: suspendAllSessions is covered end-to-end via
// tests/unit/session-suspend.test.ts and session-manager.test.ts integration paths.

describe('killAllSessions', () => {
  function makeDisposable() {
    return { dispose: vi.fn() };
  }

  function makeSession(overrides: Partial<ShutdownSession> = {}): ShutdownSession {
    return {
      id: 'sess-1',
      taskId: 'task-1',
      pty: { write: vi.fn(), kill: vi.fn() } as unknown as pty.IPty,
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      exitSequence: [],
      ...overrides,
    };
  }

  function makeContext(sessions: ShutdownSession[]) {
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const detachAndDelete = vi.fn();
    const killPty = vi.fn(() => true);
    const sessionQueueClear = vi.fn();
    const firstOutputClear = vi.fn();
    const context = {
      sessions: sessionMap,
      sessionQueue: { clear: sessionQueueClear },
      sessionFiles: { detachAndDelete },
      firstOutputTracker: { clear: firstOutputClear },
      killPty,
    } as unknown as ShutdownContext;
    return { context, sessionMap, detachAndDelete, killPty, sessionQueueClear, firstOutputClear };
  }

  it('disposes each retained PTY listener so node-pty stops invoking callbacks after kill', () => {
    const dataDisposable = makeDisposable();
    const exitDisposable = makeDisposable();
    const session = makeSession({
      ptyDisposables: [dataDisposable, exitDisposable] as unknown as pty.IDisposable[],
    });
    const { context, killPty } = makeContext([session]);

    killAllSessions(context);

    expect(killPty).toHaveBeenCalledTimes(1);
    expect(dataDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(exitDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a session that never retained disposables', () => {
    const session = makeSession({ ptyDisposables: undefined });
    const { context, detachAndDelete } = makeContext([session]);

    expect(() => killAllSessions(context)).not.toThrow();
    expect(detachAndDelete).toHaveBeenCalledWith('sess-1');
  });

  it('keeps tearing down when one disposable throws (best-effort)', () => {
    const throwing = { dispose: vi.fn(() => { throw new Error('emitter already gone'); }) };
    const healthy = makeDisposable();
    const session = makeSession({
      ptyDisposables: [throwing, healthy] as unknown as pty.IDisposable[],
    });
    const { context, detachAndDelete } = makeContext([session]);

    expect(() => killAllSessions(context)).not.toThrow();
    expect(healthy.dispose).toHaveBeenCalledTimes(1);
    expect(detachAndDelete).toHaveBeenCalledWith('sess-1');
  });

  it('clears the session, queue, and first-output maps', () => {
    const session = makeSession();
    const { context, sessionMap, sessionQueueClear, firstOutputClear } = makeContext([session]);

    killAllSessions(context);

    expect(sessionMap.size).toBe(0);
    expect(sessionQueueClear).toHaveBeenCalledTimes(1);
    expect(firstOutputClear).toHaveBeenCalledTimes(1);
  });

  // The returned report feeds the before-quit exit-callback drain (Sentry
  // DESKTOP-C): the quit is held until these children are gone so node-pty's
  // exit callback is dispatched while JS is still callable. killedCount is the
  // half that ARMS the drain; pids is only what it can probe.
  describe('the returned PtyKillReport', () => {
    function makePty(pid: number | undefined): pty.IPty {
      return { write: vi.fn(), kill: vi.fn(), pid } as unknown as pty.IPty;
    }

    it('returns the child pid of every PTY it killed, read before the reference is nulled', () => {
      const first = makeSession({ id: 'sess-1', pty: makePty(4242) });
      const second = makeSession({ id: 'sess-2', pty: makePty(4343) });
      const { context, killPty } = makeContext([first, second]);
      // The kill lands on a session whose pty is already nulled (the
      // double-kill guard), so the pid must have been captured beforehand.
      killPty.mockImplementation(() => {
        expect(first.pty).toBeNull();
        return true;
      });

      expect(killAllSessions(context)).toEqual({ pids: [4242, 4343], killedCount: 2 });
    });

    it('returns nothing for a session with no PTY', () => {
      const session = makeSession({ pty: null });
      const { context, killPty } = makeContext([session]);

      expect(killAllSessions(context)).toEqual({ pids: [], killedCount: 0 });
      expect(killPty).not.toHaveBeenCalled();
    });

    it('still returns the pid when killPty reports the child was already dead', () => {
      // An exit callback can be queued but not yet dispatched; the drain's
      // settle ticks cover it, so the pid must not be dropped here.
      const session = makeSession({ pty: makePty(4242) });
      const { context, killPty } = makeContext([session]);
      killPty.mockReturnValue(false);

      expect(killAllSessions(context)).toEqual({ pids: [4242], killedCount: 1 });
    });

    /**
     * The red-green for the whole kill-report change. Dropping the PID for an
     * unreadable one is correct: there is nothing to probe. Dropping the KILL
     * is what let a whole shutdown skip the drain, because the handler read an
     * empty pid list as "no PTY was killed" and quit straight into node::Stop()
     * with an exit callback still in flight. Fails against any implementation
     * that derives killedCount from pids.length.
     */
    it('counts a PTY with an unreadable pid as a kill even though it lists no pid to probe', () => {
      const missing = makeSession({ id: 'sess-1', pty: makePty(undefined) });
      const zero = makeSession({ id: 'sess-2', pty: makePty(0) });
      const { context } = makeContext([missing, zero]);

      expect(killAllSessions(context)).toEqual({ pids: [], killedCount: 2 });
    });

    it('counts every kill while listing only the probe-able pids', () => {
      const readable = makeSession({ id: 'sess-1', pty: makePty(4242) });
      const unreadable = makeSession({ id: 'sess-2', pty: makePty(undefined) });
      const noPty = makeSession({ id: 'sess-3', pty: null });
      const { context } = makeContext([readable, unreadable, noPty]);

      // The mixed case the killedCount >= pids.length invariant describes: the
      // drain probes 4242 and spends the blind budget for sess-2. sess-3 was
      // never killed at all, so it contributes to neither.
      expect(killAllSessions(context)).toEqual({ pids: [4242], killedCount: 2 });
    });
  });
});

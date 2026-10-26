import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import type * as pty from 'node-pty';
import { writeExitSequence, killAllSessions } from '../../src/main/pty/shutdown/session-shutdown';
import type { ShutdownSession, ShutdownContext } from '../../src/main/pty/shutdown/session-shutdown';
import type { PtyHandle } from '../../src/main/pty/host/pty-host-client';
import { DeferredKillRegistry, KILL_GRACE_MS } from '../../src/main/pty/lifecycle/deferred-kill';

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

describe('killAllSessions', () => {
  function makeDisposable() {
    return { dispose: vi.fn() };
  }

  /** A MATURE session by default (spawned two minutes ago, no alt-screen frame):
   *  the instant-kill path every test below this describe assumes. The
   *  young-session grace has its own describe. */
  function makeSession(overrides: Partial<ShutdownSession> = {}): ShutdownSession {
    return {
      id: 'sess-1',
      taskId: 'task-1',
      pty: { write: vi.fn(), kill: vi.fn(), sealUserInput: vi.fn() } as unknown as pty.IPty,
      status: 'running',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
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
      return { write: vi.fn(), kill: vi.fn(), sealUserInput: vi.fn(), pid } as unknown as pty.IPty;
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

      expect(killAllSessions(context)).toEqual({ pids: [4242, 4343], killedCount: 2, deferredCount: 0 });
    });

    it('returns nothing for a session with no PTY', () => {
      const session = makeSession({ pty: null });
      const { context, killPty } = makeContext([session]);

      expect(killAllSessions(context)).toEqual({ pids: [], killedCount: 0, deferredCount: 0 });
      expect(killPty).not.toHaveBeenCalled();
    });

    it('still returns the pid when killPty reports the child was already dead', () => {
      // An exit callback can be queued but not yet dispatched; the drain's
      // settle ticks cover it, so the pid must not be dropped here.
      const session = makeSession({ pty: makePty(4242) });
      const { context, killPty } = makeContext([session]);
      killPty.mockReturnValue(false);

      expect(killAllSessions(context)).toEqual({ pids: [4242], killedCount: 1, deferredCount: 0 });
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

      expect(killAllSessions(context)).toEqual({ pids: [], killedCount: 2, deferredCount: 0 });
    });

    it('counts every kill while listing only the probe-able pids', () => {
      const readable = makeSession({ id: 'sess-1', pty: makePty(4242) });
      const unreadable = makeSession({ id: 'sess-2', pty: makePty(undefined) });
      const noPty = makeSession({ id: 'sess-3', pty: null });
      const { context } = makeContext([readable, unreadable, noPty]);

      // The mixed case the killedCount >= pids.length invariant describes: the
      // drain probes 4242 and spends the blind budget for sess-2. sess-3 was
      // never killed at all, so it contributes to neither.
      expect(killAllSessions(context)).toEqual({ pids: [4242], killedCount: 2, deferredCount: 0 });
    });
  });

  /**
   * A YOUNG session (inside Claude Code's fullscreen boot-canary window) keeps
   * the exit-sequence grace at quit, but only when the caller says a drain
   * will follow: the kill rides the deferred registry's timer, which fires
   * inside the drain, and the report's deferredCount is what extends the
   * drain's deadline past it. Without the grace, or without a registry, the
   * kill is the instant one, and any PTY an earlier kill() parked is flushed.
   */
  describe('the young-session grace', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function makeYoungSession(pid: number, overrides: Partial<ShutdownSession> = {}): ShutdownSession {
      return makeSession({
        id: `young-${pid}`,
        pty: { write: vi.fn(), kill: vi.fn(), sealUserInput: vi.fn(), pid } as unknown as pty.IPty,
        startedAt: new Date().toISOString(),
        exitSequence: ['\x03', '/exit\r'],
        ...overrides,
      });
    }

    it('with allowGrace, writes the exit sequence, parks the kill on the registry timer, and counts it deferred', () => {
      vi.useFakeTimers();
      const session = makeYoungSession(4242);
      const ptyRef = session.pty as pty.IPty;
      const { context, killPty } = makeContext([session]);
      const deferredKills = new DeferredKillRegistry({ killPty });

      const report = killAllSessions(context, { allowGrace: true, deferredKills });

      expect(report).toEqual({ pids: [4242], killedCount: 1, deferredCount: 1 });
      expect((ptyRef.write as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual(['\x03', '/exit\r']);
      expect(killPty).not.toHaveBeenCalled();
      expect(session.pty).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(killPty).toHaveBeenCalledTimes(1);
      expect(killPty).toHaveBeenCalledWith(ptyRef);
    });

    it('closes a young session whose console close is its graceful exit at once, with nothing typed and nothing deferred', () => {
      vi.useFakeTimers();
      const session = makeYoungSession(4242, { consoleCloseIsGraceful: true, exitSequence: ['\x1b', { delayMs: 400 }, '\x03', '/exit\r'] });
      const ptyRef = session.pty as pty.IPty;
      const { context, killPty } = makeContext([session]);
      const deferredKills = new DeferredKillRegistry({ killPty });

      const report = killAllSessions(context, { allowGrace: true, deferredKills });

      expect(report).toEqual({ pids: [4242], killedCount: 1, deferredCount: 0 });
      expect(killPty).toHaveBeenCalledWith(ptyRef);
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(ptyRef.write).not.toHaveBeenCalled();
    });

    it('still detaches a deferred row\'s PTY listeners at once, like every other row', () => {
      vi.useFakeTimers();
      const dataDisposable = makeDisposable();
      const exitDisposable = makeDisposable();
      const session = makeYoungSession(4242, {
        ptyDisposables: [dataDisposable, exitDisposable] as unknown as pty.IDisposable[],
      });
      const { context, killPty } = makeContext([session]);

      killAllSessions(context, { allowGrace: true, deferredKills: new DeferredKillRegistry({ killPty }) });

      expect(dataDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(exitDisposable.dispose).toHaveBeenCalledTimes(1);
    });

    it('without allowGrace, kills a young session at once', () => {
      const session = makeYoungSession(4242);
      const { context, killPty } = makeContext([session]);

      const report = killAllSessions(context, { allowGrace: false, deferredKills: new DeferredKillRegistry({ killPty }) });

      expect(report).toEqual({ pids: [4242], killedCount: 1, deferredCount: 0 });
      expect(killPty).toHaveBeenCalledTimes(1);
    });

    it('with allowGrace but no registry, kills a young session at once (nothing can defer)', () => {
      const session = makeYoungSession(4242);
      const { context, killPty } = makeContext([session]);

      expect(killAllSessions(context, { allowGrace: true })).toEqual({ pids: [4242], killedCount: 1, deferredCount: 0 });
      expect(killPty).toHaveBeenCalledTimes(1);
    });

    it('a mature session is killed at once even with allowGrace', () => {
      const session = makeSession({ pty: { write: vi.fn(), kill: vi.fn(), sealUserInput: vi.fn(), pid: 4242 } as unknown as pty.IPty });
      const { context, killPty } = makeContext([session]);

      expect(killAllSessions(context, { allowGrace: true, deferredKills: new DeferredKillRegistry({ killPty }) }))
        .toEqual({ pids: [4242], killedCount: 1, deferredCount: 0 });
      expect(killPty).toHaveBeenCalledTimes(1);
    });

    describe('PTYs an earlier kill() parked (their rows may already be gone)', () => {
      function parkedPty(pid: number): pty.IPty {
        return { write: vi.fn(), kill: vi.fn(), pid } as unknown as pty.IPty;
      }

      it('with allowGrace, are left on their timers, counted, probed, and have their listeners detached', () => {
        vi.useFakeTimers();
        const { context, killPty } = makeContext([]);
        const deferredKills = new DeferredKillRegistry({ killPty });
        const listener = makeDisposable();
        const parked = parkedPty(5151);
        deferredKills.schedule({
          sessionId: 'gone', ptyRef: parked, pid: 5151,
          ptyDisposables: [listener] as unknown as pty.IDisposable[],
        });

        const report = killAllSessions(context, { allowGrace: true, deferredKills });

        expect(report).toEqual({ pids: [5151], killedCount: 1, deferredCount: 1 });
        expect(listener.dispose).toHaveBeenCalledTimes(1);
        expect(killPty).not.toHaveBeenCalled();
        vi.advanceTimersByTime(KILL_GRACE_MS);
        expect(killPty).toHaveBeenCalledWith(parked);
      });

      it('without allowGrace, are flushed now and counted as plain kills', () => {
        vi.useFakeTimers();
        const { context, killPty } = makeContext([]);
        const deferredKills = new DeferredKillRegistry({ killPty });
        const parked = parkedPty(5151);
        deferredKills.schedule({ sessionId: 'gone', ptyRef: parked, pid: 5151 });

        const report = killAllSessions(context, { allowGrace: false, deferredKills });

        expect(report).toEqual({ pids: [5151], killedCount: 1, deferredCount: 0 });
        expect(killPty).toHaveBeenCalledWith(parked);
        expect(deferredKills.size).toBe(0);
      });
    });
  });

  /**
   * Every place main drops a session's PTY handle seals it first. A renderer's
   * keystrokes reach the pty host on the renderer's own port, not through main,
   * so nulling `session.pty` no longer stops them: only the `sealUserInput`
   * command does. Without it a user typing into a terminal whose agent is in
   * its exit lands those keys in the agent. Main's own exit sequence is a
   * direct `write`, which a sealed PTY still takes.
   *
   * `tests/unit/terminal-input-path.test.ts` only scans the source text for the
   * call above `.pty = null`; it cannot tell whether the call runs, how often,
   * or in what order. These cases run `killAllSessions` and read the order off
   * `mock.invocationCallOrder`, which is global across every `vi.fn`.
   *
   * This file drives the quit path only. The same seal in `SessionManager.kill()`
   * and in the suspend path's `clearPty` needs a whole `SessionManager`, so it
   * is pinned beside the session-manager tests, not here.
   */
  describe('sealing the PTY handle', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    interface SealedRow {
      session: ShutdownSession;
      handle: PtyHandle;
      write: Mock<(data: string) => void>;
      sealUserInput: Mock<() => void>;
      /** What the row's `pty` held each time the seal ran. */
      rowPtyAtSeal: Array<PtyHandle | null>;
    }

    /** A session whose PTY handle records its writes and seals, and what the row held when sealed. */
    function makeSealedRow(ptyId: number, overrides: Partial<ShutdownSession> = {}): SealedRow {
      const session = makeSession({ id: `sess-${ptyId}`, taskId: `task-${ptyId}`, ...overrides });
      const rowPtyAtSeal: Array<PtyHandle | null> = [];
      const write = vi.fn<(data: string) => void>();
      const sealUserInput = vi.fn<() => void>(() => {
        rowPtyAtSeal.push(session.pty);
      });
      const handle: PtyHandle = {
        ptyId,
        pid: 4000 + ptyId,
        cols: 80,
        rows: 24,
        write,
        resize: vi.fn(),
        kill: vi.fn(),
        sealUserInput,
      };
      session.pty = handle;
      return { session, handle, write, sealUserInput, rowPtyAtSeal };
    }

    function callOrders(spy: { mock: { invocationCallOrder: number[] } }): number[] {
      return spy.mock.invocationCallOrder;
    }

    // Typed keys with no pause step: every one is written synchronously inside
    // killAllSessions, so the order against the seal is deterministic.
    const IMMEDIATE_EXIT_SEQUENCE = ['\x03', '/exit\r'];

    it('seals each session PTY exactly once', () => {
      const first = makeSealedRow(1, { exitSequence: IMMEDIATE_EXIT_SEQUENCE });
      const second = makeSealedRow(2, { exitSequence: IMMEDIATE_EXIT_SEQUENCE });
      const { context } = makeContext([first.session, second.session]);

      killAllSessions(context);

      expect(first.sealUserInput).toHaveBeenCalledTimes(1);
      expect(second.sealUserInput).toHaveBeenCalledTimes(1);
      expect(first.sealUserInput).toHaveBeenCalledWith();
    });

    it('does not seal a row with no PTY, and still seals the rows around it', () => {
      const empty = makeSession({ id: 'sess-empty', pty: null });
      const live = makeSealedRow(2);
      const { context } = makeContext([empty, live.session]);

      expect(() => killAllSessions(context)).not.toThrow();

      expect(live.sealUserInput).toHaveBeenCalledTimes(1);
    });

    it('seals a graceful-close session once, though nothing is typed into it', () => {
      const row = makeSealedRow(1, {
        consoleCloseIsGraceful: true,
        exitSequence: ['\x1b', { delayMs: 400 }, '\x03', '/exit\r'],
      });
      const { context, killPty } = makeContext([row.session]);

      killAllSessions(context);

      expect(row.write).not.toHaveBeenCalled();
      expect(row.sealUserInput).toHaveBeenCalledTimes(1);
      expect(killPty).toHaveBeenCalledWith(row.handle);
    });

    it('seals while the row still holds the handle, before session.pty is nulled', () => {
      const row = makeSealedRow(1, { exitSequence: IMMEDIATE_EXIT_SEQUENCE });
      const { context } = makeContext([row.session]);

      killAllSessions(context);

      // A seal moved below `session.pty = null` still runs through the local
      // reference, so only what the row held at the call tells the two apart.
      expect(row.rowPtyAtSeal).toHaveLength(1);
      expect(row.rowPtyAtSeal[0]).toBe(row.handle);
      expect(row.session.pty).toBeNull();
    });

    it('seals before the force-kill on the instant path', () => {
      const row = makeSealedRow(1, { exitSequence: IMMEDIATE_EXIT_SEQUENCE });
      const { context, killPty } = makeContext([row.session]);

      killAllSessions(context);

      expect(killPty).toHaveBeenCalledTimes(1);
      expect(callOrders(row.sealUserInput)[0]).toBeLessThan(callOrders(killPty)[0]);
    });

    it('seals a parked young session at once, not when its grace timer fires', () => {
      vi.useFakeTimers();
      const row = makeSealedRow(1, {
        startedAt: new Date().toISOString(),
        exitSequence: IMMEDIATE_EXIT_SEQUENCE,
      });
      const { context, killPty } = makeContext([row.session]);

      killAllSessions(context, { allowGrace: true, deferredKills: new DeferredKillRegistry({ killPty }) });

      // The kill is parked; the seal must not wait for it.
      expect(killPty).not.toHaveBeenCalled();
      expect(row.sealUserInput).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(killPty).toHaveBeenCalledTimes(1);
      expect(row.sealUserInput).toHaveBeenCalledTimes(1);
      expect(callOrders(row.sealUserInput)[0]).toBeLessThan(callOrders(killPty)[0]);
    });

    // RED against the current source, and that is the finding. killAllSessions
    // runs writeExitSequence (session-shutdown.ts, before `const ptyRef`) BEFORE
    // ptyRef.sealUserInput(). SessionManager.kill() seals first and writes the
    // exit sequence "past the seal". The host's direct `write` takes a sealed
    // PTY either way, so the exit sequence is not lost; what the order decides
    // is whether a keystroke a renderer posts between the two lands in the
    // agent after the exit keys. Fix the order in killAllSessions, not this test.
    it.each([
      ['a mature session, killed at once', false],
      ['a young session, parked on the grace timer', true],
    ])('seals before the exit sequence is written, as SessionManager.kill() does (%s)', (_label, isYoung) => {
      vi.useFakeTimers();
      const row = makeSealedRow(1, {
        startedAt: isYoung ? new Date().toISOString() : new Date(Date.now() - 120_000).toISOString(),
        exitSequence: IMMEDIATE_EXIT_SEQUENCE,
      });
      const { context, killPty } = makeContext([row.session]);

      killAllSessions(context, isYoung
        ? { allowGrace: true, deferredKills: new DeferredKillRegistry({ killPty }) }
        : {});

      // Guard against a vacuous order check: both keys were written.
      expect(row.write.mock.calls.map((call) => call[0])).toEqual(IMMEDIATE_EXIT_SEQUENCE);
      const sealOrder = callOrders(row.sealUserInput)[0];
      const firstWriteOrder = callOrders(row.write)[0];
      expect(
        sealOrder,
        'sealUserInput() must run before the exit sequence is written, as in SessionManager.kill(): '
          + 'a renderer keystroke posted between the two would land after the exit keys',
      ).toBeLessThan(firstWriteOrder);
    });
  });
});

/**
 * Unit coverage for `resolvePtyEchoReassert`, the pure guard matrix of the
 * terminal width-drift self-heal (useTerminal's SESSION_PTY_RESIZED listener).
 *
 * The scenario it exists for: a PTY reshaped under a mounted xterm (a lost
 * resize, another surface's late write, a respawn) has NO recovery path on its
 * own - xterm re-sends dimensions only when its own size changes - so live
 * absolute-positioned TUI output wraps into a staircase until the window is
 * resized by hand. The echo listener re-asserts the mounted owner's fitted
 * grid; this function decides when that is safe.
 *
 * The budget is deliberately time-windowed rather than reset-on-heal: in a
 * two-surface fight each side's successful re-assert lands an in-sync echo at
 * the OTHER side, so a budget reset by in-sync echoes never binds in exactly
 * the livelock it exists to bound. The sequence tests below pin that.
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePtyEchoReassert,
  type PtyEchoReassertAttempts,
  type PtyEchoReassertInput,
} from '../../src/renderer/hooks/useTerminal';

const NOW = 1_000_000;

function makeInput(overrides: Partial<PtyEchoReassertInput> = {}): PtyEchoReassertInput {
  return {
    // The incident geometry: PTY reshaped to the bottom panel's strip while
    // the board window's xterm sits at the detail fit.
    echoedCols: 306,
    echoedRows: 15,
    ownCols: 210,
    ownRows: 48,
    origin: 'desktop',
    replayPending: false,
    parked: false,
    ownResizePending: false,
    previousAttempts: null,
    lastRefusalAt: null,
    now: NOW,
    ...overrides,
  };
}

describe('resolvePtyEchoReassert', () => {
  it('re-asserts on a disagreeing desktop-origin echo with all guards clear', () => {
    const decision = resolvePtyEchoReassert(makeInput());
    expect(decision).toEqual({
      action: 'reassert',
      signature: '306x15<-210x48',
      nextAttempts: { signature: '306x15<-210x48', count: 1, lastScheduledAt: NOW },
    });
  });

  it('re-asserts on a cols-only and on a rows-only mismatch (rows drift staircases too)', () => {
    const colsOnly = resolvePtyEchoReassert(makeInput({ echoedCols: 306, echoedRows: 48 }));
    expect(colsOnly.action).toBe('reassert');
    const rowsOnly = resolvePtyEchoReassert(makeInput({ echoedCols: 210, echoedRows: 15 }));
    expect(rowsOnly.action).toBe('reassert');
  });

  it('treats a spawn-origin echo like desktop (a respawn under a mounted xterm is healable)', () => {
    const decision = resolvePtyEchoReassert(makeInput({ origin: 'spawn', echoedCols: 120, echoedRows: 30 }));
    expect(decision.action).toBe('reassert');
  });

  it('skips in-sync: the echo of this terminal own resize self-filters', () => {
    const decision = resolvePtyEchoReassert(makeInput({ echoedCols: 210, echoedRows: 48 }));
    expect(decision).toEqual({ action: 'skip', reason: 'in-sync', signature: '210x48<-210x48' });
  });

  it('skips foreign-hold for mobile- and park-origin echoes (a phone or the park legitimately holds the grid)', () => {
    expect(resolvePtyEchoReassert(makeInput({ origin: 'mobile' }))).toMatchObject({ action: 'skip', reason: 'foreign-hold' });
    expect(resolvePtyEchoReassert(makeInput({ origin: 'park' }))).toMatchObject({ action: 'skip', reason: 'foreign-hold' });
  });

  it('skips while parked (must not reshape a grid it is not showing)', () => {
    expect(resolvePtyEchoReassert(makeInput({ parked: true }))).toMatchObject({ action: 'skip', reason: 'parked' });
  });

  describe('the refusal hold (main deliberately holding the grid)', () => {
    it('skips refused-hold while a refusal is fresh', () => {
      const decision = resolvePtyEchoReassert(makeInput({ lastRefusalAt: NOW - 500 }));
      expect(decision).toMatchObject({ action: 'skip', reason: 'refused-hold' });
    });

    it('holds across changed own dims (time-stamped, not signature-keyed)', () => {
      // The pre-send fit can move this terminal's own dims during the
      // debounce, changing every future signature. The hold must still bind,
      // or a container drag while a phone holds the floor retries a refused
      // IPC per fresh signature.
      const decision = resolvePtyEchoReassert(makeInput({ lastRefusalAt: NOW - 500, ownCols: 190, ownRows: 40 }));
      expect(decision).toMatchObject({ action: 'skip', reason: 'refused-hold' });
    });

    it('a lapsed refusal no longer blocks (the holder may have let go)', () => {
      const decision = resolvePtyEchoReassert(makeInput({ lastRefusalAt: NOW - 60_000 }));
      expect(decision.action).toBe('reassert');
    });
  });

  it('skips while a replay is in flight (the replay own fit and resize settle the dims)', () => {
    expect(resolvePtyEchoReassert(makeInput({ replayPending: true }))).toMatchObject({ action: 'skip', reason: 'replay-in-flight' });
  });

  it('skips while its own debounced resize is pending (those dims are about to be asserted anyway)', () => {
    expect(resolvePtyEchoReassert(makeInput({ ownResizePending: true }))).toMatchObject({ action: 'skip', reason: 'own-resize-pending' });
  });

  describe('guard ordering (the trace must name the REAL reason)', () => {
    it('in-sync wins over every hold and mechanical guard', () => {
      const decision = resolvePtyEchoReassert(makeInput({
        echoedCols: 210, echoedRows: 48,
        origin: 'park', parked: true, replayPending: true, ownResizePending: true,
        lastRefusalAt: NOW - 500,
      }));
      expect(decision).toMatchObject({ action: 'skip', reason: 'in-sync' });
    });

    it('foreign-hold wins over the refusal hold, the mechanical guards, and the cap', () => {
      const spent: PtyEchoReassertAttempts = { signature: '306x15<-210x48', count: 99, lastScheduledAt: NOW };
      const decision = resolvePtyEchoReassert(makeInput({
        origin: 'mobile', parked: true, replayPending: true, previousAttempts: spent,
        lastRefusalAt: NOW - 500,
      }));
      expect(decision).toMatchObject({ action: 'skip', reason: 'foreign-hold' });
    });

    it('refused-hold wins over parked and the cap', () => {
      const spent: PtyEchoReassertAttempts = { signature: '306x15<-210x48', count: 99, lastScheduledAt: NOW };
      const decision = resolvePtyEchoReassert(makeInput({
        parked: true, previousAttempts: spent, lastRefusalAt: NOW - 500,
      }));
      expect(decision).toMatchObject({ action: 'skip', reason: 'refused-hold' });
    });

    it('the cap is judged last, so a capped-but-parked echo reports parked', () => {
      const spent: PtyEchoReassertAttempts = { signature: '306x15<-210x48', count: 99, lastScheduledAt: NOW };
      const decision = resolvePtyEchoReassert(makeInput({ parked: true, previousAttempts: spent }));
      expect(decision).toMatchObject({ action: 'skip', reason: 'parked' });
    });
  });

  describe('the time-windowed budget', () => {
    it('caps the same signature after two re-asserts inside the window', () => {
      const first = resolvePtyEchoReassert(makeInput());
      expect(first.action).toBe('reassert');
      const firstAttempts = first.action === 'reassert' ? first.nextAttempts : null;

      const second = resolvePtyEchoReassert(makeInput({ previousAttempts: firstAttempts, now: NOW + 500 }));
      expect(second.action).toBe('reassert');
      const secondAttempts = second.action === 'reassert' ? second.nextAttempts : null;
      expect(secondAttempts).toEqual({ signature: '306x15<-210x48', count: 2, lastScheduledAt: NOW + 500 });

      const third = resolvePtyEchoReassert(makeInput({ previousAttempts: secondAttempts, now: NOW + 1_000 }));
      expect(third).toMatchObject({ action: 'skip', reason: 'attempt-cap' });
    });

    it('a lapsed window grants a fresh budget for the same signature', () => {
      const spent: PtyEchoReassertAttempts = { signature: '306x15<-210x48', count: 2, lastScheduledAt: NOW };
      const decision = resolvePtyEchoReassert(makeInput({ previousAttempts: spent, now: NOW + 60_000 }));
      expect(decision).toMatchObject({
        action: 'reassert',
        nextAttempts: { signature: '306x15<-210x48', count: 1, lastScheduledAt: NOW + 60_000 },
      });
    });

    it('a new signature (different echoed or own dims) gets a fresh budget immediately', () => {
      const spent: PtyEchoReassertAttempts = { signature: '306x15<-210x48', count: 2, lastScheduledAt: NOW };
      const differentEcho = resolvePtyEchoReassert(makeInput({ echoedCols: 320, previousAttempts: spent, now: NOW + 100 }));
      expect(differentEcho).toMatchObject({ action: 'reassert', nextAttempts: { count: 1 } });
      const differentOwn = resolvePtyEchoReassert(makeInput({ ownCols: 190, previousAttempts: spent, now: NOW + 100 }));
      expect(differentOwn).toMatchObject({ action: 'reassert', nextAttempts: { count: 1 } });
    });

    it('an intervening in-sync echo does NOT refresh the budget (the two-surface livelock bound)', () => {
      // Surface A at 306x15 and surface B at 210x48 fighting over one PTY:
      // every successful re-assert by one side lands an in-sync echo at that
      // side and a disagreeing echo at the other. The caller stores attempts
      // only on a reassert decision, so B's view of the fight is: rogue echo
      // (count 1), own in-sync echo (no change), rogue echo (count 2), own
      // in-sync echo (no change), rogue echo -> CAP. Three rounds, then quiet
      // for the rest of the window, whatever the other side does.
      let attempts: PtyEchoReassertAttempts | null = null;
      const rounds: string[] = [];
      for (let round = 0; round < 4; round += 1) {
        const timestamp = NOW + round * 400;
        const rogue = resolvePtyEchoReassert(makeInput({ previousAttempts: attempts, now: timestamp }));
        rounds.push(rogue.action === 'skip' ? rogue.reason : rogue.action);
        if (rogue.action === 'reassert') attempts = rogue.nextAttempts;
        // The echo of this side's own successful re-assert: in-sync, and the
        // caller leaves the stored attempts untouched on any skip.
        const own = resolvePtyEchoReassert(makeInput({
          echoedCols: 210, echoedRows: 48, previousAttempts: attempts, now: timestamp + 200,
        }));
        expect(own).toMatchObject({ action: 'skip', reason: 'in-sync' });
      }
      expect(rounds).toEqual(['reassert', 'reassert', 'attempt-cap', 'attempt-cap']);
    });
  });
});

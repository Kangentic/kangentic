/**
 * Cross-module contract test for the refocus catch-up in useTerminal.ts: the
 * REAL focused-terminals registry (and, for the cross-registry case, the REAL
 * parked-terminals registry too) composed with a mirror of reloadScrollback's
 * observable contract, exactly as useTerminal wires the effect:
 *
 *   onTerminalRefocus(sessionId, () => {
 *     if (scrollbackPendingRef.current) return;
 *     reloadScrollback({ skipResize: true, skipFocus: true });
 *   });
 *
 * Main gates PTY emission on its focused union, and a session can leave that
 * union WITHOUT being parked (a detail window owned by a detached monitor,
 * the bottom panel hidden, the command bar closed over a transient). Those
 * sessions had no path back to a correct grid before this edge existed.
 *
 * This is a sibling of use-terminal-park-reveal.test.ts rather than an
 * extension of it: the refocus edge never touches the incoming-write-queue
 * (only parking makes the queue ack-and-discard), so there is no queue
 * fixture to share, and keeping the files separate keeps each docstring
 * accurate to what it actually exercises.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  syncFocusedTerminals,
  onTerminalRefocus,
} from '../../src/renderer/utils/focused-terminals';
import {
  syncParkedTerminals,
  onTerminalReveal,
} from '../../src/renderer/utils/parked-terminals';

interface ReloadScrollbackOptions {
  skipResize?: boolean;
  skipFocus?: boolean;
}

afterEach(() => {
  syncFocusedTerminals(new Set());
  syncParkedTerminals(new Set());
});

describe('unfocused -> focused refocus catch-up', () => {
  it('fires exactly one catch-up reload with skipResize and skipFocus on the unfocused -> focused edge', () => {
    const sessionId = 'sess-refocus-gain';
    const scrollbackPendingRef = { current: false };
    const reloadScrollback = vi.fn((_options: ReloadScrollbackOptions) => {
      scrollbackPendingRef.current = true;
    });

    const unsubscribe = onTerminalRefocus(sessionId, () => {
      if (scrollbackPendingRef.current) return;
      reloadScrollback({ skipResize: true, skipFocus: true });
    });

    // Some other session is already focused; sessionId then gains focus.
    syncFocusedTerminals(new Set(['other-session']));
    syncFocusedTerminals(new Set(['other-session', sessionId]));

    // skipResize: the PTY was never resized while this session was unfocused,
    // so a repaint must not send a fresh SIGWINCH. skipFocus: a view change
    // can refocus many sessions in the same publish, so none of them may
    // steal window focus just by catching up.
    expect(reloadScrollback).toHaveBeenCalledTimes(1);
    expect(reloadScrollback).toHaveBeenCalledWith({ skipResize: true, skipFocus: true });

    unsubscribe();
  });

  it('does not reload when a replay is already in flight (scrollbackPendingRef.current)', () => {
    const sessionId = 'sess-refocus-pending';
    // A replay already in flight, e.g. this terminal's mount-time replay is
    // still painting when the first focus publish arrives - the common
    // startup case, where the first publish reports every session as
    // regained while those terminals are mid-mount-replay.
    const scrollbackPendingRef = { current: true };
    const reloadScrollback = vi.fn();

    const unsubscribe = onTerminalRefocus(sessionId, () => {
      if (scrollbackPendingRef.current) return;
      reloadScrollback({ skipResize: true, skipFocus: true });
    });

    syncFocusedTerminals(new Set([sessionId]));

    expect(reloadScrollback).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('does not fire again when an unchanged focused set is republished', () => {
    const sessionId = 'sess-refocus-republish';
    const scrollbackPendingRef = { current: false };
    const reloadScrollback = vi.fn(() => {
      scrollbackPendingRef.current = true;
    });

    const unsubscribe = onTerminalRefocus(sessionId, () => {
      if (scrollbackPendingRef.current) return;
      reloadScrollback({ skipResize: true, skipFocus: true });
    });

    syncFocusedTerminals(new Set([sessionId]));
    expect(reloadScrollback).toHaveBeenCalledTimes(1);

    // The earlier replay has since settled, so a second edge would not be
    // blocked by the pending guard - it must be blocked by there being no
    // transition at all (sessionId was already focused).
    scrollbackPendingRef.current = false;
    syncFocusedTerminals(new Set([sessionId]));

    expect(reloadScrollback).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('stops delivering edges to a listener after unsubscribe', () => {
    const sessionId = 'sess-refocus-unsubscribe';
    const scrollbackPendingRef = { current: false };
    const reloadScrollback = vi.fn(() => {
      scrollbackPendingRef.current = true;
    });

    const unsubscribe = onTerminalRefocus(sessionId, () => {
      if (scrollbackPendingRef.current) return;
      reloadScrollback({ skipResize: true, skipFocus: true });
    });

    unsubscribe();

    syncFocusedTerminals(new Set([sessionId]));

    expect(reloadScrollback).not.toHaveBeenCalled();
  });

  it('settles on exactly one replay for a session that is both parked and unfocused, in useFocusedSessionsSync order', () => {
    const sessionId = 'sess-refocus-and-reveal';
    const scrollbackPendingRef = { current: false };
    const reloadScrollback = vi.fn(() => {
      scrollbackPendingRef.current = true;
    });

    const unsubscribeReveal = onTerminalReveal(sessionId, () => {
      reloadScrollback({ skipResize: true, skipFocus: true });
    });
    const unsubscribeRefocus = onTerminalRefocus(sessionId, () => {
      if (scrollbackPendingRef.current) return;
      reloadScrollback({ skipResize: true, skipFocus: true });
    });

    // Starting state: the session is off-view (parked) and not focused.
    syncParkedTerminals(new Set([sessionId]));
    syncFocusedTerminals(new Set());

    // useFocusedSessionsSync's single effect run publishes the parked set
    // FIRST. sessionId reveals here: the reveal listener runs and its
    // reloadScrollback sets scrollbackPendingRef synchronously.
    syncParkedTerminals(new Set());
    expect(reloadScrollback).toHaveBeenCalledTimes(1);
    expect(scrollbackPendingRef.current).toBe(true);

    // ...then the focused set is published second, in the same effect run.
    // sessionId also refocuses here, but the refocus listener takes its
    // early return because pending is still true - it is not a race, and
    // not a generation supersession, just the pending-ref guard.
    syncFocusedTerminals(new Set([sessionId]));

    expect(reloadScrollback).toHaveBeenCalledTimes(1);

    unsubscribeReveal();
    unsubscribeRefocus();
  });
});

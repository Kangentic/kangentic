/**
 * Unit tests for `src/renderer/utils/focused-terminals.ts`.
 *
 * The registry this covers exists to close a real asymmetry: main gates PTY
 * emission on its focused union, but the only catch-up repaint used to be
 * `onTerminalReveal`, which fires on the PARKED edge. A session can leave the
 * focused set without being parked (a detail window owned by a detached
 * monitor, the bottom panel hidden, the command bar closed over a transient),
 * and those sessions had no path back to a correct grid. So the assertions here
 * are about the EDGE semantics, and deliberately never touch the parked
 * registry - the whole point is that this fires independently of it.
 *
 * Module-scope state is shared across the file, so every test ends by syncing an
 * empty set to leave the module clean for the next.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isTerminalFocused,
  computeRefocused,
  syncFocusedTerminals,
  onTerminalRefocus,
} from '../../src/renderer/utils/focused-terminals';

// `onTerminalRefocus` writes into the module-scope listener map, and
// `syncFocusedTerminals(new Set())` below only ever clears the focused SET, never
// that map. Every test currently unsubscribes as its own last statement, so a
// passing run leaves nothing behind - but if an `expect()` earlier in a test
// throws, the test body never reaches its unsubscribe call and that listener
// survives into every later test in this file. Track every subscription made
// through this helper and drain it in `afterEach` regardless of how the test
// body exits, so one flaky assertion can never cascade into unrelated failures
// downstream (the cross-test-isolation rule this file otherwise wouldn't honor).
let pendingUnsubscribes: Array<() => void> = [];

function subscribe(sessionId: string, listener: () => void): () => void {
  const unsubscribe = onTerminalRefocus(sessionId, listener);
  pendingUnsubscribes.push(unsubscribe);
  return unsubscribe;
}

afterEach(() => {
  // Safe to call even when a test already unsubscribed explicitly: the returned
  // unsubscribe is idempotent (a second `delete` on an already-removed listener
  // is a no-op).
  for (const unsubscribe of pendingUnsubscribes) unsubscribe();
  pendingUnsubscribes = [];
  syncFocusedTerminals(new Set());
});

describe('focused-terminals', () => {
  describe('computeRefocused', () => {
    it('reports only the sessions that were absent before', () => {
      expect(computeRefocused(new Set(['s1']), new Set(['s1', 's2']))).toEqual(['s2']);
      expect(computeRefocused(new Set(['s1']), new Set(['s1']))).toEqual([]);
      expect(computeRefocused(new Set(['s1']), new Set())).toEqual([]);
    });

    it('treats a first publish as every session regaining focus', () => {
      // Correct rather than noisy: on a cold start those terminals are mounting
      // anyway, and their own mount replay supersedes the catch-up.
      expect(computeRefocused(new Set(), new Set(['s1', 's2']))).toEqual(['s1', 's2']);
    });
  });

  it('flips the predicate with each sync', () => {
    expect(isTerminalFocused('s1')).toBe(false);

    syncFocusedTerminals(new Set(['s1']));
    expect(isTerminalFocused('s1')).toBe(true);
    expect(isTerminalFocused('s2')).toBe(false);

    syncFocusedTerminals(new Set(['s2']));
    expect(isTerminalFocused('s1')).toBe(false);
    expect(isTerminalFocused('s2')).toBe(true);
  });

  it('fires refocus exactly once per unfocused -> focused edge', () => {
    const refocus = vi.fn();
    subscribe('s1', refocus);

    syncFocusedTerminals(new Set(['s1']));
    expect(refocus).toHaveBeenCalledTimes(1);

    // Republishing the same focused set is not an edge.
    syncFocusedTerminals(new Set(['s1']));
    expect(refocus).toHaveBeenCalledTimes(1);

    // Losing focus is not an edge for this listener either.
    syncFocusedTerminals(new Set());
    expect(refocus).toHaveBeenCalledTimes(1);
  });

  it('repairs a session that loses focus WITHOUT being parked', () => {
    // The gap this registry closes. A remotely-owned detail window, a hidden
    // bottom panel, or a closed command bar drops the session from the focused
    // set while it stays perfectly un-parked, so the reveal edge never fires and
    // nothing repaints the stale grid.
    const refocus = vi.fn();
    subscribe('s1', refocus);

    syncFocusedTerminals(new Set(['s1']));
    expect(refocus).toHaveBeenCalledTimes(1);

    syncFocusedTerminals(new Set(['s2']));
    syncFocusedTerminals(new Set(['s1', 's2']));
    expect(refocus).toHaveBeenCalledTimes(2);
  });

  it('only notifies the refocused session, not sessions that stay focused', () => {
    const refocusFirst = vi.fn();
    const refocusSecond = vi.fn();
    subscribe('s1', refocusFirst);
    subscribe('s2', refocusSecond);

    syncFocusedTerminals(new Set(['s2']));
    expect(refocusFirst).not.toHaveBeenCalled();
    expect(refocusSecond).toHaveBeenCalledTimes(1);

    syncFocusedTerminals(new Set(['s1', 's2']));
    expect(refocusFirst).toHaveBeenCalledTimes(1);
    expect(refocusSecond).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops refocus notifications', () => {
    const refocus = vi.fn();
    const unsubscribe = subscribe('s1', refocus);
    // Called explicitly here (rather than left to afterEach) because the
    // early unsubscribe IS the behavior under test, not cleanup.
    unsubscribe();

    syncFocusedTerminals(new Set(['s1']));
    expect(refocus).not.toHaveBeenCalled();
  });

  it('a throwing listener does not block the others', () => {
    const throwing = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const surviving = vi.fn();
    subscribe('s1', throwing);
    subscribe('s1', surviving);

    expect(() => syncFocusedTerminals(new Set(['s1']))).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(surviving).toHaveBeenCalledTimes(1);
  });

  it('a listener that unsubscribes itself mid-fire stops firing without disturbing its sibling', () => {
    // Self-removal (a one-shot catch-up handler unsubscribing itself the moment
    // it runs) must both take effect for FUTURE edges and leave a listener
    // co-registered on the same session untouched: removing one entry from the
    // per-session Set is independent of any other entry's subscription. Note
    // this specific case does NOT depend on the `[...listeners]` snapshot copy
    // in syncFocusedTerminals - a JS Set iterator tolerates deleting the entry
    // it is currently visiting without disturbing the rest of the walk, copy or
    // no copy. The next test covers the case that actually needs the copy.
    let unsubscribeSelf: (() => void) | undefined;
    const selfUnsubscribing = vi.fn(() => {
      unsubscribeSelf?.();
    });
    const sibling = vi.fn();
    unsubscribeSelf = subscribe('s1', selfUnsubscribing);
    subscribe('s1', sibling);

    syncFocusedTerminals(new Set(['s1']));
    expect(selfUnsubscribing).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);

    // The self-unsubscribing listener removed itself from the registry, so only
    // the survivor fires on the next unfocused -> focused edge for this session.
    syncFocusedTerminals(new Set());
    syncFocusedTerminals(new Set(['s1']));
    expect(selfUnsubscribing).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(2);
  });

  it('a listener that unsubscribes a not-yet-fired sibling does not suppress that edge for it', () => {
    // This is what the `[...listeners]` snapshot in syncFocusedTerminals is
    // actually for: the set of listeners due to receive an edge is fixed at the
    // moment the edge fires. A listener that unsubscribes a SIBLING registered
    // after it (so still due to fire on this same pass) must not cancel that
    // sibling's delivery for the edge already in progress, only for edges after
    // it. Iterating the live Set instead of a snapshot copy would drop the
    // sibling here: deleting a not-yet-visited Set entry mid-iteration skips it
    // when the walk reaches that point, unlike deleting the current entry.
    let unsubscribeSibling: (() => void) | undefined;
    const unsubscribingListener = vi.fn(() => {
      unsubscribeSibling?.();
    });
    const sibling = vi.fn();
    subscribe('s1', unsubscribingListener); // registered first, so it fires first
    unsubscribeSibling = subscribe('s1', sibling);

    syncFocusedTerminals(new Set(['s1']));
    expect(unsubscribingListener).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);

    // The sibling was unsubscribed during the first edge, so it does not fire on
    // a later one; the listener that unsubscribed it keeps firing on every edge.
    syncFocusedTerminals(new Set());
    syncFocusedTerminals(new Set(['s1']));
    expect(unsubscribingListener).toHaveBeenCalledTimes(2);
    expect(sibling).toHaveBeenCalledTimes(1);
  });
});

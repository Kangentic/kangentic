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

afterEach(() => {
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
    const unsubscribe = onTerminalRefocus('s1', refocus);

    syncFocusedTerminals(new Set(['s1']));
    expect(refocus).toHaveBeenCalledTimes(1);

    // Republishing the same focused set is not an edge.
    syncFocusedTerminals(new Set(['s1']));
    expect(refocus).toHaveBeenCalledTimes(1);

    // Losing focus is not an edge for this listener either.
    syncFocusedTerminals(new Set());
    expect(refocus).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('repairs a session that loses focus WITHOUT being parked', () => {
    // The gap this registry closes. A remotely-owned detail window, a hidden
    // bottom panel, or a closed command bar drops the session from the focused
    // set while it stays perfectly un-parked, so the reveal edge never fires and
    // nothing repaints the stale grid.
    const refocus = vi.fn();
    const unsubscribe = onTerminalRefocus('s1', refocus);

    syncFocusedTerminals(new Set(['s1']));
    expect(refocus).toHaveBeenCalledTimes(1);

    syncFocusedTerminals(new Set(['s2']));
    syncFocusedTerminals(new Set(['s1', 's2']));
    expect(refocus).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('only notifies the refocused session, not sessions that stay focused', () => {
    const refocusFirst = vi.fn();
    const refocusSecond = vi.fn();
    const unsubscribeFirst = onTerminalRefocus('s1', refocusFirst);
    const unsubscribeSecond = onTerminalRefocus('s2', refocusSecond);

    syncFocusedTerminals(new Set(['s2']));
    expect(refocusFirst).not.toHaveBeenCalled();
    expect(refocusSecond).toHaveBeenCalledTimes(1);

    syncFocusedTerminals(new Set(['s1', 's2']));
    expect(refocusFirst).toHaveBeenCalledTimes(1);
    expect(refocusSecond).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('unsubscribe stops refocus notifications', () => {
    const refocus = vi.fn();
    const unsubscribe = onTerminalRefocus('s1', refocus);
    unsubscribe();

    syncFocusedTerminals(new Set(['s1']));
    expect(refocus).not.toHaveBeenCalled();
  });

  it('a throwing listener does not block the others', () => {
    const throwing = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const surviving = vi.fn();
    const unsubscribeThrowing = onTerminalRefocus('s1', throwing);
    const unsubscribeSurviving = onTerminalRefocus('s1', surviving);

    expect(() => syncFocusedTerminals(new Set(['s1']))).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(surviving).toHaveBeenCalledTimes(1);

    unsubscribeThrowing();
    unsubscribeSurviving();
  });
});

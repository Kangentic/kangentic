/**
 * Unit tests for `src/renderer/utils/parked-terminals.ts`.
 *
 * The parked registry is module-scope state shared across the file, so every
 * test ends by syncing an empty set to leave the module clean for the next.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isTerminalParked,
  syncParkedTerminals,
  onTerminalReveal,
} from '../../src/renderer/utils/parked-terminals';

afterEach(() => {
  syncParkedTerminals(new Set());
});

describe('parked-terminals', () => {
  it('flips the predicate with each sync', () => {
    expect(isTerminalParked('s1')).toBe(false);

    syncParkedTerminals(new Set(['s1']));
    expect(isTerminalParked('s1')).toBe(true);
    expect(isTerminalParked('s2')).toBe(false);

    syncParkedTerminals(new Set(['s2']));
    expect(isTerminalParked('s1')).toBe(false);
    expect(isTerminalParked('s2')).toBe(true);
  });

  it('fires reveal exactly once per parked -> visible edge', () => {
    const reveal = vi.fn();
    const unsubscribe = onTerminalReveal('s1', reveal);

    syncParkedTerminals(new Set(['s1']));
    expect(reveal).not.toHaveBeenCalled();

    // Republishing the same parked set is not an edge.
    syncParkedTerminals(new Set(['s1']));
    expect(reveal).not.toHaveBeenCalled();

    syncParkedTerminals(new Set());
    expect(reveal).toHaveBeenCalledTimes(1);

    // Republishing the same visible state is not an edge either.
    syncParkedTerminals(new Set());
    expect(reveal).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('fires reveal again after a re-park and re-reveal', () => {
    const reveal = vi.fn();
    const unsubscribe = onTerminalReveal('s1', reveal);

    syncParkedTerminals(new Set(['s1']));
    syncParkedTerminals(new Set());
    syncParkedTerminals(new Set(['s1']));
    syncParkedTerminals(new Set());
    expect(reveal).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('only notifies the revealed session, not sessions that stay parked', () => {
    const revealFirst = vi.fn();
    const revealSecond = vi.fn();
    const unsubscribeFirst = onTerminalReveal('s1', revealFirst);
    const unsubscribeSecond = onTerminalReveal('s2', revealSecond);

    syncParkedTerminals(new Set(['s1', 's2']));
    syncParkedTerminals(new Set(['s2']));
    expect(revealFirst).toHaveBeenCalledTimes(1);
    expect(revealSecond).not.toHaveBeenCalled();

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('unsubscribe stops reveal notifications', () => {
    const reveal = vi.fn();
    const unsubscribe = onTerminalReveal('s1', reveal);
    unsubscribe();

    syncParkedTerminals(new Set(['s1']));
    syncParkedTerminals(new Set());
    expect(reveal).not.toHaveBeenCalled();
  });

  it('a throwing listener does not block the others', () => {
    const throwing = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const surviving = vi.fn();
    const unsubscribeThrowing = onTerminalReveal('s1', throwing);
    const unsubscribeSurviving = onTerminalReveal('s1', surviving);

    syncParkedTerminals(new Set(['s1']));
    expect(() => syncParkedTerminals(new Set())).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(surviving).toHaveBeenCalledTimes(1);

    unsubscribeThrowing();
    unsubscribeSurviving();
  });
});

/**
 * Unit coverage for `isSessionSwapWithoutRemount`, the pure predicate behind
 * useTerminal's dev-only host-contract tripwire. A host (CommandTerminalWindow,
 * TerminalTab, ...) must remount (key={sessionId}) rather than swap
 * `options.sessionId` to a different live session on the same instance -
 * swapping in place leaves onData/onResize/clipboard/WebGL bound to the dead
 * session, which is exactly the Command Terminal branch-switch bug this
 * predicate now catches at dev time.
 */
import { describe, it, expect } from 'vitest';
import { isSessionSwapWithoutRemount } from '../../src/renderer/hooks/useTerminal';

describe('isSessionSwapWithoutRemount', () => {
  it('flags a live terminal whose sessionId changed to a different session', () => {
    expect(isSessionSwapWithoutRemount('sess-1', 'sess-2', true)).toBe(true);
  });

  it('does not flag the first sessionId a fresh instance ever sees (no previous id)', () => {
    expect(isSessionSwapWithoutRemount(null, 'sess-1', true)).toBe(false);
  });

  it('does not flag a correctly-keyed remount (no live terminal survives the swap)', () => {
    expect(isSessionSwapWithoutRemount('sess-1', 'sess-2', false)).toBe(false);
  });

  it('does not flag the same sessionId repeating (a no-op re-render)', () => {
    expect(isSessionSwapWithoutRemount('sess-1', 'sess-1', true)).toBe(false);
  });

  it('does not flag a transition to a null sessionId (a host going session-less)', () => {
    expect(isSessionSwapWithoutRemount('sess-1', null, true)).toBe(false);
  });

  it('does not flag two null sessionIds (a session-less pane re-rendering)', () => {
    expect(isSessionSwapWithoutRemount(null, null, true)).toBe(false);
  });
});

/**
 * Unit tests for resolveTerminalBackground (src/renderer/hooks/useTerminal.ts).
 *
 * Surfaces that must paint the identical background color BEFORE (or
 * independent of) the live xterm instance - the host container, the replay
 * veil (see TerminalTab.tsx, CommandTerminalWindow.tsx) - call this function
 * so they never drift from the user's configured terminal background. It
 * must return the user's override when set, and fall back to the built-in
 * default whenever the override is absent OR is an empty string (an empty
 * string is not a valid CSS color and must not be honored - see the `||`
 * fallback in the source, not `??`).
 */
import { describe, it, expect } from 'vitest';
import { resolveTerminalBackground, TERMINAL_DEFAULT_COLORS } from '../../src/renderer/hooks/useTerminal';

describe('resolveTerminalBackground', () => {
  it('falls back to the built-in default when overrides is undefined', () => {
    expect(resolveTerminalBackground(undefined)).toBe(TERMINAL_DEFAULT_COLORS.background);
  });

  it('falls back to the built-in default when overrides is empty', () => {
    expect(resolveTerminalBackground({})).toBe(TERMINAL_DEFAULT_COLORS.background);
  });

  it('falls back to the built-in default when background is an empty string', () => {
    // Deliberately NOT honored: an empty string is an invalid color, so the
    // `||` fallback (not `??`) must treat it the same as "unset".
    expect(resolveTerminalBackground({ background: '' })).toBe(TERMINAL_DEFAULT_COLORS.background);
  });

  it('honors the user override when set', () => {
    expect(resolveTerminalBackground({ background: '#ff0000' })).toBe('#ff0000');
  });

  it('pins the built-in default hex value itself', () => {
    // Locks the actual default so a change to TERMINAL_DEFAULT_COLORS.background
    // is a deliberate, visible diff in this test rather than silently drifting.
    expect(TERMINAL_DEFAULT_COLORS.background).toBe('#0c0c0c');
  });
});

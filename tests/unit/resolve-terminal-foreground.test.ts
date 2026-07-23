/**
 * Unit tests for resolveTerminalForeground (src/renderer/hooks/useTerminal.ts).
 *
 * Mirrors resolve-terminal-background.test.ts: a surface that must paint
 * terminal-matching text (e.g. LaunchOverlay's terminal variant) calls this
 * function so it never drifts from the user's configured terminal
 * foreground. It must return the user's override when set, and fall back to
 * the built-in default whenever the override is absent OR is an empty string
 * (an empty string is not a valid CSS color and must not be honored - see
 * the `||` fallback in the source, not `??`).
 */
import { describe, it, expect } from 'vitest';
import { resolveTerminalForeground, TERMINAL_DEFAULT_COLORS } from '../../src/renderer/hooks/useTerminal';

describe('resolveTerminalForeground', () => {
  it('falls back to the built-in default when overrides is undefined', () => {
    expect(resolveTerminalForeground(undefined)).toBe(TERMINAL_DEFAULT_COLORS.foreground);
  });

  it('falls back to the built-in default when overrides is empty', () => {
    expect(resolveTerminalForeground({})).toBe(TERMINAL_DEFAULT_COLORS.foreground);
  });

  it('falls back to the built-in default when foreground is an empty string', () => {
    // Deliberately NOT honored: an empty string is an invalid color, so the
    // `||` fallback (not `??`) must treat it the same as "unset".
    expect(resolveTerminalForeground({ foreground: '' })).toBe(TERMINAL_DEFAULT_COLORS.foreground);
  });

  it('honors the user override when set', () => {
    expect(resolveTerminalForeground({ foreground: '#ff0000' })).toBe('#ff0000');
  });

  it('pins the built-in default hex value itself', () => {
    // Locks the actual default so a change to TERMINAL_DEFAULT_COLORS.foreground
    // is a deliberate, visible diff in this test rather than silently drifting.
    expect(TERMINAL_DEFAULT_COLORS.foreground).toBe('#e4e4e7');
  });
});

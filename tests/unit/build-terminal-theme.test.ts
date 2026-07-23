/**
 * Unit tests for buildTerminalTheme (src/renderer/hooks/useTerminal.ts).
 *
 * Builds the full xterm theme object passed to `new Terminal({ theme })` and to
 * the live-apply effect's `terminal.options = { theme: ... }` reassignment.
 * resolveTerminalBackground's own fallback/empty-string edge cases are already
 * covered by resolve-terminal-background.test.ts; this file covers what
 * buildTerminalTheme adds on top: cursorAccent tracking the resolved
 * background, foreground/cursor override fallback, and the ANSI 16 palette
 * staying fixed regardless of user overrides.
 */
import { describe, it, expect } from 'vitest';
import { buildTerminalTheme, TERMINAL_DEFAULT_COLORS } from '../../src/renderer/hooks/useTerminal';

describe('buildTerminalTheme', () => {
  it('tracks cursorAccent to the resolved (default) background when unset', () => {
    const theme = buildTerminalTheme(undefined);
    expect(theme.background).toBe(TERMINAL_DEFAULT_COLORS.background);
    expect(theme.cursorAccent).toBe(theme.background);
  });

  it('tracks cursorAccent to a custom background override', () => {
    const theme = buildTerminalTheme({ background: '#123456' });
    expect(theme.background).toBe('#123456');
    expect(theme.cursorAccent).toBe('#123456');
  });

  it('honors a foreground override', () => {
    const theme = buildTerminalTheme({ foreground: '#abcdef' });
    expect(theme.foreground).toBe('#abcdef');
  });

  it('falls back foreground to the default when the override is an empty string', () => {
    // Same `||` (not `??`) semantics as resolveTerminalBackground's background
    // fallback - an empty string is not a valid CSS color.
    const theme = buildTerminalTheme({ foreground: '' });
    expect(theme.foreground).toBe(TERMINAL_DEFAULT_COLORS.foreground);
  });

  it('honors a cursor override', () => {
    const theme = buildTerminalTheme({ cursor: '#fedcba' });
    expect(theme.cursor).toBe('#fedcba');
  });

  it('falls back cursor to the default when unset', () => {
    const theme = buildTerminalTheme({});
    expect(theme.cursor).toBe(TERMINAL_DEFAULT_COLORS.cursor);
  });

  it('keeps the fixed ANSI 16 palette regardless of user overrides', () => {
    const theme = buildTerminalTheme({
      background: '#000001',
      foreground: '#000002',
      cursor: '#000003',
    });
    // The 16-color ANSI palette is not user-customizable (see
    // TerminalColorOverrides docs) - it must stay the built-in scheme.
    expect(theme.red).toBe(TERMINAL_DEFAULT_COLORS.red);
    expect(theme.green).toBe(TERMINAL_DEFAULT_COLORS.green);
    expect(theme.black).toBe(TERMINAL_DEFAULT_COLORS.black);
    expect(theme.brightWhite).toBe(TERMINAL_DEFAULT_COLORS.brightWhite);
  });
});

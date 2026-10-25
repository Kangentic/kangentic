/**
 * Each platform's native terminal defaults (src/shared/terminal-native-defaults.ts):
 * what its own default terminal draws, from Windows Terminal's profiles.schema.json
 * and GNOME's gsettings schemas.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import {
  PREVIOUS_TERMINAL_DEFAULTS,
  isPreviousTerminalDefault,
  nativeTerminalDefaults,
} from '../../src/shared/terminal-native-defaults';

describe('nativeTerminalDefaults', () => {
  it('gives Windows Windows Terminal\'s Cascadia Mono and bar cursor at 14px, Consolas behind it', () => {
    expect(nativeTerminalDefaults('win32')).toEqual({
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 14,
      cursorStyle: 'bar',
    });
  });

  it('gives Linux GNOME\'s Adwaita Mono and block cursor at 14px', () => {
    expect(nativeTerminalDefaults('linux')).toEqual({
      fontFamily: '"Adwaita Mono", "Source Code Pro", "DejaVu Sans Mono", monospace',
      fontSize: 14,
      cursorStyle: 'block',
    });
  });

  it('keeps every platform at 14px, the size whose glyphs fit their cells', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(nativeTerminalDefaults(platform).fontSize).toBe(14);
    }
  });

  it('keeps macOS, and any other platform, on the previous default until its native one is confirmed', () => {
    expect(nativeTerminalDefaults('darwin')).toEqual(PREVIOUS_TERMINAL_DEFAULTS);
    expect(nativeTerminalDefaults('freebsd')).toEqual(PREVIOUS_TERMINAL_DEFAULTS);
  });

  it('is the value DEFAULT_CONFIG falls back to, so the two cannot drift', () => {
    expect(DEFAULT_CONFIG.terminal).toMatchObject(PREVIOUS_TERMINAL_DEFAULTS);
  });
});

describe('isPreviousTerminalDefault', () => {
  it('is true only for the exact old font and size', () => {
    expect(isPreviousTerminalDefault({ fontFamily: PREVIOUS_TERMINAL_DEFAULTS.fontFamily, fontSize: 14 })).toBe(true);
    expect(isPreviousTerminalDefault({ fontFamily: PREVIOUS_TERMINAL_DEFAULTS.fontFamily, fontSize: 13 })).toBe(false);
    expect(isPreviousTerminalDefault({ fontFamily: 'Fira Code', fontSize: 14 })).toBe(false);
    expect(isPreviousTerminalDefault({ fontFamily: null, fontSize: 14 })).toBe(false);
  });
});

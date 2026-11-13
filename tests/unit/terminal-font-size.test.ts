/**
 * A sub-pixel font never reaches xterm (Sentry DESKTOP-1J/1K).
 *
 * xterm's WebGL renderer floors the character width to whole device pixels, so a
 * font whose 'W' measures under one device pixel builds a glyph atlas 0 pixels
 * wide, and the first `_` it rasterizes throws `IndexSizeError`. The Settings field
 * committed every keystroke, so typing "12" applied 1px first. The behavior case,
 * on real WebGL, is tests/ui/terminal-webgl-subpixel-font.spec.ts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import {
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_LINE_HEIGHT_DEFAULT,
  resolveTerminalFontSize,
  resolveTerminalLineHeight,
} from '../../src/renderer/utils/terminal-font-size';
import { DEFAULT_CONFIG } from '../../src/shared/types';

describe('resolveTerminalFontSize', () => {
  it('holds a size below the floor at the floor', () => {
    expect(resolveTerminalFontSize(1)).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(resolveTerminalFontSize(0.5)).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(resolveTerminalFontSize(TERMINAL_FONT_SIZE_MIN - 1)).toBe(TERMINAL_FONT_SIZE_MIN);
  });

  it('falls back to the default for a missing or unusable size', () => {
    for (const unusable of [undefined, null, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveTerminalFontSize(unusable)).toBe(DEFAULT_CONFIG.terminal.fontSize);
    }
  });

  it('passes a usable size through, including one above the field\'s maximum', () => {
    expect(resolveTerminalFontSize(TERMINAL_FONT_SIZE_MIN)).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(resolveTerminalFontSize(12)).toBe(12);
    expect(resolveTerminalFontSize(40)).toBe(40);
  });

  it('is the only way useTerminal reads the configured size', () => {
    // A raw `options.fontSize || 14` anywhere would let 1px through, and would
    // disagree with the resolved size the conform memo and the display effect
    // compare against.
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(/options\.fontSize\s*\|\|/u);
    // The hook's own `options` bag, not `terminal.options.fontSize` (xterm's).
    expect(source.match(/(?<![.\w])options\.fontSize/gu) ?? []).toHaveLength(1);
    expect(source).toContain('const configuredFontSize = resolveTerminalFontSize(options.fontSize);');
  });
});

// `config.terminal.lineHeight` has no settings row; the web demo sets it (1.17) so Inconsolata draws
// the 14px rows its recordings were made at. xterm throws on a value under 1, so a hand-edited
// config must never reach the constructor with one.
describe('resolveTerminalLineHeight', () => {
  it('runs at xterm\'s own default when the config names none or one xterm would refuse', () => {
    for (const unusable of [undefined, null, 0, 0.9, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveTerminalLineHeight(unusable)).toBe(TERMINAL_LINE_HEIGHT_DEFAULT);
    }
    expect(TERMINAL_LINE_HEIGHT_DEFAULT).toBe(new Terminal({ allowProposedApi: true }).options.lineHeight);
  });

  it('passes a line height of at least 1 through, and xterm accepts it', () => {
    expect(resolveTerminalLineHeight(1)).toBe(1);
    expect(resolveTerminalLineHeight(1.17)).toBe(1.17);
    const terminal = new Terminal({ lineHeight: resolveTerminalLineHeight(1.17) });
    expect(terminal.options.lineHeight).toBe(1.17);
  });

  it('reaches xterm from config on construction and on a settings change', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'), 'utf-8');
    expect(source).toContain('const configuredLineHeight = resolveTerminalLineHeight(options.lineHeight);');
    // Once in the constructor, once in the display-settings effect's options.
    expect(source.match(/lineHeight: configuredLineHeight,/gu) ?? []).toHaveLength(2);
    for (const host of ['terminal/TerminalTab.tsx', 'command-bar/CommandTerminalPane.tsx', 'workflows/WorkflowAgentPane.tsx']) {
      const hostSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'renderer', 'components', host), 'utf-8');
      expect(hostSource, host).toContain('lineHeight: config.terminal.lineHeight,');
    }
  });
});

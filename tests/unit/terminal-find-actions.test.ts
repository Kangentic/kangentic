/**
 * The terminal find helpers that touch an xterm and its search addon: which addon call a
 * direction makes, the decorations a search hands the addon, what closing does, and the
 * reach a search covers. The pure helpers sit in terminal-find.test.ts.
 *
 * The vitest environment is node, so `document` and `getComputedStyle` are stubbed to
 * answer for the `--kng-warning` token, and the terminal and addon are the minimum shape
 * the helpers read. The helpers under test are the real ones.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { clearTerminalFind, readTerminalReach, runTerminalFind } from '../../src/renderer/utils/terminal-find';

function stubWarningToken(token: string): void {
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => token }));
}

function fakeTerminal(background: string | undefined): Terminal {
  return { options: { theme: background === undefined ? undefined : { background } } } as unknown as Terminal;
}

function fakeAddon() {
  return { findPrevious: vi.fn(), findNext: vi.fn(), dispose: vi.fn() };
}

const OPAQUE_HEX = /^#[0-9a-f]{6}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runTerminalFind', () => {
  it('searches toward older output with findPrevious and toward newer output with findNext', () => {
    stubWarningToken('#d9b83f');
    const addon = fakeAddon();

    runTerminalFind(fakeTerminal('#0c0c0c'), addon as unknown as SearchAddon, 'build', 'older');
    expect(addon.findPrevious).toHaveBeenCalledTimes(1);
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.findPrevious.mock.calls[0][0]).toBe('build');

    runTerminalFind(fakeTerminal('#0c0c0c'), addon as unknown as SearchAddon, 'build', 'newer');
    expect(addon.findNext).toHaveBeenCalledTimes(1);
    expect(addon.findPrevious).toHaveBeenCalledTimes(1);
    expect(addon.findNext.mock.calls[0][0]).toBe('build');
  });

  it('hands the addon opaque #RRGGBB colors, which xterm requires, blended from the theme token', () => {
    stubWarningToken('#d9b83f');
    const addon = fakeAddon();

    runTerminalFind(fakeTerminal('#0c0c0c'), addon as unknown as SearchAddon, 'x', 'older');

    const { decorations } = addon.findPrevious.mock.calls[0][1];
    expect(decorations.matchBackground).toBe('#54481e');
    expect(decorations.matchOverviewRuler).toBe(decorations.matchBackground);
    expect(decorations.activeMatchBorder).toBe('#d9b83f');
    expect(decorations.activeMatchBackground).toMatch(OPAQUE_HEX);
    expect(decorations.activeMatchBackground).not.toBe(decorations.matchBackground);
    expect(decorations.activeMatchColorOverviewRuler).toBe(decorations.activeMatchBackground);
  });

  it('falls back to a fixed highlight when the theme token is not #RRGGBB, so xterm never gets a color it rejects', () => {
    stubWarningToken('rgb(217, 184, 63)');
    const addon = fakeAddon();

    runTerminalFind(fakeTerminal('#0c0c0c'), addon as unknown as SearchAddon, 'x', 'older');

    const { decorations } = addon.findPrevious.mock.calls[0][1];
    for (const color of Object.values<string>(decorations)) expect(color).toMatch(OPAQUE_HEX);
    expect(decorations.activeMatchBorder).toBe('#d9b83f');
  });

  it('falls back to a fixed background for a custom background that is not #RRGGBB or is unset', () => {
    stubWarningToken('#d9b83f');
    const reference = fakeAddon();
    runTerminalFind(fakeTerminal('#0c0c0c'), reference as unknown as SearchAddon, 'x', 'older');
    const expected = reference.findPrevious.mock.calls[0][1].decorations;

    for (const background of ['rgba(0, 0, 0, 0.8)', 'black', '', undefined]) {
      const addon = fakeAddon();
      runTerminalFind(fakeTerminal(background), addon as unknown as SearchAddon, 'x', 'older');
      const { decorations } = addon.findPrevious.mock.calls[0][1];
      for (const color of Object.values<string>(decorations)) expect(color).toMatch(OPAQUE_HEX);
      expect(decorations).toEqual(expected);
    }
  });

  it('reads the token at each search, so a theme change applies to the next one', () => {
    const addon = fakeAddon();
    stubWarningToken('#d9b83f');
    runTerminalFind(fakeTerminal('#0c0c0c'), addon as unknown as SearchAddon, 'x', 'older');
    stubWarningToken('#3fd9b8');
    runTerminalFind(fakeTerminal('#0c0c0c'), addon as unknown as SearchAddon, 'x', 'older');

    expect(addon.findPrevious.mock.calls[0][1].decorations.activeMatchBorder).toBe('#d9b83f');
    expect(addon.findPrevious.mock.calls[1][1].decorations.activeMatchBorder).toBe('#3fd9b8');
  });
});

describe('clearTerminalFind', () => {
  it('disposes the addon, not clearDecorations, and drops the selection so the next Ctrl+C interrupts', () => {
    const addon = { dispose: vi.fn(), clearDecorations: vi.fn() };
    const terminal = { clearSelection: vi.fn() };

    clearTerminalFind(terminal as unknown as Terminal, addon as unknown as SearchAddon);

    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(addon.clearDecorations).not.toHaveBeenCalled();
    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('tolerates a terminal or an addon that is already gone', () => {
    const addon = { dispose: vi.fn() };
    const terminal = { clearSelection: vi.fn() };

    expect(() => clearTerminalFind(null, addon as unknown as SearchAddon)).not.toThrow();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(() => clearTerminalFind(terminal as unknown as Terminal, null)).not.toThrow();
    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
    expect(() => clearTerminalFind(null, null)).not.toThrow();
  });
});

describe('readTerminalReach', () => {
  function terminalWithBuffer(buffer: { type: string; baseY: number; cursorY: number }): Terminal {
    return { buffer: { active: buffer } } as unknown as Terminal;
  }

  it('counts the lines from the oldest held to the cursor, cursor line included', () => {
    expect(readTerminalReach(terminalWithBuffer({ type: 'normal', baseY: 120, cursorY: 4 }))).toEqual({ alternate: false, lines: 125 });
  });

  it('reads the alternate screen as the screen alone, since its baseY is 0', () => {
    expect(readTerminalReach(terminalWithBuffer({ type: 'alternate', baseY: 0, cursorY: 23 }))).toEqual({ alternate: true, lines: 24 });
  });

  it('reports no reach before a terminal exists', () => {
    expect(readTerminalReach(null)).toEqual({ alternate: false, lines: 0 });
  });
});

/**
 * The smallest terminal area the Command Terminal panel's terminals fit in
 * (src/renderer/components/command-bar/command-terminal-grid-fit.ts). The panel
 * never resizes under it, so a resize can never take the grid away.
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_TERMINAL_FLOOR, commandTerminalGridMinimum } from '../../src/renderer/components/command-bar/command-terminal-grid-fit';

describe('commandTerminalGridMinimum', () => {
  it('is one terminal at the floor for one terminal, or none', () => {
    expect(commandTerminalGridMinimum(1, false)).toEqual({ width: 630, height: 200 });
    expect(commandTerminalGridMinimum(0, false)).toEqual({ width: 630, height: 200 });
  });

  it('is two floors wide for two side by side', () => {
    expect(commandTerminalGridMinimum(2, false)).toEqual({ width: 1260, height: 200 });
  });

  it('adds a second row of the height floor for three and four', () => {
    expect(commandTerminalGridMinimum(3, false)).toEqual({ width: 1260, height: 400 });
    expect(commandTerminalGridMinimum(4, false)).toEqual({ width: 1260, height: 400 });
  });

  it('is one terminal at the floor while one is expanded, whatever the count', () => {
    expect(commandTerminalGridMinimum(2, true)).toEqual({ width: 630, height: 200 });
    expect(commandTerminalGridMinimum(4, true)).toEqual({ width: 630, height: 200 });
  });

  it('holds two side by side beside the narrowest rail on a 1920 screen', () => {
    const panelBorder = 2;
    const narrowestRail = 200;
    expect(narrowestRail + commandTerminalGridMinimum(2, false).width + panelBorder).toBeLessThanOrEqual(1920);
  });

  it('takes another floor', () => {
    expect(commandTerminalGridMinimum(4, false, { width: 650, height: 200 })).toEqual({ width: 1300, height: 400 });
    expect(COMMAND_TERMINAL_FLOOR).toEqual({ width: 630, height: 200 });
  });
});

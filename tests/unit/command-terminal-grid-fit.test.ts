/**
 * Whether the Command Terminal panel can show its terminals as a grid at the
 * pane floor (src/renderer/components/command-bar/command-terminal-grid-fit.ts).
 * The floor is a task window's 650px width; an area too small for the preset
 * shows one terminal expanded instead.
 */
import { describe, expect, it } from 'vitest';
import { commandTerminalGridFits } from '../../src/renderer/components/command-bar/command-terminal-grid-fit';

const FLOOR = { width: 650, height: 200 };

describe('commandTerminalGridFits', () => {
  it('always fits one terminal, whatever the area: it fills the panel', () => {
    expect(commandTerminalGridFits(1, { width: 300, height: 100 }, FLOOR)).toBe(true);
    expect(commandTerminalGridFits(0, { width: 0, height: 0 }, FLOOR)).toBe(true);
  });

  it('fits two side by side only from two floors wide', () => {
    expect(commandTerminalGridFits(2, { width: 1300, height: 200 }, FLOOR)).toBe(true);
    expect(commandTerminalGridFits(2, { width: 1299, height: 900 }, FLOOR)).toBe(false);
  });

  it('needs two rows of the height floor for three and four', () => {
    expect(commandTerminalGridFits(3, { width: 1300, height: 400 }, FLOOR)).toBe(true);
    expect(commandTerminalGridFits(3, { width: 1300, height: 399 }, FLOOR)).toBe(false);
    expect(commandTerminalGridFits(4, { width: 1672, height: 922 }, FLOOR)).toBe(true);
    expect(commandTerminalGridFits(4, { width: 1113, height: 922 }, FLOOR)).toBe(false);
  });

  it('does not fit two at the 900px window floor, where the rail leaves one terminal width', () => {
    expect(commandTerminalGridFits(2, { width: 900 - 248 - 2, height: 480 }, FLOOR)).toBe(false);
  });
});

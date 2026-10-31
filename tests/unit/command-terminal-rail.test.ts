/**
 * The Command Terminal rail's shown width (src/shared/command-terminal-rail.ts).
 *
 * The user's width is global and kept across restarts, so the rule that
 * matters is that a narrow window SHOWS the rail narrower without the saved
 * width ever changing: the resolver is pure and returns a width, it never
 * writes one, and the saved width comes back the moment there is room.
 */
import { describe, it, expect } from 'vitest';
import {
  COMMAND_RAIL_COLLAPSED_WIDTH_PX,
  COMMAND_RAIL_DEFAULT_WIDTH_PX,
  COMMAND_RAIL_MAX_WIDTH_PX,
  COMMAND_RAIL_MIN_WIDTH_PX,
  resolveRailWidth,
  savedRailWidth,
} from '../../src/shared/command-terminal-rail';

/** The terminals' grid at the 630px floor (`commandTerminalGridMinimum`): one terminal, and two side by side. */
const TERMINAL_FLOOR = 630;
const TWO_TERMINAL_FLOOR = 1260;

describe('resolveRailWidth', () => {
  it('shows the saved width when the row has room for it beside the terminals at their floor', () => {
    expect(resolveRailWidth({ saved: { width: 360, collapsed: false }, rowWidth: 1800, terminalFloorWidth: TWO_TERMINAL_FLOOR })).toBe(360);
  });

  it('narrows the rail in a row too small for it, down to the drag minimum', () => {
    // The 900px window floor: the panel's body row is 898px, which leaves 268 beside one terminal.
    expect(resolveRailWidth({ saved: { width: 360, collapsed: false }, rowWidth: 898, terminalFloorWidth: TERMINAL_FLOOR })).toBe(268);
    expect(resolveRailWidth({ saved: { width: 360, collapsed: false }, rowWidth: 1540, terminalFloorWidth: TWO_TERMINAL_FLOOR })).toBe(280);
    expect(resolveRailWidth({ saved: { width: 360, collapsed: false }, rowWidth: 898, terminalFloorWidth: TWO_TERMINAL_FLOOR })).toBe(COMMAND_RAIL_MIN_WIDTH_PX);
    expect(resolveRailWidth({ saved: { width: 360, collapsed: false }, rowWidth: 700, terminalFloorWidth: TERMINAL_FLOOR })).toBe(COMMAND_RAIL_MIN_WIDTH_PX);
  });

  it('never writes the narrowing back: the same saved width shows whole again with room', () => {
    const saved = { width: 360, collapsed: false };
    resolveRailWidth({ saved, rowWidth: 898, terminalFloorWidth: TERMINAL_FLOOR });
    expect(saved).toEqual({ width: 360, collapsed: false });
    expect(resolveRailWidth({ saved, rowWidth: 1600, terminalFloorWidth: TERMINAL_FLOOR })).toBe(360);
  });

  it('shows the strip when folded, whatever the saved width and the room', () => {
    expect(resolveRailWidth({ saved: { width: 400, collapsed: true }, rowWidth: 2000, terminalFloorWidth: TERMINAL_FLOOR }))
      .toBe(COMMAND_RAIL_COLLAPSED_WIDTH_PX);
  });

  it('shows the saved width before the row is measured', () => {
    expect(resolveRailWidth({ saved: { width: 320, collapsed: false }, rowWidth: 0, terminalFloorWidth: TERMINAL_FLOOR })).toBe(320);
  });
});

describe('savedRailWidth', () => {
  it('keeps a width the drag could have produced', () => {
    expect(savedRailWidth(COMMAND_RAIL_MIN_WIDTH_PX)).toBe(COMMAND_RAIL_MIN_WIDTH_PX);
    expect(savedRailWidth(333)).toBe(333);
    expect(savedRailWidth(COMMAND_RAIL_MAX_WIDTH_PX)).toBe(COMMAND_RAIL_MAX_WIDTH_PX);
  });

  it('brings an out-of-range width into range and rounds it', () => {
    expect(savedRailWidth(120)).toBe(COMMAND_RAIL_MIN_WIDTH_PX);
    expect(savedRailWidth(900)).toBe(COMMAND_RAIL_MAX_WIDTH_PX);
    expect(savedRailWidth(301.6)).toBe(302);
  });

  it('falls back to the default for anything that is not a width', () => {
    expect(savedRailWidth(undefined)).toBe(COMMAND_RAIL_DEFAULT_WIDTH_PX);
    expect(savedRailWidth('wide')).toBe(COMMAND_RAIL_DEFAULT_WIDTH_PX);
    expect(savedRailWidth(Number.NaN)).toBe(COMMAND_RAIL_DEFAULT_WIDTH_PX);
  });
});

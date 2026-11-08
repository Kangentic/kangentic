/**
 * The terminal link tip (src/renderer/utils/terminal-links/link-tip.ts): where it points and what
 * it says. What a user loses if this goes: a tip over the wrong row of a wrapped or scrolled link,
 * or one that tells a Mac user to Ctrl+click, which there is a right click.
 */
import { describe, expect, it } from 'vitest';
import { linkRowAnchor, linkTipText, type CellGrid } from '../../src/renderer/utils/terminal-links/link-tip';

/** 40 by 10 cells of 8 by 16 pixels, with the screen's top left corner at (100, 50). */
const GRID: CellGrid = { left: 100, top: 50, cellWidth: 8, cellHeight: 16, rows: 10, cols: 40, viewportY: 0 };

/** A pointer a few pixels into the given 0-based viewport row. */
function pointerOnViewportRow(row: number, grid: CellGrid = GRID): number {
  return grid.top + row * grid.cellHeight + 3;
}

describe('linkRowAnchor', () => {
  it('covers the cells of a one-row link', () => {
    const range = { start: { x: 5, y: 3 }, end: { x: 14, y: 3 } };
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(2))).toEqual({ left: 132, width: 80, top: 82, bottom: 98 });
  });

  it('points at the row under the pointer of a wrapped link, clipped to that row', () => {
    const range = { start: { x: 30, y: 2 }, end: { x: 6, y: 4 } };
    // First row: from the link's start to the edge.
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(1))).toEqual({ left: 332, width: 88, top: 66, bottom: 82 });
    // A middle row: the whole row.
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(2))).toEqual({ left: 100, width: 320, top: 82, bottom: 98 });
    // Last row: from the edge to the link's end.
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(3))).toEqual({ left: 100, width: 48, top: 98, bottom: 114 });
  });

  it('reads buffer rows against a scrolled viewport', () => {
    const scrolled = { ...GRID, viewportY: 100 };
    const range = { start: { x: 1, y: 103 }, end: { x: 4, y: 103 } };
    expect(linkRowAnchor(range, scrolled, pointerOnViewportRow(2, scrolled))).toEqual({ left: 100, width: 32, top: 82, bottom: 98 });
  });

  it('keeps to the link rows when the pointer reads just off them', () => {
    const range = { start: { x: 1, y: 3 }, end: { x: 4, y: 3 } };
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(3))).toEqual({ left: 100, width: 32, top: 82, bottom: 98 });
  });

  it('points nowhere when the link row has scrolled out of view', () => {
    const range = { start: { x: 1, y: 3 }, end: { x: 4, y: 3 } };
    expect(linkRowAnchor(range, { ...GRID, viewportY: 5 }, pointerOnViewportRow(0))).toBeNull();
  });

  it('points nowhere before the terminal has a size', () => {
    const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
    expect(linkRowAnchor(range, { ...GRID, cellWidth: 0 }, pointerOnViewportRow(0))).toBeNull();
  });
});

describe('linkTipText', () => {
  it.each([
    ['a URL', 'url', 'Open in browser'],
    ['a path', 'path', 'Show in folder'],
  ] as const)('says what a click on %s does', (_label, kind, expected) => {
    expect(linkTipText(kind, false).label).toBe(expected);
  });

  it('shows Ctrl then Click off a Mac', () => {
    expect(linkTipText('url', false).keys).toEqual(['Ctrl', 'Click']);
  });

  it('shows Cmd then Click on a Mac, where Ctrl+click is a right click', () => {
    expect(linkTipText('url', true).keys).toEqual(['⌘', 'Click']);
  });
});

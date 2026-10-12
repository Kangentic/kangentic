/**
 * Where a card's right-click menu goes (`placeContextMenu`). A workflow task's
 * menu (its workflow rows plus every Move to row) is taller than any fixed
 * guess, so the menu is measured and moved inside the window, 8px from each
 * edge, and scrolls when it is taller than the window.
 */
import { describe, it, expect } from 'vitest';
import { CONTEXT_MENU_VIEWPORT_MARGIN, placeContextMenu } from '../../src/renderer/components/board/context-menu-placement';

const VIEWPORT = { width: 1200, height: 800 };
const MENU = { width: 220, height: 300 };

describe('placeContextMenu', () => {
  it('opens at the press when the menu fits', () => {
    expect(placeContextMenu({ x: 400, y: 200 }, MENU, VIEWPORT)).toEqual({ left: 400, top: 200, maxHeight: undefined });
  });

  it('moves left of the right edge, keeping the margin', () => {
    const placement = placeContextMenu({ x: 1150, y: 200 }, MENU, VIEWPORT);
    expect(placement.left).toBe(VIEWPORT.width - MENU.width - CONTEXT_MENU_VIEWPORT_MARGIN);
    expect(placement.top).toBe(200);
  });

  it('moves up from the bottom edge, keeping the margin', () => {
    const placement = placeContextMenu({ x: 400, y: 700 }, MENU, VIEWPORT);
    expect(placement.top).toBe(VIEWPORT.height - MENU.height - CONTEXT_MENU_VIEWPORT_MARGIN);
    expect(placement.maxHeight).toBeUndefined();
  });

  it('caps a menu taller than the window at the window less its margins, from the top margin', () => {
    const tall = { width: 220, height: 1_400 };
    const placement = placeContextMenu({ x: 400, y: 500 }, tall, VIEWPORT);
    expect(placement.maxHeight).toBe(VIEWPORT.height - CONTEXT_MENU_VIEWPORT_MARGIN * 2);
    expect(placement.top).toBe(CONTEXT_MENU_VIEWPORT_MARGIN);
  });

  it('never goes past the top or left margin, however small the window', () => {
    const placement = placeContextMenu({ x: 2, y: 3 }, MENU, { width: 200, height: 250 });
    expect(placement.left).toBe(CONTEXT_MENU_VIEWPORT_MARGIN);
    expect(placement.top).toBe(CONTEXT_MENU_VIEWPORT_MARGIN);
  });
});

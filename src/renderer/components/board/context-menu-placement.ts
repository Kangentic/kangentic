/** The menu's distance from the window's edges once it is moved inside. */
export const CONTEXT_MENU_VIEWPORT_MARGIN = 8;

export interface MenuPlacement {
  left: number;
  top: number;
  /** Set only when the menu is taller than the window; it then scrolls. */
  maxHeight: number | undefined;
}

/**
 * Where a menu of this size goes for a press at this point, kept inside the
 * window, 8px from each edge. A menu taller than the window gets the window's
 * height and scrolls. A module of its own so `TaskContextMenu.tsx` exports only
 * its component and stays a Fast Refresh boundary.
 */
export function placeContextMenu(
  pointer: { x: number; y: number },
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
): MenuPlacement {
  const availableHeight = viewport.height - CONTEXT_MENU_VIEWPORT_MARGIN * 2;
  const height = Math.min(menuSize.height, availableHeight);
  return {
    left: Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(pointer.x, viewport.width - menuSize.width - CONTEXT_MENU_VIEWPORT_MARGIN)),
    top: Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(pointer.y, viewport.height - height - CONTEXT_MENU_VIEWPORT_MARGIN)),
    maxHeight: menuSize.height > availableHeight ? availableHeight : undefined,
  };
}

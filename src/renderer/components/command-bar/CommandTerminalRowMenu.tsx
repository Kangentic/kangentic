/**
 * The right-click menu on a terminal's Running row in the rail, or on its chip
 * in the collapsed rail: that terminal's whole ... menu, at the pointer
 * (`CommandTerminalMenuItems`, the same list its header's kebab shows).
 *
 * It looks and dismisses as `KebabMenu` does: a `document.body` portal (the
 * panel is transformed and clips, so an in-flow menu would be cut off or placed
 * against the wrong box), a capture-phase outside press, and a capture-phase
 * Escape that closes the menu and nothing under it. Placed before paint with
 * `placeContextMenu`, so it never shows at the press point first and stays
 * inside the window.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeContextMenu, type MenuPlacement } from '../board/context-menu-placement';
import { CommandTerminalMenuItems, type CommandTerminalMenuActions } from './CommandTerminalMenuItems';

interface CommandTerminalRowMenuProps extends CommandTerminalMenuActions {
  /** Where the right-click landed, in viewport pixels. */
  position: { x: number; y: number };
  onClose: () => void;
}

export function CommandTerminalRowMenu({ position, onClose, ...actions }: CommandTerminalRowMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePress = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    // Escape closes the menu, not the window or panel behind it: the in-gesture
    // shape `KebabMenu` uses (`.claude/rules/keybindings-registry.md`).
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('mousedown', handlePress, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handlePress, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [onClose]);

  // The press point by value: `position` is a new object on each render of the host.
  const { x: pointerX, y: pointerY } = position;
  const [placement, setPlacement] = useState<MenuPlacement>({ left: pointerX, top: pointerY, maxHeight: undefined });
  // `offset*` sizes, not the bounding rect: the entrance animation scales the
  // menu, and a rect read on mount would be the scaled-down size.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const borderHeight = menu.offsetHeight - menu.clientHeight;
    setPlacement(placeContextMenu(
      { x: pointerX, y: pointerY },
      { width: menu.offsetWidth, height: menu.scrollHeight + borderHeight },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [pointerX, pointerY]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed min-w-[170px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-[2147483646] py-1 overlay-popover-in"
      style={{
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        overflowY: placement.maxHeight === undefined ? undefined : 'auto',
        transformOrigin: 'top left',
      }}
      // Its own right-click opens nothing else.
      onContextMenu={(event) => event.preventDefault()}
      data-testid="command-terminal-row-menu"
    >
      <CommandTerminalMenuItems close={onClose} testIdPrefix="command-terminal-row-menu" {...actions} />
    </div>,
    document.body,
  );
}

/**
 * The menu a right-click on a Command Terminal's title opens, in its header or
 * its Running row in the rail. It opens at the cursor through a body portal:
 * the engine moves a terminal's frame by transform, and a fixed element inside
 * the frame would be placed against the frame instead of the window.
 */

import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { OverlayPopover } from '../OverlayPopover';
import { KebabMenuItem } from '../KebabMenu';

export interface ContextMenuPosition {
  x: number;
  y: number;
}

/** The menu's min width and its one row's height, to keep it inside the window. */
const MENU_WIDTH_PX = 170;
const MENU_HEIGHT_PX = 40;

interface CommandTerminalContextMenuProps {
  /** Where the right-click landed; null while the menu is closed. */
  position: ContextMenuPosition | null;
  onRename: () => void;
  onClose: () => void;
}

export function CommandTerminalContextMenu({ position, onRename, onClose }: CommandTerminalContextMenuProps) {
  const { t } = useLingui();
  const menuRef = useRef<HTMLDivElement>(null);
  const open = position !== null;
  // Where it last opened, so the exit animation plays in place after `position` clears.
  const [shownAt, setShownAt] = useState<ContextMenuPosition>({ x: 0, y: 0 });
  if (position && (position.x !== shownAt.x || position.y !== shownAt.y)) setShownAt(position);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    // Escape closes the menu, not the panel under it (keybindings-registry.md, an open menu).
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [open, onClose]);

  return (
    <OverlayPopover
      open={open}
      popoverRef={menuRef}
      portal
      role="menu"
      transformOrigin="top left"
      style={{
        left: Math.min(shownAt.x, window.innerWidth - MENU_WIDTH_PX),
        top: Math.min(shownAt.y, window.innerHeight - MENU_HEIGHT_PX),
      }}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed min-w-[170px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-[2147483646] py-1"
      data-testid="command-terminal-context-menu"
    >
      <KebabMenuItem
        icon={<Pencil size={14} />}
        label={t`Rename`}
        onClick={() => { onClose(); onRename(); }}
        data-testid="command-terminal-context-rename"
      />
    </OverlayPopover>
  );
}

import React, { useRef, useEffect } from 'react';
import { FolderPlus, FolderTree } from 'lucide-react';

export interface SidebarBackgroundMenuProps {
  position: { x: number; y: number };
  onAddProject: () => void;
  onNewGroup: () => void;
  onClose: () => void;
}

/**
 * Right-click menu for the empty space below the project list.
 *
 * Without it that area falls through to Electron's native Copy / Paste /
 * Select All menu, which offers nothing a project list can act on and reads as
 * a bug. The two entries mirror the footer's actions, so the gesture people
 * reach for on a list background lands somewhere useful.
 *
 * Shell mirrors ProjectContextMenu / GroupContextMenu: cursor-anchored and
 * `position: fixed`, which `popover-escapes-clipping.md` exempts from the
 * portal rule since it is positioned at the pointer, not against a trigger.
 */
export function SidebarBackgroundMenu({
  position,
  onAddProject,
  onNewGroup,
  onClose,
}: SidebarBackgroundMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const menuStyle: React.CSSProperties = {
    left: Math.min(position.x, window.innerWidth - 200),
    top: Math.min(position.y, window.innerHeight - 90),
  };

  const itemClass = 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors text-left';

  return (
    <div
      ref={containerRef}
      role="menu"
      data-testid="sidebar-background-menu"
      // `data-dismissable-layer`: renders in flow inside the sidebar, which the board layer
      // owns for light dismiss, so without the marker a click on the menu's own padding
      // would close an open task window behind it.
      data-dismissable-layer
      className="fixed bg-surface-raised border border-edge rounded-md shadow-lg z-50 py-1 min-w-[160px] overlay-popover-in"
      style={{ ...menuStyle, transformOrigin: 'top left' }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => { onClose(); onAddProject(); }}
        className={itemClass}
        data-testid="sidebar-background-add-project"
      >
        <FolderPlus size={14} className="text-fg-faint" />
        Add project
      </button>
      <button
        type="button"
        role="menuitem"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { onClose(); onNewGroup(); }}
        className={itemClass}
        data-testid="sidebar-background-new-group"
      >
        <FolderTree size={14} className="text-fg-faint" />
        New group
      </button>
    </div>
  );
}

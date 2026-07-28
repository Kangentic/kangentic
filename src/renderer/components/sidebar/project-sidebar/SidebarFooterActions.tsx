import { useRef, useState, useEffect } from 'react';
import { FolderPlus, FolderTree, ChevronUp } from 'lucide-react';
import { OverlayPopover } from '../../OverlayPopover';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';

export interface SidebarFooterActionsProps {
  onAddProject: () => void;
  onNewGroup: () => void;
}

/**
 * The sidebar's footer: one split button.
 *
 * Adding a project is a constant action and new group is a rare one, so they
 * are no longer two same-weight buttons competing for the same strip. The
 * primary action fills the footer and the secondary lives behind the caret,
 * which also removes the hand-tuned icon-button height that had to be kept in
 * sync with the text button's padding by hand.
 */
export function SidebarFooterActions({ onAddProject, onNewGroup }: SidebarFooterActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu portals to the body: the footer sits below a `overflow-y-auto`
  // list and inside the sidebar's own stacking context, and it opens upward
  // because it is pinned to the bottom of the window.
  //
  // `preferRight` is pinned rather than left at `'auto'`: auto left-aligns any
  // trigger in the viewport's left half, which the sidebar caret always is, so
  // the menu would hang off the sidebar's right edge and float over the board.
  // Right-aligning pins the menu's right edge to the caret's, inside the rail.
  const { style, placement } = usePopoverPosition(caretRef, menuRef, menuOpen, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'above',
    preferRight: true,
  });

  useEffect(() => {
    if (!menuOpen) return;
    // Checks BOTH refs: once portaled, a click inside the menu is no longer a
    // descendant of the trigger and would otherwise read as "outside".
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || containerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  return (
    <div className="px-3 py-2 border-t border-edge">
      <div
        ref={containerRef}
        className="flex items-stretch rounded-md border border-edge/60 overflow-hidden focus-within:border-edge"
      >
        <button
          type="button"
          // Closes the caret menu too: this button is inside `containerRef`, so
          // the outside-click handler reads a click on it as "inside" and would
          // leave the menu floating behind the folder picker.
          onClick={() => {
            setMenuOpen(false);
            onAddProject();
          }}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors"
          title="Open folder as project"
          data-testid="sidebar-new-project-button"
        >
          <FolderPlus size={14} />
          Add project
        </button>
        <button
          ref={caretRef}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setMenuOpen((open) => !open)}
          className="flex-shrink-0 inline-flex items-center justify-center w-7 border-l border-edge/60 cursor-pointer text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors"
          title="More project actions"
          aria-label="More project actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid="sidebar-footer-more-button"
        >
          <ChevronUp size={14} />
        </button>
      </div>

      <OverlayPopover
        open={menuOpen}
        popoverRef={menuRef}
        style={style}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
        role="menu"
        data-testid="sidebar-footer-menu"
        className="fixed z-[2147483646] min-w-[170px] bg-surface-raised border border-edge-input rounded-md shadow-xl py-1"
      >
        <button
          type="button"
          role="menuitem"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setMenuOpen(false);
            onNewGroup();
          }}
          className="w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-fg-tertiary hover:bg-surface-hover hover:text-fg"
          title="New group"
          data-testid="sidebar-new-group-button"
        >
          <FolderTree size={14} className="text-fg-faint" />
          New group
        </button>
      </OverlayPopover>
    </div>
  );
}

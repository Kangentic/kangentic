import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import type { Swimlane } from '../../../shared/types';

/** Space kept between the menu and the window's edges, in px. */
const EDGE_GAP_PX = 8;
/** Space between a menu button and the menu it opens, below or above it, in px. */
export const MENU_TRIGGER_GAP_PX = 4;

const MENU_ITEM_CLASS = 'w-full px-3 py-1.5 text-sm text-left outline-none flex items-center gap-2';
const MENU_ITEM_DEFAULT_CLASS = `${MENU_ITEM_CLASS} text-fg-secondary hover:bg-surface-hover/40 focus-visible:bg-surface-hover/40`;
const MENU_ITEM_DANGER_CLASS = `${MENU_ITEM_CLASS} text-red-400 hover:bg-red-400/10 focus-visible:bg-red-400/10`;

interface BacklogContextMenuProps {
  position: { x: number; y: number };
  /**
   * 'start' opens the menu with its left edge at `position` (a right-click at the pointer);
   * 'end' puts its right edge there (under a row's menu button).
   */
  align?: 'start' | 'end';
  /**
   * The button that opened the menu, when one did. A press on it is not an outside click (its
   * own click closes the menu), the menu flips above it when it does not fit below, the first
   * item takes focus on open, and Escape, Tab or a pick hands focus back to it. A button that
   * has left the page (its row scrolled out of the virtualized table) counts as none.
   */
  trigger?: HTMLElement | null;
  swimlanes: Swimlane[];
  selectedCount: number;
  onMoveToBoard: (swimlaneId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** The trigger while it is still in the page, else null. */
function connectedTrigger(trigger: HTMLElement | null): HTMLElement | null {
  return trigger?.isConnected ? trigger : null;
}

/**
 * A backlog row's menu, opened by a right-click or the row's menu button. Its order matches
 * the board's task menu: Edit, then Move to with the columns, then Delete at the bottom.
 */
export function BacklogContextMenu({
  position,
  align = 'start',
  trigger = null,
  swimlanes,
  selectedCount,
  onMoveToBoard,
  onEdit,
  onDelete,
  onClose,
}: BacklogContextMenuProps) {
  const { t } = useLingui();
  const menuRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(position.y);

  /** Close, handing focus back to the button that opened the menu. */
  const closeToTrigger = useCallback(() => {
    onClose();
    connectedTrigger(trigger)?.focus();
  }, [onClose, trigger]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (connectedTrigger(trigger)?.contains(target)) return;
      if (menuRef.current && !menuRef.current.contains(target)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeToTrigger();
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [onClose, closeToTrigger, trigger]);

  const targets = swimlanes.filter(
    (lane) => lane.role !== 'done' && !lane.is_archived && !lane.is_ghost,
  );

  // Placed from the menu's measured height, before paint: under the button, or above it when
  // the window has no room below (the last rows at the 900x600 floor); at the pointer for a
  // right-click, pulled up to stay inside the window. Placed again when its items change.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const height = menu.offsetHeight;
    const bottomLimit = window.innerHeight - EDGE_GAP_PX;
    const anchor = connectedTrigger(trigger);
    if (anchor && position.y + height > bottomLimit) {
      const above = anchor.getBoundingClientRect().top - MENU_TRIGGER_GAP_PX - height;
      if (above >= EDGE_GAP_PX) {
        setTop(above);
        return;
      }
    }
    setTop(Math.max(EDGE_GAP_PX, Math.min(position.y, bottomLimit - height)));
  }, [position.y, trigger, targets.length, selectedCount]);

  // A menu opened from its button is a keyboard target: its first item takes focus.
  useEffect(() => {
    if (!trigger) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [trigger]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Tab leaves the menu: close it and hand focus to the button, so the key's own move goes
    // on from there.
    if (event.key === 'Tab') {
      closeToTrigger();
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    else if (event.key === 'ArrowUp') nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex].focus();
  };

  const menuStyle: React.CSSProperties = align === 'end'
    ? { right: Math.max(EDGE_GAP_PX, window.innerWidth - position.x), top, transformOrigin: 'top right' }
    : { left: Math.min(position.x, window.innerWidth - 200), top, transformOrigin: 'top left' };

  return createPortal(
    <div
      ref={menuRef}
      // Portaled to `document.body`, so no overflow box in the backlog clips it and it sits
      // outside the board layer's light-dismiss subtree. `data-dismissable-layer` still marks
      // it as an open menu for the Escape owners that yield to one.
      data-dismissable-layer
      role="menu"
      onKeyDown={handleMenuKeyDown}
      className="fixed z-[2147483646] bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[180px] max-h-[calc(100vh-16px)] overflow-y-auto overlay-popover-in"
      style={menuStyle}
      data-testid="backlog-row-menu"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => { onEdit(); onClose(); }}
        className={MENU_ITEM_DEFAULT_CLASS}
        data-testid="context-edit-item"
      >
        <Pencil size={14} className="text-fg-faint" />
        <Trans context="button">Edit</Trans>
      </button>

      {targets.length > 0 && (
        <>
          <div className="border-t border-edge my-1" />
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            {selectedCount > 1
              ? t`Move ${plural(selectedCount, { one: '# item', other: '# items' })} to`
              : t({ message: 'Move to', context: 'menu header' })}
          </div>
          {targets.map((lane) => (
            <button
              key={lane.id}
              type="button"
              role="menuitem"
              onClick={() => { onMoveToBoard(lane.id); closeToTrigger(); }}
              className={MENU_ITEM_DEFAULT_CLASS}
              data-testid="context-move-to-board"
            >
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: lane.color }}
              />
              {lane.name}
            </button>
          ))}
        </>
      )}

      <div className="border-t border-edge my-1" />

      <button
        type="button"
        role="menuitem"
        onClick={() => { onDelete(); onClose(); }}
        className={MENU_ITEM_DANGER_CLASS}
        data-testid="context-delete-item"
      >
        <Trash2 size={14} />
        {selectedCount > 1
          ? t`Delete ${plural(selectedCount, { one: '# item', other: '# items' })}`
          : t({ message: 'Delete', context: 'button' })}
      </button>
    </div>,
    document.body,
  );
}

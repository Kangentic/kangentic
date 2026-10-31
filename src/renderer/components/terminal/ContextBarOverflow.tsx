/**
 * The context bar's +N pill: what did not fit the bar's one row
 * (`useContextBarFold`), listed in a popover above it. The list shows copies of
 * the folded pills, with their tips; the folded pills themselves stay in the
 * row, out of sight. With nothing folded the pill stays in the row out of sight
 * too, so the fold knows its width before anything folds.
 */

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { OverlayPopover } from '../OverlayPopover';
import { pill } from './context-bar-pill';
import type { ContextBarFoldId } from './context-bar-fold';

export interface ContextBarOverflowItem {
  id: ContextBarFoldId;
  node: ReactNode;
}

export function ContextBarOverflow({
  buttonRef,
  items,
  open,
  onOpenChange,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** The folded pills, in the order the row draws them. */
  items: ContextBarOverflowItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const listRef = useRef<HTMLDivElement>(null);
  const count = items.length;
  const listOpen = open && count > 0;
  // Fixed and portaled: the bar is a compositing layer, which would contain a fixed child.
  const { style, placement } = usePopoverPosition(buttonRef, listRef, listOpen, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'above',
  });

  useEffect(() => {
    if (!listOpen) return;
    const closeOnOutsidePress = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (listRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    // The open menu's own Escape, ahead of the window or dialog under it.
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener('mousedown', closeOnOutsidePress, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [listOpen, buttonRef, onOpenChange]);

  const idle = count === 0;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`${pill} text-fg-secondary font-semibold tabular-nums cursor-pointer hover:bg-surface-hover${
          idle ? ' absolute invisible pointer-events-none' : ''
        }`}
        aria-label={t`${plural(count, { one: 'Show # more', other: 'Show # more' })}`}
        aria-expanded={listOpen}
        aria-hidden={idle || undefined}
        inert={idle || undefined}
        data-fold-more=""
        data-testid="context-bar-overflow"
      >
        <Trans>+{count}</Trans>
      </button>
      {listOpen && (
        <OverlayPopover
          open
          popoverRef={listRef}
          style={style}
          portal
          transformOrigin={`${placement.vertical === 'above' ? 'bottom' : 'top'} ${placement.horizontal}`}
          className="fixed z-[2147483646] flex flex-col items-start gap-1.5 rounded-lg border border-edge bg-surface-raised p-1.5 text-xs shadow-xl max-h-[min(340px,var(--popover-available-height,340px))] overflow-y-auto"
          data-testid="context-bar-overflow-list"
        >
          {items.map((item) => (
            <div key={item.id} className="flex" data-overflow-item={item.id}>{item.node}</div>
          ))}
        </OverlayPopover>
      )}
    </>
  );
}

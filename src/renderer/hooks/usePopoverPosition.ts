import { useState, useLayoutEffect, type CSSProperties, type RefObject } from 'react';

export type PopoverMode = 'dropdown' | 'flyout';

interface PopoverOptions {
  mode: PopoverMode;
  viewportPadding?: number;
  /**
   * Horizontal alignment preference for dropdown mode.
   * - `'auto'` (default): right-align when trigger is in the right half of the viewport,
   *   left-align when in the left half. This follows the UX convention of anchoring the
   *   popover edge closest to the nearest viewport edge.
   * - `true`: always prefer right-alignment (overflow flips to left).
   * - `false`: always prefer left-alignment (overflow flips to right).
   */
  preferRight?: boolean | 'auto';
}

export interface PopoverPlacement {
  vertical: 'below' | 'above';
  horizontal: 'left' | 'right';
}

interface PopoverPosition {
  style: CSSProperties;
  placement: PopoverPlacement;
}

const HIDDEN: CSSProperties = { visibility: 'hidden' };
const EMPTY: CSSProperties = {};

export function usePopoverPosition(
  triggerRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  options: PopoverOptions,
): PopoverPosition {
  const { mode, viewportPadding = 8, preferRight = 'auto' } = options;
  const [placement, setPlacement] = useState<PopoverPlacement>({ vertical: 'below', horizontal: 'right' });

  useLayoutEffect(() => {
    if (!isOpen) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let resolvedVertical: 'below' | 'above' = 'below';
    let resolvedHorizontal: 'left' | 'right' = 'right';

    if (mode === 'dropdown') {
      // Resolve auto preference: right-align when trigger center is in right half
      const effectivePreferRight = preferRight === 'auto'
        ? (triggerRect.left + triggerRect.width / 2) > viewportWidth / 2
        : preferRight;

      resolvedHorizontal = effectivePreferRight ? 'right' : 'left';

      // Vertical: below or above
      const fitsBelow = triggerRect.bottom + popoverRect.height + viewportPadding <= viewportHeight;
      if (fitsBelow) {
        popover.style.top = '100%';
        popover.style.bottom = '';
        popover.style.marginTop = '4px';
        popover.style.marginBottom = '';
      } else {
        resolvedVertical = 'above';
        popover.style.bottom = '100%';
        popover.style.top = '';
        popover.style.marginBottom = '4px';
        popover.style.marginTop = '';
      }

      // Horizontal: align left or right edge, with overflow flip
      if (effectivePreferRight) {
        const alignRightOverflows = triggerRect.right - popoverRect.width < viewportPadding;
        if (alignRightOverflows) {
          resolvedHorizontal = 'left';
          popover.style.left = '0';
          popover.style.right = '';
        } else {
          popover.style.right = '0';
          popover.style.left = '';
        }
      } else {
        const alignLeftOverflows = triggerRect.left + popoverRect.width + viewportPadding > viewportWidth;
        if (alignLeftOverflows) {
          resolvedHorizontal = 'right';
          popover.style.right = '0';
          popover.style.left = '';
        } else {
          popover.style.left = '0';
          popover.style.right = '';
        }
      }
    } else {
      // Flyout mode
      const fitsRight = triggerRect.right + popoverRect.width + viewportPadding <= viewportWidth;
      const fitsLeft = triggerRect.left - popoverRect.width >= viewportPadding;

      if (fitsRight) {
        resolvedHorizontal = 'right';
        popover.style.left = '100%';
        popover.style.right = '';
        popover.style.marginLeft = '-1px';
        popover.style.marginRight = '';
      } else if (fitsLeft) {
        resolvedHorizontal = 'left';
        popover.style.right = '100%';
        popover.style.left = '';
        popover.style.marginRight = '-1px';
        popover.style.marginLeft = '';
      } else {
        // Neither side fits cleanly; prefer the side with more space
        if (triggerRect.left > viewportWidth - triggerRect.right) {
          resolvedHorizontal = 'left';
          popover.style.right = '100%';
          popover.style.left = '';
          popover.style.marginRight = '-1px';
          popover.style.marginLeft = '';
        } else {
          resolvedHorizontal = 'right';
          popover.style.left = '100%';
          popover.style.right = '';
          popover.style.marginLeft = '-1px';
          popover.style.marginRight = '';
        }
      }

      // Vertical: anchor top, shift up if overflowing bottom
      popover.style.top = '0';
      const overflowBottom = triggerRect.top + popoverRect.height + viewportPadding - viewportHeight;
      if (overflowBottom > 0) {
        popover.style.top = `-${overflowBottom}px`;
      }
    }

    popover.style.visibility = 'visible';
    setPlacement({ vertical: resolvedVertical, horizontal: resolvedHorizontal });
  }, [isOpen, mode, viewportPadding, preferRight, triggerRef, popoverRef]);

  return {
    style: isOpen ? EMPTY : HIDDEN,
    placement,
  };
}

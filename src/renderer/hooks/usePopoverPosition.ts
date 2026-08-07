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
  /**
   * Vertical placement preference for dropdown mode.
   * - `'below'` (default): open downward, flipping above only when the popover
   *   would overflow the viewport bottom (legacy behaviour).
   * - `'above'`: open upward, flipping below only when it does not fit above.
   *   Use for triggers pinned to the bottom of their container (e.g. the
   *   ContextBar), where opening downward can render past the container edge
   *   (clipped inside a floating overlay) even though there is viewport room.
   */
  preferVertical?: 'below' | 'above';
  /**
   * Positioning strategy for dropdown mode.
   * - `'absolute'` (default): `position: absolute` offsets (`top: 100%`, `right: 0`)
   *   relative to the trigger's positioned ancestor. The popover must NOT be
   *   portaled and is clipped by any ancestor `overflow: hidden`.
   * - `'fixed'`: `position: fixed` viewport coordinates computed from the trigger
   *   rect. Use together with a body portal so the popover escapes a clipping
   *   ancestor (e.g. a window frame's `overflow-hidden`). Flyout mode is unaffected.
   */
  strategy?: 'absolute' | 'fixed';
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
  const { mode, viewportPadding = 8, preferRight = 'auto', preferVertical = 'below', strategy = 'absolute' } = options;
  const [placement, setPlacement] = useState<PopoverPlacement>({ vertical: 'below', horizontal: 'right' });

  useLayoutEffect(() => {
    if (!isOpen) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    // `offsetWidth`/`offsetHeight`, NOT `getBoundingClientRect()`, for the
    // popover's own size. `OverlayPopover` plays a grow-in animation that starts
    // at `transform: scale(0.96)`, and this effect runs on the commit that mounts
    // it - so a rect measurement reads ~4% short. On a marginal fit that is
    // exactly enough to decide "fits below" for a popover that then paints at
    // full size and spills past the viewport edge. The offset* properties are
    // layout dimensions and ignore transforms.
    const popoverWidth = popover.offsetWidth;
    const popoverHeight = popover.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let resolvedVertical: 'below' | 'above' = 'below';
    let resolvedHorizontal: 'left' | 'right' = 'right';

    if (mode === 'dropdown') {
      // Resolve auto preference: right-align when trigger center is in right half
      const effectivePreferRight = preferRight === 'auto'
        ? (triggerRect.left + triggerRect.width / 2) > viewportWidth / 2
        : preferRight;

      // Vertical: below or above. `preferVertical` picks the default side and
      // each side flips to the other only when the preferred side overflows.
      // 'above' is for bottom-anchored triggers (ContextBar) where downward can
      // render past a floating container's edge even with viewport room below.
      const spaceBelow = viewportHeight - triggerRect.bottom - viewportPadding;
      const spaceAbove = triggerRect.top - viewportPadding;
      const fitsBelow = popoverHeight <= spaceBelow;
      const fitsAbove = popoverHeight <= spaceAbove;
      // When one side fits, use it (honouring `preferVertical`). When NEITHER
      // fits, take the roomier side rather than flipping unconditionally: a
      // popover taller than the space on both sides should spill where there is
      // the most room, not always upward past the viewport top.
      const openAbove = preferVertical === 'above'
        ? (fitsAbove || !fitsBelow)
        : (!fitsBelow && (fitsAbove || spaceAbove > spaceBelow));
      resolvedVertical = openAbove ? 'above' : 'below';

      // Horizontal: align the trigger-nearest edge, flipping on overflow.
      let alignRight: boolean;
      if (effectivePreferRight) {
        alignRight = !(triggerRect.right - popoverWidth < viewportPadding);
      } else {
        alignRight = triggerRect.left + popoverWidth + viewportPadding > viewportWidth;
      }
      resolvedHorizontal = alignRight ? 'right' : 'left';

      if (strategy === 'fixed') {
        // Viewport coordinates so the popover can be portaled out of a clipping
        // ancestor (the trigger-relative `100%`/`0` offsets below cannot).
        popover.style.position = 'fixed';
        popover.style.bottom = '';
        popover.style.right = '';
        popover.style.marginTop = '';
        popover.style.marginBottom = '';
        popover.style.top = openAbove
          ? `${triggerRect.top - popoverHeight - 8}px`
          : `${triggerRect.bottom + 8}px`;
        popover.style.left = alignRight
          ? `${triggerRect.right - popoverWidth}px`
          : `${triggerRect.left}px`;
      } else {
        if (openAbove) {
          popover.style.bottom = '100%';
          popover.style.top = '';
          popover.style.marginBottom = '8px';
          popover.style.marginTop = '';
        } else {
          popover.style.top = '100%';
          popover.style.bottom = '';
          popover.style.marginTop = '8px';
          popover.style.marginBottom = '';
        }
        if (alignRight) {
          popover.style.right = '0';
          popover.style.left = '';
        } else {
          popover.style.left = '0';
          popover.style.right = '';
        }
      }
    } else {
      // Flyout mode
      const fitsRight = triggerRect.right + popoverWidth + viewportPadding <= viewportWidth;
      const fitsLeft = triggerRect.left - popoverWidth >= viewportPadding;

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
      const overflowBottom = triggerRect.top + popoverHeight + viewportPadding - viewportHeight;
      if (overflowBottom > 0) {
        popover.style.top = `-${overflowBottom}px`;
      }
    }

    popover.style.visibility = 'visible';
    setPlacement({ vertical: resolvedVertical, horizontal: resolvedHorizontal });
  }, [isOpen, mode, viewportPadding, preferRight, preferVertical, strategy, triggerRef, popoverRef]);

  return {
    style: isOpen ? EMPTY : HIDDEN,
    placement,
  };
}

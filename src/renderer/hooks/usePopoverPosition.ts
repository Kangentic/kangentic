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
   *   The side is decided once, at open, but the popover is anchored on the edge
   *   facing its trigger, so content that arrives later grows away from it. The
   *   room on the chosen side is published as `--popover-available-height` and
   *   `--popover-available-width` on the popover for its own max-size classes.
   */
  strategy?: 'absolute' | 'fixed';
  /**
   * Dropdown mode: size the popover to the trigger's width BEFORE the placement
   * is measured, by writing `popover.style.width` from the trigger rect. This is
   * the fixed-strategy replacement for an in-flow `left-0 right-0` stretch.
   *
   * It has to happen inside this hook's own effect, ahead of the `offsetWidth` /
   * `offsetHeight` reads. A consumer that measures the trigger in a later layout
   * effect of its own and passes `width` through `style` lands one commit late:
   * layout effects run in declaration order, so on the mount commit the hook
   * measures a width-less menu. Its shrink-to-fit width is a run of inline-block
   * `w-full` option buttons laid on ONE line (about 1300px for 15 agents), which
   * flips the overflow check and right-aligns the menu hundreds of pixels left of
   * its trigger, on the first open per mount only (the width state survived the
   * close, so the second open measured a menu that already had its width).
   *
   * In dropdown mode the hook owns the inline `width` either way: it clears it
   * when this is false. A menu with its own width takes a class (`w-64`,
   * `min-w-[160px]`), never `style.width`.
   */
  matchTriggerWidth?: boolean;
}

export interface PopoverPlacement {
  vertical: 'below' | 'above';
  horizontal: 'left' | 'right';
}

interface PopoverPosition {
  style: CSSProperties;
  placement: PopoverPlacement;
}

/** Space between a dropdown and its trigger. */
const POPOVER_GAP = 8;

const HIDDEN: CSSProperties = { visibility: 'hidden' };
const EMPTY: CSSProperties = {};

export function usePopoverPosition(
  triggerRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  options: PopoverOptions,
): PopoverPosition {
  const {
    mode,
    viewportPadding = 8,
    preferRight = 'auto',
    preferVertical = 'below',
    strategy = 'absolute',
    matchTriggerWidth = false,
  } = options;
  const [placement, setPlacement] = useState<PopoverPlacement>({ vertical: 'below', horizontal: 'right' });

  useLayoutEffect(() => {
    if (!isOpen) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    // Size before measuring. Both reads below depend on it: at the shrink-to-fit
    // width the option buttons sit on one line, so the height read would be one
    // row tall too and the fits-below decision would be made against the wrong
    // height. See the option's doc comment for the horizontal failure. Cleared
    // on the negative, like every other property this effect owns, so an
    // instance whose option flips off does not keep a stale width.
    if (mode === 'dropdown') {
      popover.style.width = matchTriggerWidth ? `${triggerRect.width}px` : '';
    }
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
    let resolvedHorizontal: 'left' | 'right';

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
        //
        // Anchored on the edge that FACES the trigger: `bottom` when above,
        // `right` when right-aligned, exactly as the absolute branch below does
        // with `bottom: 100%` / `right: 0`. Content that grows or shrinks after
        // this measurement (rows an async fetch delivers, a list the user
        // filters) then moves only the far edge, never over the trigger.
        // The fixed containing block is the viewport minus scrollbars, hence
        // the documentElement client size for the anchor math.
        const layoutWidth = document.documentElement.clientWidth;
        const layoutHeight = document.documentElement.clientHeight;
        popover.style.position = 'fixed';
        popover.style.marginTop = '';
        popover.style.marginBottom = '';
        if (openAbove) {
          popover.style.top = '';
          popover.style.bottom = `${layoutHeight - triggerRect.top + POPOVER_GAP}px`;
        } else {
          popover.style.bottom = '';
          popover.style.top = `${triggerRect.bottom + POPOVER_GAP}px`;
        }
        if (alignRight) {
          popover.style.left = '';
          popover.style.right = `${layoutWidth - triggerRect.right}px`;
        } else {
          popover.style.right = '';
          popover.style.left = `${triggerRect.left}px`;
        }
        // The room on the chosen side, for a consumer to cap itself with
        // (`max-h-[min(340px,var(--popover-available-height,340px))]`) so a
        // short window scrolls inside the popover instead of spilling out of
        // it. Variables, not an inline max-height: an inline value would
        // override every consumer's own class cap, and a popover without
        // `overflow-y-auto` would spill its content out of a clamped box.
        const availableHeight = (openAbove ? spaceAbove : spaceBelow) - POPOVER_GAP;
        const availableWidth = alignRight
          ? triggerRect.right - viewportPadding
          : viewportWidth - triggerRect.left - viewportPadding;
        popover.style.setProperty('--popover-available-height', `${Math.max(0, availableHeight)}px`);
        popover.style.setProperty('--popover-available-width', `${Math.max(0, availableWidth)}px`);
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
  }, [isOpen, mode, viewportPadding, preferRight, preferVertical, strategy, matchTriggerWidth, triggerRef, popoverRef]);

  return {
    style: isOpen ? EMPTY : HIDDEN,
    placement,
  };
}

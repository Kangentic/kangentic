/**
 * How much of the graph canvas the floating panels are covering, in pixels.
 *
 * The canvas is full-bleed and the Display panel, the search box and the detail
 * rail float ON TOP of it, so the pane the user perceives is a smaller rectangle
 * than the one three renders into. Every framing decision - where the default
 * view centres, how far back it sits, where a search flies to - is about that
 * smaller rectangle, and until it was measured the camera was aiming at a pane
 * nobody was looking at.
 *
 * MEASURED rather than declared as constants, because constants drift: the panel
 * is a Tailwind width, the search box is responsive, and the rail is conditional.
 * A panel joins the calculation by carrying `data-graph-chrome`, which is one
 * attribute at the place where its position is already being decided.
 *
 * The EDGE is declared rather than inferred from position. Inferring it would
 * mean guessing for anything anchored to a corner, and guessing wrong there
 * silently steals a whole axis of the map.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NO_VIEWPORT_INSETS, type ViewportInsets } from './knowledge-graph-scene';

const CHROME_SELECTOR = '[data-graph-chrome]';

/** Air between a panel and the nearest thing the map may draw against it. */
const CHROME_CLEARANCE = 12;

function sameInsets(first: ViewportInsets, second: ViewportInsets): boolean {
  return first.left === second.left
    && first.right === second.right
    && first.top === second.top
    && first.bottom === second.bottom;
}

/**
 * @param rootRef the element the canvas fills and the panels are positioned in.
 * @param revision anything that changes WHICH panels are mounted. A resize is
 *   observed, but a rail opening is not a resize of anything.
 */
export function useChromeInsets(
  rootRef: React.RefObject<HTMLElement | null>,
  revision: string,
): ViewportInsets {
  const [insets, setInsets] = useState<ViewportInsets>(NO_VIEWPORT_INSETS);
  // Returned to the scene as an effect dependency, so a fresh object on every
  // measurement would re-aim the camera in a loop.
  const currentRef = useRef(insets);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;

    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;
    for (const element of root.querySelectorAll(CHROME_SELECTOR)) {
      const rect = element.getBoundingClientRect();
      // A panel mid-transition, or one that is display:none, covers nothing.
      if (rect.width === 0 || rect.height === 0) continue;
      switch (element.getAttribute('data-graph-chrome')) {
        case 'left':
          left = Math.max(left, rect.right - bounds.left + CHROME_CLEARANCE);
          break;
        case 'right':
          right = Math.max(right, bounds.right - rect.left + CHROME_CLEARANCE);
          break;
        case 'top':
          top = Math.max(top, rect.bottom - bounds.top + CHROME_CLEARANCE);
          break;
        case 'bottom':
          bottom = Math.max(bottom, bounds.bottom - rect.top + CHROME_CLEARANCE);
          break;
        default:
          break;
      }
    }

    const next: ViewportInsets = { left, right, top, bottom };
    if (sameInsets(currentRef.current, next)) return;
    currentRef.current = next;
    setInsets(next);
  }, [rootRef]);

  // Layout effect: the panels are already laid out by the time this runs, and
  // measuring in a passive effect would let one frame paint with a stale aim.
  useLayoutEffect(() => {
    measure();
  }, [measure, revision]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootRef, measure]);

  // Measure AGAIN when a panel finishes sliding in.
  //
  // The rails enter on the app's panel animation, whose first keyframe is
  // `translateX(100%)` - and `getBoundingClientRect` reports the TRANSFORMED box
  // by definition, so the layout effect above measures a rail that is still one
  // full width off the right edge. Measured on the real surface: a 320px rail
  // read as 24px of inset, which put Reset view underneath it and framed the map
  // into a pane that still included the rail. Nothing corrected it either, since
  // an animation ending is neither a revision change nor a resize.
  //
  // The event bubbles, so this covers any animated panel added later rather than
  // just the two rails. Each firing costs a handful of rect reads and returns
  // early when nothing moved.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const remeasure = () => measure();
    root.addEventListener('animationend', remeasure);
    return () => root.removeEventListener('animationend', remeasure);
  }, [rootRef, measure]);

  return insets;
}

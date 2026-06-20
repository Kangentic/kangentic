/**
 * Pure geometry helpers. No React, no store access: unit-testable in isolation.
 *
 * Windows store FRACTIONAL geometry (0..1 of the overlay). These functions
 * convert to/from the PIXEL rects the layout actually renders, against the
 * overlay's measured size. Drag/resize math runs in pixels (pointer deltas),
 * then converts back to fractional once on commit.
 */

import type { FractionalRect } from './types';

/** A rectangle in CSS pixels, relative to the overlay's top-left. */
export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ContainerSize {
  width: number;
  height: number;
}

/** Clamp a number to the inclusive [min, max] range. Shared by the drag, resize,
 *  and footprint-resize gestures, which all bound a pixel value to a span. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function fractionalToPixels(geometry: FractionalRect, container: ContainerSize): PixelRect {
  return {
    left: geometry.x * container.width,
    top: geometry.y * container.height,
    width: geometry.w * container.width,
    height: geometry.h * container.height,
  };
}

export function pixelsToFractional(rect: PixelRect, container: ContainerSize): FractionalRect {
  const safeWidth = container.width || 1;
  const safeHeight = container.height || 1;
  return {
    x: rect.left / safeWidth,
    y: rect.top / safeHeight,
    w: rect.width / safeWidth,
    h: rect.height / safeHeight,
  };
}

/** Smallest fraction of the overlay a window may occupy on an axis. */
const MIN_FRACTION = 0.12;

/** Keep a window's size in range and its top-left inside the overlay. */
export function clampGeometry(geometry: FractionalRect): FractionalRect {
  const width = Math.min(1, Math.max(MIN_FRACTION, geometry.w));
  const height = Math.min(1, Math.max(MIN_FRACTION, geometry.h));
  const x = Math.min(1 - width, Math.max(0, geometry.x));
  const y = Math.min(1 - height, Math.max(0, geometry.y));
  return { x, y, w: width, h: height };
}

const CASCADE_STEP = 0.03;
const CASCADE_CYCLE = 5;
const DEFAULT_WIDTH = 0.58;
const DEFAULT_HEIGHT = 0.7;

/** Smart default placement: the FIRST window opens centered at a comfortable
 *  large size; each subsequent window cascades a small step down-right FROM
 *  center so opening several in a row does not stack them exactly on top of one
 *  another. clampGeometry keeps a cascaded window inside the overlay. */
export function defaultWindowGeometry(openIndex: number): FractionalRect {
  const shift = (openIndex % CASCADE_CYCLE) * CASCADE_STEP;
  return clampGeometry({
    x: (1 - DEFAULT_WIDTH) / 2 + shift,
    y: (1 - DEFAULT_HEIGHT) / 2 + shift,
    w: DEFAULT_WIDTH,
    h: DEFAULT_HEIGHT,
  });
}

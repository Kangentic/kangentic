/**
 * Measured "priority-plus" overflow for the task-detail header quick-access pills.
 *
 * The title is reserved only up to a FLOOR (~50 chars), not its full natural
 * width. As the window narrows, the header protects the leading cluster (pause /
 * id / priority), the trailing controls (overflow / expand / close), and that
 * title floor - then fills whatever is left with the quick access pills in
 * DESCENDING priority, so the lowest-priority pills surrender first. Because the
 * title element is `flex-1`, on a large window it reclaims all leftover space and
 * shows in FULL (well past the floor); it only truncates toward the floor when the
 * pills genuinely need the room. The resulting priority is: title up to ~50ch >
 * quick-action pills > title beyond ~50ch. Dropped pills are not lost: the `...`
 * overflow menu mirrors every built-in pill, and a header-only shortcut is folded
 * back into the menu by the caller.
 *
 * The title's natural width is read from the inner title `<span>`'s `scrollWidth`.
 * Because that span is content-sized (not flex-grown), its `scrollWidth` is the
 * full untruncated text width whether or not it is currently ellipsized - so no
 * canvas/offscreen measurement is needed. The floor's pixel size is derived from
 * the same span (`scrollWidth / textContent.length` gives a live average char
 * width), so "~50 chars" stays accurate across themes and font changes. Pill
 * widths are cached per id from the live DOM, so a folded pill still contributes
 * its last-measured width when deciding whether it fits again as the window grows.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface HeaderPillSpec {
  id: string;
  /** Higher priority pills stay visible longer (they collapse last). */
  priority: number;
}

/** gap-3 between pills, and between the outer header sections. */
const GAP_PX = 12;
/** px-4 on the header (both sides). */
const HEADER_PADDING_X_PX = 32;
/** Outer sections: leading, title, pills, trailing -> 3 gaps between them. */
const OUTER_GAP_TOTAL_PX = GAP_PX * 3;
/** A little breathing room past the title text before a pill may sit next to it. */
const TITLE_RESERVE_BUFFER_PX = 8;
/**
 * Title floor: reserve at most this many characters of the title before pills may
 * compete for the remaining width. Tuned to keep a legible leading portion of the
 * title visible while letting the quick actions reclaim the rest of a wide header.
 */
const TITLE_FLOOR_CHARS = 50;

function sameSet(first: Set<string>, second: Set<string>): boolean {
  if (first.size !== second.size) return false;
  for (const value of first) if (!second.has(value)) return false;
  return true;
}

/** Header geometry the overflow calc needs: measured from the live DOM by the hook,
 *  and supplied synthetically by unit tests. */
export interface HeaderOverflowMeasurements {
  /** Header content-box width (`clientWidth`). */
  headerWidth: number;
  /** Protected leading cluster width (pause / id / priority). */
  leadingWidth: number;
  /** Protected trailing controls width (overflow / expand / close). */
  trailingWidth: number;
  /** The title's full untruncated text width (the inner span's `scrollWidth`). */
  titleNaturalWidth: number;
  /** The title's character count in code points (so an emoji counts once). */
  titleCharCount: number;
  /** Last-measured pill widths by id; an id absent from the map is unmeasured. */
  pillWidths: Map<string, number>;
}

/**
 * Pure "priority-plus" overflow math: given the measured header, decide which pills
 * must fold into the kebab. The title is reserved only up to a ~50ch FLOOR (not its
 * full natural width), so pills reclaim any width above the floor and fold in
 * ASCENDING priority (lowest first) once the leftover runs out. The floor's pixel
 * size is the live average char width (natural width / char count), so "~50 chars"
 * tracks the current font, and it is clamped to the natural width so a short title
 * reserves only what it needs. Extracted from the hook so the floor-vs-pills decision
 * is unit-testable without a DOM or ResizeObserver.
 */
export function computeHiddenPills(
  pills: HeaderPillSpec[],
  measurements: HeaderOverflowMeasurements,
): Set<string> {
  const averageCharWidth = measurements.titleNaturalWidth / Math.max(measurements.titleCharCount, 1);
  const titleFloor = Math.min(measurements.titleNaturalWidth, TITLE_FLOOR_CHARS * averageCharWidth);
  const titleReserve = titleFloor + TITLE_RESERVE_BUFFER_PX;
  const available =
    measurements.headerWidth
    - HEADER_PADDING_X_PX
    - measurements.leadingWidth
    - measurements.trailingWidth
    - titleReserve
    - OUTER_GAP_TOTAL_PX;

  // Keep the highest-priority pills that fit in the leftover space.
  const ordered = [...pills].sort((first, second) => second.priority - first.priority);
  const keep = new Set<string>();
  let used = 0;
  for (const pill of ordered) {
    const width = measurements.pillWidths.get(pill.id);
    // An as-yet-unmeasured pill is shown so it can measure on the next pass.
    if (width == null) { keep.add(pill.id); continue; }
    const projected = used + width + (keep.size > 0 ? GAP_PX : 0);
    if (projected <= available) { keep.add(pill.id); used = projected; }
  }

  const hidden = new Set<string>();
  for (const pill of pills) if (!keep.has(pill.id)) hidden.add(pill.id);
  return hidden;
}

export function useHeaderPillOverflow(
  headerRef: RefObject<HTMLElement | null>,
  leadingRef: RefObject<HTMLElement | null>,
  trailingRef: RefObject<HTMLElement | null>,
  titleRef: RefObject<HTMLElement | null>,
  pillsRef: RefObject<HTMLElement | null>,
  pills: HeaderPillSpec[],
): Set<string> {
  const widthCacheRef = useRef<Map<string, number>>(new Map());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());

  useLayoutEffect(() => {
    const header = headerRef.current;
    const leading = leadingRef.current;
    const trailing = trailingRef.current;
    const title = titleRef.current;
    const pillsContainer = pillsRef.current;
    if (!header || !leading || !trailing || !title || !pillsContainer) return;

    const recompute = () => {
      // Refresh the width cache from whatever pills are currently in the DOM.
      for (const child of Array.from(pillsContainer.children)) {
        const id = (child as HTMLElement).dataset.pillId;
        if (id) widthCacheRef.current.set(id, (child as HTMLElement).offsetWidth);
      }

      const nextHidden = computeHiddenPills(pills, {
        headerWidth: header.clientWidth,
        leadingWidth: leading.offsetWidth,
        trailingWidth: trailing.offsetWidth,
        // scrollWidth is the full untruncated text width even when ellipsized,
        // because the inner title span is content-sized (not flex-grown).
        titleNaturalWidth: title.scrollWidth,
        // Count code points (spread), not UTF-16 units, so a surrogate-pair glyph
        // (e.g. an emoji) counts as one character and does not deflate the average.
        titleCharCount: [...(title.textContent ?? '')].length,
        pillWidths: widthCacheRef.current,
      });
      setHiddenIds((previous) => (sameSet(previous, nextHidden) ? previous : nextHidden));
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(header);
    observer.observe(leading);
    observer.observe(trailing);
    observer.observe(title);
    return () => observer.disconnect();
  }, [headerRef, leadingRef, trailingRef, titleRef, pillsRef, pills]);

  return hiddenIds;
}

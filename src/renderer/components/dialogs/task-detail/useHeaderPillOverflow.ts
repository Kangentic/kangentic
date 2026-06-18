/**
 * Measured "priority-plus" overflow for the task-detail header quick-access pills.
 *
 * The title wins. As the window narrows, the header protects the leading cluster
 * (pause / id / priority), the trailing controls (overflow / expand / close), and
 * the TITLE's full natural width - then fills whatever is left with the quick
 * access pills in DESCENDING priority, so the lowest-priority pills surrender
 * first. The title only starts truncating once every pill has folded. Dropped
 * pills are not lost: the `...` overflow menu mirrors every built-in pill, and a
 * header-only shortcut is folded back into the menu by the caller.
 *
 * The title's natural width is read from the inner title `<span>`'s `scrollWidth`.
 * Because that span is content-sized (not flex-grown), its `scrollWidth` is the
 * full untruncated text width whether or not it is currently ellipsized - so no
 * canvas/offscreen measurement is needed. Pill widths are cached per id from the
 * live DOM, so a folded pill still contributes its last-measured width when
 * deciding whether it fits again as the window grows.
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

function sameSet(first: Set<string>, second: Set<string>): boolean {
  if (first.size !== second.size) return false;
  for (const value of first) if (!second.has(value)) return false;
  return true;
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

      // The title's full text width gets reserved first, so pills only ever take
      // space the title does not need (and fold to give it back when squeezed).
      const titleReserve = title.scrollWidth + TITLE_RESERVE_BUFFER_PX;
      const available =
        header.clientWidth
        - HEADER_PADDING_X_PX
        - leading.offsetWidth
        - trailing.offsetWidth
        - titleReserve
        - OUTER_GAP_TOTAL_PX;

      // Keep the highest-priority pills that fit in the leftover space.
      const ordered = [...pills].sort((first, second) => second.priority - first.priority);
      const keep = new Set<string>();
      let used = 0;
      for (const pill of ordered) {
        const width = widthCacheRef.current.get(pill.id);
        // An as-yet-unmeasured pill is shown so it can measure on the next pass.
        if (width == null) { keep.add(pill.id); continue; }
        const projected = used + width + (keep.size > 0 ? GAP_PX : 0);
        if (projected <= available) { keep.add(pill.id); used = projected; }
      }

      const nextHidden = new Set<string>();
      for (const pill of pills) if (!keep.has(pill.id)) nextHidden.add(pill.id);
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

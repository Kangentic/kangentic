/**
 * Measures the context bar's row and decides what folds into its +N list
 * (`resolveContextBarFold`). The bar marks what it lays out:
 *
 * - `data-fold-id` on every pill that can fold, and on the two parts of a pill
 *   that fold on their own: the agent's version number and the context counts.
 * - `data-folded` on whatever is folded. A folded pill stays mounted, out of
 *   the row and out of sight, so its width is still its own and unfolding it
 *   remounts nothing.
 * - `data-meter` on the rate limits and context pills, whose `data-meter-track`
 *   bars stretch to fill the row; a meter counts with each track at its own
 *   minimum width.
 * - `data-fold-more` on the +N pill, kept in the row out of sight while nothing
 *   is folded, so its width is known before anything does.
 *
 * Everything else in the row (the model and effort pickers, a task's profile
 * picker) never folds. It runs from ResizeObservers on the bar and on each
 * pill, never on a render: the bar renders on every usage tick.
 */

import { useLayoutEffect, useState, type RefObject } from 'react';
import {
  isContextBarFoldId,
  resolveContextBarFold,
  type ContextBarFoldId,
  type ContextBarFoldInput,
  type ContextBarFoldItem,
} from './context-bar-fold';

function sameSet(first: Set<ContextBarFoldId>, second: Set<ContextBarFoldId>): boolean {
  if (first.size !== second.size) return false;
  for (const value of first) if (!second.has(value)) return false;
  return true;
}

const pixels = (value: string): number => parseFloat(value) || 0;

/** A meter's width with each of its tracks at its own minimum width. */
function meterMinimumWidth(meter: HTMLElement, width: number): number {
  let minimum = width;
  for (const track of Array.from(meter.querySelectorAll<HTMLElement>('[data-meter-track]'))) {
    minimum -= track.getBoundingClientRect().width - pixels(getComputedStyle(track).minWidth);
  }
  return minimum;
}

/** The room a part takes inside its pill: its width, its margin, and its pill's gap. */
function innerPartWidth(part: HTMLElement): number {
  const parentGap = part.parentElement ? pixels(getComputedStyle(part.parentElement).columnGap) : 0;
  return part.getBoundingClientRect().width + pixels(getComputedStyle(part).marginLeft) + parentGap;
}

export function measureContextBarFold(bar: HTMLElement): ContextBarFoldInput {
  const style = getComputedStyle(bar);
  const gap = pixels(style.columnGap);
  const available = bar.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
  const items: ContextBarFoldItem[] = [];
  // The first thing in the row has no gap before it.
  let fixedWidth = -gap;
  let moreWidth = 0;
  for (const child of Array.from(bar.children) as HTMLElement[]) {
    if (getComputedStyle(child).display === 'none') continue;
    if (child.hasAttribute('data-fold-more')) {
      moreWidth = child.getBoundingClientRect().width + gap;
      continue;
    }
    let width = child.getBoundingClientRect().width;
    for (const part of Array.from(child.querySelectorAll<HTMLElement>('[data-fold-id]'))) {
      const partId = part.dataset.foldId;
      if (!isContextBarFoldId(partId)) continue;
      const partWidth = innerPartWidth(part);
      // A part still in its pill is in the pill's width.
      if (!part.hasAttribute('data-folded')) width -= partWidth;
      items.push({ id: partId, width: partWidth });
    }
    if (child.hasAttribute('data-meter')) width = meterMinimumWidth(child, width);
    const id = child.dataset.foldId;
    if (isContextBarFoldId(id)) items.push({ id, width: width + gap });
    else fixedWidth += width + gap;
  }
  return { available, fixedWidth, items, moreWidth };
}

/**
 * The pills folded out of `barRef`'s row. `frozen` holds the set while the +N
 * list is open, so what it lists does not change under the pointer.
 */
export function useContextBarFold(
  barRef: RefObject<HTMLElement | null>,
  { active, frozen }: { active: boolean; frozen: boolean },
): Set<ContextBarFoldId> {
  const [folded, setFolded] = useState<Set<ContextBarFoldId>>(() => new Set());

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!active || frozen || !bar) return;
    const recompute = (): void => {
      const next = resolveContextBarFold(measureContextBarFold(bar));
      setFolded((previous) => (sameSet(previous, next) ? previous : next));
    };
    const resizeObserver = new ResizeObserver(recompute);
    const observeRow = (): void => {
      resizeObserver.disconnect();
      resizeObserver.observe(bar);
      for (const element of Array.from(bar.querySelectorAll<HTMLElement>(':scope > *, [data-fold-id]'))) {
        resizeObserver.observe(element);
      }
    };
    observeRow();
    // A pill a setting turns on or off, or a usage report that adds one: watch it too.
    const mutationObserver = new MutationObserver(() => {
      observeRow();
      recompute();
    });
    mutationObserver.observe(bar, { childList: true, subtree: true });
    recompute();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [barRef, active, frozen]);

  return folded;
}

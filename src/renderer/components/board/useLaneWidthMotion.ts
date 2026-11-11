import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { motionReduced } from '../../utils/motion-reduced';
import {
  LANE_COUNT_ATTRIBUTE,
  LANE_HEADER_ATTRIBUTE,
  LANE_WIDTH_MOTION_EASING,
  LANE_WIDTH_MOTION_MS,
  SHRUNK_LANE_WIDTH_PROPERTY,
} from './lane-widths';

/** The attribute `KanbanBoard` stamps on each column's wrapper, holding the column's id. */
export const LANE_WRAPPER_ATTRIBUTE = 'data-lane-wrapper';

/**
 * After the board mounts or the project changes, the first reloads settle what
 * the board shows (a column that emptied while the user was away). Those are an
 * arrival, not a live change, so nothing eases until this has passed
 * (`restore-no-animation-replay.md`).
 */
const ARRIVAL_QUIET_MS = 1000;

/** A width that moved less than this did not move. */
const WIDTH_EPSILON_PX = 0.5;

/**
 * Give every shrunk column one width: the widest header on the board, whether
 * its column is empty or not.
 *
 * It was the widest EMPTY column's header. A drop that emptied one column and
 * filled another changed which columns were empty, so columns that had nothing
 * to do with the move grew or shrank under it (20px, measured). A width that
 * every header on the board fits does not depend on where the cards are.
 *
 * Each header is measured on a copy laid out at its natural width, off to the
 * side, so no column and no card is laid out again. The copy's count reads 0,
 * what an empty column shows, so a tenth card in a column does not widen the
 * empty ones. A collapsed column draws no header and keeps the width it last
 * measured. All before paint: one layout of the copies.
 */
function equalizeShrunkLanes(row: HTMLElement, headerWidths: Map<string, number>): void {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;width:max-content';
  const copies: Array<{ laneId: string; wrapper: HTMLElement; header: HTMLElement; copy: HTMLElement }> = [];
  const inRow = new Set<string>();
  for (const wrapper of row.querySelectorAll<HTMLElement>(`[${LANE_WRAPPER_ATTRIBUTE}]`)) {
    const laneId = wrapper.getAttribute(LANE_WRAPPER_ATTRIBUTE);
    if (!laneId) continue;
    inRow.add(laneId);
    const header = wrapper.querySelector<HTMLElement>(`[${LANE_HEADER_ATTRIBUTE}]`);
    if (!header) continue;
    const copy = header.cloneNode(true) as HTMLElement;
    copy.style.width = 'max-content';
    const count = copy.querySelector(`[${LANE_COUNT_ATTRIBUTE}]`);
    const digits = count ? document.createTreeWalker(count, NodeFilter.SHOW_TEXT).nextNode() : null;
    if (digits) digits.nodeValue = '0';
    probe.appendChild(copy);
    copies.push({ laneId, wrapper, header, copy });
  }
  row.appendChild(probe);
  for (const { laneId, wrapper, header, copy } of copies) {
    // What the column adds around its header (its own edges), read off the live one.
    const edges = wrapper.getBoundingClientRect().width - header.getBoundingClientRect().width;
    headerWidths.set(laneId, copy.getBoundingClientRect().width + Math.max(0, edges));
  }
  probe.remove();
  for (const laneId of [...headerWidths.keys()]) {
    if (!inRow.has(laneId)) headerWidths.delete(laneId);
  }
  const widest = Math.max(0, ...headerWidths.values());
  if (widest > 0) row.style.setProperty(SHRUNK_LANE_WIDTH_PROPERTY, `${Math.ceil(widest)}px`);
  else row.style.removeProperty(SHRUNK_LANE_WIDTH_PROPERTY);
}

/**
 * Eases the board's columns to their new widths when a column changes shape
 * (#1056): it emptied or took its first card, or the user collapsed or expanded
 * it.
 *
 * The widths themselves are CSS (`lane-widths.ts`): flex shares the row, and an
 * empty column is as wide as its content. CSS cannot ease between those, so
 * this plays the change itself. It keeps each wrapper's last width, measures
 * the new one in the commit that changed the shapes, and animates every wrapper
 * from the old width to the new for 200ms. When the animation ends it is gone,
 * and the CSS already holds the same width.
 *
 * It eases only on a shape change. A window resize, a sidebar drag and a
 * Column width change move widths with every shape the same, and they snap. It
 * never plays on the first paint, for a moment after a project switch, during
 * a drag (dnd-kit measured its drop targets at the drag's start), or with
 * Animations off.
 */
export function useLaneWidthMotion(options: {
  rowRef: RefObject<HTMLElement | null>;
  /** `laneShapesKey` of the row. The motion plays when it changes. */
  shapesKey: string;
  /** The columns in the row. A changed set re-attaches the width observer. */
  laneIdsKey: string;
  /** What a shrunk column's header draws (the names). A change measures the shared shrunk width again. */
  shrunkContentKey: string;
  /** The project the board shows. A change is an arrival. */
  projectId: string | null;
  dragging: boolean;
}): void {
  const { rowRef, shapesKey, laneIdsKey, shrunkContentKey, projectId, dragging } = options;
  // Keyed by the wrapper ELEMENT, never the column's id. The row can be
  // rebuilt with the same columns in it (the board's drag context re-keys on a
  // Fast Refresh, and the row unmounts while the board is not hydrated), and a
  // width remembered by id would then be the width of an element that is gone.
  // A removed element reports 0, so every column eased in from nothing: the
  // whole board squashed to the left on the next collapse.
  const widthsRef = useRef<WeakMap<Element, number>>(new WeakMap());
  const observedRef = useRef<{ row: HTMLElement | null; laneIdsKey: string; observer: ResizeObserver | null }>({
    row: null,
    laneIdsKey: '',
    observer: null,
  });
  const previousRef = useRef<{ shapesKey: string; projectId: string | null } | null>(null);
  // Each column's header width as last measured, by column id: a width of the
  // column's content, so it holds across a rebuilt row. Emptied when the
  // headers' content changes (a rename, a Column width change).
  const headerWidthsRef = useRef<{ contentKey: string; widths: Map<string, number> }>({ contentKey: '', widths: new Map() });
  const quietUntilRef = useRef(0);
  const animationsRef = useRef<Animation[]>([]);
  // The row element the shared shrunk width was last written on. The width is
  // an inline custom property, so it lives on that element and nowhere else.
  const equalizedRowRef = useRef<HTMLElement | null>(null);

  // Each wrapper's width as last laid out, mid-animation frames included, so a
  // change that lands during a motion starts from where the column is. Runs
  // after every commit and re-attaches only when the row element or its
  // columns changed: no dependency list can name "the row was rebuilt".
  useEffect(() => {
    const row = rowRef.current;
    const observed = observedRef.current;
    if (row === observed.row && laneIdsKey === observed.laneIdsKey) return;
    observed.observer?.disconnect();
    observed.row = row;
    observed.laneIdsKey = laneIdsKey;
    observed.observer = null;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // A wrapper taken out of the page reports 0. That is not a width it had.
        if (!entry.target.isConnected) continue;
        widthsRef.current.set(entry.target, entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
      }
    });
    for (const wrapper of row.querySelectorAll(`[${LANE_WRAPPER_ATTRIBUTE}]`)) observer.observe(wrapper);
    observed.observer = observer;
  });
  useEffect(() => () => {
    observedRef.current.observer?.disconnect();
    observedRef.current = { row: null, laneIdsKey: '', observer: null };
  }, []);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { shapesKey, projectId };
    const arrived = !previous || previous.projectId !== projectId;
    if (arrived) quietUntilRef.current = performance.now() + ARRIVAL_QUIET_MS;
    const row = rowRef.current;
    if (!row) return;

    // End whatever is still easing first. A pinned wrapper cannot be measured,
    // and a drag (which re-runs this) measures its drop targets as it starts.
    for (const animation of animationsRef.current) animation.cancel();
    animationsRef.current = [];

    if (headerWidthsRef.current.contentKey !== shrunkContentKey) {
      headerWidthsRef.current = { contentKey: shrunkContentKey, widths: new Map() };
    }
    equalizeShrunkLanes(row, headerWidthsRef.current.widths);
    equalizedRowRef.current = row;

    if (arrived || previous.shapesKey === shapesKey) return;
    if (dragging || motionReduced() || performance.now() < quietUntilRef.current) return;

    const moves: Array<{ wrapper: HTMLElement; from: number; to: number }> = [];
    let changed = false;
    for (const wrapper of row.querySelectorAll<HTMLElement>(`[${LANE_WRAPPER_ATTRIBUTE}]`)) {
      const from = widthsRef.current.get(wrapper);
      // A column with no earlier width is new to the row. It appears at its
      // width. A column is never 0 wide, so a 0 is no width to ease from either.
      if (from === undefined || from <= 0) continue;
      const to = wrapper.getBoundingClientRect().width;
      if (Math.abs(to - from) >= WIDTH_EPSILON_PX) changed = true;
      moves.push({ wrapper, from, to });
    }
    if (!changed) return;

    const timing: KeyframeAnimationOptions = { duration: LANE_WIDTH_MOTION_MS, easing: LANE_WIDTH_MOTION_EASING };
    // Every wrapper is pinned for the motion, the still ones too: a column left
    // on its flex share would take up the room the others have not reached yet.
    const pinned = (width: number): Keyframe => ({
      width: `${width}px`,
      minWidth: `${width}px`,
      maxWidth: `${width}px`,
      flex: '0 0 auto',
      // The column's content is laid out at its final width and uncovered as
      // the wrapper opens. `clip` with a margin keeps the lane's 1px ring.
      overflow: 'clip',
      overflowClipMargin: '2px',
    });
    for (const { wrapper, from, to } of moves) {
      animationsRef.current.push(wrapper.animate([pinned(from), pinned(to)], timing));
      const lane = wrapper.firstElementChild;
      // A column that opens holds its content at the final width, so cards do
      // not re-wrap on every frame of a strip opening.
      if (to > from && lane instanceof HTMLElement) {
        animationsRef.current.push(lane.animate([{ minWidth: `${to}px` }, { minWidth: `${to}px` }], timing));
      }
    }
  }, [rowRef, shapesKey, shrunkContentKey, projectId, dragging]);

  // The row can be rebuilt with nothing above changed: the board's drag context
  // re-keys on a Fast Refresh, and the row unmounts while the board is not
  // hydrated. The new element has no shared width on it, so every shrunk
  // column would size to its own header until the next shape change. Runs
  // after every commit, after the effect above, and measures only for a row
  // that effect did not just handle: no dependency list can name "the row was
  // rebuilt" (`hmr-patterns.md`, the re-key remount).
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || row === equalizedRowRef.current) return;
    equalizedRowRef.current = row;
    equalizeShrunkLanes(row, headerWidthsRef.current.widths);
  });

  // A header set in a font that has not loaded yet measures at the fallback's
  // width. Measure again once the fonts are in.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      const row = rowRef.current;
      if (!cancelled && row && animationsRef.current.length === 0) equalizeShrunkLanes(row, headerWidthsRef.current.widths);
    });
    return () => {
      cancelled = true;
    };
  }, [rowRef, laneIdsKey]);

  useEffect(() => () => {
    for (const animation of animationsRef.current) animation.cancel();
    animationsRef.current = [];
  }, []);
}

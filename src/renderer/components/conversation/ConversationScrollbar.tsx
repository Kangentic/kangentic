/**
 * Custom overlay scrollbar rail for the conversation viewer, replacing the
 * native scrollbar on the scroll container ONLY (see the
 * `.conversation-scroll-hide-native` rule in index.css - every other surface keeps the
 * global 8px scrollbar). At 10k+ messages a purely proportional native thumb
 * collapses to an ungrabbable sliver; this rail enforces a minimum thumb size
 * (`scrollbar-math.ts`) and stays fat and always visible instead of
 * hover-only, so it never competes with the panel's own resize handle for the
 * same few pixels at the window edge.
 *
 * Also renders the "jump to latest" pill (bottom-center, appears once the
 * user has scrolled away from the tail) as the explicit way back, since
 * auto-follow is gated off while the window is focused or hovered.
 *
 * Reads the container's native `scrollTop`/`scrollHeight`/`clientHeight`
 * rather than the virtualizer's own reactive fields - the virtualizer sets
 * those same DOM properties under the hood, so this stays fully decoupled
 * from @tanstack/react-virtual's API surface while remaining exact.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowDown, Hash } from 'lucide-react';
import { formatTime } from '../../lib/datetime';
import { computeThumbGeometry, thumbPositionToOffset, isScrolledToBottom, FAR_FROM_BOTTOM_PX, type ScrollGeometry } from './scrollbar-math';
import type { DisplayRow } from './display-rows';

interface ConversationScrollbarProps {
  containerRef: RefObject<HTMLDivElement | null>;
  rows: DisplayRow[];
  onJumpToLatest: () => void;
  /** Reports whether the rail is currently showing (content overflows the
   *  viewport), so ConversationView can reclaim the row's extra right-side
   *  clearance when there's no scrollbar to clear. */
  onShowRailChange?: (showRail: boolean) => void;
}

/** Flush to the window's right edge (no inset gap) with a visible track
 *  background, so it reads as a traditional vertical scrollbar rather than a
 *  floating pill. The thumb sits inside the track with a small fixed margin. */
const RAIL_WIDTH_PX = 14;
const THUMB_MARGIN_PX = 3;

/** Matches ConversationView's row wrapper `pl-3` (12px) - the message box's
 *  own left inset from the window's left edge. Exported (not just inline in
 *  ConversationView) because CONTENT_RIGHT_CLEARANCE_PX reproduces it on the
 *  right side too, and ConversationView reuses it as the row's right padding
 *  when there is no scrollbar to clear (reclaiming the extra clearance). */
export const ROW_LEFT_INSET_PX = 12;

/** How far a message row's own right edge must sit from the window's right
 *  edge so the gap between the message border and the thumb's LEFT edge
 *  matches the message's own left inset (ROW_LEFT_INSET_PX) - the same
 *  breathing room a message keeps from the window's left edge, mirrored on
 *  the right. The thumb's left edge sits THUMB_MARGIN_PX in from the rail's
 *  own left edge (RAIL_WIDTH_PX = thumb width + a THUMB_MARGIN_PX margin on
 *  each side), so the message border needs to clear that PLUS the desired
 *  gap. Exported so ConversationView can size its row padding against it
 *  instead of duplicating the rail's own geometry as a second magic number. */
export const CONTENT_RIGHT_CLEARANCE_PX = (RAIL_WIDTH_PX - THUMB_MARGIN_PX) + ROW_LEFT_INSET_PX;

export function ConversationScrollbar({ containerRef, rows, onJumpToLatest, onShowRailChange }: ConversationScrollbarProps) {
  const [geometry, setGeometry] = useState<ScrollGeometry>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isHoveringRail, setIsHoveringRail] = useState(false);
  const dragStateRef = useRef<{ pointerId: number; startClientY: number; startThumbTop: number } | null>(null);
  const scrollReadRafRef = useRef<number | null>(null);
  const dragApplyRafRef = useRef<number | null>(null);
  const pendingDragOffsetRef = useRef<number | null>(null);

  const readGeometry = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    setGeometry({ scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, clientHeight: container.clientHeight });
  }, [containerRef]);

  useEffect(() => {
    readGeometry();
    const container = containerRef.current;
    if (!container) return undefined;
    const handleScroll = () => {
      if (scrollReadRafRef.current !== null) return;
      scrollReadRafRef.current = requestAnimationFrame(() => {
        scrollReadRafRef.current = null;
        readGeometry();
      });
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(readGeometry);
    resizeObserver.observe(container);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
      if (scrollReadRafRef.current !== null) cancelAnimationFrame(scrollReadRafRef.current);
    };
    // Re-observe when the row count changes (a live append can grow
    // scrollHeight without firing a 'scroll' event).
  }, [containerRef, readGeometry, rows.length]);

  const railSize = geometry.clientHeight;
  const { thumbTop, thumbSize } = computeThumbGeometry({
    scrollOffset: geometry.scrollTop,
    totalSize: geometry.scrollHeight,
    viewportSize: railSize,
    railSize,
  });

  const flushDragOffset = useCallback(() => {
    dragApplyRafRef.current = null;
    const container = containerRef.current;
    if (container && pendingDragOffsetRef.current !== null) {
      container.scrollTop = pendingDragOffsetRef.current;
    }
  }, [containerRef]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = { pointerId: event.pointerId, startClientY: event.clientY, startThumbTop: thumbTop };
    setIsDragging(true);
  }, [thumbTop]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - dragState.startClientY;
    const offset = thumbPositionToOffset({
      thumbTop: dragState.startThumbTop + deltaY,
      thumbSize,
      totalSize: geometry.scrollHeight,
      viewportSize: railSize,
      railSize,
    });
    pendingDragOffsetRef.current = offset;
    if (dragApplyRafRef.current === null) {
      dragApplyRafRef.current = requestAnimationFrame(flushDragOffset);
    }
  }, [thumbSize, geometry.scrollHeight, railSize, flushDragOffset]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    setIsDragging(false);
    if (dragApplyRafRef.current !== null) {
      cancelAnimationFrame(dragApplyRafRef.current);
      flushDragOffset();
    }
  }, [flushDragOffset]);

  useEffect(() => {
    return () => {
      if (scrollReadRafRef.current !== null) cancelAnimationFrame(scrollReadRafRef.current);
      if (dragApplyRafRef.current !== null) cancelAnimationFrame(dragApplyRafRef.current);
    };
  }, []);

  const distanceFromBottom = geometry.scrollHeight - (geometry.scrollTop + geometry.clientHeight);
  const isAtBottom = isScrolledToBottom(geometry);
  const showRail = geometry.scrollHeight > railSize && railSize > 0;

  useEffect(() => {
    onShowRailChange?.(showRail);
  }, [showRail, onShowRailChange]);

  const handleJumpClick = useCallback(() => {
    onJumpToLatest();
  }, [onJumpToLatest]);

  // Scrub bubble: approximate which row is under the thumb, using scroll
  // PROGRESS against the row count as a proxy - close enough for a live label
  // while dragging (not a precision requirement; the real destination is
  // whatever offset the drag lands on).
  const progress = geometry.scrollHeight > railSize
    ? geometry.scrollTop / (geometry.scrollHeight - railSize)
    : 0;
  const anchoredIndex = rows.length > 0
    ? Math.min(rows.length - 1, Math.max(0, Math.round(progress * (rows.length - 1))))
    : 0;
  const anchoredRow = rows[anchoredIndex];
  const showExpandedThumb = isDragging || isHoveringRail;

  return (
    <>
      {showRail && (
        <div
          className={`absolute top-0 bottom-0 right-0 select-none transition-colors duration-150 ${
            showExpandedThumb ? 'bg-fg/[0.05]' : 'bg-fg/[0.02]'
          }`}
          style={{ width: RAIL_WIDTH_PX }}
          onMouseEnter={() => setIsHoveringRail(true)}
          onMouseLeave={() => setIsHoveringRail(false)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          data-testid="conversation-scrollbar-rail"
        >
          <div
            className={`absolute w-2 rounded-sm transition-colors duration-150 ${
              showExpandedThumb ? 'bg-[var(--kng-edge-input)]' : 'bg-[var(--kng-edge)]'
            }`}
            style={{ top: thumbTop, height: thumbSize, right: THUMB_MARGIN_PX }}
            data-testid="conversation-scrollbar-thumb"
          />
          {isDragging && anchoredRow && (
            <div
              className="absolute right-full mr-2 whitespace-nowrap rounded-md border border-edge bg-surface-raised px-2 py-1.5 text-[11px] text-fg shadow-lg flex flex-col gap-1"
              style={{ top: Math.max(0, thumbTop) }}
              data-testid="conversation-scrollbar-bubble"
            >
              {anchoredRow.entry.ts > 0 && <span>{formatTime(anchoredRow.entry.ts)}</span>}
              <span className="flex items-center gap-1 text-fg-muted">
                <Hash size={11} className="flex-shrink-0" />
                {anchoredIndex + 1} of {rows.length}
              </span>
            </div>
          )}
        </div>
      )}
      {!isAtBottom && geometry.scrollHeight > 0 && (
        <button
          type="button"
          onClick={handleJumpClick}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-edge bg-surface-raised px-3 py-1.5 text-xs text-fg-secondary shadow-lg hover:bg-surface-hover transition-colors"
          data-testid="conversation-jump-to-latest"
          data-far={distanceFromBottom > FAR_FROM_BOTTOM_PX ? 'true' : undefined}
        >
          <ArrowDown size={13} />
          Jump to latest
        </button>
      )}
    </>
  );
}

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
 *
 * A paged window (`logical`) sizes and places the thumb against the WHOLE
 * transcript, not the rows loaded: the container still scrolls natively, and
 * its offsets map to and from the transcript's logical positions. A drag
 * inside the loaded rows scrolls them; a drag past them shows placeholder rows
 * and the target's date, and loads the page there once the pointer rests or
 * lets go. The page lands with the view still mounted, so the rows appear
 * under a pointer that is still held and the drag carries on over them.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ArrowDown, Hash } from 'lucide-react';
import { formatMonthDayTime, formatTime } from '../../lib/datetime';
import { computeThumbGeometry, thumbPositionToOffset, isScrolledToBottom, FAR_FROM_BOTTOM_PX, type ScrollGeometry } from './scrollbar-math';
import { ConversationSkeleton } from './ConversationSkeleton';
import type { DisplayRow } from './display-rows';

/** A paged window's drag: the logical position at the thumb's top, whether it
 *  is past the loaded rows, and the viewport's logical size when it started. */
interface LogicalDrag {
  logical: number;
  far: boolean;
  viewportLogical: number;
}

/** A paged window's whole-transcript coordinate, as the scrollbar reads it. */
export interface LogicalScroll {
  total: number;
  /** The logical position at a pixel offset of the scroll content. */
  atOffset: (offset: number) => number;
  /** The pixel offset of a logical position, or null outside the loaded rows. */
  offsetAt: (logical: number) => number | null;
  /** The time at a logical position, or null where there are no timestamps. */
  timeAt: (logical: number) => number | null;
  /** A drag resting or released past the loaded rows: load the page there. Null drops the read. */
  onFarSeek: (logical: number | null) => Promise<FarSeekOutcome>;
}

/**
 * How a far drag's read ended: its page is in the window, it came back without
 * the page, or a newer read, a jump or a cancel took its place.
 */
export type FarSeekOutcome = 'landed' | 'failed' | 'dropped';

/** How long a far drag rests before the page under it is read. */
const FAR_REST_MS = 120;
/** How long a held far drag waits to ask once more after its read came back without the page. */
const FAR_RETRY_MS = 1000;

interface ConversationScrollbarProps {
  containerRef: RefObject<HTMLDivElement | null>;
  rows: DisplayRow[];
  onJumpToLatest: () => void;
  /** Reports whether the rail is currently showing (content overflows the
   *  viewport), so ConversationView can reclaim the row's extra right-side
   *  clearance when there's no scrollbar to clear. */
  onShowRailChange?: (showRail: boolean) => void;
  /** Set for a paged window: the thumb covers the whole transcript. */
  logical?: LogicalScroll | null;
  /** False when the loaded rows stop short of the newest message: Jump to latest shows. */
  windowReachesTail?: boolean;
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

export function ConversationScrollbar({
  containerRef,
  rows,
  onJumpToLatest,
  onShowRailChange,
  logical = null,
  windowReachesTail = true,
}: ConversationScrollbarProps) {
  const [geometry, setGeometry] = useState<ScrollGeometry>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isHoveringRail, setIsHoveringRail] = useState(false);
  // A paged window's drag: the logical position under the thumb, and whether
  // it is past the loaded rows (a far drag).
  const [dragLogical, setDragLogical] = useState<LogicalDrag | null>(null);
  const dragLogicalRef = useRef<LogicalDrag | null>(null);
  // A far drag let go before its page landed: its placeholders hold until it does.
  const [heldFar, setHeldFar] = useState<LogicalDrag | null>(null);
  const dragStateRef = useRef<{ pointerId: number; startClientY: number; startThumbTop: number; viewportLogical: number } | null>(null);
  const scrollReadRafRef = useRef<number | null>(null);
  const dragApplyRafRef = useRef<number | null>(null);
  const pendingDragOffsetRef = useRef<number | null>(null);
  const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The far position last asked for, so a rest and a release ask once.
  const askedFarRef = useRef<number | null>(null);
  // The far position already asked for a second time, so a read that keeps
  // failing under a held pointer is retried once, not in a loop.
  const retriedFarRef = useRef<number | null>(null);
  const logicalRef = useRef<LogicalScroll | null>(logical);
  useLayoutEffect(() => {
    logicalRef.current = logical;
  });

  const clearRestTimer = useCallback(() => {
    if (restTimerRef.current !== null) {
      clearTimeout(restTimerRef.current);
      restTimerRef.current = null;
    }
  }, []);

  const askForFar = useCallback((target: number | null) => {
    const ask = (asked: number | null): void => {
      if (askedFarRef.current === asked) return;
      askedFarRef.current = asked;
      const seek = logicalRef.current?.onFarSeek(asked);
      if (asked === null || !seek) return;
      void seek.then((outcome) => {
        // A newer ask took this one's place and answers for itself.
        if (askedFarRef.current !== asked) return;
        askedFarRef.current = null;
        if (outcome === 'dropped') return;
        if (dragStateRef.current) {
          // Still resting out there after a read that came back without the
          // page: ask once more, on the rest timer, so a move cancels it.
          const drag = dragLogicalRef.current;
          if (outcome === 'failed' && drag?.far && drag.logical === asked && retriedFarRef.current !== asked) {
            retriedFarRef.current = asked;
            clearRestTimer();
            restTimerRef.current = setTimeout(() => {
              restTimerRef.current = null;
              ask(asked);
            }, FAR_RETRY_MS);
          }
          return;
        }
        // A release waiting on it: a failed read lets the placeholders go now,
        // and a landed one by the time its rows have rendered at the latest.
        const letGo = () => setHeldFar((held) => (held && held.logical === asked ? null : held));
        if (outcome === 'failed') letGo();
        else setTimeout(letGo, FAR_RETRY_MS);
      });
    };
    ask(target);
  }, [clearRestTimer]);

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
  // A paged window measures in logical units: where the viewport's top and
  // bottom fall in the whole transcript.
  const logicalTop = logical ? logical.atOffset(geometry.scrollTop) : 0;
  const viewportLogical = logical
    ? Math.max(1, logical.atOffset(geometry.scrollTop + geometry.clientHeight) - logicalTop)
    : 0;
  // A far drag scrolls nothing, so its thumb follows the pointer's target, and
  // stays there after a release until the page lands.
  const farDrag = logical ? (dragLogical?.far ? dragLogical : heldFar) : null;
  const { thumbTop, thumbSize } = logical
    ? computeThumbGeometry({
      scrollOffset: farDrag ? farDrag.logical : logicalTop,
      totalSize: logical.total,
      viewportSize: farDrag ? farDrag.viewportLogical : viewportLogical,
      railSize,
    })
    : computeThumbGeometry({
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
    // A new drag starts from where the thumb is drawn, a held far target included.
    const held = farDrag;
    // And gets its own retry: the track's ends are the same position every drag.
    retriedFarRef.current = null;
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startThumbTop: thumbTop,
      viewportLogical: held ? held.viewportLogical : viewportLogical,
    };
    if (held) {
      dragLogicalRef.current = held;
      setDragLogical(held);
      setHeldFar(null);
    }
    setIsDragging(true);
  }, [farDrag, thumbTop, viewportLogical]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - dragState.startClientY;
    let offset: number | null;
    if (logical) {
      // The viewport's logical size is held from the drag's start, so a page
      // landing mid-drag does not resize the thumb under the pointer.
      const target = thumbPositionToOffset({
        thumbTop: dragState.startThumbTop + deltaY,
        thumbSize,
        totalSize: logical.total,
        viewportSize: dragState.viewportLogical,
        railSize,
      });
      offset = logical.offsetAt(target);
      const far = offset === null;
      dragLogicalRef.current = { logical: target, far, viewportLogical: dragState.viewportLogical };
      setDragLogical(dragLogicalRef.current);
      clearRestTimer();
      if (far) {
        // Past the loaded rows: once the pointer rests there, read the page under it.
        restTimerRef.current = setTimeout(() => {
          restTimerRef.current = null;
          askForFar(target);
        }, FAR_REST_MS);
      } else if (askedFarRef.current !== null) {
        // Back over loaded rows: the page asked for is no longer wanted.
        askForFar(null);
      }
    } else {
      offset = thumbPositionToOffset({
        thumbTop: dragState.startThumbTop + deltaY,
        thumbSize,
        totalSize: geometry.scrollHeight,
        viewportSize: railSize,
        railSize,
      });
    }
    pendingDragOffsetRef.current = offset;
    if (offset !== null && dragApplyRafRef.current === null) {
      dragApplyRafRef.current = requestAnimationFrame(flushDragOffset);
    }
  }, [logical, thumbSize, geometry.scrollHeight, railSize, flushDragOffset, clearRestTimer, askForFar]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    setIsDragging(false);
    clearRestTimer();
    const released = dragLogicalRef.current;
    dragLogicalRef.current = null;
    setDragLogical(null);
    if (released?.far && logical) {
      // Let go past the loaded rows: read the page there, if the rest has not
      // already, and hold the placeholders until it lands.
      askForFar(released.logical);
      setHeldFar(released);
    }
    if (dragApplyRafRef.current !== null) {
      cancelAnimationFrame(dragApplyRafRef.current);
      flushDragOffset();
    }
  }, [logical, flushDragOffset, clearRestTimer, askForFar]);

  // A far target's page landed (the window now holds the target): scroll to it,
  // and take the placeholders down a frame later, once the rows there have
  // rendered.
  useEffect(() => {
    const pending = dragLogicalRef.current?.far ? dragLogicalRef.current : heldFar;
    if (!logical || !pending) return undefined;
    const offset = logical.offsetAt(pending.logical);
    if (offset === null) return undefined;
    const container = containerRef.current;
    if (container) container.scrollTop = offset;
    let frame: number | null = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (dragStateRef.current) {
          if (dragLogicalRef.current?.far && dragLogicalRef.current.logical === pending.logical) {
            dragLogicalRef.current = { ...pending, far: false };
            setDragLogical(dragLogicalRef.current);
          }
        } else {
          setHeldFar(null);
        }
      });
    });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [logical, heldFar, containerRef]);

  useEffect(() => {
    return () => {
      if (scrollReadRafRef.current !== null) cancelAnimationFrame(scrollReadRafRef.current);
      if (dragApplyRafRef.current !== null) cancelAnimationFrame(dragApplyRafRef.current);
      clearRestTimer();
    };
  }, [clearRestTimer]);

  const distanceFromBottom = geometry.scrollHeight - (geometry.scrollTop + geometry.clientHeight);
  const isAtBottom = isScrolledToBottom(geometry);
  // A paged window always has more transcript than it shows, so its track shows.
  const showRail = railSize > 0 && (logical !== null || geometry.scrollHeight > railSize);
  const dragLabelTs = logical && dragLogical ? logical.timeAt(dragLogical.logical) : null;

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
      {farDrag && (
        // Past the loaded rows: placeholder rows stand in until the page there lands.
        <ConversationSkeleton labelTs={null} className="absolute top-0 bottom-0 left-0" style={{ right: RAIL_WIDTH_PX }} />
      )}
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
          {isDragging && logical && dragLabelTs !== null && (
            // A paged window's label: the date and time under the thumb, from
            // the whole transcript rather than the rows loaded.
            <div
              className="absolute right-full mr-2 whitespace-nowrap rounded-md border border-edge bg-surface-raised px-2 py-1.5 text-[11px] text-fg shadow-lg"
              style={{ top: Math.max(0, thumbTop) }}
              data-testid="conversation-scrollbar-bubble"
            >
              {formatMonthDayTime(dragLabelTs)}
            </div>
          )}
          {isDragging && !logical && anchoredRow && (
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
      {(!isAtBottom || !windowReachesTail) && geometry.scrollHeight > 0 && (
        <button
          type="button"
          onClick={handleJumpClick}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-edge bg-surface-raised px-3 py-1.5 text-xs text-fg-secondary shadow-lg hover:bg-surface-hover transition-colors"
          data-testid="conversation-jump-to-latest"
          data-far={distanceFromBottom > FAR_FROM_BOTTOM_PX || !windowReachesTail ? 'true' : undefined}
        >
          <ArrowDown size={13} />
          Jump to latest
        </button>
      )}
    </>
  );
}

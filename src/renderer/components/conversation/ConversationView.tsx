/**
 * Pure, virtualized renderer for a single agent conversation transcript.
 *
 * Renders the structured `TranscriptEntry[]` (agent-agnostic) with dynamic row
 * measurement (turn heights vary, unlike the fixed-row ActivityLog). tool_result
 * entries are folded into their owning tool_use card via `reconcileDisplayRows`
 * (`display-rows.ts`); a tool_result with no owning tool_use in this parse (an
 * orphan, e.g. after a resume) renders as its own standalone row.
 *
 * Stateless with respect to fetching: the owning ConversationWindow fetches and
 * passes the loaded entries down. `reconcileDisplayRows` reuses a previous
 * row's object identity whenever its uuid and content are unchanged, which is
 * what lets `MemoConversationRow`'s default shallow-compare skip re-rendering
 * (and re-parsing markdown) rows a live-poll tick did not actually change.
 *
 * Three things can move the scroll position, coordinated through one bounded
 * rAF "settle loop" (`useScrollSettle`) so they never fight each other:
 *   1. Mount-time initial positioning (`initialPosition` / `scrollToTurnUuid`
 *      already set at open) - the container stays `visibility: hidden` for the
 *      few settle frames so the viewer opens already positioned, no top-flash.
 *   2. A later `scrollToTurnUuid` (search palette, or the in-viewer search bar
 *      via `navigateToUuid`) - centers + flashes the target for 4s.
 *   3. Auto-follow-to-bottom on a live-poll append - suppressed while a settle
 *      loop is active, and cancelled itself by any user wheel/pointerdown.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronRight, ChevronDown, Wrench, MessageSquareWarning, Bot, User, Terminal, Copy, Check } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { HeaderActionButton } from '../HeaderActionButton';
import { useKeybinding } from '../../hooks/useKeybinding';
import { ConversationSearchBar, type ConversationSearchBarHandle } from './ConversationSearchBar';
import { ConversationScrollbar, CONTENT_RIGHT_CLEARANCE_PX, ROW_LEFT_INSET_PX } from './ConversationScrollbar';
import { reconcileDisplayRows, isSlashCommandRow, speakerGroup, type DisplayRow, type DisplayRowResult } from './display-rows';
import { FAR_FROM_BOTTOM_PX } from './scrollbar-math';
import { ESTIMATED_ROW_HEIGHT, computeSettleScrollTop, type SettleVirtualItem } from './settle-scroll';
import { renderAssistantBlocksMarkdown } from '../../../shared/transcript-format';
import { sanitizeTranscriptText } from '../../../shared/ansi-strip';
import { humanizeModelId } from '../../../shared/model-id';
import { parseFileEditTool, computeLineDiff, diffStats, type FileEdit } from '../../../shared/tool-diff';
import { formatTime } from '../../lib/datetime';
import type {
  TranscriptEntry,
  TranscriptSource,
  TranscriptUnavailableReason,
  TranscriptBlock,
} from '../../../shared/types';

/** Result bodies longer than this are clamped with a "Show all" toggle. */
const RESULT_CLAMP_CHARS = 4000;
const HIGHLIGHT_DURATION_MS = 4000;

/** Where the viewer opens by default (no `scrollToTurnUuid`): the latest
 *  message, or centered on the row matching the terminal's visible
 *  scrollback (see `tui-anchor.ts`). Computed by `ConversationWindow`. */
export type InitialPosition = { kind: 'bottom' } | { kind: 'uuid'; uuid: string };

interface ConversationViewProps {
  entries: TranscriptEntry[];
  degraded: boolean;
  source: TranscriptSource;
  unavailableReason?: TranscriptUnavailableReason;
  /** Agent CLI display name (e.g. "Claude Code") shown as each agent turn's role
   *  pill; falls back to "Agent" when unknown. */
  agentName?: string;
  /** One-shot: scroll to (and highlight) the row with this uuid, then clear. */
  scrollToTurnUuid: string | null;
  /** Called once the scroll-to signal has been consumed (found or not). */
  onConsumedScroll: () => void;
  /** Whether new turns arriving (a live session's transcript growing) should
   *  smoothly auto-scroll to the bottom. The owning window gates this on the
   *  user NOT focusing or hovering it, so reading an earlier part of the
   *  transcript is never yanked out from under them. */
  autoFollowNewMessages: boolean;
  /** Where to position on first paint, when no `scrollToTurnUuid` wins first. */
  initialPosition: InitialPosition;
  /** Whether the owning window is focused - gates the Mod+F keybinding that
   *  focuses the (always-visible) in-viewer search bar. */
  isFocused: boolean;
}

/**
 * Bounded settle loop that drives the scroll container's `scrollTop`
 * DIRECTLY (never through `virtualizer.scrollToIndex`/`scrollToEnd`) until it
 * stabilizes across two ticks (or a tick cap is hit).
 *
 * For `align: 'center' | 'start'`, each tick delegates the actual scrollTop
 * math to `computeSettleScrollTop` (settle-scroll.ts, unit-tested there),
 * which first checks whether the target row is currently among the
 * virtualizer's OWN rendered `getVirtualItems()` - if so, its `start`/`size`
 * are real, measured values (accurate regardless of how far off the row's
 * static `estimatedHeight` heuristic was), and it uses them directly instead
 * of the heuristic. A target far from the current scroll position is not yet
 * rendered on tick 1, so that tick falls back to the heuristic-summed
 * estimate purely to get CLOSE - close enough that the browser's own
 * scrollTop clamping settles near the target's real rows, which the
 * virtualizer then renders, which the NEXT tick picks up via a fresh
 * `virtualItem`. This is what actually fulfills convergence: the heuristic
 * alone never improves across retries (it is static per row), so without
 * this real-measurement readback the loop would just rewrite the same wrong
 * value every tick and call it "stable".
 *
 * This bypasses `@tanstack/virtual-core`'s own scroll-to + reconcile
 * machinery on purpose: that reconcile path schedules its OWN
 * `requestAnimationFrame`-driven correction keyed off asynchronous
 * scroll/resize-observer callbacks, and on a freshly-mounted virtualizer (no
 * prior real measurements yet) that correction can race the browser's own
 * scroll-offset reporting and silently reset `scrollTop` back to 0 - exactly
 * the "opens at the top instead of the bottom" bug this feature exists to
 * fix. A raw, self-computed `scrollTop` write plus a `setTimeout`-based retry
 * (never `requestAnimationFrame`, which is throttled or never fires for a
 * backgrounded / not-yet-visible window) sidesteps that path entirely while
 * still converging on the real, measured position within a few ticks.
 * Cancelled by any user wheel/pointerdown on the scroll container.
 */
function useScrollSettle(
  containerRef: RefObject<HTMLDivElement | null>,
  rows: DisplayRow[],
  getVirtualItems: () => SettleVirtualItem[],
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSettlingRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    isSettlingRef.current = false;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const handleUserScroll = () => cancel();
    container.addEventListener('wheel', handleUserScroll, { passive: true });
    container.addEventListener('pointerdown', handleUserScroll);
    return () => {
      container.removeEventListener('wheel', handleUserScroll);
      container.removeEventListener('pointerdown', handleUserScroll);
    };
  }, [containerRef, cancel]);

  // Deliberately NO unmount-cleanup effect calling cancel() here. React
  // StrictMode's development-only double-invoke simulates an unmount+remount
  // of every effect immediately after mount (synchronously, within the same
  // task) - an unmount-cleanup effect here would cancel the settle loop's
  // pending correction tick before it ever fires, permanently leaving the
  // FIRST (imprecise, pre-measurement) position on screen. A genuinely
  // unmounted component already makes this safe without an explicit cancel:
  // React clears `containerRef.current` to null on unmount, and `step()`
  // below bails immediately when the container is gone.
  const settleToIndex = useCallback(
    (index: number, options?: { align?: 'center' | 'start' | 'end'; onSettled?: () => void; instant?: boolean }) => {
      cancel();
      isSettlingRef.current = true;
      const align = options?.align ?? 'center';
      const MAX_TICKS = 12;
      const TICK_MS = 16;
      const STABLE_TICKS_NEEDED = 2;
      let previousScrollTop: number | null = null;
      let stableTicks = 0;
      let tick = 0;

      const step = () => {
        const container = containerRef.current;
        if (!container) return;
        if (align === 'end') {
          // Browsers clamp an over-large scrollTop assignment to the real
          // max automatically, so this always lands exactly at the tail
          // regardless of how precise the estimate is.
          container.scrollTop = container.scrollHeight;
        } else {
          // Prefer the virtualizer's OWN item for this index when available.
          // The item exists from the first tick if the target is already
          // within the render range, but its start/size are only the static
          // estimateSize() substitutes until @tanstack/react-virtual's
          // ResizeObserver actually measures the rendered row (asynchronous,
          // typically ready by the NEXT tick) - at that point start/size flip
          // to real values and this converges to the true position, which the
          // static heuristic alone never would (see this function's doc
          // comment above and computeSettleScrollTop's in settle-scroll.ts).
          const virtualItem = getVirtualItems().find((item) => item.index === index);
          container.scrollTop = computeSettleScrollTop({ align, index, rows, virtualItem, clientHeight: container.clientHeight });
        }

        // `instant` (search-result navigation) skips the retry loop entirely:
        // a single synchronous jump, no visible multi-tick correction. This is
        // safe here specifically because it targets an already-mounted,
        // already-measured virtualizer (unlike the mount-time positioning this
        // loop also drives, which genuinely needs the retries - see the loop's
        // own doc comment above).
        if (options?.instant) {
          isSettlingRef.current = false;
          options?.onSettled?.();
          return;
        }

        const currentScrollTop = container.scrollTop;
        if (previousScrollTop !== null && Math.abs(currentScrollTop - previousScrollTop) < 1) {
          stableTicks += 1;
        } else {
          stableTicks = 0;
        }
        previousScrollTop = currentScrollTop;
        tick += 1;
        if (stableTicks >= STABLE_TICKS_NEEDED || tick >= MAX_TICKS) {
          isSettlingRef.current = false;
          timerRef.current = null;
          options?.onSettled?.();
          return;
        }
        timerRef.current = setTimeout(step, TICK_MS);
      };
      // The first step runs SYNCHRONOUSLY so the target is positioned
      // immediately in the common case; the timer-based retries correct it
      // once the container's real (measured) dimensions have settled.
      step();
    },
    [containerRef, rows, cancel, getVirtualItems],
  );

  return { settleToIndex, isSettlingRef };
}

export function ConversationView({
  entries,
  degraded,
  source,
  unavailableReason,
  agentName,
  scrollToTurnUuid,
  onConsumedScroll,
  autoFollowNewMessages,
  initialPosition,
  isFocused,
}: ConversationViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchBarRef = useRef<ConversationSearchBarHandle>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [highlightedUuid, setHighlightedUuid] = useState<string | null>(null);
  // Whether the custom scrollbar rail is currently showing (content
  // overflows the viewport) - reported by ConversationScrollbar so rows can
  // reclaim their extra right-side clearance when there's no rail to clear.
  const [hasScrollbar, setHasScrollbar] = useState(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Reuses row object identity across renders whenever a row's uuid + content
  // are unchanged (see display-rows.ts) - this is what lets MemoConversationRow
  // bail out of re-rendering. Mutating a ref during render to "remember last
  // result" is the same pattern React's own memoization guidance uses; it
  // never schedules a render itself, only caches for the NEXT call.
  const previousRowsRef = useRef<DisplayRow[]>([]);
  const rows = useMemo(() => {
    const next = reconcileDisplayRows(previousRowsRef.current, entries);
    previousRowsRef.current = next;
    return next;
  }, [entries]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => rows[index]?.estimatedHeight ?? ESTIMATED_ROW_HEIGHT,
    // Key the virtualizer's measurement cache by the entry's stable uuid, not
    // the default raw index. The live-poll can stitch new rows into the
    // MIDDLE of this array (a session_boundary divider plus a newly-live
    // session's entries), shifting every later row's index - without this,
    // the cache keeps applying an earlier row's already-measured height to
    // whatever new content now sits at that index, which visibly overlaps
    // rendered text until a scroll forces a full remeasure.
    getItemKey: (index) => rows[index].uuid,
    overscan: 8,
  });

  const getVirtualItems = useCallback(() => virtualizer.getVirtualItems(), [virtualizer]);
  const { settleToIndex, isSettlingRef } = useScrollSettle(containerRef, rows, getVirtualItems);

  // Core navigate-to-turn logic, shared by the scrollToTurnUuid prop effect,
  // the mount-time initial-position effect, and the in-viewer search bar's
  // result-click / prev-next navigation. Mirrors ActivityLog.tsx:188-213.
  const navigateToUuid = useCallback(
    (targetUuid: string, options?: { flash?: boolean; onSettled?: () => void; instant?: boolean }): boolean => {
      const flash = options?.flash ?? true;
      let index = rows.findIndex((row) => row.uuid === targetUuid);
      let expandKey: string | null = null;
      if (index < 0) {
        // The target may be a folded tool_result: scroll to its owning
        // assistant row and auto-expand the card that holds it.
        const target = entries.find((entry) => entry.uuid === targetUuid);
        if (target && target.kind === 'tool_result' && target.toolUseId) {
          const ownerToolUseId = target.toolUseId;
          index = rows.findIndex(
            (row) =>
              row.entry.kind === 'assistant'
              && row.entry.blocks.some(
                (block) => block.type === 'tool_use' && block.id === ownerToolUseId,
              ),
          );
          if (index >= 0) expandKey = ownerToolUseId;
        }
      }
      if (index < 0) return false;

      // A conversation search hit anchors on its matched chunk's FIRST turn,
      // which can be a bare slash-command. Landing on the command instead of
      // the content that actually matched is confusing, so advance past any
      // leading command turns to the first substantive one. Bounded and never
      // targets a folded tool_result redirect (expandKey), which is already
      // the right row.
      if (!expandKey) {
        let skip = 0;
        while (index + 1 < rows.length && isSlashCommandRow(rows[index].entry) && skip < 4) {
          index += 1;
          skip += 1;
        }
      }

      if (expandKey) {
        const key = expandKey;
        setExpandedKeys((previous) => new Set(previous).add(key));
      }
      settleToIndex(index, { align: 'center', onSettled: options?.onSettled, instant: options?.instant });
      if (flash) {
        const targetRowUuid = rows[index].uuid;
        setHighlightedUuid(targetRowUuid);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => {
          highlightTimerRef.current = undefined;
          setHighlightedUuid(null);
        }, HIGHLIGHT_DURATION_MS);
      }
      return true;
    },
    [rows, entries, settleToIndex],
  );

  // The in-viewer search bar's own navigation (result click / prev / next)
  // always snaps instantly - no multi-tick settle animation. Distinct from
  // navigateToUuid's other callers (mount-time positioning, the search
  // palette's scrollToTurnUuid), which keep the settle loop's retries.
  const navigateToUuidFromSearch = useCallback(
    (targetUuid: string) => navigateToUuid(targetUuid, { flash: true, instant: true }),
    [navigateToUuid],
  );

  // Mod+F focuses the always-visible search bar (it has no open/close state
  // to toggle - see conversation.find's registry comment for the deliberate
  // scope shadow over the board's global Mod+F).
  useKeybinding(
    'conversation.find',
    () => searchBarRef.current?.focus(),
    { capture: true, enabled: isFocused, stopPropagation: true },
  );

  // Mount-time positioning: applied once on the first render with non-empty
  // rows. Runs in a LAYOUT effect (synchronously after DOM mutation, before
  // the browser paints) and the settle loop's first jump is itself
  // synchronous (see useScrollSettle above), so the very first paint already
  // shows the target position - no separate "hide the container" step is
  // needed to avoid a top-flash. Precedence: an already-set `scrollToTurnUuid`
  // (opened from the search palette) wins, WITH the flash; else
  // `initialPosition` (the TUI-anchor match or bottom), with no flash - a
  // quiet open.
  const hasAppliedInitialPositionRef = useRef(false);
  const initialScrollHandledUuidRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (hasAppliedInitialPositionRef.current) return;
    if (rows.length === 0) return;
    hasAppliedInitialPositionRef.current = true;

    if (scrollToTurnUuid) {
      initialScrollHandledUuidRef.current = scrollToTurnUuid;
      const found = navigateToUuid(scrollToTurnUuid, { flash: true });
      onConsumedScroll();
      if (found) return;
    }
    if (initialPosition.kind === 'uuid') {
      const found = navigateToUuid(initialPosition.uuid, { flash: false });
      if (found) return;
    }
    settleToIndex(rows.length - 1, { align: 'end' });
  }, [rows.length, scrollToTurnUuid, initialPosition, navigateToUuid, onConsumedScroll, settleToIndex]);

  // Post-mount scrollToTurnUuid changes (a search-palette navigate while this
  // window is already open). Skips the value the mount effect already
  // consumed this tick, so the two never double-navigate on open.
  useEffect(() => {
    if (!scrollToTurnUuid) return;
    if (scrollToTurnUuid === initialScrollHandledUuidRef.current) return;
    navigateToUuid(scrollToTurnUuid, { flash: true });
    onConsumedScroll();
  }, [scrollToTurnUuid, navigateToUuid, onConsumedScroll]);

  // Auto-follow: while the window isn't focused/hovered AND no settle loop is
  // active, smoothly scroll to the bottom whenever the live-refresh poll grows
  // the transcript, so the newest turn stays in view. Tracks the previous row
  // count in a ref rather than state so this never fires on the initial load
  // (previousCount starts null) - only on a genuine append after the view is
  // already showing something.
  const previousRowCountRef = useRef<number | null>(null);
  useEffect(() => {
    const previousCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;
    if (previousCount === null) return;
    if (rows.length <= previousCount) return;
    if (!autoFollowNewMessages) return;
    if (isSettlingRef.current) return;
    virtualizer.scrollToEnd({ behavior: 'smooth' });
  }, [rows.length, autoFollowNewMessages, virtualizer, isSettlingRef]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  // A selection spanning multiple rendered blocks (headings, paragraphs, list
  // items) gets the browser's default plain-text serialization, which inserts
  // a blank line at each block boundary crossed - often leaving 1-2 trailing
  // blank lines when the selection ends mid-block. Collapse runs of 3+
  // newlines to a plain paragraph break and trim the ends so a multi-block
  // selection still pastes clean, matching the copy button's tidiness.
  const handleSelectionCopy = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const text = window.getSelection()?.toString() ?? '';
    if (!text) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text.replace(/\n{3,}/g, '\n\n').trim());
  }, []);

  // "Jump to latest" pill: near the tail, a smooth scroll reads as a natural
  // continuation; far away, smooth-scrolling the whole distance takes an
  // uncomfortably long time, so snap instantly instead.
  const handleJumpToLatest = useCallback(() => {
    const container = containerRef.current;
    const totalSize = virtualizer.getTotalSize();
    const distanceFromBottom = container ? totalSize - (container.scrollTop + container.clientHeight) : 0;
    virtualizer.scrollToEnd({ behavior: distanceFromBottom > FAR_FROM_BOTTOM_PX ? 'auto' : 'smooth' });
  }, [virtualizer]);

  // source === 'none': no content at all. Explain why per unavailable reason.
  if (source === 'none') {
    return (
      <div
        className="flex-1 min-h-0 flex items-center justify-center px-6 text-center"
        data-testid="conversation-empty"
      >
        <p className="text-sm text-fg-muted max-w-md">{emptyReasonText(unavailableReason)}</p>
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      className="flex-1 min-h-0 flex flex-col overflow-hidden"
      data-testid="conversation-view"
      onCopy={handleSelectionCopy}
    >
      {degraded && (
        <div
          className="flex items-center gap-2 px-4 py-2 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/20"
          data-testid="conversation-degraded-banner"
        >
          <MessageSquareWarning size={14} className="flex-shrink-0" />
          <span>Original transcript file is gone - showing indexed text.</span>
        </div>
      )}
      <ConversationSearchBar ref={searchBarRef} rows={rows} onNavigate={navigateToUuidFromSearch} />
      {rows.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-fg-muted">
          This conversation has no messages yet.
        </div>
      ) : (
        <div className="relative flex-1 min-h-0">
        <div
          ref={containerRef}
          className="conversation-scroll-hide-native h-full overflow-y-auto"
          data-testid="conversation-scroll-container"
        >
          <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index];
              const isHighlighted = highlightedUuid === row.uuid;
              // Each message is a discrete rounded box, filled AND bordered in a
              // theme-adaptive role color (accent for you, neutral for the agent),
              // separated by small gaps. Gaps use padding (not margin) so the
              // virtualizer measures heights correctly. System entries render as a
              // plain divider, no box.
              const speaker = speakerGroup(row.entry);
              const isSystem = speaker === 'system';
              const boxClass = speaker === 'user'
                ? 'border-accent/40 bg-accent/10'
                : 'border-edge bg-fg/[0.05]';
              // 12px on the left; 6px top/bottom per row so adjacent rows sum to a
              // 12px gap, with the first/last rows getting the full 12px so the top
              // and bottom edges match that rhythm. The right side is handled
              // separately (see rowStyle below) - it must clear the overlaid
              // scrollbar rail, not just match the left inset.
              const gapClass = `pl-3 ${virtualRow.index === 0 ? 'pt-3' : 'pt-1.5'} ${
                virtualRow.index === rows.length - 1 ? 'pb-3' : 'pb-1.5'
              }`;
              // Right padding clears the overlaid scrollbar rail with the same
              // visual gap the thumb keeps from the window's own right edge, so
              // the thumb reads as evenly inset from the message content on one
              // side and the window edge on the other (see
              // CONTENT_RIGHT_CLEARANCE_PX's doc comment in ConversationScrollbar).
              // When there's no rail (content doesn't overflow), that extra
              // clearance is reclaimed back down to the plain left-matching inset.
              const rowStyle = { paddingRight: hasScrollbar ? CONTENT_RIGHT_CLEARANCE_PX : ROW_LEFT_INSET_PX };
              return (
                <div
                  key={row.uuid}
                  data-index={virtualRow.index}
                  data-turn-uuid={row.uuid}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {isSystem ? (
                    <div className={gapClass} style={rowStyle} data-testid="conversation-row-gap">
                      <MemoConversationRow
                        row={row}
                        agentName={agentName}
                        expandedKeys={expandedKeys}
                        toggleExpanded={toggleExpanded}
                      />
                    </div>
                  ) : (
                    <div className={gapClass} style={rowStyle} data-testid="conversation-row-gap">
                      <div
                        data-highlighted={isHighlighted ? 'true' : undefined}
                        className={`group/message rounded-lg border px-3 py-2 transition-colors duration-700 ${
                          isHighlighted ? 'border-amber-400/60 bg-amber-400/10' : boxClass
                        }`}
                      >
                        <MemoConversationRow
                          row={row}
                          agentName={agentName}
                          expandedKeys={expandedKeys}
                          toggleExpanded={toggleExpanded}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <ConversationScrollbar
          containerRef={containerRef}
          rows={rows}
          onJumpToLatest={handleJumpToLatest}
          onShowRailChange={setHasScrollbar}
        />
        </div>
      )}
    </div>
  );
}

function emptyReasonText(reason: TranscriptUnavailableReason | undefined): string {
  switch (reason) {
    case 'unsupported_agent':
      return "Structured transcripts aren't available for this agent.";
    case 'no_agent_session_id':
      return "This session's history hasn't been written yet.";
    case 'file_missing':
      return 'The transcript file no longer exists.';
    default:
      return 'No conversation is available for this session.';
  }
}

/* ── Per-kind rows ── */

interface ConversationRowProps {
  row: DisplayRow;
  agentName?: string;
  expandedKeys: Set<string>;
  toggleExpanded: (key: string) => void;
}

function ConversationRow({ row, agentName, expandedKeys, toggleExpanded }: ConversationRowProps) {
  const { entry, results } = row;
  if (entry.kind === 'user') return <UserRow text={entry.text} ts={entry.ts} />;
  if (entry.kind === 'system') return <SystemRow subtype={entry.subtype} text={entry.text} />;
  if (entry.kind === 'tool_result') return <OrphanToolResultRow entry={entry} expandedKeys={expandedKeys} toggleExpanded={toggleExpanded} />;
  return (
    <AssistantRow
      model={entry.model}
      blocks={entry.blocks}
      uuid={entry.uuid}
      // A stitched task-level view stamps each entry with the agent of the
      // session it came from (entry.agentName); the component-level prop only
      // describes the latest session, so it's the fallback for an ordinary
      // single-session transcript where entries don't carry their own.
      agentName={entry.agentName ?? agentName}
      ts={entry.ts}
      resultsByUseId={results}
      expandedKeys={expandedKeys}
      toggleExpanded={toggleExpanded}
    />
  );
}

/**
 * Memoized row. `useVirtualizer` re-renders the whole list on every scroll
 * frame; without this, each visible row re-runs its body (markdown sanitize,
 * the eager copy-text serialization, JSX construction) on every frame - the
 * jank that shows up on long transcripts. All four props are referentially
 * stable while scrolling AND while a live-poll tick does not touch this
 * particular row: `row` is reused by `reconcileDisplayRows` whenever its uuid
 * and content (including its OWN folded tool results) are unchanged, and
 * `expandedKeys` only changes on a toggle. So the default shallow compare
 * bails the entire subtree out of both scroll re-renders and poll re-renders
 * for every row a tick did not actually change. `isHighlighted` deliberately
 * lives on the OUTER box, not here, so a highlight flash never busts this memo.
 */
const MemoConversationRow = memo(ConversationRow);

/** The speaker badge (accent for you, neutral for the agent / tool), with the
 *  agent's friendly model name beside it. Rendered inside a MessageHeader. */
function RoleBadge({
  icon,
  label,
  tone = 'neutral',
  model,
}: {
  icon: ReactNode;
  label: string;
  tone?: 'accent' | 'neutral';
  model?: string;
}) {
  const friendlyModel = model ? humanizeModelId(model) ?? model : null;
  return (
    <>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
          tone === 'accent'
            ? 'border-accent/30 bg-accent/15 text-accent'
            : 'border-edge/60 bg-surface-hover/60 text-fg-muted'
        }`}
      >
        {icon}
        {label}
      </span>
      {friendlyModel && <span className="text-[11px] text-fg-muted">{friendlyModel}</span>}
    </>
  );
}

/** Per-message header row: the (optional) speaker badge, the message timestamp,
 *  and a hover-revealed copy button for that message's own contents. */
function MessageHeader({ badge, ts, copyText }: { badge?: ReactNode; ts: number; copyText: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      {badge}
      {ts > 0 && <span className="text-[11px] text-fg-disabled whitespace-nowrap">{formatTime(ts)}</span>}
      <div className="flex-1" />
      {copyText.length > 0 && <CopyIconButton text={copyText} />}
    </div>
  );
}

/** Shared copy-with-confirmation behavior for the message and tool-call copy
 *  buttons: writes to the clipboard, flips to a check for 1.5s on success. */
function useCopyFeedback(text: string): { copied: boolean; handleCopy: () => void } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, [text]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return { copied, handleCopy };
}

/** HeaderActionButton takes an icon COMPONENT, not a pre-rendered element, so
 *  the brief "copied" confirmation (green check) is its own tiny component
 *  rather than an inline conditional element (mirrors ConversationWindow's
 *  title-bar copy button). */
function MessageCopiedCheckIcon({ size }: { size?: number }) {
  return <Check size={size} className="text-green-400" />;
}

/** Copy button that reveals on message hover (or keyboard focus) and copies
 *  that message's text, flipping to a check for brief confirmation. Reuses
 *  the shared HeaderActionButton (size="small") so it carries the exact same
 *  colors/contrast as the title-bar action buttons instead of a bespoke,
 *  fainter treatment. */
function CopyIconButton({ text }: { text: string }) {
  const { copied, handleCopy } = useCopyFeedback(text);
  return (
    <HeaderActionButton
      icon={copied ? MessageCopiedCheckIcon : Copy}
      onClick={handleCopy}
      size="small"
      title="Copy message"
      ariaLabel="Copy message"
      testId="conversation-message-copy"
      // HeaderActionButton's rest background (bg-surface-hover/50) barely
      // differs from a message row's own background (bg-surface-hover/30),
      // so it nearly disappears here even though the title bar (against
      // bg-surface-raised) contrasts fine. A visible border reads regardless
      // of background blending, so add one just for this placement.
      className="!border-edge/60 opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100"
    />
  );
}

function UserRow({ text, ts }: { text: string; ts: number }) {
  const clean = sanitizeTranscriptText(text);
  return (
    <div data-testid="conversation-row-user">
      <MessageHeader
        badge={<RoleBadge icon={<User size={12} />} label="You" tone="accent" />}
        ts={ts}
        copyText={clean}
      />
      <div className="text-sm text-fg">
        <MarkdownRenderer content={clean} />
      </div>
    </div>
  );
}

function SystemRow({
  subtype,
  text,
}: {
  subtype: 'compaction' | 'command' | 'command_output' | 'session_boundary';
  text: string;
}) {
  const clean = sanitizeTranscriptText(text).trim();
  const label =
    subtype === 'compaction'
      ? 'Conversation compacted'
      : subtype === 'command'
        ? `[command] ${clean}`
        // session_boundary's text is already a ready-to-display label (e.g.
        // "New session - Claude Code (isolated: Executing)"), unlike the
        // other subtypes whose text is raw payload behind a canned label.
        : subtype === 'session_boundary'
          ? clean
          : 'Command output';
  return (
    <div className="flex items-center gap-3 py-1 text-fg-disabled" data-testid="conversation-row-system">
      <div className="flex-1 h-px bg-edge/50" />
      <span className="text-[11px] uppercase tracking-wider whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-edge/50" />
    </div>
  );
}

interface AssistantRowProps {
  model?: string;
  blocks: TranscriptBlock[];
  uuid: string;
  /** Agent CLI display name for the role pill; falls back to "Agent". */
  agentName?: string;
  ts: number;
  resultsByUseId: Map<string, DisplayRowResult>;
  expandedKeys: Set<string>;
  toggleExpanded: (key: string) => void;
}

function AssistantRow({ model, blocks, uuid, agentName, ts, resultsByUseId, expandedKeys, toggleExpanded }: AssistantRowProps) {
  // The copy button needs this turn's full markdown, but serializing every
  // block (plus its tool results) is not free - memoize it so it is built once
  // per turn, not eagerly on every render.
  const copyText = useMemo(() => renderAssistantBlocksMarkdown(blocks, resultsByUseId), [blocks, resultsByUseId]);
  // Every turn shows its own badge (agent name + model) and timestamp - a
  // tool-calling stretch is exactly where knowing which agent/model ran each
  // step (without scrolling back to find the last header) matters most.
  return (
    <div data-testid="conversation-row-assistant">
      <MessageHeader
        badge={<RoleBadge icon={<Bot size={12} />} label={agentName || 'Agent'} model={model} />}
        ts={ts}
        copyText={copyText}
      />
      <div className="space-y-2">
        {blocks.map((block, index) => {
          if (block.type === 'text') {
            return (
              <div key={`text-${index}`} className="text-sm text-fg-secondary">
                <MarkdownRenderer content={sanitizeTranscriptText(block.text)} />
              </div>
            );
          }
          // activity-state-ok: this is TranscriptBlock.type, not an ActivityState bucket.
          if (block.type === 'thinking') {
            const key = `${uuid}:think:${index}`;
            return (
              <ThinkingBlock
                key={key}
                text={block.text}
                expanded={expandedKeys.has(key)}
                onToggle={() => toggleExpanded(key)}
              />
            );
          }
          // tool_use
          return (
            <ToolCallCard
              key={`tool-${block.id}`}
              name={block.name}
              input={block.input}
              result={resultsByUseId.get(block.id) ?? null}
              expanded={expandedKeys.has(block.id)}
              onToggle={() => toggleExpanded(block.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ThinkingBlock({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="border-l-2 border-edge/60 pl-2" data-testid="conversation-thinking">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-1 text-xs text-fg-disabled hover:text-fg-muted transition-colors"
        data-testid="conversation-thinking-toggle"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Thinking
      </button>
      {expanded && (
        <div className="mt-1 text-xs text-fg-muted whitespace-pre-wrap font-mono">
          {sanitizeTranscriptText(text).trim()}
        </div>
      )}
    </div>
  );
}

interface ToolCallCardProps {
  name: string;
  input: unknown;
  result: DisplayRowResult | null;
  expanded: boolean;
  onToggle: () => void;
}

function ToolCallCard({ name, input, result, expanded, onToggle }: ToolCallCardProps) {
  const [showFullResult, setShowFullResult] = useState(false);
  // File-editing tools (Edit/MultiEdit/Write) render as a Claude-Code-style diff
  // rather than raw JSON; everything else keeps the input/result JSON view.
  const fileEdit = useMemo(() => parseFileEditTool(input), [input]);
  const stats = useMemo(() => (fileEdit ? diffStats(fileEdit.hunks) : null), [fileEdit]);
  const summary = fileEdit ? basename(fileEdit.filePath) : summarizeInput(input);
  const resultContent = result ? sanitizeTranscriptText(result.content) : '';
  const isClamped = resultContent.length > RESULT_CLAMP_CHARS;
  const shownResult = isClamped && !showFullResult ? resultContent.slice(0, RESULT_CLAMP_CHARS) : resultContent;

  return (
    <div
      className={`rounded border text-xs ${
        result?.isError ? 'border-red-500/40 bg-red-500/5' : 'border-edge/60 bg-surface-hover/30'
      }`}
      data-testid="conversation-tool-card"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        data-testid="conversation-tool-toggle"
      >
        {expanded ? <ChevronDown size={13} className="flex-shrink-0 text-fg-muted" /> : <ChevronRight size={13} className="flex-shrink-0 text-fg-muted" />}
        <Wrench size={12} className="flex-shrink-0 text-fg-muted" />
        <span className="font-mono font-medium text-fg-secondary flex-shrink-0">{name}</span>
        <span className="text-fg-disabled truncate min-w-0">{summary}</span>
        {(stats || result?.isError) && (
          <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-[11px] font-mono">
            {stats && stats.added > 0 && <span className="text-green-400">+{stats.added}</span>}
            {stats && stats.removed > 0 && <span className="text-red-400">-{stats.removed}</span>}
            {result?.isError && <span className="text-red-400">error</span>}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-2">
          {fileEdit ? (
            <DiffView fileEdit={fileEdit} />
          ) : (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-fg-disabled mb-0.5">Input</div>
              <pre className="text-xs text-fg-muted whitespace-pre-wrap break-words bg-surface-inset/40 rounded p-2 overflow-x-auto">
                {prettyJson(input)}
              </pre>
            </div>
          )}
          {/* A file edit's success result is just a verbose "updated successfully"
              blurb the agent emits, redundant with the diff - hide it and only
              surface a result when it is an error (or a non-edit tool). */}
          {result && (!fileEdit || result.isError) && (
            <div>
              <div className={`text-[11px] uppercase tracking-wider mb-0.5 ${result.isError ? 'text-red-400' : 'text-fg-disabled'}`}>
                {result.isError ? 'Error' : 'Result'}
              </div>
              <pre
                className={`text-xs whitespace-pre-wrap break-words rounded p-2 overflow-x-auto ${
                  result.isError ? 'text-red-300 bg-red-500/5' : 'text-fg-muted bg-surface-inset/40'
                }`}
              >
                {shownResult}
              </pre>
              {isClamped && (
                <button
                  type="button"
                  onClick={() => setShowFullResult((previous) => !previous)}
                  className="mt-1 text-[11px] text-accent hover:underline"
                  data-testid="conversation-tool-show-all"
                >
                  {showFullResult ? 'Show less' : `Show all (${resultContent.length.toLocaleString()} chars)`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders a file edit as a colorized line diff, one block per hunk. Lossless:
 *  the add/remove lines come straight from the tool's old/new strings. */
function DiffView({ fileEdit }: { fileEdit: FileEdit }) {
  return (
    <div className="space-y-2" data-testid="conversation-diff">
      {fileEdit.hunks.map((hunk, hunkIndex) => {
        const lines = computeLineDiff(hunk.oldText, hunk.newText);
        return (
          <div
            key={hunkIndex}
            className="overflow-x-auto rounded bg-surface-inset/40 py-1 font-mono text-xs leading-relaxed"
          >
            {lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                className={`whitespace-pre px-2 ${
                  line.type === 'add'
                    ? 'bg-green-500/15 text-green-300'
                    : line.type === 'remove'
                      ? 'bg-red-500/15 text-red-300'
                      : 'text-fg-muted'
                }`}
              >
                <span className="select-none opacity-50">
                  {line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  '}
                </span>
                {line.text.length > 0 ? line.text : ' '}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function OrphanToolResultRow({
  entry,
  expandedKeys,
  toggleExpanded,
}: {
  entry: Extract<TranscriptEntry, { kind: 'tool_result' }>;
  expandedKeys: Set<string>;
  toggleExpanded: (key: string) => void;
}) {
  const key = `orphan:${entry.uuid}`;
  const expanded = expandedKeys.has(key);
  const content = sanitizeTranscriptText(entry.content);
  return (
    <div data-testid="conversation-row-tool-result">
      <MessageHeader
        badge={<RoleBadge icon={<Terminal size={12} />} label="Tool result" />}
        ts={entry.ts}
        copyText={content}
      />
      <div
        className={`rounded border text-xs ${
          entry.isError ? 'border-red-500/40 bg-red-500/5' : 'border-edge/60 bg-surface-hover/30'
        }`}
      >
        <button
          type="button"
          onClick={() => toggleExpanded(key)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        >
          {expanded ? <ChevronDown size={13} className="flex-shrink-0 text-fg-muted" /> : <ChevronRight size={13} className="flex-shrink-0 text-fg-muted" />}
          <span className="text-fg-disabled truncate min-w-0">{content.slice(0, 120)}</span>
        </button>
        {expanded && (
          <pre className="px-2 pb-2 text-xs text-fg-muted whitespace-pre-wrap break-words overflow-x-auto">
            {content.length > RESULT_CLAMP_CHARS ? content.slice(0, RESULT_CLAMP_CHARS) : content}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ── Helpers ── */

/** Last path segment of a file path, for a compact tool-card summary. */
function basename(filePath: string | null): string {
  if (!filePath) return '';
  const segments = filePath.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? filePath;
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input.slice(0, 120);
  try {
    const json = JSON.stringify(input);
    return json.length > 120 ? `${json.slice(0, 120)}...` : json;
  } catch {
    return String(input);
  }
}

function prettyJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

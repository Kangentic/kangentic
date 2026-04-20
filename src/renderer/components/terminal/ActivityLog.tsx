import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatTime } from '../../lib/datetime';
import { useSessionStore } from '../../stores/session-store';
import { Select } from '../settings/shared';
import { EventType, IdleReason } from '../../../shared/types';
import type { SessionEvent } from '../../../shared/types';

const SCROLL_RETURN_DELAY_MS = 3000;
const ESTIMATED_ROW_HEIGHT = 20;

// 8 distinct colors for session badges (Tailwind-ish)
const BADGE_COLORS = [
  'text-blue-400',
  'text-amber-400',
  'text-purple-400',
  'text-emerald-400',
  'text-rose-400',
  'text-cyan-400',
  'text-orange-400',
  'text-pink-400',
];

interface ActivityLogProps {
  active: boolean;
  sessionIds: string[];
  taskLabelMap: Map<string, string>;
}

export function ActivityLog({ active, sessionIds, taskLabelMap }: ActivityLogProps) {
  // Narrow selector: only re-render when events for visible sessions change.
  // useShallow compares each value by reference, so background session events
  // don't trigger re-renders here.
  const sessionEvents = useSessionStore(
    useShallow(
      useCallback((s) => {
        const result: Record<string, SessionEvent[]> = {};
        for (const sid of sessionIds) {
          const events = s.sessionEvents[sid];
          if (events) result[sid] = events;
        }
        return result;
      }, [sessionIds]),
    ),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const colorMapRef = useRef(new Map<string, number>());
  const colorIndexRef = useRef(0);
  const returnTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isSmoothScrollingRef = useRef(false);
  const [filterSessionId, setFilterSessionId] = useState<string | null>(null);

  // Auto-clear filter when the filtered session exits
  useEffect(() => {
    if (filterSessionId && !sessionIds.includes(filterSessionId)) {
      setFilterSessionId(null);
    }
  }, [filterSessionId, sessionIds]);

  // Stable color assignment per session
  const getColorIndex = (sessionId: string): number => {
    if (!colorMapRef.current.has(sessionId)) {
      colorMapRef.current.set(sessionId, colorIndexRef.current % BADGE_COLORS.length);
      colorIndexRef.current++;
    }
    return colorMapRef.current.get(sessionId)!;
  };

  // Filter to selected session or show all
  const effectiveSessionIds = useMemo(
    () => filterSessionId ? [filterSessionId] : sessionIds,
    [filterSessionId, sessionIds],
  );

  // Merge events from active sessions, sorted by timestamp. Skip event types
  // that would render to null so virtualized row counts match actual DOM rows.
  const allEvents = useMemo(() => {
    const events: Array<{ sessionId: string; event: SessionEvent }> = [];
    for (const sid of effectiveSessionIds) {
      const evts = sessionEvents[sid] || [];
      for (const event of evts) {
        if (isRenderableEventType(event.type)) {
          events.push({ sessionId: sid, event });
        }
      }
    }
    events.sort((a, b) => a.event.ts - b.event.ts);
    return events;
  }, [effectiveSessionIds, sessionEvents]);

  const virtualizer = useVirtualizer({
    count: allEvents.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 12,
  });

  // Smooth-scroll back to bottom and re-enable auto-scroll
  const smoothScrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    // Already at bottom -- just re-enable
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 1) {
      autoScrollRef.current = true;
      return;
    }
    isSmoothScrollingRef.current = true;
    autoScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // Track scroll position -- auto-scroll when at bottom
  const handleScroll = () => {
    if (isSmoothScrollingRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 1;
    autoScrollRef.current = atBottom;
  };

  const handleMouseEnter = () => {
    if (returnTimerRef.current) {
      clearTimeout(returnTimerRef.current);
      returnTimerRef.current = undefined;
    }
  };

  const handleMouseLeave = () => {
    if (!autoScrollRef.current) {
      if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
      returnTimerRef.current = setTimeout(() => {
        returnTimerRef.current = undefined;
        smoothScrollToBottom();
      }, SCROLL_RETURN_DELAY_MS);
    }
  };

  // Auto-scroll to bottom when new events arrive (only when visible)
  useEffect(() => {
    if (active && autoScrollRef.current && allEvents.length > 0) {
      virtualizer.scrollToIndex(allEvents.length - 1, { align: 'end' });
    }
  }, [active, allEvents.length, virtualizer]);

  // Clear isSmoothScrollingRef when scroll animation finishes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onEnd = () => { isSmoothScrollingRef.current = false; };
    el.addEventListener('scrollend', onEnd);
    return () => el.removeEventListener('scrollend', onEnd);
  }, []);

  // Instant-scroll to bottom when switching to the Activity tab
  // Also resets the smooth-scrolling guard -- if a scroll was in progress
  // when the tab was hidden (display:none), scrollend won't fire.
  useEffect(() => {
    isSmoothScrollingRef.current = false;
    if (active && !autoScrollRef.current) {
      autoScrollRef.current = true;
      requestAnimationFrame(() => {
        if (allEvents.length > 0) {
          virtualizer.scrollToIndex(allEvents.length - 1, { align: 'end' });
        }
      });
    }
  }, [active, allEvents.length, virtualizer]);

  // Cleanup return timer on unmount
  useEffect(() => {
    return () => {
      if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
    };
  }, []);

  const showFilter = sessionIds.length >= 2;
  const filteredLabel = filterSessionId
    ? taskLabelMap.get(filterSessionId) || filterSessionId.slice(0, 8)
    : null;

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const firstStart = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const lastEnd = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].end : 0;
  const showLabel = !filterSessionId && sessionIds.length > 1;

  return (
    <div className="h-full w-full bg-surface flex flex-col font-mono px-2">
      {showFilter && (
        <FilterPill
          sessionIds={sessionIds}
          taskLabelMap={taskLabelMap}
          filterSessionId={filterSessionId}
          onFilter={setFilterSessionId}
        />
      )}
      {allEvents.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-fg-disabled text-sm">
          {filteredLabel
            ? `No activity yet for ${filteredLabel}...`
            : 'Waiting for agent activity...'}
        </div>
      ) : (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="flex-1 min-h-0 overflow-y-auto text-xs leading-5 py-2"
        >
          {firstStart > 0 && <div style={{ height: firstStart }} />}
          {virtualItems.map((virtualRow) => {
            const item = allEvents[virtualRow.index];
            return (
              <div
                key={`${item.sessionId}-${item.event.ts}`}
                data-index={virtualRow.index}
              >
                <EventLine
                  sessionId={item.sessionId}
                  event={item.event}
                  label={taskLabelMap.get(item.sessionId) || item.sessionId.slice(0, 8)}
                  colorClass={BADGE_COLORS[getColorIndex(item.sessionId)]}
                  showLabel={showLabel}
                />
              </div>
            );
          })}
          {virtualItems.length > 0 && totalSize - lastEnd > 0 && (
            <div style={{ height: totalSize - lastEnd }} />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Filter Pill ── */

interface FilterPillProps {
  sessionIds: string[];
  taskLabelMap: Map<string, string>;
  filterSessionId: string | null;
  onFilter: (id: string | null) => void;
}

function FilterPill({
  sessionIds,
  taskLabelMap,
  filterSessionId,
  onFilter,
}: FilterPillProps) {
  return (
    <div className="bg-surface pt-2 pb-1.5 mb-1 border-b border-edge">
      <Select
        data-testid="activity-filter"
        value={filterSessionId ?? ''}
        onChange={(event) => onFilter(event.target.value || null)}
        className="appearance-none bg-surface-raised text-fg-muted pl-2.5 pr-7 py-0.5 text-xs font-semibold cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
        wrapperClassName="relative inline-block"
        chevronSize={12}
        chevronClassName="right-2"
      >
        <option value="">All</option>
        {sessionIds.map((sessionId) => (
          <option key={sessionId} value={sessionId}>
            {taskLabelMap.get(sessionId) || sessionId.slice(0, 8)}
          </option>
        ))}
      </Select>
    </div>
  );
}

interface EventLineProps {
  sessionId: string;
  event: SessionEvent;
  label: string;
  colorClass: string;
  showLabel: boolean;
}

/** Dim italic text line (no detail). */
function DimLine({ ts, label, colorClass, showLabel, text }: {
  ts: number; label: string; colorClass: string; showLabel: boolean; text: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-zinc-600 shrink-0">{formatTime(ts)}</span>
      {showLabel && <span className={`${colorClass} font-semibold shrink-0`}>[{label}]</span>}
      <span className="text-fg-faint italic">{text}</span>
    </div>
  );
}

/** Dim italic text line with optional trailing detail. */
function DimDetailLine({ ts, label, colorClass, showLabel, text, detail }: {
  ts: number; label: string; colorClass: string; showLabel: boolean; text: string; detail?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0">
      <span className="text-zinc-600 shrink-0">{formatTime(ts)}</span>
      {showLabel && <span className={`${colorClass} font-semibold shrink-0`}>[{label}]</span>}
      <span className="text-fg-faint italic">{text}</span>
      {detail && <span className="text-fg-faint truncate min-w-0">{detail}</span>}
    </div>
  );
}

/** Badge line: colored pill label with optional trailing detail. */
function BadgeLine({ ts, label, colorClass, showLabel, badge, detail, variant = 'default' }: {
  ts: number; label: string; colorClass: string; showLabel: boolean;
  badge: string; detail?: string; variant?: 'default' | 'warn';
}) {
  const badgeClass = variant === 'warn'
    ? 'bg-amber-900/30 text-amber-400'
    : 'bg-surface-raised text-fg-secondary';
  return (
    <div className="flex items-baseline gap-1.5 min-w-0">
      <span className="text-zinc-600 shrink-0">{formatTime(ts)}</span>
      {showLabel && <span className={`${colorClass} font-semibold shrink-0`}>[{label}]</span>}
      <span className={`${badgeClass} px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 select-none`}>
        {badge}
      </span>
      {detail && <span className="text-fg-faint truncate min-w-0">{detail}</span>}
    </div>
  );
}

interface EventLineCommon {
  ts: number;
  label: string;
  colorClass: string;
  showLabel: boolean;
}

type EventRenderer = (common: EventLineCommon, event: SessionEvent) => ReactNode;

/**
 * Single source of truth for which event types render in the Activity tab.
 * The filter in `allEvents` and the dispatch in `EventLine` both derive from
 * this map, so adding a new renderable EventType requires only one edit here.
 *
 * Exported for the unit-level exhaustiveness check in
 * `tests/unit/activity-log-renderers.test.ts`. That test ensures every
 * `EventType` value is either present in this map or explicitly listed in the
 * non-renderable set, so future `EventType` additions cannot be silently
 * dropped from the Activity tab.
 */
export const EVENT_RENDERERS: Partial<Record<EventType, EventRenderer>> = {
  [EventType.ToolStart]: (common, event) => (
    <BadgeLine {...common} badge={event.tool || 'Tool'} detail={event.detail} />
  ),
  [EventType.Interrupted]: (common, event) => (
    <BadgeLine {...common} badge={`${event.tool || 'Tool'} interrupted`} detail={event.detail} variant="warn" />
  ),
  [EventType.Idle]: (common, event) => (
    <DimLine {...common} text={event.detail === IdleReason.Timeout ? 'Idle (no activity detected)' : 'Idle (waiting for input)'} />
  ),
  [EventType.Prompt]: (common) => (
    <div className="flex items-baseline gap-1.5">
      <span className="text-zinc-600 shrink-0">{formatTime(common.ts)}</span>
      {common.showLabel && <span className={`${common.colorClass} font-semibold shrink-0`}>[{common.label}]</span>}
      <span className="text-fg-muted">Thinking...</span>
    </div>
  ),
  [EventType.SessionStart]: (common) => <DimLine {...common} text="Session started" />,
  [EventType.SessionEnd]: (common) => <DimLine {...common} text="Session ended" />,
  [EventType.SubagentStart]: (common, event) => <BadgeLine {...common} badge="Subagent" detail={event.detail} />,
  [EventType.SubagentStop]: (common, event) => <BadgeLine {...common} badge="Subagent done" detail={event.detail} />,
  [EventType.Notification]: (common, event) => <BadgeLine {...common} badge="Notice" detail={event.detail} variant="warn" />,
  [EventType.Compact]: (common) => <DimLine {...common} text="Compacting context..." />,
  [EventType.TeammateIdle]: (common, event) => <DimDetailLine {...common} text="Teammate idle" detail={event.detail} />,
  [EventType.TaskCompleted]: (common, event) => <BadgeLine {...common} badge="Task done" detail={event.detail} />,
  [EventType.ConfigChange]: (common) => <DimLine {...common} text="Config changed" />,
  [EventType.WorktreeCreate]: (common, event) => <BadgeLine {...common} badge="Worktree" detail={event.detail} />,
  [EventType.WorktreeRemove]: (common, event) => <DimDetailLine {...common} text="Worktree removed" detail={event.detail} />,
};

/** Exported for unit testing - see `tests/unit/activity-log-renderers.test.ts`. */
export function isRenderableEventType(type: string): boolean {
  return Object.hasOwn(EVENT_RENDERERS, type);
}

function EventLine({ event, label, colorClass, showLabel }: EventLineProps) {
  const renderer = EVENT_RENDERERS[event.type];
  if (!renderer) return null;
  return renderer({ ts: event.ts, label, colorClass, showLabel }, event);
}

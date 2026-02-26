import React, { useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/session-store';
import type { SessionEvent } from '../../../shared/types';

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
  const sessionEvents = useSessionStore((s) => s.sessionEvents);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const colorMapRef = useRef(new Map<string, number>());
  const colorIndexRef = useRef(0);

  // Stable color assignment per session
  const getColorIndex = (sessionId: string): number => {
    if (!colorMapRef.current.has(sessionId)) {
      colorMapRef.current.set(sessionId, colorIndexRef.current % BADGE_COLORS.length);
      colorIndexRef.current++;
    }
    return colorMapRef.current.get(sessionId)!;
  };

  // Merge events from all active sessions, sorted by timestamp
  const allEvents: Array<{ sessionId: string; event: SessionEvent }> = [];
  for (const sid of sessionIds) {
    const events = sessionEvents[sid] || [];
    for (const event of events) {
      allEvents.push({ sessionId: sid, event });
    }
  }
  allEvents.sort((a, b) => a.event.ts - b.event.ts);

  // Cap display at last 500 events
  const displayEvents = allEvents.length > 500 ? allEvents.slice(-500) : allEvents;

  // Track scroll position — auto-scroll when at bottom
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [displayEvents.length]);

  if (displayEvents.length === 0) {
    return (
      <div className="h-full w-full bg-zinc-900 flex items-center justify-center text-zinc-600 text-sm font-mono">
        Waiting for agent activity...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-full w-full bg-zinc-900 overflow-y-auto font-mono text-xs leading-5 p-2"
    >
      {displayEvents.map((item, i) => (
        <EventLine
          key={`${item.sessionId}-${item.event.ts}-${i}`}
          sessionId={item.sessionId}
          event={item.event}
          label={taskLabelMap.get(item.sessionId) || item.sessionId.slice(0, 8)}
          colorClass={BADGE_COLORS[getColorIndex(item.sessionId)]}
          showLabel={sessionIds.length > 1}
        />
      ))}
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

function EventLine({ event, label, colorClass, showLabel }: EventLineProps) {
  switch (event.type) {
    case 'tool_start':
      return (
        <div className="flex items-baseline gap-1.5 min-w-0">
          {showLabel && <span className={`${colorClass} font-semibold shrink-0`}>[{label}]</span>}
          <span className="bg-zinc-800 text-zinc-200 px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0">
            {event.tool || 'Tool'}
          </span>
          {event.detail && (
            <span className="text-zinc-500 truncate min-w-0">{event.detail}</span>
          )}
        </div>
      );

    case 'tool_end':
      // tool_end is typically not shown — the tool_start line is sufficient.
      // Only render if there's no tool_start context (e.g., tool name only).
      return null;

    case 'idle':
      return (
        <div className="flex items-baseline gap-1.5">
          {showLabel && <span className={`${colorClass} font-semibold shrink-0`}>[{label}]</span>}
          <span className="text-zinc-500 italic">Idle — waiting for input</span>
        </div>
      );

    case 'prompt':
      return (
        <div className="flex items-baseline gap-1.5">
          {showLabel && <span className={`${colorClass} font-semibold shrink-0`}>[{label}]</span>}
          <span className="text-zinc-400">Thinking...</span>
        </div>
      );

    default:
      return null;
  }
}

import { memo, useMemo } from 'react';
import type { ActivityStatsSnapshot, ActivityState, SessionEvent } from '../../../shared/types';
import { EventType } from '../../../shared/types';

/**
 * Horizontal timeline + compensation counter strip for one session in
 * the Activity Debug Overlay. Renders four tracks over the last 120s
 * of session activity with a left gutter for row labels, a top time
 * axis (-120s … -60s … now), gridlines at 30s intervals, and a "now"
 * marker on the right edge. The intent is "glance at the chart, see
 * where the gaps are, see what fired during them".
 *
 * Tracks (top → bottom):
 *   state  - color band (idle / thinking / permission)
 *   events - vertical ticks colored by EventType group
 *   pty    - subtle ticks; opacity scales with bucket count
 *   timer  - active watchdog deadline line + dashed deadline marker.
 *            Label matches the engine's `timer:*` trigger prefix
 *            (timer:stale-thinking, timer:bg-shell-hatch,
 *            timer:stuck-pending-tools) so non-zero compensation
 *            counters tie visually to the same row.
 *
 * The counter strip above tallies recovery / compensation events
 * (`stale-thinking ×N`, `force-thinking ×N`, …). All zeros = clean
 * session. Non-zero is a "click into the timeline to see what
 * happened" cue.
 *
 * Hand-coded SVG (no charting deps) so production builds stay slim.
 */

const WINDOW_MS = 120_000;
const TRACK_HEIGHT_PX = 18;
const TRACK_GAP_PX = 4;
const GUTTER_WIDTH_PX = 44;
const TIMELINE_HEIGHT_PX = TRACK_HEIGHT_PX * 4 + TRACK_GAP_PX * 3; // 84
const AXIS_HEIGHT_PX = 14;

type EventGroup = 'tool' | 'subagent' | 'background-shell' | 'idle' | 'interrupted' | 'log-only';

/**
 * Tool ticks were originally green-500 (#22c55e) - the same hue
 * Tailwind / the activity pill use for "thinking". With the state
 * band now using that green for thinking, green-on-green tool ticks
 * would vanish. Sky-400 (#38bdf8) keeps tool ticks high-contrast on
 * the green band while staying clearly distinct from the
 * subagent / bg-shell / interrupt families.
 */
const EVENT_GROUP_COLORS: Record<EventGroup, string> = {
  tool: '#38bdf8',
  subagent: '#a855f7',
  'background-shell': '#f97316',
  idle: '#94a3b8',
  interrupted: '#ef4444',
  'log-only': '#cbd5e1',
};

/**
 * State band colors mirror the activity pill's palette so the chart
 * speaks the same visual language as the rest of the overlay:
 *   - thinking  → green-500 (matches the pill's bg-green-500/15)
 *   - permission → blue-500 (matches the permission pill)
 *   - idle      → slate (neutral, "nothing happening")
 * Higher alpha than the pill backgrounds so a wide thinking band
 * remains legible on the dark surface.
 */
const ACTIVITY_BAND_COLORS: Record<ActivityState, string> = {
  idle: 'rgba(148, 163, 184, 0.25)',
  thinking: 'rgba(34, 197, 94, 0.45)',
  permission: 'rgba(59, 130, 246, 0.45)',
};

function classifyEvent(eventType: string): EventGroup {
  switch (eventType) {
    case EventType.ToolStart:
    case EventType.ToolEnd:
    case EventType.ToolSelectionStart:
      return 'tool';
    case EventType.SubagentStart:
    case EventType.SubagentStop:
      return 'subagent';
    case EventType.BackgroundShellStart:
    case EventType.BackgroundShellEnd:
      return 'background-shell';
    case EventType.Idle:
      return 'idle';
    case EventType.Interrupted:
      return 'interrupted';
    default:
      return 'log-only';
  }
}

export interface WatchdogPick {
  thresholdMs: number;
  shortLabel: string;
}

/**
 * Pick the watchdog hold that currently applies, mirroring
 * `findActiveWatchdogHold` in the engine. We re-derive it in the
 * renderer from the snapshot's predicate fields - the engine doesn't
 * surface "active hold" directly, and adding that would clutter the
 * snapshot type. If the engine adds a fifth hold or reorders
 * predicates, update here too. Thresholds match the engine's defaults.
 */
export function pickWatchdog(snapshot: ActivityStatsSnapshot): WatchdogPick | null {
  if (snapshot.activity !== 'thinking') return null;
  if (snapshot.permissionPending) return null;
  const bgShells = snapshot.backgroundShellIds.length + snapshot.anonymousBackgroundShellCount;

  if (
    !snapshot.turnActive
    && snapshot.pendingToolCount === 0
    && snapshot.subagentDepth === 0
    && snapshot.backgroundShellIds.length > 0
  ) {
    // A hook-declared (named) bg shell: held to the long 5-min cap unless
    // the watcher confirms liveness (Tier A) or a positive exit arrives.
    return { thresholdMs: 5 * 60_000, shortLabel: 'bg-shell-hatch 5m' };
  }
  if (
    !snapshot.turnActive
    && snapshot.pendingToolCount === 0
    && snapshot.subagentDepth === 0
    && snapshot.backgroundShellIds.length === 0
    && snapshot.anonymousBackgroundShellCount > 0
  ) {
    // Anonymous-only (heuristic) bg shells: reclaimed fast at the 30s grace.
    return { thresholdMs: 30_000, shortLabel: 'bg-shell-hatch 30s' };
  }
  if (
    snapshot.pendingToolCount > 0
    && snapshot.subagentDepth === 0
    && bgShells === 0
  ) {
    return { thresholdMs: 5 * 60_000, shortLabel: 'stuck-pending-tools 5m' };
  }
  if (
    snapshot.turnActive
    && snapshot.pendingToolCount === 0
    && snapshot.subagentDepth === 0
    && bgShells === 0
  ) {
    return { thresholdMs: 180_000, shortLabel: 'stale-thinking 180s' };
  }
  if (
    snapshot.subagentDepth > 0
    && snapshot.pendingToolCount === 0
    && bgShells === 0
  ) {
    // A subagent whose named terminal stop was dropped (only its ignored
    // empty-detail inner stop arrived): depth stuck > 0. Reclaimed at the
    // long 5-min cap (signal-or-pty-output anchored). Disjoint from the holds
    // above, which all require subagentDepth === 0.
    return { thresholdMs: 5 * 60_000, shortLabel: 'stuck-subagent 5m' };
  }
  return null;
}

const COUNTER_LABELS: Record<keyof ActivityStatsSnapshot['compensationCounters'], string> = {
  staleThinking: 'stale-thinking',
  bgShellHatch: 'bg-shell-hatch',
  stuckPendingTools: 'stuck-pending-tools',
  forceThinking: 'force-thinking',
  forceIdle: 'force-idle',
  unmatchedBgShellEnd: 'unmatched-bg-shell-end',
  ignoredInnerSubagentStop: 'ignored-inner-subagent-stop',
  duplicateSubagentStop: 'duplicate-subagent-stop',
  stuckSubagent: 'stuck-subagent',
};

interface ActivityTimelineProps {
  snapshot: ActivityStatsSnapshot;
  sessionEvents: SessionEvent[] | undefined;
  /**
   * Wall-clock anchor for "now" on the timeline. Captured once per
   * 2 s poll tick by the parent overlay and prop-drilled here so the
   * three useMemo caches below (`bands`, `eventTicks`, `maxChunkCount`)
   * actually hit on off-cycle re-renders driven by unrelated stores
   * (e.g. `sessionEvents` updates from hook traffic). Reading
   * `Date.now()` in the render body would change the value on every
   * render and bust all three caches.
   */
  pollNow: number;
}

export const ActivityTimeline = memo(function ActivityTimeline({
  snapshot,
  sessionEvents,
  pollNow,
}: ActivityTimelineProps) {
  const now = pollNow;
  const windowStart = now - WINDOW_MS;

  // Reconstruct activity bands from recentTransitions.
  const bands = useMemo(() => {
    const out: { start: number; end: number; state: ActivityState }[] = [];
    const transitions = snapshot.recentTransitions.filter((record) => record.from !== record.to);
    if (transitions.length === 0) {
      out.push({ start: windowStart, end: now, state: snapshot.activity });
      return out;
    }
    const firstTransition = transitions[0];
    out.push({
      start: windowStart,
      end: Math.max(windowStart, firstTransition.ts),
      state: firstTransition.from,
    });
    for (let index = 0; index < transitions.length; index += 1) {
      const segment = transitions[index];
      const next = transitions[index + 1];
      out.push({
        start: Math.max(windowStart, segment.ts),
        end: next ? Math.max(windowStart, next.ts) : now,
        state: segment.to,
      });
    }
    return out.filter((band) => band.end > band.start);
  }, [snapshot.recentTransitions, snapshot.activity, windowStart, now]);

  const eventTicks = useMemo(() => {
    if (!sessionEvents) return [];
    return sessionEvents
      .filter((event) => event.ts >= windowStart && event.ts <= now)
      .map((event) => ({
        ts: event.ts,
        group: classifyEvent(event.type),
        type: event.type,
      }));
  }, [sessionEvents, windowStart, now]);

  const maxChunkCount = useMemo(() => {
    let max = 1;
    for (const entry of snapshot.recentPtyChunks) {
      if (entry.tsBucket >= windowStart && entry.count > max) max = entry.count;
    }
    return max;
  }, [snapshot.recentPtyChunks, windowStart]);

  const watchdog = useMemo(() => pickWatchdog(snapshot), [snapshot]);

  const counterEntries = useMemo(() => {
    const counters = snapshot.compensationCounters;
    return (Object.keys(COUNTER_LABELS) as Array<keyof typeof COUNTER_LABELS>).map((key) => ({
      key,
      label: COUNTER_LABELS[key],
      count: counters[key],
    }));
  }, [snapshot.compensationCounters]);

  // The SVG covers only the plot area (no gutter). Gutter labels and
  // axis labels live in HTML siblings so text renders at native
  // resolution (preserveAspectRatio="none" on the plot SVG would
  // otherwise squish glyphs into illegible smears at narrow card
  // widths).
  const viewWidth = 1000;
  const tsToFraction = (timestamp: number): number => {
    const fraction = (timestamp - windowStart) / WINDOW_MS;
    return Math.max(0, Math.min(1, fraction));
  };
  const tsToX = (timestamp: number): number => tsToFraction(timestamp) * viewWidth;
  const trackY = (index: number): number => index * (TRACK_HEIGHT_PX + TRACK_GAP_PX);

  // Track labels mirror the engine's vocabulary: "state" matches
  // `state.activity`, "events" matches the JSONL event stream, "pty"
  // matches the PTY chunk path, and "timer" matches the engine's
  // `timer:*` trigger prefix (timer:stale-thinking, timer:bg-shell-
  // hatch, timer:stuck-pending-tools) so a non-zero compensation
  // counter ties visually to the same row. The timer row only
  // renders content when a single-holder watchdog applies; when none
  // does (multi-holder thinking, idle, permission), the row is dim
  // and an "active timer:" indicator below the chart fills in the
  // missing context.
  const trackLabels = ['state', 'events', 'pty', 'timer'];
  const timerRowMuted = !watchdog;
  const axisTicks = [120, 90, 60, 30, 0];

  return (
    <div className="space-y-1.5 pt-1.5">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[10px] uppercase tracking-wider font-medium text-fg-faint"
          title="Lifetime tally of recovery / compensation events the engine fired without flipping the activity pill (watchdog hatches and force-thinking / force-idle paths). All zeros = clean session."
        >
          Recoveries
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {counterEntries.map((entry) => (
          <span
            key={entry.key}
            className={
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono ' +
              (entry.count > 0
                ? 'border-edge bg-surface-raised text-fg-secondary'
                : 'border-edge-faint bg-surface text-fg-disabled')
            }
            title={
              entry.count > 0
                ? `${entry.label} fired ${entry.count} time${entry.count === 1 ? '' : 's'} this session`
                : `${entry.label} - no firings yet`
            }
          >
            {entry.label}
            <span className="tabular-nums">×{entry.count}</span>
          </span>
        ))}
      </div>
      <div className="flex" style={{ height: TIMELINE_HEIGHT_PX + AXIS_HEIGHT_PX }}>
        {/* Left gutter: HTML row labels at native resolution. The SVG
            beside us uses preserveAspectRatio="none" which would
            otherwise squish glyphs horizontally into illegible smears
            at narrow card widths. */}
        <div
          className="flex flex-col font-mono text-[10px] text-fg-faint shrink-0"
          style={{ width: GUTTER_WIDTH_PX, paddingRight: 4 }}
        >
          {trackLabels.map((label, index) => {
            const isMutedTimer = label === 'timer' && timerRowMuted;
            return (
              <div
                key={label}
                className={
                  'flex items-center justify-end '
                  + (isMutedTimer ? 'text-fg-disabled italic' : '')
                }
                style={{
                  height: TRACK_HEIGHT_PX,
                  marginTop: index === 0 ? 0 : TRACK_GAP_PX,
                }}
                title={
                  isMutedTimer
                    ? 'No watchdog active (multi-holder thinking, idle, or permission). Single-holder thinking states arm one of the timer:* watchdogs and draw a deadline line on this row.'
                    : undefined
                }
              >
                {label}
              </div>
            );
          })}
          <div style={{ height: AXIS_HEIGHT_PX }} />
        </div>
        {/* Plot area: SVG for the data tracks + HTML axis labels
            absolutely positioned along the bottom. */}
        <div className="relative flex-1 min-w-0">
          <svg
            viewBox={`0 0 ${viewWidth} ${TIMELINE_HEIGHT_PX}`}
            preserveAspectRatio="none"
            className="w-full block"
            style={{ height: TIMELINE_HEIGHT_PX }}
            role="img"
            aria-label="Activity timeline (last 120 seconds)"
          >
            {/* Gridlines at -90s, -60s, -30s. Use non-scaling stroke
                so the dashed line stays visible after horizontal
                compression. */}
            {axisTicks.slice(1, -1).map((secondsBeforeNow) => {
              const x = tsToX(now - secondsBeforeNow * 1000);
              return (
                <line
                  key={`grid-${secondsBeforeNow}`}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={TIMELINE_HEIGHT_PX}
                  stroke="currentColor"
                  strokeWidth={1}
                  opacity={0.18}
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                  className="text-fg-disabled"
                />
              );
            })}

            {/* Track 1: activity-state band. */}
            {bands.map((band, index) => (
              <rect
                key={`band-${index}`}
                x={tsToX(band.start)}
                y={trackY(0)}
                width={Math.max(1, tsToX(band.end) - tsToX(band.start))}
                height={TRACK_HEIGHT_PX}
                fill={ACTIVITY_BAND_COLORS[band.state]}
              >
                <title>{`${band.state} (${((band.end - band.start) / 1000).toFixed(1)}s)`}</title>
              </rect>
            ))}

            {/* Track 2: event arrival ticks. Non-scaling stroke keeps
                each tick a fixed pixel width regardless of how much
                the SVG is horizontally compressed. */}
            {eventTicks.map((tick, index) => (
              <line
                key={`event-${index}`}
                x1={tsToX(tick.ts)}
                x2={tsToX(tick.ts)}
                y1={trackY(1)}
                y2={trackY(1) + TRACK_HEIGHT_PX}
                stroke={EVENT_GROUP_COLORS[tick.group]}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${tick.type} @ -${((now - tick.ts) / 1000).toFixed(1)}s`}</title>
              </line>
            ))}

            {/* Track 3: PTY chunk ticks. */}
            {snapshot.recentPtyChunks.map((entry, index) => {
              if (entry.tsBucket < windowStart) return null;
              const opacity = Math.min(1, 0.25 + 0.75 * (entry.count / maxChunkCount));
              return (
                <line
                  key={`pty-${index}`}
                  x1={tsToX(entry.tsBucket)}
                  x2={tsToX(entry.tsBucket)}
                  y1={trackY(2)}
                  y2={trackY(2) + TRACK_HEIGHT_PX}
                  stroke="#64748b"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  opacity={opacity}
                >
                  <title>{`${entry.count} chunk${entry.count === 1 ? '' : 's'} in this 100ms bucket`}</title>
                </line>
              );
            })}

            {/* Track 4: timer (watchdog) deadline. */}
            {watchdog && snapshot.lastSignalAt !== null && (() => {
              const startX = tsToX(snapshot.lastSignalAt);
              const deadlineMs = snapshot.lastSignalAt + watchdog.thresholdMs;
              const deadlineX = tsToX(deadlineMs);
              const lineY = trackY(3) + TRACK_HEIGHT_PX / 2;
              const pastDeadline = deadlineMs <= now;
              return (
                <g>
                  <line
                    x1={startX}
                    x2={deadlineX}
                    y1={lineY}
                    y2={lineY}
                    stroke="#ea580c"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    opacity={0.9}
                  />
                  <line
                    x1={deadlineX}
                    x2={deadlineX}
                    y1={trackY(3)}
                    y2={trackY(3) + TRACK_HEIGHT_PX}
                    stroke="#ea580c"
                    strokeWidth={2}
                    strokeDasharray="3 2"
                    vectorEffect="non-scaling-stroke"
                    opacity={pastDeadline ? 1 : 0.95}
                  >
                    <title>{`Timer: ${watchdog.shortLabel}. Fires at ${
                      deadlineMs > now
                        ? `+${((deadlineMs - now) / 1000).toFixed(1)}s from now`
                        : `${((now - deadlineMs) / 1000).toFixed(1)}s ago`
                    }`}</title>
                  </line>
                </g>
              );
            })()}

            {/* Subtle horizontal separators between tracks. */}
            {[1, 2, 3].map((index) => (
              <line
                key={`sep-${index}`}
                x1={0}
                x2={viewWidth}
                y1={trackY(index) - TRACK_GAP_PX / 2}
                y2={trackY(index) - TRACK_GAP_PX / 2}
                stroke="currentColor"
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
                opacity={0.18}
                className="text-fg-disabled"
              />
            ))}

            {/* Now marker on the right edge. */}
            <line
              x1={viewWidth}
              x2={viewWidth}
              y1={0}
              y2={TIMELINE_HEIGHT_PX}
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.5}
              className="text-fg-secondary"
            />
          </svg>
          {/* HTML axis labels positioned along the bottom of the plot.
              Using percentage-based positioning so they line up with
              the gridlines regardless of the plot's rendered width. */}
          <div
            className="absolute left-0 right-0 font-mono text-[10px] text-fg-faint pointer-events-none"
            style={{ top: TIMELINE_HEIGHT_PX, height: AXIS_HEIGHT_PX }}
          >
            {axisTicks.map((secondsBeforeNow) => {
              const fractionFromLeft = 1 - secondsBeforeNow / 120;
              const isNow = secondsBeforeNow === 0;
              const isStart = secondsBeforeNow === 120;
              return (
                <span
                  key={`axis-${secondsBeforeNow}`}
                  className="absolute"
                  style={{
                    left: `${fractionFromLeft * 100}%`,
                    transform: isNow ? 'translateX(-100%)' : isStart ? 'none' : 'translateX(-50%)',
                    top: 0,
                  }}
                >
                  {isNow ? 'now' : `-${secondsBeforeNow}s`}
                </span>
              );
            })}
          </div>
        </div>
      </div>
      {/* Inline timer indicator naming the currently-active watchdog
          (stale-thinking / bg-shell-hatch / stuck-pending-tools), or
          a clear "no active timer" message when none applies.
          Critical for screenshot diagnosis: "deadline near now" +
          "stale-thinking 180s" tells me hook-loss is imminent; same
          geometry with "bg-shell-hatch 5m" tells me an orphan shell
          is the cause. Always rendering this line - even in the
          inactive case - means the chart's bottom never goes blank
          and the user knows whether the empty timer row is "no
          deadline applies" vs "something's wrong with the chart". */}
      <div className="text-[10px] font-mono text-fg-disabled">
        active timer:{' '}
        {watchdog ? (
          <span style={{ color: '#ea580c' }}>{watchdog.shortLabel}</span>
        ) : (
          <span className="italic">none (no single-holder thinking)</span>
        )}
      </div>
    </div>
  );
});

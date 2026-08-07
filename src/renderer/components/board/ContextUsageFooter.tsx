import { getProgressColor } from '../../utils/progress-color';

/**
 * The board task card's footer: model name on the left, context-window percent on
 * the right, and a full-width progress track beneath.
 *
 * Extracted from TaskCard so the Agent Monitor's card renders the IDENTICAL
 * footer rather than a lookalike. The monitor is meant to feel like an extension
 * of the board, and the surest way to guarantee that is one component, not two
 * that agree today and drift next month.
 *
 * The percent is passed in already resolved (TaskCard clamps an over-budget
 * window to 100 via `contextWindowDisplayPercent`; the monitor's aggregator
 * carries the same clamped value), so this component stays presentational.
 */
export function ContextUsageFooter({
  modelName, percent, windowKnown = true, unknownLabel, testId = 'usage-bar', className = '', divider = true,
}: {
  /** Human model name (e.g. "Opus 5"). Never the raw model id - users don't read those. */
  modelName: string;
  percent: number;
  /** False when the agent has not reported a usable context window; the track sits at 0. */
  windowKnown?: boolean;
  /**
   * Replaces the percent label with this text when `windowKnown` is false. Omit
   * to keep printing `{percent}%` regardless, which is the board's behavior:
   * TaskCard deliberately holds the track at 0% until a known window arrives
   * (see the comment above its call site), so the label reads as the value of
   * the track it labels rather than contradicting it. The monitor card has no
   * such track-matching intent and passes `"-"`, the unknown state
   * `MonitorTable` already renders for the same null `contextPercent`.
   */
  unknownLabel?: string;
  testId?: string;
  className?: string;
  /**
   * Draw the rule above the footer. Defaults on, which is what the board's
   * TaskCard needs: nothing else there marks where its content ends.
   *
   * The monitor card turns it off. Its peek sits in a shaded well whose own
   * bottom edge already closes the content region, so the rule became a second,
   * weaker boundary saying the same thing - and on a card with no label pills the
   * two land within a few pixels of each other. A prop rather than a fork of this
   * component, because the whole point of sharing it is that the two footers
   * cannot drift apart on the things that matter (tone, spacing, the track).
   */
  divider?: boolean;
}) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const percentLabel = !windowKnown && unknownLabel != null ? unknownLabel : `${clamped}%`;
  // `pt-2` exists to clear the RULE, so it goes with it. Left in, a divider-less
  // footer sat 16px below the content above it while every other gap on the card
  // is 6-8px, which read as a missing element rather than as breathing room.
  const spacing = divider ? 'mt-2 pt-2 border-t border-edge' : 'mt-2';
  return (
    <div
      className={`${spacing} ${className}`}
      data-testid={testId}
      data-context-window={windowKnown ? undefined : 'unknown'}
    >
      {/* Both halves carry their own testid. The model name and the unknown-window
          label can render the SAME text ("-"), so an assertion scoped to the whole
          footer cannot tell which half produced it - which is exactly how a test
          meant to pin the percent label passes on the model name instead. */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-fg-faint truncate" data-testid={`${testId}-model`}>{modelName}</span>
        <span className="text-xs text-fg-faint" data-testid={`${testId}-percent`}>{percentLabel}</span>
      </div>
      {/* The fill is a full-width bar scaled on the X axis, not a bar whose WIDTH
          changes. `transform` is composited; `width` is a layout property, so a
          width transition costs layout AND paint on every frame of its 300ms, on
          every card with a running session. Keep `origin-left` or the bar grows
          from its centre, and keep the transition list naming `transform` - a
          stale `width` in that list leaves the bar rendering correctly while
          silently not animating, which no test catches.

          Do NOT add `will-change: transform`. A transform transition composites
          while it runs without it; a permanent hint here would mint one layer per
          card. The track above is deliberately box-identical to `CardStatusBar`
          in TaskCard.tsx - see its JSDoc, card height stability is load-bearing
          for dnd-kit's per-card ResizeObserver during a drag. */}
      <div className="w-full h-1 bg-surface-hover rounded-full overflow-hidden">
        <div
          className="h-full w-full origin-left rounded-full transition-[transform,background-color] duration-300"
          data-percent={clamped}
          style={{ transform: `scaleX(${clamped / 100})`, backgroundColor: getProgressColor(clamped) }}
        />
      </div>
    </div>
  );
}

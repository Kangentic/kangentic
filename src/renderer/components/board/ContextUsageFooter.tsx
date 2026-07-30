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
  modelName, percent, windowKnown = true, testId = 'usage-bar', className = '',
}: {
  /** Human model name (e.g. "Opus 5"). Never the raw model id - users don't read those. */
  modelName: string;
  percent: number;
  /** False when the agent has not reported a usable context window; the track sits at 0. */
  windowKnown?: boolean;
  testId?: string;
  className?: string;
}) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return (
    <div
      className={`mt-2 pt-2 border-t border-edge ${className}`}
      data-testid={testId}
      data-context-window={windowKnown ? undefined : 'unknown'}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-fg-faint truncate">{modelName}</span>
        <span className="text-xs text-fg-faint">{clamped}%</span>
      </div>
      <div className="w-full h-1 bg-surface-hover rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${clamped}%`, backgroundColor: getProgressColor(clamped) }}
        />
      </div>
    </div>
  );
}

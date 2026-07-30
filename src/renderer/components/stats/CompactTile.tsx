import type { ReactNode } from 'react';
import { useValuePulse } from '../../hooks/useValuePulse';

/**
 * The shared small-metric tile. Extracted from KpiTiles so surfaces other than the
 * usage dashboard (the Agent Monitor's summary strip) can reuse the exact chrome
 * rather than copying its class strings a third time, and can do so without
 * pulling KpiTiles' sparkline/chart import graph into their bundle.
 */

/** Neutral signed delta for the secondary strip: the +/- sign carries the
 *  direction (no redundant arrow glyph), muted (activity metrics, not spend),
 *  with the comparison window in the tooltip. */
function CompactDelta({ delta, baseline }: { delta: number | null; baseline: string }) {
  if (delta === null || baseline === '') return null;
  return (
    <span className="text-[11px] text-fg-muted tabular-nums flex-shrink-0" title={baseline}>
      {`${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}%`}
    </span>
  );
}

export interface CompactTileProps {
  label: string;
  icon: ReactNode;
  value: string;
  /** Optional styled rendering of `value` (same text content - `value` still
   *  drives the change pulse and the testid's text). */
  valueNode?: ReactNode;
  sub?: string;
  title?: string;
  delta?: number | null;
  deltaBaseline?: string;
  resetKey: string;
  testId: string;
}

/** One card of a metric strip: the same chrome as the hero tiles (and every
 *  other surface on the page), just smaller. The icon is a vertically-centered
 *  anchor spanning BOTH text rows, so label and value share one left edge with
 *  nothing floating beside them. */
export function CompactTile({ label, icon, value, valueNode, sub, title, delta = null, deltaBaseline = '', resetKey, testId }: CompactTileProps) {
  const pulseRef = useValuePulse(value, { resetKey });
  return (
    <div className="bg-surface-raised border border-edge rounded-lg px-3 py-2.5 min-w-0 flex items-center gap-2.5" data-testid={testId} title={title}>
      <span className="flex-shrink-0 text-fg-muted" aria-hidden>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-fg-muted truncate">{label}</div>
        {/* Two clean columns: value anchored left, quiet signed delta at the
            cell's far edge - a straight line to scan down the strip. */}
        <div className="flex items-baseline justify-between gap-1.5 mt-0.5 min-w-0">
          <span ref={pulseRef} className="text-sm font-semibold text-fg tabular-nums truncate" data-testid={`${testId}-value`}>{valueNode ?? value}</span>
          <CompactDelta delta={delta} baseline={deltaBaseline} />
        </div>
        {sub && <div className="text-[11px] text-fg-muted tabular-nums truncate">{sub}</div>}
      </div>
    </div>
  );
}

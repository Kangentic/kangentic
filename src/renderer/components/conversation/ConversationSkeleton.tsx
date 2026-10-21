/**
 * Placeholder rows for a part of a paged conversation that is not loaded yet:
 * under a far scrollbar drag, and in place of the view while a jump reads the
 * page it lands on. Still boxes, no motion, so a drag that sweeps across it
 * reads as the content standing in rather than as something loading.
 */

import type { CSSProperties } from 'react';
import { formatMonthDayTime } from '../../lib/datetime';

/** Heights of the stand-in message boxes, varied like real turns. */
const SKELETON_ROW_HEIGHTS = [72, 120, 56, 96, 144, 64, 88];

export function ConversationSkeleton({ labelTs, className = '', style }: {
  /** The moment the target is at, shown as a date and time; null to show none. */
  labelTs: number | null;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`flex flex-col gap-3 overflow-hidden bg-surface p-3 ${className}`} style={style} data-testid="conversation-skeleton">
      {labelTs !== null && (
        <div
          className="self-center rounded-md border border-edge bg-surface-raised px-2 py-1 text-[11px] text-fg"
          data-testid="conversation-skeleton-label"
        >
          {formatMonthDayTime(labelTs)}
        </div>
      )}
      {SKELETON_ROW_HEIGHTS.map((height, index) => (
        <div key={index} className="flex-shrink-0 rounded-lg border border-edge bg-fg/[0.05]" style={{ height }} />
      ))}
    </div>
  );
}

import React from 'react';
import { useLingui } from '@lingui/react/macro';
import { Pill, TINTED_PILL_FILL, TINTED_PILL_EDGE } from '../Pill';
import { Tooltip } from '../Tooltip';
import { useConfigStore } from '../../stores/config-store';
import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';
import { displayPriorityLabel } from './priority-labels';
import { PriorityMeter } from './PriorityMeter';

/** The pill's side padding around its meter, in px. */
const PRIORITY_PILL_PADDING_X_PX = 8;
/** The pill's padding and its 1px `border`, both sides: its width beyond the meter's. */
export const PRIORITY_PILL_CHROME_PX = 2 * (PRIORITY_PILL_PADDING_X_PX + 1);
/** The bare mark's right padding. With the pill row's 4px gap it sits 6px before the first label. */
const PRIORITY_MARK_GAP_PX = 2;

/**
 * `pill` draws the meter inside a pill tinted with the level's color (the backlog table's
 * Priority column). `bare` draws the meter alone (a task's pill row, `TaskPills`), so beside
 * the label pills it reads as a mark rather than one more, louder label (#1143). `inline` is
 * the bare meter in a card's title row (#1146): no pill-row height and no trailing gap, so the
 * row keeps its 20px line and its own gap spaces the meter from #N and the globe (#1160).
 */
export type PriorityBadgeVariant = 'pill' | 'bare' | 'inline';

interface PriorityBadgeProps {
  priority: number;
  /** Draw the scale's bottom entry (None) as an empty meter. Cards leave it out; the backlog table shows it. */
  showNone?: boolean;
  variant?: PriorityBadgeVariant;
}

/**
 * A task's priority: the level meter, inside a tinted pill or bare (see `PriorityBadgeVariant`).
 * The bar count carries the rank, so the color is never the only signal. The level's name is
 * the hover tip and the mark's accessible name, since the mark takes no focus.
 */
export const PriorityBadge = React.memo(function PriorityBadge({ priority, showNone = false, variant = 'pill' }: PriorityBadgeProps) {
  const { t } = useLingui();
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  // `P0`, `P1`...: a code with no words, so it needs no translation. MCP names
  // a level past the scale the same way (`priorityName` in label-and-priority.ts).
  const entry = priorities[priority] ?? { label: `P${priority}`, color: '#6b7280' };
  const label = displayPriorityLabel(entry.label);

  if (priority === 0 && !showNone) return null;

  const accessibleName = t`Priority: ${label}`;
  const meter = <PriorityMeter level={priority} levelCount={priorities.length} color={entry.color} />;
  // Every variant keeps the `priority-pill` test id, so one selector finds a task's
  // priority on every surface. The bare and inline marks carry `data-variant`.
  // `min-h-6` holds the 24px line the label pills set, so a priority-only pill row
  // keeps its height. The title row's line is the title's own, so `inline` leaves it out.
  const isBare = variant === 'bare';
  return (
    <Tooltip label={label} describe={false}>
      {variant !== 'pill' ? (
        <span
          className={`inline-flex shrink-0 items-center ${isBare ? 'min-h-6' : ''}`}
          role="img"
          aria-label={accessibleName}
          style={isBare ? { paddingRight: PRIORITY_MARK_GAP_PX } : undefined}
          data-testid="priority-pill"
          data-variant={variant}
        >
          {meter}
        </span>
      ) : (
        <Pill
          size="sm"
          className="border"
          role="img"
          aria-label={accessibleName}
          style={{ color: entry.color, backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE, paddingLeft: PRIORITY_PILL_PADDING_X_PX, paddingRight: PRIORITY_PILL_PADDING_X_PX }}
          data-testid="priority-pill"
        >
          {meter}
        </Pill>
      )}
    </Tooltip>
  );
});

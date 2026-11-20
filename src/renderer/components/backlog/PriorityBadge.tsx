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

interface PriorityBadgeProps {
  priority: number;
  /** Draw the scale's bottom entry (None) as an empty meter. Cards leave it out; the backlog table shows it. */
  showNone?: boolean;
}

/**
 * A task's priority: the level meter inside a pill tinted with the level's color. The bar
 * count carries the rank, so the color is never the only signal. The level's name is the
 * hover tip and the pill's accessible name, since a pill takes no focus.
 */
export const PriorityBadge = React.memo(function PriorityBadge({ priority, showNone = false }: PriorityBadgeProps) {
  const { t } = useLingui();
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  // `P0`, `P1`...: a code with no words, so it needs no translation. MCP names
  // a level past the scale the same way (`priorityName` in label-and-priority.ts).
  const entry = priorities[priority] ?? { label: `P${priority}`, color: '#6b7280' };
  const label = displayPriorityLabel(entry.label);

  if (priority === 0 && !showNone) return null;

  const accessibleName = t`Priority: ${label}`;
  return (
    <Tooltip label={label} describe={false}>
      <Pill
        size="sm"
        className="border"
        role="img"
        aria-label={accessibleName}
        style={{ color: entry.color, backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE, paddingLeft: PRIORITY_PILL_PADDING_X_PX, paddingRight: PRIORITY_PILL_PADDING_X_PX }}
        data-testid="priority-pill"
      >
        <PriorityMeter level={priority} levelCount={priorities.length} color={entry.color} />
      </Pill>
    </Tooltip>
  );
});

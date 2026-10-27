import React from 'react';
import { Pill, TINTED_PILL_FILL, TINTED_PILL_EDGE } from '../Pill';
import { useConfigStore } from '../../stores/config-store';
import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';
import { displayPriorityLabel } from './priority-labels';

interface PriorityBadgeProps {
  priority: number;
  showLabel?: boolean;
}

export const PriorityBadge = React.memo(function PriorityBadge({ priority, showLabel = false }: PriorityBadgeProps) {
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  // `P0`, `P1`...: a code with no words, so it needs no translation.
  const entry = priorities[priority] ?? { label: `P${priority}`, color: '#6b7280' };
  const label = displayPriorityLabel(entry.label);

  if (priority === 0 && !showLabel) return null;

  if (priority === 0) {
    return <span className="text-xs text-fg-disabled">{label}</span>;
  }

  return (
    <Pill
      size="sm"
      className="font-medium border"
      style={{ color: entry.color, backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
    >
      {label}
    </Pill>
  );
});

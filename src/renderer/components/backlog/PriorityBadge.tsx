import React from 'react';
import { Pill, TINTED_PILL_FILL, TINTED_PILL_EDGE } from '../Pill';
import { useConfigStore } from '../../stores/config-store';
import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';

interface PriorityBadgeProps {
  priority: number;
  showLabel?: boolean;
}

export const PriorityBadge = React.memo(function PriorityBadge({ priority, showLabel = false }: PriorityBadgeProps) {
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  const entry = priorities[priority] ?? { label: `P${priority}`, color: '#6b7280' };

  if (priority === 0 && !showLabel) return null;

  if (priority === 0) {
    return <span className="text-xs text-fg-disabled">{entry.label}</span>;
  }

  return (
    <Pill
      size="sm"
      className="font-medium border"
      style={{ color: entry.color, backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
      title={entry.label}
    >
      {entry.label}
    </Pill>
  );
});

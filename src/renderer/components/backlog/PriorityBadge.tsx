import React from 'react';
import { Pill } from '../Pill';
import { useConfigStore } from '../../stores/config-store';

const DEFAULT_PRIORITIES = [
  { label: 'None', color: '#6b7280' },
  { label: 'Low', color: '#3b82f6' },
  { label: 'Medium', color: '#eab308' },
  { label: 'High', color: '#f97316' },
  { label: 'Urgent', color: '#ef4444' },
];

interface PriorityBadgeProps {
  priority: number;
  showLabel?: boolean;
}

export const PriorityBadge = React.memo(function PriorityBadge({ priority, showLabel = false }: PriorityBadgeProps) {
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITIES;
  const entry = priorities[priority] ?? { label: `P${priority}`, color: '#6b7280' };

  if (priority === 0 && !showLabel) return null;

  if (priority === 0) {
    return <span className="text-xs text-fg-disabled">{entry.label}</span>;
  }

  return (
    <Pill
      size="sm"
      className="font-medium"
      style={{ backgroundColor: `${entry.color}20`, color: entry.color, border: `1px solid ${entry.color}30` }}
      title={entry.label}
    >
      {entry.label}
    </Pill>
  );
});

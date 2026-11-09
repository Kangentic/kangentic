import React from 'react';
import { Flag } from 'lucide-react';
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
  // `P0`, `P1`...: a code with no words, so it needs no translation. MCP names
  // a level past the scale the same way (`priorityName` in label-and-priority.ts).
  const entry = priorities[priority] ?? { label: `P${priority}`, color: '#6b7280' };
  const label = displayPriorityLabel(entry.label);

  if (priority === 0 && !showLabel) return null;

  if (priority === 0) {
    return <span className="text-xs text-fg-disabled">{label}</span>;
  }

  // The flag says "priority" where an orange level and an orange label would
  // otherwise differ only in their word. The name stays, so the color is never
  // the only signal.
  return (
    <Pill
      size="sm"
      className="font-medium border"
      style={{ color: entry.color, backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
      data-testid="priority-pill"
    >
      <Flag size={12} className="shrink-0" aria-hidden />
      {label}
    </Pill>
  );
});

import React from 'react';
import { LabelPillItems } from '../Pill';
import { PriorityBadge } from './PriorityBadge';

interface TaskPillsProps {
  /**
   * Index into the project's priority scale. 0, the scale's bottom entry, draws nothing.
   * A card leaves it out: it draws the meter in its title row (#1146).
   */
  priority?: number;
  labels: string[];
  labelColors: Record<string, string>;
  className?: string;
}

/** Whether `TaskPills` draws anything for this priority and these labels. */
function taskHasPills(priority: number, labels: readonly string[]): boolean {
  return priority !== 0 || labels.length > 0;
}

/**
 * A task's pill row: its priority first, then its labels, in ONE wrap run so a
 * long row wraps pill by pill rather than the labels dropping as a block. The
 * priority is the bare meter, not a pill, so it reads apart from the labels by
 * shape and takes 16px less (#1143). The task window draws both here; a card
 * draws only its labels here and its meter in the title row (#1146).
 */
export const TaskPills = React.memo(function TaskPills({ priority = 0, labels, labelColors, className }: TaskPillsProps) {
  if (!taskHasPills(priority, labels)) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ''}`} data-testid="task-pills">
      {/* A card passes no priority, so it mounts no meter it would only hide. */}
      {priority !== 0 && <PriorityBadge priority={priority} variant="bare" />}
      <LabelPillItems labels={labels} labelColors={labelColors} />
    </div>
  );
});

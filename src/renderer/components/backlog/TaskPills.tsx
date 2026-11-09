import React from 'react';
import { LabelPillItems } from '../Pill';
import { PriorityBadge } from './PriorityBadge';

interface TaskPillsProps {
  /** Index into the project's priority scale. 0, the scale's bottom entry, draws no pill. */
  priority: number;
  labels: string[];
  labelColors: Record<string, string>;
  className?: string;
}

/**
 * Whether `TaskPills` draws anything. A host whose layout depends on the row (the
 * card's footer rule, the monitor card's spacer) asks this, so it cannot
 * disagree with what the row draws.
 */
export function taskHasPills(priority: number, labels: readonly string[]): boolean {
  return priority !== 0 || labels.length > 0;
}

/**
 * A task's pill row: its priority first, then its labels, in ONE wrap run so a
 * long row wraps pill by pill rather than the labels dropping as a block. Every
 * surface that shows a task's labels draws them through this, so priority shows
 * wherever labels do and in the same place.
 */
export const TaskPills = React.memo(function TaskPills({ priority, labels, labelColors, className }: TaskPillsProps) {
  if (!taskHasPills(priority, labels)) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ''}`} data-testid="task-pills">
      <PriorityBadge priority={priority} />
      <LabelPillItems labels={labels} labelColors={labelColors} />
    </div>
  );
});

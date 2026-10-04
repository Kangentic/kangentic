import React from 'react';
import { Lock } from 'lucide-react';
import type { WorkflowRouteStep } from '../../../shared/types';

/**
 * The strip on top of a workflow task's card: what the card belongs to (its
 * column on the Workflows canvas, its workflow on the board) as an icon and a
 * name, the step track, and the lock. The title row under it is the board's,
 * unchanged: new information goes in this strip, never into an existing row.
 */

const AHEAD_COLOR = 'var(--color-edge)';

/** One segment per step the task visits: done, current, ahead. Skipped columns are not drawn. */
export const WorkflowStepTrack = React.memo(function WorkflowStepTrack({ steps }: { steps: readonly WorkflowRouteStep[] }) {
  const visited = steps.filter((step) => step.state !== 'skipped');
  if (visited.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" data-testid="workflow-step-track">
      {visited.map((step) => {
        const color = step.color ?? 'var(--color-fg-faint)';
        if (step.state === 'current') {
          return (
            <i
              key={step.swimlaneId}
              title={`${step.name}: now`}
              data-step-state="current"
              className="block w-[15px] h-[6px] rounded-[3px]"
              style={{ background: color, boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 18%, transparent)` }}
            />
          );
        }
        return (
          <i
            key={step.swimlaneId}
            title={`${step.name}: ${step.state === 'done' ? 'done' : 'next'}`}
            data-step-state={step.state}
            className="block w-[11px] h-[4px] rounded-[2px]"
            style={step.state === 'done' ? { background: color, opacity: 0.55 } : { background: AHEAD_COLOR }}
          />
        );
      })}
    </span>
  );
});

interface WorkflowCardStripProps {
  /** The icon, already colored by the caller (the column's color, or the workflow's). */
  icon: React.ReactNode;
  label: string;
  steps: readonly WorkflowRouteStep[];
  /** Set while the workflow runs: the card moves by its workflow, not by hand. */
  lockedTitle?: string | null;
}

export const WorkflowCardStrip = React.memo(function WorkflowCardStrip({ icon, label, steps, lockedTitle }: WorkflowCardStripProps) {
  return (
    <div
      className="h-[29px] px-2.5 flex items-center justify-between gap-2 border-b border-edge bg-surface/30 shrink-0"
      data-testid="workflow-card-strip"
    >
      <span className="inline-flex items-center gap-[5px] text-xs text-fg-muted min-w-0">
        <span className="inline-flex shrink-0">{icon}</span>
        <span className="truncate" title={label}>{label}</span>
      </span>
      <span className="inline-flex items-center gap-[7px] shrink-0">
        <WorkflowStepTrack steps={steps} />
        {lockedTitle && (
          <span className="inline-flex text-fg-faint" title={lockedTitle} data-testid="workflow-card-lock">
            <Lock size={12} aria-label={lockedTitle} />
          </span>
        )}
      </span>
    </div>
  );
});

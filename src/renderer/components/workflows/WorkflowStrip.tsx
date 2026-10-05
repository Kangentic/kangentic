import React from 'react';
import { Lock } from 'lucide-react';
import type { Swimlane, WorkflowRouteStep } from '../../../shared/types';
import { ColumnGlyph } from '../../utils/swimlane-icons';

/**
 * The strip on top of a workflow task's card: on the left whatever the card
 * belongs to (its workflow on the board; its project on the Workflows canvas
 * once the workflow spans boards; nothing otherwise), on the right the step
 * track and the lock. On the canvas the column is named by the track itself:
 * its current step is the column's own marker, and the name is the marker's
 * tooltip and accessible name. On the board the lane names the column, so the
 * current step stays a bar. The title row under the strip is the board's,
 * unchanged: new information goes in this strip, never into an existing row.
 * The phone app draws the canvas strip at the same sizes.
 */

const AHEAD_COLOR = 'var(--color-edge)';
const UNCOLORED = 'var(--color-fg-faint)';

/**
 * Where a task is when it is not on its route: To Do before it starts, Done
 * after it finishes. Neither column is ever a step of the track, so the track
 * is that column's marker alone, uncolored.
 */
export interface OutsideRouteColumn {
  role: NonNullable<Swimlane['role']>;
  name: string;
  /** The column's own icon when the caller has it; its role's default otherwise. */
  icon?: string | null;
}

/**
 * The column a task is in, drawn as one 18px rounded square: the column's
 * glyph at 12px (its icon, its To Do or Done default, or a dot in its color)
 * on its color at 18%, the strength the old current bar's ring had.
 */
function StepMarker({ column, color, label, testState }: {
  column: Pick<Swimlane, 'icon' | 'role'>;
  color: string;
  label: string;
  testState: { stepState?: 'current'; outsideRoute?: OutsideRouteColumn['role'] };
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="workflow-step-marker"
      data-step-state={testState.stepState}
      data-outside-route={testState.outsideRoute}
      className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-[5px] shrink-0"
      style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
    >
      <ColumnGlyph column={column} size={12} color={color} />
    </span>
  );
}

/**
 * How the track draws the step the task is on. `marker` is the column's own
 * marker, for a surface where nothing else names the column (the Workflows
 * canvas, the phone). `bar` is a wider, brighter bar, for the board, where the
 * lane the card sits in already names it.
 */
export type CurrentStepStyle = 'marker' | 'bar';

/**
 * One mark per step the task visits: done, the current step, then the steps
 * ahead. Skipped columns are not drawn. With the `marker` style a task in To Do
 * or Done is not on its route, and its track is that column's marker alone.
 */
export const WorkflowStepTrack = React.memo(function WorkflowStepTrack({ steps, outsideRoute = null, currentStep = 'marker' }: {
  steps: readonly WorkflowRouteStep[];
  outsideRoute?: OutsideRouteColumn | null;
  currentStep?: CurrentStepStyle;
}) {
  if (outsideRoute && currentStep === 'marker') {
    return (
      <span className="inline-flex items-center gap-0.5 shrink-0" data-testid="workflow-step-track">
        <StepMarker
          column={{ icon: outsideRoute.icon ?? null, role: outsideRoute.role }}
          color={UNCOLORED}
          label={outsideRoute.name}
          testState={{ outsideRoute: outsideRoute.role }}
        />
      </span>
    );
  }
  const visited = steps.filter((step) => step.state !== 'skipped');
  if (visited.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" data-testid="workflow-step-track">
      {visited.map((step) => {
        const color = step.color ?? UNCOLORED;
        if (step.state === 'current' && currentStep === 'bar') {
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
        if (step.state === 'current') {
          return (
            <StepMarker
              key={step.swimlaneId}
              column={{ icon: step.icon, role: null }}
              color={color}
              label={`${step.name}: now`}
              testState={{ stepState: 'current' }}
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

/** The strip's left side as an icon and a name that truncates, with an optional mark after it that never does. */
export function WorkflowStripLabel({ icon, label, labelTrailing, className, testId }: {
  icon: React.ReactNode;
  label: string;
  /** Drawn right after the label and never truncated with it (a paused workflow's pause glyph). */
  labelTrailing?: React.ReactNode;
  /** The gap and text color: the workflow's name and a project's name read differently. */
  className: string;
  testId?: string;
}) {
  return (
    <span className={`inline-flex items-center text-xs min-w-0 ${className}`} data-testid={testId}>
      <span className="inline-flex shrink-0">{icon}</span>
      <span className="truncate" title={label}>{label}</span>
      {labelTrailing && <span className="inline-flex shrink-0">{labelTrailing}</span>}
    </span>
  );
}

interface WorkflowCardStripProps {
  /** The left side: the workflow on a board card, the project on a canvas card of a workflow across boards. */
  leading?: React.ReactNode;
  steps: readonly WorkflowRouteStep[];
  /** Set for a task in To Do or Done, whose track is that column's marker alone (the `marker` style). */
  outsideRoute?: OutsideRouteColumn | null;
  /** How the step the task is on is drawn: the column's marker, or the board's bar. */
  currentStep?: CurrentStepStyle;
  /** Set while the workflow runs: the card moves by its workflow, not by hand. */
  lockedTitle?: string | null;
}

export const WorkflowCardStrip = React.memo(function WorkflowCardStrip({ leading = null, steps, outsideRoute = null, currentStep = 'marker', lockedTitle }: WorkflowCardStripProps) {
  return (
    <div
      className="h-[29px] px-2.5 flex items-center justify-between gap-2 border-b border-edge bg-surface/30 shrink-0"
      data-testid="workflow-card-strip"
    >
      {leading ?? <span aria-hidden="true" />}
      <span className="inline-flex items-center gap-[7px] shrink-0">
        <WorkflowStepTrack steps={steps} outsideRoute={outsideRoute} currentStep={currentStep} />
        {lockedTitle && (
          <span className="inline-flex text-fg-faint" title={lockedTitle} data-testid="workflow-card-lock">
            <Lock size={12} aria-label={lockedTitle} />
          </span>
        )}
      </span>
    </div>
  );
});
